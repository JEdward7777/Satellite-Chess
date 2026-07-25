/**
 * GameDO — one Durable Object per game, authoritative for everything.
 *
 * Addressed by join code, so there is no lookup table and no eventual-consistency
 * race when someone scans a QR three seconds after the game was created
 * (decision 0007).
 *
 * Three constraints shape every method here, and breaking any of them breaks the
 * deployment rather than merely the design (decision 0006):
 *
 * - **Hibernation is mandatory**, via `ctx.acceptWebSocket()`. An idle game —
 *   players walking, thinking, resting — must not be billed for duration.
 * - **Therefore nothing lives in memory.** No `setTimeout`, no cached clock, no
 *   per-socket state outside `serializeAttachment`. Every method reads what it
 *   needs from SQLite.
 * - **Inbound messages are billed as requests.** The client computes reach for
 *   its own UI at full GPS rate for free; the server hears from it only at a
 *   lift, a place, and a coarse position relay (decision 0008).
 */

import { DurableObject } from 'cloudflare:workers';

import { type ClockState, newClock, remainingMs, snapshot as clockSnapshot } from '../shared/clock.js';
import { type FieldSnapshot, geometryFromSnapshot } from '../shared/field.js';
import { DEFAULT_REACH, inStartZone } from '../shared/reach.js';
import {
  DISCONNECT_GRACE_MS,
  type GameSnapshot,
  type GameStatus,
  PING,
  PONG,
  POS_SERVER_MIN_INTERVAL_MS,
  PROTOCOL_VERSION,
  type PlayerView,
  type ResultOutcome,
  type ResultReason,
  type ServerMsg,
  UNCLAIMED_GAME_TTL_MS,
} from '../shared/protocol.js';
import type { Color } from '../shared/squares.js';
import { Timers } from './timers.js';
import { applySchema, isInitialised } from './schema.js';

/** What a socket needs to remember about itself across a hibernation. */
interface SocketAttachment {
  playerId: string;
  color: Color;
}

export interface CreateGameOptions {
  joinCode: string;
  creatorPlayerId: string;
  /** The colour the creator takes; the joiner gets the other. */
  creatorColor: Color;
  field: FieldSnapshot;
  initialMs: number;
  incrementMs: number;
  reachBonusM?: Partial<Record<Color, number>>;
}

// The index signature is what `sql.exec<T>()` requires: it returns
// `Record<string, SqlStorageValue>`, which a plain interface does not satisfy.
interface GameRow {
  join_code: string;
  status: GameStatus;
  fen: string;
  field_snapshot_json: string;
  white_player_id: string | null;
  black_player_id: string | null;
  white_ms_remaining: number;
  black_ms_remaining: number;
  increment_ms: number;
  active_color: Color;
  last_clock_start_at: number | null;
  white_reach_bonus_m: number;
  black_reach_bonus_m: number;
  draw_offer_from: Color | null;
  result_outcome: string | null;
  result_reason: string | null;
  result_at: number | null;
  rev: number;
  created_at: number;
  updated_at: number;
  [key: string]: SqlStorageValue;
}

interface PresenceRow {
  player_id: string;
  color: Color;
  connected: number;
  last_seen_at: number | null;
  last_lat: number | null;
  last_lng: number | null;
  last_acc: number | null;
  last_pos_at: number | null;
  travel_m: number;
  in_start_zone: number;
  [key: string]: SqlStorageValue;
}

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export class GameDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly timers: Timers;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    // Idempotent, and cheap enough to run on every wake. `blockConcurrencyWhile`
    // so no request can observe a half-created schema.
    ctx.blockConcurrencyWhile(async () => {
      applySchema(this.sql);
    });

    this.timers = new Timers(ctx, this.sql);

    // Keepalive that costs nothing: the runtime answers a ping itself, without
    // waking this object and without being billed as a request. A hand-rolled
    // ping/pong would turn every idle game into a running cost.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create the game. Called once, by the router, for a freshly generated code.
   *
   * Returns false if this object already holds a game, which is how a join-code
   * collision is handled: the loser retries with a new code, and the cost of a
   * ~1-in-1e9 event is one extra round trip (decision 0007).
   */
  async create(options: CreateGameOptions): Promise<boolean> {
    if (isInitialised(this.sql)) return false;

    const now = Date.now();
    const clock = newClock(options.initialMs, options.incrementMs, 'w');
    const white = options.creatorColor === 'w' ? options.creatorPlayerId : null;
    const black = options.creatorColor === 'b' ? options.creatorPlayerId : null;

    this.sql.exec(
      `INSERT INTO game (
         id, join_code, status, fen, field_snapshot_json,
         white_player_id, black_player_id,
         white_ms_remaining, black_ms_remaining, increment_ms,
         active_color, last_clock_start_at,
         white_reach_bonus_m, black_reach_bonus_m,
         rev, created_at, updated_at
       ) VALUES (1, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?, 'w', NULL, ?, ?, 1, ?, ?)`,
      options.joinCode,
      STARTING_FEN,
      JSON.stringify(options.field),
      white,
      black,
      clock.whiteMs,
      clock.blackMs,
      clock.incrementMs,
      options.reachBonusM?.w ?? 0,
      options.reachBonusM?.b ?? 0,
      now,
      now,
    );

    this.sql.exec(
      `INSERT INTO presence (player_id, color) VALUES (?, ?)`,
      options.creatorPlayerId,
      options.creatorColor,
    );

    // An unclaimed code must not linger. If nobody joins, this object deletes
    // itself and stops existing, which frees the code and keeps the account tidy.
    await this.timers.schedule('gc', now + UNCLAIMED_GAME_TTL_MS);
    return true;
  }

  /**
   * Take the free seat.
   *
   * Idempotent for a player already in the game, so reopening the link is not an
   * error. Rejects a third player.
   */
  async join(playerId: string): Promise<{ ok: true; color: Color } | { ok: false; reason: 'not_found' | 'full' }> {
    const game = this.game();
    if (game === null) return { ok: false, reason: 'not_found' };

    const existing = this.colorOf(game, playerId);
    if (existing !== null) return { ok: true, color: existing };

    const free: Color | null =
      game.white_player_id === null ? 'w' : game.black_player_id === null ? 'b' : null;
    if (free === null) return { ok: false, reason: 'full' };

    const now = Date.now();
    this.sql.exec(
      free === 'w'
        ? `UPDATE game SET white_player_id = ?, updated_at = ? WHERE id = 1`
        : `UPDATE game SET black_player_id = ?, updated_at = ? WHERE id = 1`,
      playerId,
      now,
    );
    this.sql.exec(`INSERT INTO presence (player_id, color) VALUES (?, ?)`, playerId, free);

    // Both seats filled: the game stops being a dangling code and starts waiting
    // for two people to walk to their own back ranks (decision 0005). The initial
    // start uses the same handshake as a resume, so there is one code path and one
    // rule to explain.
    this.setStatus('staging');
    await this.timers.cancel('gc');
    this.bumpRev();
    this.broadcastState();
    return { ok: true, color: free };
  }

  // -------------------------------------------------------------------------
  // WebSockets
  // -------------------------------------------------------------------------

  /**
   * WebSocket upgrades arrive here rather than through an RPC method.
   *
   * They have to: a `Response` carrying a `webSocket` cannot be serialised across
   * the RPC boundary, and attempting it fails with `DataCloneError: Could not
   * serialize object of type "WebSocket"`. Every other operation on this object is
   * a plain RPC method, which is nicer — this one is a `fetch` out of necessity.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/ws') {
      return new Response('not found', { status: 404 });
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }
    const playerId = url.searchParams.get('playerId');
    if (playerId === null || playerId === '') {
      return new Response('a playerId is required', { status: 400 });
    }
    return this.openWebSocket(playerId);
  }

  /**
   * Seat a socket for a player already in this game.
   *
   * `acceptWebSocket` rather than `server.accept()`: the object may then hibernate
   * between messages while two people walk around a field, which is the only way
   * this fits the free tier.
   *
   * Not called `connect`: `DurableObject` already has a `connect(socket)` for
   * outbound TCP, and overriding it by accident would be a strange bug to find.
   */
  private async openWebSocket(playerId: string): Promise<Response> {
    const game = this.game();
    if (game === null) {
      return new Response('no such game', { status: 404 });
    }
    const color = this.colorOf(game, playerId);
    if (color === null) {
      return new Response('not a player in this game', { status: 403 });
    }

    const pair = new WebSocketPair();
    const server = pair[1];

    // Tagged with the player id so a later message can find its own socket, and
    // attached with the identity because nothing survives in memory.
    this.ctx.acceptWebSocket(server, [playerId, color]);
    const attachment: SocketAttachment = { playerId, color };
    server.serializeAttachment(attachment);

    const now = Date.now();
    this.sql.exec(
      `UPDATE presence SET connected = 1, last_seen_at = ? WHERE player_id = ?`,
      now,
      playerId,
    );

    // Reconnecting inside the grace window means nothing was lost, so the pending
    // suspension is called off.
    if (this.allConnected()) await this.timers.cancel('disconnect');

    this.send(server, { t: 'state', game: this.snapshotFor(color) });
    this.broadcastState({ except: playerId });

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment === null) {
      // Should be impossible: every accepted socket is given one.
      ws.close(1011, 'no attachment');
      return;
    }

    if (typeof raw !== 'string') {
      this.send(ws, { t: 'error', code: 'bad_message', message: 'Binary frames are not used.' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.send(ws, { t: 'error', code: 'bad_message', message: 'Malformed JSON.' });
      return;
    }

    await this.handle(ws, attachment, parsed);
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.onDisconnect(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.onDisconnect(ws);
  }

  private async onDisconnect(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment === null) return;

    const now = Date.now();
    // A player may have more than one socket briefly, mid-reconnect, so only mark
    // them gone once none of their sockets remain.
    const remaining = this.ctx
      .getWebSockets(attachment.playerId)
      .filter((other) => other !== ws && other.readyState === WebSocket.OPEN);

    if (remaining.length > 0) return;

    this.sql.exec(
      `UPDATE presence SET connected = 0, last_seen_at = ? WHERE player_id = ?`,
      now,
      attachment.playerId,
    );

    const game = this.game();
    if (game !== null && game.status === 'active') {
      // Not suspended immediately: a dropped connection is a network or GPS
      // failure, not a decision, and someone walking behind a building should not
      // cost their opponent the walk back to their own back rank. The grace period
      // is a scheduled deadline, not a timer in memory.
      await this.timers.schedule('disconnect', now + DISCONNECT_GRACE_MS);
    }

    this.bumpRev();
    this.broadcastState();
  }

  // -------------------------------------------------------------------------
  // Message dispatch
  // -------------------------------------------------------------------------

  private async handle(ws: WebSocket, who: SocketAttachment, msg: unknown): Promise<void> {
    const t = (msg as { t?: unknown }).t;

    switch (t) {
      case 'sync':
        this.send(ws, { t: 'state', game: this.snapshotFor(who.color) });
        return;

      case 'pos':
        await this.onPos(who, msg as { lat: number; lng: number; acc: number; travelM?: number });
        return;

      case 'ready':
      case 'lift':
      case 'drop':
      case 'place':
      case 'resign':
      case 'draw':
      case 'pause':
        // Phase 4 (chess and the carry) and phase 5 (clock and suspension) fill
        // these in. Answering explicitly is better than silence, which would look
        // like a dropped message to a client standing in a field.
        this.send(ws, {
          t: 'error',
          code: 'bad_message',
          message: `"${t}" is not implemented yet. See harness/plan/04-chess.md.`,
        });
        return;

      default:
        this.send(ws, {
          t: 'error',
          code: 'bad_message',
          message: `Unknown message type ${JSON.stringify(t)}.`,
        });
    }
  }

  /**
   * Coarse opponent-position relay. Atmosphere, not correctness — it exists so
   * you can see your opponent jogging across the board.
   *
   * The client is supposed to send these only on meaningful movement and no more
   * than every couple of seconds. This re-checks, because a client that ignores
   * the policy would otherwise spend the whole account's request budget.
   */
  private async onPos(
    who: SocketAttachment,
    msg: { lat: number; lng: number; acc: number; travelM?: number },
  ): Promise<void> {
    if (
      !Number.isFinite(msg.lat) ||
      !Number.isFinite(msg.lng) ||
      !Number.isFinite(msg.acc) ||
      Math.abs(msg.lat) > 90 ||
      Math.abs(msg.lng) > 180
    ) {
      return;
    }

    const now = Date.now();
    const [row] = [...this.sql.exec<{ last_pos_at: number | null }>(
      `SELECT last_pos_at FROM presence WHERE player_id = ?`,
      who.playerId,
    )];
    if (row?.last_pos_at != null && now - row.last_pos_at < POS_SERVER_MIN_INTERVAL_MS) {
      return;
    }

    const game = this.game();
    const zone = game === null ? false : this.isInOwnStartZone(game, who.color, msg);

    this.sql.exec(
      `UPDATE presence
          SET last_lat = ?, last_lng = ?, last_acc = ?, last_pos_at = ?,
              last_seen_at = ?, in_start_zone = ?,
              travel_m = MAX(travel_m, ?)
        WHERE player_id = ?`,
      msg.lat,
      msg.lng,
      msg.acc,
      now,
      now,
      zone ? 1 : 0,
      // Monotonic: distance walked only ever increases, so a client that resets
      // or a stale message cannot reduce it.
      Number.isFinite(msg.travelM) ? Math.max(0, msg.travelM as number) : 0,
      who.playerId,
    );

    this.broadcast(
      { t: 'opp_pos', lat: msg.lat, lng: msg.lng, acc: msg.acc, at: now },
      { except: who.playerId },
    );
  }

  // -------------------------------------------------------------------------
  // Alarm
  // -------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    const now = Date.now();
    for (const kind of this.timers.claimDue(now)) {
      switch (kind) {
        case 'gc':
          await this.collect();
          return; // Nothing left to reschedule against.
        case 'disconnect':
          await this.suspendForDisconnect(now);
          break;
        case 'flag':
          // Phase 5. Deliberately not silently ignored — leaving a no-op here
          // would look deliberate later.
          break;
      }
    }
    await this.timers.sync();
  }

  /**
   * Freeze the game because someone has been gone too long.
   *
   * Both clocks stop. In over-the-board chess your clock runs regardless, but a
   * lost connection here is a failure rather than a choice.
   */
  private async suspendForDisconnect(now: number): Promise<void> {
    const game = this.game();
    if (game === null || game.status !== 'active') return;
    if (this.allConnected()) return;

    const clock = this.clockOf(game);
    const spent = clock.startedAt === null ? 0 : Math.max(0, now - clock.startedAt);
    const banked = Math.max(0, (clock.active === 'w' ? clock.whiteMs : clock.blackMs) - spent);

    this.sql.exec(
      clock.active === 'w'
        ? `UPDATE game SET white_ms_remaining = ?, last_clock_start_at = NULL, status = 'suspended', updated_at = ? WHERE id = 1`
        : `UPDATE game SET black_ms_remaining = ?, last_clock_start_at = NULL, status = 'suspended', updated_at = ? WHERE id = 1`,
      banked,
      now,
    );

    // No clock is running, so no flag can fall.
    await this.timers.cancel('flag');
    this.bumpRev();
    this.broadcastState();
  }

  /**
   * Delete everything, so the object stops taking up space and the join code is
   * free again.
   *
   * Re-applying the schema afterwards is not tidiness, it is required.
   * `deleteAll()` drops the tables, but this instance stays resident in memory, so
   * the next call would run `SELECT … FROM game` against a table that no longer
   * exists and fail with SQLITE_ERROR. Recreating the empty schema means every
   * read keeps working and simply finds no game.
   *
   * `ctx.abort()` would also solve it, by discarding the instance — but it breaks
   * the output gate for the request that called it, so the alarm invocation
   * itself fails. Recreating the schema is quieter.
   *
   * The cost is that a collected game leaves a single `meta` row rather than
   * literally zero bytes, so the object does not strictly "cease to exist". That
   * is a few dozen bytes against the 5 GB budget, and the thing garbage collection
   * is really for — abandoned games accumulating moves and position tracks — is
   * gone.
   */
  private async collect(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1001, 'game expired');
      } catch {
        // Already gone; nothing to do.
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    applySchema(this.sql);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  private game(): GameRow | null {
    const [row] = [...this.sql.exec<GameRow>(`SELECT * FROM game WHERE id = 1`)];
    return row ?? null;
  }

  private presence(): PresenceRow[] {
    return [...this.sql.exec<PresenceRow>(`SELECT * FROM presence`)];
  }

  private colorOf(game: GameRow, playerId: string): Color | null {
    if (game.white_player_id === playerId) return 'w';
    if (game.black_player_id === playerId) return 'b';
    return null;
  }

  private allConnected(): boolean {
    const game = this.game();
    if (game === null) return false;
    if (game.white_player_id === null || game.black_player_id === null) return false;
    const rows = this.presence();
    return rows.length === 2 && rows.every((row) => row.connected === 1);
  }

  private clockOf(game: GameRow): ClockState {
    return {
      whiteMs: game.white_ms_remaining,
      blackMs: game.black_ms_remaining,
      incrementMs: game.increment_ms,
      active: game.active_color,
      startedAt: game.last_clock_start_at,
    };
  }

  private fieldOf(game: GameRow): FieldSnapshot {
    return JSON.parse(game.field_snapshot_json) as FieldSnapshot;
  }

  private reachBonus(game: GameRow, color: Color): number {
    return color === 'w' ? game.white_reach_bonus_m : game.black_reach_bonus_m;
  }

  private isInOwnStartZone(
    game: GameRow,
    color: Color,
    pos: { lat: number; lng: number; acc: number },
  ): boolean {
    try {
      const geo = geometryFromSnapshot(this.fieldOf(game));
      return inStartZone(geo, pos, pos.acc, color, DEFAULT_REACH, this.reachBonus(game, color)).ok;
    } catch {
      // A malformed snapshot must not take the object down.
      return false;
    }
  }

  private setStatus(status: GameStatus): void {
    this.sql.exec(`UPDATE game SET status = ?, updated_at = ? WHERE id = 1`, status, Date.now());
  }

  private bumpRev(): void {
    this.sql.exec(`UPDATE game SET rev = rev + 1, updated_at = ? WHERE id = 1`, Date.now());
  }

  // -------------------------------------------------------------------------
  // Snapshots and sending
  // -------------------------------------------------------------------------

  /**
   * The full state, from one player's point of view.
   *
   * Sent on every change rather than a delta. Outbound messages are not billed,
   * so a delta protocol would be complexity in exchange for nothing — and a
   * client that reconnects mid-game gets correct state for free.
   */
  snapshotFor(you: Color): GameSnapshot {
    const game = this.game();
    if (game === null) throw new Error('snapshot requested before the game exists');

    const now = Date.now();
    const clock = this.clockOf(game);
    const rows = new Map(this.presence().map((row) => [row.color, row]));

    const [moveCount] = [...this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM moves`)];

    return {
      v: PROTOCOL_VERSION,
      rev: game.rev,
      joinCode: game.join_code,
      status: game.status,
      fen: game.fen,
      field: this.fieldOf(game),
      reach: DEFAULT_REACH,
      clock,
      serverNow: now,
      you,
      players: {
        w: this.playerView(game, 'w', rows.get('w')),
        b: this.playerView(game, 'b', rows.get('b')),
      },
      lastMove: null,
      moveCount: moveCount?.n ?? 0,
      carry: null,
      result:
        game.result_outcome === null
          ? null
          : {
              outcome: game.result_outcome as ResultOutcome,
              reason: game.result_reason as ResultReason,
              at: game.result_at ?? 0,
            },
      drawOfferFrom: game.draw_offer_from,
      createdAt: game.created_at,
    };
  }

  private playerView(game: GameRow, color: Color, row: PresenceRow | undefined): PlayerView | null {
    const playerId = color === 'w' ? game.white_player_id : game.black_player_id;
    if (playerId === null) return null;
    return {
      color,
      connected: row?.connected === 1,
      reachBonusM: this.reachBonus(game, color),
      travelM: row?.travel_m ?? 0,
      inStartZone: row?.in_start_zone === 1,
      lastSeenAt: row?.last_seen_at ?? null,
    };
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // The socket died between our reading it and writing to it. `webSocketClose`
      // will deal with presence; there is nothing useful to do here.
    }
  }

  private broadcastState(options: { except?: string } = {}): void {
    const game = this.game();
    if (game === null) return;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as SocketAttachment | null;
      if (attachment === null) continue;
      if (options.except !== undefined && attachment.playerId === options.except) continue;
      this.send(ws, { t: 'state', game: this.snapshotFor(attachment.color) });
    }
  }

  private broadcast(msg: ServerMsg, options: { except?: string } = {}): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as SocketAttachment | null;
      if (attachment === null) continue;
      if (options.except !== undefined && attachment.playerId === options.except) continue;
      this.send(ws, msg);
    }
  }

  // -------------------------------------------------------------------------
  // Read-only accessors used by the router and by tests
  // -------------------------------------------------------------------------

  /** Enough to render a join screen without opening a socket. */
  async peek(): Promise<{
    exists: boolean;
    status?: GameStatus;
    joinCode?: string;
    seatsFree?: number;
    field?: FieldSnapshot;
  }> {
    const game = this.game();
    if (game === null) return { exists: false };
    const seatsFree =
      (game.white_player_id === null ? 1 : 0) + (game.black_player_id === null ? 1 : 0);
    return {
      exists: true,
      status: game.status,
      joinCode: game.join_code,
      seatsFree,
      field: this.fieldOf(game),
    };
  }

  /** Both clocks as of now, for tests and for a client that has just woken. */
  async clocks(): Promise<{ w: number; b: number; running: boolean }> {
    const game = this.game();
    if (game === null) return { w: 0, b: 0, running: false };
    const clock = this.clockOf(game);
    return { ...clockSnapshot(clock, Date.now()), running: clock.startedAt !== null };
  }

  /** Milliseconds left for one colour, unclamped, so a test can see an overrun. */
  async remainingFor(color: Color): Promise<number> {
    const game = this.game();
    if (game === null) return 0;
    return remainingMs(this.clockOf(game), color, Date.now());
  }
}
