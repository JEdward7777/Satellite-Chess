/**
 * A watcher's connection (stage 10.14, decision 0055).
 *
 * **It sends nothing but the free keepalive.** A watcher only receives: the
 * game closes a watcher's socket on anything it says, and an inbound message
 * would be billed. The server sends the whole view on connecting, so a
 * reconnect needs no `sync` either. The keepalive ping is answered by the
 * runtime without waking the game, and is not billed.
 *
 * Closed by the game for a reason of its own (turned off, the game over, too
 * many watching), the page stops and says so. Closed by the network, it tries
 * again, backing off, and gives up after a few sockets in a row that never
 * opened — a link to a game that has gone answers no socket at all.
 */

import { PING, PONG } from '../shared/protocol.js';
import { type WatchLink, type WatchServerMsg, type WatchSnapshot, watchSocketPath } from '../shared/watch.js';
import { WATCH_MAX_FAILED_OPENS, type WatchEnd, watchCloseOutcome, watchRetryDelayMs } from './watching.js';

export interface WatchNetState {
  status: 'connecting' | 'open' | 'reconnecting' | 'ended';
  view: WatchSnapshot | null;
  /** Local time the view arrived, for the clock (`client/clock.ts`). */
  receivedAt: number | null;
  ended: WatchEnd | null;
}

export interface WatchConnection {
  readonly state: WatchNetState;
  subscribe(listener: (state: WatchNetState) => void): () => void;
  close(): void;
}

interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface WatchConnectionOptions {
  link: WatchLink;
  origin?: string;
  socketFactory?(url: string): SocketLike;
  now?(): number;
}

const PING_MS = 25_000;

export function connectToWatch(opts: WatchConnectionOptions): WatchConnection {
  const now = opts.now ?? (() => Date.now());
  let state: WatchNetState = { status: 'connecting', view: null, receivedAt: null, ended: null };
  const listeners = new Set<(state: WatchNetState) => void>();
  let socket: SocketLike | null = null;
  let wanted = true;
  let attempt = 0;
  let failedOpens = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;

  const patch = (next: Partial<WatchNetState>) => {
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener(state);
  };

  const stopPing = () => {
    if (ping !== null) clearInterval(ping);
    ping = null;
  };

  const url = () => {
    const origin = opts.origin ?? location.origin;
    return `${origin.replace(/^http/, 'ws')}${watchSocketPath(opts.link)}`;
  };

  const onMessage = (data: string) => {
    if (data === PONG || data === PING) return;
    let msg: WatchServerMsg;
    try {
      msg = JSON.parse(data) as WatchServerMsg;
    } catch {
      return;
    }
    if (msg.t === 'watch_state') {
      patch({ view: msg.game, receivedAt: now() });
    } else if (msg.t === 'watch_pos' && state.view !== null) {
      const view = state.view;
      const player = view.players[msg.color];
      patch({ view: { ...view, players: { ...view.players, [msg.color]: { ...player, at: msg.at } } } });
    }
  };

  const open = () => {
    if (!wanted) return;
    patch({ status: state.view === null ? 'connecting' : 'reconnecting' });
    const factory = opts.socketFactory ?? ((u: string) => new WebSocket(u) as unknown as SocketLike);
    let opened = false;
    let s: SocketLike;
    try {
      s = factory(url());
    } catch {
      failedOpens += 1;
      schedule();
      return;
    }
    socket = s;
    s.onopen = () => {
      opened = true;
      attempt = 0;
      failedOpens = 0;
      patch({ status: 'open' });
      stopPing();
      ping = setInterval(() => {
        try {
          socket?.send(PING);
        } catch {
          // Closing; the close handler decides what next.
        }
      }, PING_MS);
    };
    s.onmessage = (event) => onMessage(String(event.data));
    s.onclose = (event) => {
      stopPing();
      if (socket === s) socket = null;
      if (!wanted) return;
      if (!opened) failedOpens += 1;
      const outcome = watchCloseOutcome(event.code, failedOpens);
      if (outcome === 'retry') {
        schedule();
        return;
      }
      wanted = false;
      patch({ status: 'ended', ended: outcome });
    };
  };

  function schedule(): void {
    if (!wanted) return;
    if (failedOpens >= WATCH_MAX_FAILED_OPENS) {
      wanted = false;
      patch({ status: 'ended', ended: 'broken' });
      return;
    }
    patch({ status: state.view === null ? 'connecting' : 'reconnecting' });
    const delay = watchRetryDelayMs(attempt);
    attempt += 1;
    retry = setTimeout(() => {
      retry = null;
      open();
    }, delay);
  }

  open();

  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listener(state);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      wanted = false;
      stopPing();
      if (retry !== null) clearTimeout(retry);
      retry = null;
      try {
        socket?.close();
      } catch {
        // Already closed.
      }
      socket = null;
    },
  };
}
