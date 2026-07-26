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
import { Chess, type Square } from 'chess.js';

import {
  type ClockState,
  applyMove,
  flagFallAt,
  flaggedColor,
  newClock,
  remainingMs,
  snapshot as clockSnapshot,
} from '../shared/clock.js';
import { type FieldSnapshot, geometryFromSnapshot } from '../shared/field.js';
import { DEFAULT_REACH, checkCarry, checkReachTo, inStartZone } from '../shared/reach.js';
import {
  DISCONNECT_GRACE_MS,
  type GameSnapshot,
  type GameStatus,
  PING,
  PONG,
  POS_SERVER_MIN_INTERVAL_MS,
  PROTOCOL_VERSION,
  FINISHED_GAME_TTL_MS,
  type PlayerView,
  type PosFix,
  type ResultOutcome,
  type ResultReason,
  type ServerMsg,
  UNCLAIMED_GAME_TTL_MS,
} from '../shared/protocol.js';
import { type Color, isSquare } from '../shared/squares.js';
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

interface CarryRow {
  color: Color;
  from_sq: string;
  piece: string;
  lift_lat: number;
  lift_lng: number;
  lift_acc: number;
  lift_at: number;
  [key: string]: SqlStorageValue;
}

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Validate a client-supplied fix. Everything from a client is untrusted. */
function asPosFix(value: unknown): PosFix | null {
  if (typeof value !== 'object' || value === null) return null;
  const fix = value as Record<string, unknown>;
  const lat = fix.lat;
  const lng = fix.lng;
  const acc = fix.acc;
  if (typeof lat !== 'number' || typeof lng !== 'number' || typeof acc !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(acc)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || acc < 0) return null;
  return { lat, lng, acc, ts: typeof fix.ts === 'number' ? fix.ts : 0 };
}

/**
 * Promotion is a pure UI choice with no travel involved, so anything unrecognised
 * becomes a queen rather than an error — that is what the player meant.
 */
function normalisePromotion(value: unknown): 'q' | 'r' | 'b' | 'n' {
  return value === 'r' || value === 'b' || value === 'n' ? value : 'q';
}

/**
 * Could `color` conceivably deliver mate with what is on the board?
 *
 * Used only for flag-fall: a lone king, or a king with a single bishop or knight,
 * cannot force mate, so an opponent running out of time draws rather than loses.
 * Deliberately the simple test rather than an exhaustive one — the rare
 * king-and-two-knights case is theoretically winnable and counts as material here,
 * which matches how the rule is usually applied.
 */
function hasMatingMaterial(chess: Chess, color: Color): boolean {
  let minors = 0;
  for (const row of chess.board()) {
    for (const square of row) {
      if (square === null || square.color !== color) continue;
      switch (square.type) {
        case 'k':
          break;
        case 'b':
        case 'n':
          minors += 1;
          break;
        default:
          // A pawn, rook or queen is always enough.
          return true;
      }
    }
  }
  return minors >= 2;
}

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
        await this.onReady(ws, who, msg as { pos: PosFix });
        return;

      case 'lift':
        await this.onLift(ws, who, msg as { from: string; pos: PosFix });
        return;

      case 'drop':
        await this.onDrop(ws, who);
        return;

      case 'place':
        await this.onPlace(ws, who, msg as { to: string; promotion?: string; pos: PosFix });
        return;

      case 'resign':
      case 'draw':
      case 'pause':
        // Phase 4's remaining stages. Answering explicitly is better than
        // silence, which would look like a dropped message to a client in a field.
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
  // The start and resume handshake (decision 0005)
  // -------------------------------------------------------------------------

  /**
   * "I am standing on my own back rank."
   *
   * Body position is part of the game state and cannot be serialised, so it is
   * reset rather than restored: both players return to their own back rank before
   * the clock starts. The same handshake opens a fresh game and resumes a
   * suspended one, so there is one code path and one rule to explain.
   *
   * The client only sends this when it believes it qualifies; the server checks
   * again, because the client is untrusted.
   */
  private async onReady(ws: WebSocket, who: SocketAttachment, msg: { pos: PosFix }): Promise<void> {
    const game = this.game();
    if (game === null) return;

    if (game.status !== 'staging' && game.status !== 'suspended') {
      this.send(ws, {
        t: 'error',
        code: 'not_active',
        message: `The game is ${game.status}; there is nothing to get ready for.`,
      });
      return;
    }

    const pos = asPosFix(msg?.pos);
    if (pos === null) {
      this.send(ws, { t: 'error', code: 'bad_message', message: 'A position fix is required.' });
      return;
    }

    const zone = this.startZoneCheck(game, who.color, pos);
    this.sql.exec(
      `UPDATE presence SET in_start_zone = ?, last_lat = ?, last_lng = ?, last_acc = ?,
              last_pos_at = ?, last_seen_at = ? WHERE player_id = ?`,
      zone.ok ? 1 : 0,
      pos.lat,
      pos.lng,
      pos.acc,
      Date.now(),
      Date.now(),
      who.playerId,
    );

    if (!zone.ok) {
      this.send(ws, {
        t: 'error',
        code: 'out_of_reach',
        message:
          `You are ${zone.nearestM.toFixed(0)} m from your back rank and your reach is ` +
          `${zone.reachM.toFixed(1)} m. Walk to your own end of the board.`,
      });
      this.bumpRev();
      this.broadcastState();
      return;
    }

    await this.startIfBothReady();
    this.bumpRev();
    this.broadcastState();
  }

  /** Start the clock once both players are connected and on their back ranks. */
  private async startIfBothReady(): Promise<void> {
    const game = this.game();
    if (game === null) return;
    if (game.status !== 'staging' && game.status !== 'suspended') return;
    if (!this.allConnected()) return;

    const rows = this.presence();
    if (rows.length !== 2 || !rows.every((row) => row.in_start_zone === 1)) return;

    const now = Date.now();
    this.sql.exec(
      `UPDATE game SET status = 'active', last_clock_start_at = ?, updated_at = ? WHERE id = 1`,
      now,
      now,
    );
    await this.armFlag();
  }

  /**
   * Point the flag deadline at the exact instant the active player expires.
   *
   * Re-armed after every move and after every resume, cleared whenever the clock
   * stops. Nothing polls; the alarm is the only mechanism, and it survives
   * hibernation.
   */
  private async armFlag(): Promise<void> {
    const game = this.game();
    if (game === null) return;
    const at = flagFallAt(this.clockOf(game));
    if (at === null) {
      await this.timers.cancel('flag');
      return;
    }
    await this.timers.schedule('flag', at);
  }

  // -------------------------------------------------------------------------
  // The carry: lift here, walk, place there (decision 0001)
  // -------------------------------------------------------------------------

  /**
   * Pick a piece up.
   *
   * Requires being within reach of its square *now*. The destination is checked
   * later, at the place, because requiring both ends at one instant would make
   * every long move physically impossible.
   */
  private async onLift(
    ws: WebSocket,
    who: SocketAttachment,
    msg: { from: string; pos: PosFix },
  ): Promise<void> {
    const game = this.game();
    if (game === null) return;

    if (game.status !== 'active') {
      this.send(ws, { t: 'error', code: 'not_active', message: `The game is ${game.status}.` });
      return;
    }
    if (game.active_color !== who.color) {
      this.send(ws, { t: 'error', code: 'not_your_turn', message: 'It is not your turn.' });
      return;
    }
    if (this.carry() !== null) {
      this.send(ws, {
        t: 'error',
        code: 'already_carrying',
        message: 'You are already carrying a piece.',
      });
      return;
    }

    const from = msg?.from;
    const pos = asPosFix(msg?.pos);
    if (!isSquare(from) || pos === null) {
      this.send(ws, { t: 'error', code: 'bad_message', message: 'A square and a fix are required.' });
      return;
    }

    const chess = new Chess(game.fen);
    const piece = chess.get(from as Square);
    if (!piece || piece.color !== who.color) {
      this.send(ws, {
        t: 'error',
        code: 'illegal_move',
        message: `There is no piece of yours on ${from}.`,
        move: { from },
      });
      return;
    }

    // Nothing is gained by letting someone carry a piece that cannot go anywhere,
    // and it would strand them mid-field having spent clock time.
    const destinations = chess
      .moves({ square: from as Square, verbose: true })
      .map((move) => move.to);
    if (destinations.length === 0) {
      this.send(ws, {
        t: 'error',
        code: 'no_legal_moves',
        message: `The piece on ${from} has no legal moves.`,
        move: { from },
      });
      return;
    }

    const verdict = checkReachTo(
      geometryFromSnapshot(this.fieldOf(game)),
      pos,
      pos.acc,
      from as Square,
      DEFAULT_REACH,
      this.reachBonus(game, who.color),
    );
    if (!verdict.ok) {
      this.send(ws, {
        t: 'error',
        code: verdict.code ?? 'out_of_reach',
        message: verdict.message ?? 'Out of reach.',
        move: { from },
      });
      return;
    }

    // Persisted, not held in memory: the walk may take a minute, during which the
    // object will hibernate.
    this.sql.exec(
      `INSERT OR REPLACE INTO carry
         (id, color, from_sq, piece, lift_lat, lift_lng, lift_acc, lift_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
      who.color,
      from,
      piece.type,
      pos.lat,
      pos.lng,
      pos.acc,
      Date.now(),
    );

    this.bumpRev();
    // Broadcast, so the opponent can see a queen coming for their king across the
    // field. That visibility is most of the tension the game has to offer.
    this.broadcastState();
  }

  /** Put it back. Free — the piece never moved, so it costs only clock time. */
  private async onDrop(ws: WebSocket, who: SocketAttachment): Promise<void> {
    const carry = this.carry();
    if (carry === null || carry.color !== who.color) {
      this.send(ws, { t: 'error', code: 'not_carrying', message: 'You are not carrying anything.' });
      return;
    }
    this.clearCarry();
    this.bumpRev();
    this.broadcastState();
  }

  /**
   * Put the carried piece down, completing the move.
   *
   * This is where the move is finally judged: reach to the destination now, a
   * physically possible walk since the lift, and legality according to chess.js —
   * which is the authority, whatever the client believed.
   */
  private async onPlace(
    ws: WebSocket,
    who: SocketAttachment,
    msg: { to: string; promotion?: string; pos: PosFix },
  ): Promise<void> {
    const game = this.game();
    if (game === null) return;

    if (game.status !== 'active') {
      this.send(ws, { t: 'error', code: 'not_active', message: `The game is ${game.status}.` });
      return;
    }
    const carry = this.carry();
    if (carry === null || carry.color !== who.color) {
      this.send(ws, { t: 'error', code: 'not_carrying', message: 'You are not carrying anything.' });
      return;
    }
    if (game.active_color !== who.color) {
      this.send(ws, { t: 'error', code: 'not_your_turn', message: 'It is not your turn.' });
      return;
    }

    const to = msg?.to;
    const pos = asPosFix(msg?.pos);
    if (!isSquare(to) || pos === null) {
      this.send(ws, { t: 'error', code: 'bad_message', message: 'A square and a fix are required.' });
      return;
    }

    const now = Date.now();

    // Chess legality first, and the order matters.
    //
    // Legality does not depend on where anyone is standing, so it is both the
    // cheaper check and the clearer one. Run the other way round, a player who
    // tries an illegal move quickly enough is told "your GPS jumped" — the carry
    // check sees a long walk in no time and cries `implausible`, which is a
    // baffling thing to read when the real problem is that bishops do not move
    // like that.
    //
    // The server's own rules engine decides. The client runs the same library for
    // instant highlighting, but its opinion is only a hint.
    const chess = new Chess(game.fen);
    let move;
    try {
      move = chess.move({
        from: carry.from_sq,
        to,
        promotion: normalisePromotion(msg?.promotion),
      });
    } catch {
      // chess.js 1.x throws on an illegal move where 0.x returned null. Catching
      // is not optional: an uncaught throw here would fault the object.
      this.send(ws, {
        t: 'error',
        code: 'illegal_move',
        message: `${carry.from_sq}–${to} is not a legal move.`,
        move: { from: carry.from_sq as Square, to: to as Square },
      });
      return;
    }

    const verdict = checkCarry(
      geometryFromSnapshot(this.fieldOf(game)),
      { pos: { lat: carry.lift_lat, lng: carry.lift_lng }, accuracyM: carry.lift_acc, at: carry.lift_at },
      { pos, accuracyM: pos.acc, at: now },
      carry.from_sq as Square,
      to as Square,
      DEFAULT_REACH,
      this.reachBonus(game, who.color),
    );
    if (!verdict.ok) {
      this.send(ws, {
        t: 'error',
        code: verdict.code ?? 'out_of_reach',
        message: verdict.message ?? 'Out of reach.',
        move: { from: carry.from_sq as Square, to: to as Square },
      });
      return;
    }

    const clockAfter = applyMove(this.clockOf(game), now);
    const [seqRow] = [...this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM moves`)];
    const seq = (seqRow?.n ?? 0) + 1;

    this.sql.exec(
      `INSERT INTO moves (
         seq, color, uci, san, fen_after, from_sq, to_sq,
         lift_lat, lift_lng, lift_acc, lift_at,
         place_lat, place_lng, place_acc, place_at,
         carried_m, carried_ms, server_ms, clock_ms_after
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      seq,
      who.color,
      move.lan,
      move.san,
      chess.fen(),
      move.from,
      move.to,
      carry.lift_lat,
      carry.lift_lng,
      carry.lift_acc,
      carry.lift_at,
      pos.lat,
      pos.lng,
      pos.acc,
      now,
      verdict.carriedM,
      verdict.carriedMs,
      now,
      who.color === 'w' ? clockAfter.whiteMs : clockAfter.blackMs,
    );

    this.sql.exec(
      `UPDATE game
          SET fen = ?, active_color = ?, white_ms_remaining = ?, black_ms_remaining = ?,
              last_clock_start_at = ?, draw_offer_from = NULL, updated_at = ?
        WHERE id = 1`,
      chess.fen(),
      clockAfter.active,
      clockAfter.whiteMs,
      clockAfter.blackMs,
      clockAfter.startedAt,
      now,
    );
    this.clearCarry();

    const ended = this.detectTerminal(chess, now);
    if (!ended) await this.armFlag();

    this.bumpRev();
    this.broadcastState();
  }

  /** Record a result if the position is terminal. Returns whether it did. */
  private detectTerminal(chess: Chess, now: number): boolean {
    let outcome: ResultOutcome | null = null;
    let reason: ResultReason | null = null;

    if (chess.isCheckmate()) {
      // chess.js reports whose turn it is *after* the move, and that side is mated.
      outcome = chess.turn() === 'w' ? '0-1' : '1-0';
      reason = 'checkmate';
    } else if (chess.isStalemate()) {
      outcome = '1/2-1/2';
      reason = 'stalemate';
    } else if (chess.isInsufficientMaterial()) {
      outcome = '1/2-1/2';
      reason = 'insufficient_material';
    } else if (chess.isThreefoldRepetition()) {
      outcome = '1/2-1/2';
      reason = 'threefold_repetition';
    } else if (chess.isDraw()) {
      // Whatever is left is the fifty-move rule.
      outcome = '1/2-1/2';
      reason = 'fifty_move_rule';
    }

    if (outcome === null || reason === null) return false;
    void this.finish(outcome, reason, now);
    return true;
  }

  private async finish(outcome: ResultOutcome, reason: ResultReason, now: number): Promise<void> {
    this.sql.exec(
      `UPDATE game
          SET status = 'finished', result_outcome = ?, result_reason = ?, result_at = ?,
              last_clock_start_at = NULL, updated_at = ?
        WHERE id = 1`,
      outcome,
      reason,
      now,
      now,
    );
    this.clearCarry();
    await this.timers.cancel('flag');
    await this.timers.cancel('disconnect');
    // Finished games are kept for review, then collected.
    await this.timers.schedule('gc', now + FINISHED_GAME_TTL_MS);
  }

  private carry(): CarryRow | null {
    const [row] = [...this.sql.exec<CarryRow>(`SELECT * FROM carry WHERE id = 1`)];
    return row ?? null;
  }

  private clearCarry(): void {
    this.sql.exec(`DELETE FROM carry WHERE id = 1`);
  }

  private startZoneCheck(
    game: GameRow,
    color: Color,
    pos: { lat: number; lng: number; acc: number },
  ): { ok: boolean; nearestM: number; reachM: number } {
    try {
      const geo = geometryFromSnapshot(this.fieldOf(game));
      return inStartZone(geo, pos, pos.acc, color, DEFAULT_REACH, this.reachBonus(game, color));
    } catch {
      return { ok: false, nearestM: Infinity, reachM: 0 };
    }
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
          await this.onFlagFall(now);
          break;
      }
    }
    await this.timers.sync();
  }

  /**
   * The active player's clock has run out.
   *
   * The alarm was set to the exact expiry instant, so this normally fires with
   * nothing left to check — but it re-derives the clock from stored timestamps
   * anyway, because the alarm may fire late, or against a game that has since
   * been suspended or finished.
   */
  private async onFlagFall(now: number): Promise<void> {
    const game = this.game();
    if (game === null || game.status !== 'active') return;

    const flagged = flaggedColor(this.clockOf(game), now);
    if (flagged === null) {
      // Fired early, or the clock moved on. Re-arm rather than ending a game that
      // still has time on it.
      await this.armFlag();
      return;
    }

    // A player who runs out of time but whose opponent could never deliver mate
    // draws rather than loses, as over the board.
    const winner: Color = flagged === 'w' ? 'b' : 'w';
    if (!hasMatingMaterial(new Chess(game.fen), winner)) {
      await this.finish('1/2-1/2', 'insufficient_material', now);
    } else {
      await this.finish(winner === 'w' ? '1-0' : '0-1', 'timeout', now);
    }

    this.bumpRev();
    this.broadcastState();
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

    // Decision 0009: a carried piece goes back. Body position is part of the
    // game state and cannot be serialised — whoever resumes will be standing
    // somewhere else, quite possibly nowhere near the square they lifted from.
    // Leaving the carry pending would mean resuming mid-move with no way to
    // finish it legally. The clock keeps what it spent; nothing is refunded.
    this.clearCarry();

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
      lastMove: this.lastMove(),
      moveCount: moveCount?.n ?? 0,
      carry: this.carryState(game),
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

  private lastMove(): GameSnapshot['lastMove'] {
    const [row] = [...this.sql.exec<{
      seq: number;
      from_sq: string;
      to_sq: string;
      san: string;
      color: Color;
      carried_m: number;
      [key: string]: SqlStorageValue;
    }>(`SELECT seq, from_sq, to_sq, san, color, carried_m FROM moves ORDER BY seq DESC LIMIT 1`)];
    if (row === undefined) return null;
    return {
      seq: row.seq,
      from: row.from_sq as Square,
      to: row.to_sq as Square,
      san: row.san,
      color: row.color,
      carriedM: row.carried_m,
    };
  }

  /**
   * The piece currently in someone's hand, with its legal destinations.
   *
   * Sent to both players: watching a queen being carried across the field towards
   * your king is most of the tension the game has to offer.
   */
  private carryState(game: GameRow): GameSnapshot['carry'] {
    const carry = this.carry();
    if (carry === null) return null;
    let destinations: Square[] = [];
    try {
      destinations = new Chess(game.fen)
        .moves({ square: carry.from_sq as Square, verbose: true })
        .map((move) => move.to);
    } catch {
      // A carry whose origin no longer holds a piece should be impossible, but
      // must not take the snapshot down.
    }
    return {
      color: carry.color,
      from: carry.from_sq as Square,
      piece: carry.piece,
      at: carry.lift_at,
      destinations,
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
