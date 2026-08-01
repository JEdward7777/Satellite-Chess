/**
 * The client's end of the wire: one WebSocket to one game's Durable Object.
 *
 * Three project rules shape this file, and each one is a cost rather than a
 * preference (see `harness/reference/budget.md`):
 *
 * - **Never stream GPS.** Every inbound message is billed as a request against
 *   100k/day, and 1 Hz from two players for half an hour is 3,600 of them for a
 *   single game. Reach is computed locally at full rate for free; the server
 *   hears a position only at a lift, a place, and a hard rate-limited relay.
 * - **Keepalive must cost nothing.** The DO answers `PING` via
 *   `setWebSocketAutoResponse`, which does not wake the object and is not billed.
 *   So the client pings, and a `PONG` is not a message anyone needs to see.
 * - **The server is the only authority.** This module never decides anything
 *   about the game. It relays, it reconnects, and it hands snapshots on.
 *
 * Reconnection is not a nicety either: the phone is outdoors, in a pocket, on one
 * bar. A dropped socket that stayed dropped would suspend the game after the
 * 20 s grace and cost both players the back-rank handshake to resume.
 */

import { distanceM } from '../shared/geo.js';
import {
  type ClientMsg,
  type ErrorMsg,
  type GameSnapshot,
  type OppPosMsg,
  PING,
  PONG,
  POS_MIN_DELTA_M,
  POS_MIN_INTERVAL_MS,
  type ServerMsg,
} from '../shared/protocol.js';
import type { GpsFix } from './gps.js';

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Everything a view needs to know about the connection and the game. */
export interface NetState {
  status: ConnStatus;
  /** The last snapshot the server sent, or null before the first one. */
  game: GameSnapshot | null;
  /** The most recent rejection, for the view to show and then dismiss. */
  lastError: ErrorMsg | null;
  /** Opponent's last relayed position — atmosphere, never correctness. */
  opponent: { lat: number; lng: number; acc: number; at: number } | null;
  /** How many times the socket has had to come back. Useful in the field. */
  reconnects: number;
}

export interface GameConnection {
  readonly state: NetState;
  subscribe(listener: (state: NetState) => void): () => void;
  /** Queue a message. Sent now if open, dropped with a warning if not. */
  send(msg: ClientMsg): boolean;
  /**
   * Offer a position for relay. Returns true if it actually went.
   *
   * This is the one method that deliberately refuses most of what it is given.
   */
  offerPosition(fix: GpsFix, travelM?: number): boolean;
  /** Ask for a fresh snapshot, after a reconnect or a suspicion of drift. */
  resync(): void;
  close(): void;
}

export interface GameConnectionOptions {
  joinCode: string;
  playerId: string;
  /** Overridable for tests; defaults to this page's origin. */
  origin?: string;
  /** Injectable so a test need not run a real server. */
  socketFactory?: (url: string) => WebSocketLike;
  /** Keepalive period. Free, so frequent enough to hold an idle NAT open. */
  pingIntervalMs?: number;
  now?: () => number;
}

/** The slice of WebSocket this module uses, so a fake is small. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

const OPEN = 1;

/**
 * Backoff for reconnection, in milliseconds.
 *
 * Starts fast because the overwhelming case is a two-second signal dropout while
 * walking past a building, and the 20 s disconnect grace is the deadline that
 * matters — reconnecting inside it means the game never suspends at all. Tops out
 * at 10 s so a phone that has genuinely lost signal is not burning battery.
 */
const BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000, 10_000];

/** Frequent enough to hold a mobile NAT binding open, and free either way. */
const DEFAULT_PING_MS = 25_000;

class Connection implements GameConnection {
  private readonly listeners = new Set<(state: NetState) => void>();
  private readonly now: () => number;
  private readonly pingIntervalMs: number;
  private socket: WebSocketLike | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private wanted = true;
  private current: NetState = {
    status: 'idle',
    game: null,
    lastError: null,
    opponent: null,
    reconnects: 0,
  };

  /** Relay bookkeeping. Both are the client half of the request budget. */
  private lastSentPos: { lat: number; lng: number } | null = null;
  private lastSentAt = 0;

  constructor(private readonly opts: GameConnectionOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_MS;
    this.open();
  }

  get state(): NetState {
    return this.current;
  }

  subscribe(listener: (state: NetState) => void): () => void {
    listener(this.current);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private patch(next: Partial<NetState>): void {
    this.current = { ...this.current, ...next };
    for (const listener of this.listeners) listener(this.current);
  }

  private url(): string {
    const origin = this.opts.origin ?? location.origin;
    const wsOrigin = origin.replace(/^http/, 'ws');
    return `${wsOrigin}/api/game/${encodeURIComponent(this.opts.joinCode)}/ws?playerId=${encodeURIComponent(
      this.opts.playerId,
    )}`;
  }

  private open(): void {
    if (!this.wanted) return;
    this.patch({ status: this.current.game === null ? 'connecting' : 'reconnecting' });

    const factory = this.opts.socketFactory ?? ((url: string) => new WebSocket(url) as WebSocketLike);
    let socket: WebSocketLike;
    try {
      socket = factory(this.url());
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.patch({ status: 'open' });
      this.startPing();
      // A reconnect may have missed any number of broadcasts, so never assume
      // the snapshot in hand is current.
      this.sendRaw({ t: 'sync' });
    };

    socket.onmessage = (event) => {
      const data = String(event.data);
      // The runtime answers our pings itself. Seeing one means the socket is
      // alive, which is all it was ever for.
      if (data === PONG || data === PING) return;

      let msg: ServerMsg;
      try {
        msg = JSON.parse(data) as ServerMsg;
      } catch {
        // A frame we cannot parse is a bug somewhere, but dropping the game over
        // it would be worse than ignoring it.
        return;
      }
      this.receive(msg);
    };

    socket.onerror = () => {
      // `onclose` always follows, and that is where the retry lives.
    };

    socket.onclose = () => {
      this.stopPing();
      this.socket = null;
      if (!this.wanted) {
        this.patch({ status: 'closed' });
        return;
      }
      this.patch({ status: 'reconnecting', reconnects: this.current.reconnects + 1 });
      this.scheduleRetry();
    };
  }

  private receive(msg: ServerMsg): void {
    switch (msg.t) {
      case 'state':
        // One patch, not two: the opponent's dot arrives inside the snapshot as
        // well as on its own, and a listener should see one update either way.
        this.patch({
          game: msg.game,
          lastError: null,
          opponent: this.opponentFrom(msg.game) ?? this.current.opponent,
        });
        return;
      case 'error':
        this.patch({ lastError: msg });
        return;
      case 'opp_pos': {
        const pos = msg as OppPosMsg;
        this.patch({ opponent: { lat: pos.lat, lng: pos.lng, acc: pos.acc, at: this.now() } });
        return;
      }
    }
  }

  /**
   * The opponent's position as a snapshot reports it, or null if it says nothing
   * newer than we already have.
   *
   * Without this a client that has just connected has no dot to draw until the
   * opponent happens to move two metres — and someone standing on their back
   * rank waiting for you never will. The snapshot is the only thing that can
   * answer "where are they *now*", because the relay only speaks on movement.
   *
   * The snapshot times the fix on the server's clock, so it is converted through
   * `serverNow` into local time rather than compared against it. The two phones'
   * clocks have never been synchronised with each other and this is the one
   * place that would quietly assume they had.
   */
  private opponentFrom(game: GameSnapshot): NetState['opponent'] {
    const them = game.players?.[game.you === 'w' ? 'b' : 'w'];
    const pos = them?.pos;
    if (!pos) return null;
    const at = this.now() - Math.max(0, game.serverNow - pos.at);
    const known = this.current.opponent;
    if (known !== null && at <= known.at) return null;
    return { lat: pos.lat, lng: pos.lng, acc: pos.acc, at };
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      // Costs nothing: answered by the runtime without waking the object.
      this.socket?.send(PING);
    }, this.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private sendRaw(msg: ClientMsg): boolean {
    const socket = this.socket;
    if (socket === null || socket.readyState !== OPEN) return false;
    socket.send(JSON.stringify(msg));
    return true;
  }

  send(msg: ClientMsg): boolean {
    return this.sendRaw(msg);
  }

  /**
   * Relay a position, or decline to.
   *
   * Declining is the normal outcome and the entire point. The thresholds live in
   * `shared/protocol.ts` so both ends agree, and the server enforces its own
   * stricter backstop against a client that ignores them.
   */
  offerPosition(fix: GpsFix, travelM = 0): boolean {
    const at = this.now();
    if (at - this.lastSentAt < POS_MIN_INTERVAL_MS) return false;
    if (this.lastSentPos !== null && distanceM(this.lastSentPos, fix.pos) < POS_MIN_DELTA_M) {
      return false;
    }

    const sent = this.sendRaw({
      t: 'pos',
      lat: fix.pos.lat,
      lng: fix.pos.lng,
      acc: fix.accuracyM,
      // No timestamp: `PosMsg` deliberately has no field for one. The server
      // times everything itself, because a client clock is not evidence.
      travelM,
    });
    if (sent) {
      this.lastSentPos = { ...fix.pos };
      this.lastSentAt = at;
    }
    return sent;
  }

  resync(): void {
    this.sendRaw({ t: 'sync' });
  }

  close(): void {
    this.wanted = false;
    this.stopPing();
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.socket?.close();
    this.socket = null;
    this.patch({ status: 'closed' });
  }
}

export function connectToGame(opts: GameConnectionOptions): GameConnection {
  return new Connection(opts);
}
