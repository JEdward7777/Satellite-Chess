/**
 * The wire protocol between a phone and its GameDO.
 *
 * Request budget shapes this file more than anything else. On a hibernatable
 * Durable Object every *inbound* WebSocket message is billed as a request, and
 * the free plan allows 100k a day. Streaming 1 Hz GPS from two players for
 * thirty minutes would be ~3,600 requests for one game.
 *
 * So:
 * - Reach for the UI is computed on the client, at full GPS rate, for free.
 * - The server only needs a position at the instant a move is submitted, which
 *   is why `MoveMsg` carries one.
 * - Opponent position is relayed for atmosphere, not correctness, so it is
 *   sent only on meaningful movement and hard rate-limited.
 *
 * Outbound messages are not billed, so the server happily sends a full
 * snapshot on every change rather than maintaining a delta protocol.
 */

import type { FieldSnapshot } from './field.js';
import type { ClockState } from './clock.js';
import type { ReachConfig } from './reach.js';
import type { Color, Square } from './squares.js';

export const PROTOCOL_VERSION = 1;

/** Free keep-alive: the runtime answers these without waking the DO. */
export const PING = 'p';
export const PONG = 'P';

export type GameStatus =
  /** Created, waiting for a second player. */
  | 'waiting'
  /** Both players present, both walking to their back rank before the clock starts. */
  | 'staging'
  | 'active'
  /** Frozen: someone dropped, or a player asked for a break. */
  | 'suspended'
  | 'finished';

export type ResultOutcome = '1-0' | '0-1' | '1/2-1/2';

export type ResultReason =
  | 'checkmate'
  | 'resignation'
  | 'timeout'
  | 'stalemate'
  | 'insufficient_material'
  | 'threefold_repetition'
  | 'fifty_move_rule'
  | 'agreement'
  | 'abandoned';

export interface GameResult {
  outcome: ResultOutcome;
  reason: ResultReason;
  at: number;
}

/** A position fix as reported by a client. Never trusted for timing. */
export interface PosFix {
  lat: number;
  lng: number;
  /** Reported horizontal accuracy in metres. */
  acc: number;
  /** Client clock at the fix. Stored for review only — never used for rules. */
  ts: number;
}

export interface PlayerView {
  color: Color;
  connected: boolean;
  /** Handicap: extra metres of reach. */
  reachBonusM: number;
  /** Client-reported metres walked. A stat, so client-trusted by design. */
  travelM: number;
  /** In their own start zone, per the server's own check. */
  inStartZone: boolean;
  lastSeenAt: number | null;
}

export interface MoveRecord {
  seq: number;
  color: Color;
  uci: string;
  san: string;
  fenAfter: string;
  from: Square;
  to: Square;
  /** Server time the move was accepted. */
  at: number;
  /** Where the mover stood when they lifted the piece. */
  liftPos: PosFix | null;
  /** Where they stood when they put it down. */
  placePos: PosFix | null;
  /** Ground distance walked while carrying, in metres. */
  carriedM: number;
  /** Wall-clock duration of the carry. */
  carriedMs: number;
  /** Clock left for the mover immediately after their increment. */
  clockMsAfter: number;
}

/** A piece currently in someone's hand, mid-walk. */
export interface CarryState {
  color: Color;
  from: Square;
  /** Piece type, so the opponent can see what is coming for them. */
  piece: string;
  /** Server time of the lift. */
  at: number;
  /** Legal destinations for the carried piece. */
  destinations: Square[];
}

/** Everything a client needs to render the game. Sent on every change. */
export interface GameSnapshot {
  v: number;
  rev: number;
  joinCode: string;
  status: GameStatus;
  fen: string;
  field: FieldSnapshot;
  reach: ReachConfig;
  clock: ClockState;
  /** Server time at which this snapshot was built, for clock offset correction. */
  serverNow: number;
  /** The receiving player's colour. */
  you: Color;
  players: { w: PlayerView | null; b: PlayerView | null };
  lastMove: Pick<MoveRecord, 'seq' | 'from' | 'to' | 'san' | 'color' | 'carriedM'> | null;
  moveCount: number;
  /** Set while someone is walking with a piece in hand. */
  carry: CarryState | null;
  result: GameResult | null;
  /** Set when the opponent has offered a draw and it is still open. */
  drawOfferFrom: Color | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/**
 * Coarse opponent-position relay. Atmosphere, not correctness: it exists so you
 * can see your opponent jogging across the board. The client sends these only
 * when it has moved more than a couple of metres, and no more than once every
 * few seconds.
 */
export interface PosMsg {
  t: 'pos';
  lat: number;
  lng: number;
  acc: number;
  /** Cumulative metres walked, piggybacked so it costs no extra message. */
  travelM?: number;
}

/**
 * Pick a piece up. Must be within reach of `from` at this moment.
 *
 * A move is two acts separated by a walk: you lift here, carry the piece across
 * the field, and put it down there. The server records the lift so it can
 * validate the far end later, and so your opponent can see what you are
 * carrying — which is most of the tension in the game.
 */
export interface LiftMsg {
  t: 'lift';
  from: Square;
  pos: PosFix;
}

/** Put the carried piece back. Free; you only paid clock time. */
export interface DropMsg {
  t: 'drop';
}

/** Complete the move. Must be within reach of `to` at this moment. */
export interface PlaceMsg {
  t: 'place';
  to: Square;
  /** Only for promotions; a pure UI choice, no travel involved. */
  promotion?: 'q' | 'r' | 'b' | 'n';
  pos: PosFix;
}

/** "I am standing on my back rank" — for the start and resume handshakes. */
export interface ReadyMsg {
  t: 'ready';
  pos: PosFix;
}

export interface ResignMsg {
  t: 'resign';
}

export interface DrawMsg {
  t: 'draw';
  action: 'offer' | 'accept' | 'decline';
}

/** Ask for a break. Freezes both clocks; resuming needs the back-rank handshake. */
export interface PauseMsg {
  t: 'pause';
}

/** Full state, please — sent after a reconnect. */
export interface SyncMsg {
  t: 'sync';
}

export type ClientMsg =
  | PosMsg
  | LiftMsg
  | DropMsg
  | PlaceMsg
  | ReadyMsg
  | ResignMsg
  | DrawMsg
  | PauseMsg
  | SyncMsg;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export interface StateMsg {
  t: 'state';
  game: GameSnapshot;
}

export interface OppPosMsg {
  t: 'opp_pos';
  lat: number;
  lng: number;
  acc: number;
  /** Server receive time, so the client can age out a stale dot. */
  at: number;
}

export type ErrorCode =
  | 'not_your_turn'
  | 'illegal_move'
  | 'out_of_reach'
  | 'accuracy'
  | 'not_active'
  | 'game_full'
  | 'not_a_player'
  | 'bad_message'
  | 'no_draw_offer'
  | 'implausible'
  /** Tried to place without carrying anything, or lift while already carrying. */
  | 'not_carrying'
  | 'already_carrying'
  | 'no_legal_moves';

export interface ErrorMsg {
  t: 'error';
  code: ErrorCode;
  message: string;
  /** Echoes the rejected move so the client can un-highlight the right thing. */
  move?: { from?: Square; to?: Square };
}

export type ServerMsg = StateMsg | OppPosMsg | ErrorMsg;

// ---------------------------------------------------------------------------
// Client-side send policy (kept here so both ends agree on the numbers)
// ---------------------------------------------------------------------------

/** Don't relay a position until it has changed by at least this much. */
export const POS_MIN_DELTA_M = 2;
/** And never more often than this. */
export const POS_MIN_INTERVAL_MS = 2500;
/** Server-side backstop, in case a client ignores the policy above. */
export const POS_SERVER_MIN_INTERVAL_MS = 1500;
/** How long a player may be gone before the game suspends and clocks freeze. */
export const DISCONNECT_GRACE_MS = 20_000;
/** Unjoined games evaporate, so stale join codes don't linger. */
export const UNCLAIMED_GAME_TTL_MS = 30 * 60_000;
/** Finished and abandoned games are garbage-collected on an alarm. */
export const FINISHED_GAME_TTL_MS = 30 * 24 * 3600_000;
export const ABANDONED_GAME_TTL_MS = 14 * 24 * 3600_000;

export function isClientMsg(x: unknown): x is ClientMsg {
  return typeof x === 'object' && x !== null && typeof (x as { t?: unknown }).t === 'string';
}
