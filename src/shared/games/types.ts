/**
 * Which game is being played on the field, and what every game must say about
 * itself (decision 0056, O-57).
 *
 * Everything around the rules — calibrating a field, the carry, the clock, the
 * handshake, the record, the archive, the replay, the zoom — is the same
 * whatever is being played. What differs is behind three doors, one per
 * runtime and weight, so that a phone never downloads an engine:
 *
 * - **{@link GameDescriptor}**, here and in `shared/games/<game>.ts`: the
 *   game's name, its lattice, its start zones, its creation options, its
 *   record format, and its *position codec* — reading a position string and
 *   moving a piece the server has already called legal. Engine-free and a
 *   few hundred bytes, so both the Worker and the phone's main bundle hold
 *   every game's descriptor.
 * - **{@link GameRules}**, implemented in `worker/games/`: the descriptor plus
 *   the authority — legal moves, applying a move, how a game ends, and the
 *   game's record file. Only the server holds it (decision 0008), so chess.js
 *   never reaches a phone.
 * - **`GameArt`** (`client/games/types.ts`): the pieces as drawn and the
 *   record file's writer, fetched by the phone only when that game is shown.
 *
 * ## A move is a carry, and a carry may stop on the way
 *
 * Decision 0001 makes a move two acts separated by a walk: lift near the
 * origin, place near the destination. This generalises it to **lift, then
 * zero or more waypoints, then place**. A waypoint is "I am standing on the
 * square this piece hops through" — a checkers multi-jump walks each hop. Each
 * stop is judged for reach when it is made, and the walk between consecutive
 * stops for plausibility, exactly as the one walk of a chess move is.
 *
 * Chess never stops on the way: {@link NextStops.waypoints} is always empty
 * for it, so a chess carry is the two acts it always was.
 */

import type { ResultOutcome, ResultReason } from '../protocol.js';
import type { GameReport } from '../review.js';
import type { Color, Square } from '../squares.js';

/**
 * The games this build knows. A new game adds its name here, a descriptor in
 * `shared/games/catalog.ts`, rules in `worker/games/` and art in
 * `client/games/`.
 */
export type GameType = 'chess' | 'checkers';

/**
 * What a game with no type is (decision 0056). Every game created before game
 * types existed, every archive written before them, and every message that
 * leaves the field out are chess — "absent is chess" is the one back-compat
 * rule, used for storage, the archive and the wire alike.
 */
export const DEFAULT_GAME_TYPE: GameType = 'chess';

/** Every game this build knows, in the order a creation screen offers them. */
export const GAME_TYPES: readonly GameType[] = ['chess', 'checkers'];

/**
 * A stored or sent game type, read: absent (null, undefined, empty) is chess;
 * a name this build does not know is null, never quietly chess.
 */
export function parseGameType(value: unknown): GameType | null {
  if (value === null || value === undefined || value === '') return DEFAULT_GAME_TYPE;
  return typeof value === 'string' && (GAME_TYPES as readonly string[]).includes(value)
    ? (value as GameType)
    : null;
}

/**
 * The squares a game lays on the field (O-57: "a field is a calibrated
 * rectangle, and each game lays its own lattice on it").
 *
 * A field is calibrated once, as a rectangle, and is never re-calibrated to
 * play a different game. Each game says how many files and ranks it divides
 * that rectangle into and which of those squares are played on. Chess and
 * checkers are both 8 × 8, so the field's own geometry (`shared/field.ts`,
 * eight squares a side) is their lattice exactly; checkers plays only the dark
 * squares. A game on another lattice is the case decision 0056 leaves open:
 * see its "Revisit if".
 */
export interface Lattice {
  files: number;
  ranks: number;
  /** Whether a piece may ever stand on this square. */
  playable(file: number, rank: number): boolean;
}

/**
 * One creation setting a game offers (checkers: "jumps are required").
 * Chess has none. Every option is a switch with a default, so an absent
 * option always has an answer.
 */
export interface OptionSpec {
  key: string;
  kind: 'boolean';
  default: boolean;
  /** As the creation screen says it, in American English. */
  label: string;
}

/** A game's creation settings, as stored with the game and fixed for its life. */
export type GameOptions = Readonly<Record<string, boolean>>;

/** A piece as the board knows it: a type in the game's own letters, and a side. */
export interface PieceOn {
  /** Lower-case letter: `p`, `n`, `b`, `r`, `q`, `k` for chess. */
  type: string;
  color: Color;
}

/**
 * The squares a carry has stopped on so far: where the piece was lifted, and
 * each waypoint since, in order. A chess carry is always `via: []`.
 */
export interface CarryPath {
  from: Square;
  via: readonly Square[];
}

/**
 * Where a carried piece may stop next.
 *
 * `places` end the move; `waypoints` are landings the move continues from (a
 * hop of a multi-jump). A square may be in both where a game lets a player
 * choose to stop. Both empty means the piece cannot move, which the server
 * refuses at the lift rather than strand a player mid-field.
 */
export interface NextStops {
  waypoints: Square[];
  places: Square[];
}

/** A move the rules accepted, as it is stored. */
export interface PlayedMove {
  /** The position after the move, in the game's own position notation. */
  state: string;
  /**
   * The move in the game's record notation (SAN for chess, PDN for checkers).
   * Stored and sent as `san`, which is the wire and archive name for it.
   */
  notation: string;
  /**
   * The move in long algebraic form, stored as `uci`: chess's `e2e4`,
   * `e7e8q`; checkers names every square stood on, `c3e5g7` (decision 0057).
   */
  uci: string;
  from: Square;
  to: Square;
}

/** How a game ended by its own rules, or on the clock. */
export interface GameEnd {
  outcome: ResultOutcome;
  reason: ResultReason;
}

/** The record file a game leaves as (decision 0041): PGN, or PDN. */
export interface RecordFormat {
  /** `PGN` or `PDN`, as the screen names the file. */
  name: string;
  /** The file's extension, without the dot. */
  extension: string;
  /** What the server's download says it is. */
  mime: string;
}

/**
 * A choice made as the piece goes down, with no travel in it (a pawn's
 * promotion). The game asks for one only where it applies.
 */
export interface PlaceChoice {
  /** What travels on `place` as `promotion`. */
  type: string;
  /** The choice as a player reads it. */
  name: string;
}

/**
 * What both the Worker and the phone know about a game: metadata and the
 * engine-free position codec. Nothing here judges legality.
 */
export interface GameDescriptor {
  type: GameType;
  /** As a player reads it: "Chess". */
  name: string;
  lattice: Lattice;
  /**
   * The squares a player stands on for the start and resume handshake
   * (decision 0005): their own back rank, for chess and checkers.
   */
  startZone(color: Color): Square[];
  /** Whether a carry may stop on the way (decision 0056). False for chess. */
  waypoints: boolean;
  options: readonly OptionSpec[];
  record: RecordFormat;
  /** The position a new game starts from, in the game's position notation. */
  initialState(options: GameOptions): string;
  /** What stands on a square, read straight off the position string. */
  pieceAt(state: string, square: Square): PieceOn | null;
  /** Every piece on the board, by square. */
  piecesOf(state: string): Partial<Record<Square, PieceOn>>;
  /**
   * A move the server has already judged legal, applied to a position for
   * drawing only: the phone's prediction and the replay. Validates nothing.
   * `choice` is a place choice (`promotion` on the wire), or undefined.
   */
  applyKnown(state: string, path: CarryPath, to: Square, choice?: string): string;
  /** Every piece type the game has, in its own letters. */
  pieceTypes: readonly string[];
  /** Every choice a place can ask for, in the order a picker offers them. */
  choices: readonly PlaceChoice[];
  /**
   * Whether putting this carried piece down on `to` asks for one of
   * {@link choices}. Chess: a pawn reaching the far rank.
   */
  asksChoice(piece: PieceOn, to: Square): boolean;
  /** The place choice a stored move made (`e7e8q` → `q`), or undefined. */
  choiceOf(uci: string): string | undefined;
}

/**
 * The authority (decision 0008): everything the descriptor says, plus what
 * only the server may decide. Each method takes the stored position string and
 * returns a new one; nothing is held between calls, because the Durable
 * Object hibernates between every message.
 */
export interface GameRules extends GameDescriptor {
  /** A stored option set made whole: unknown keys dropped, absent ones defaulted. */
  normaliseOptions(raw: unknown): GameOptions;
  /**
   * Where the carried piece may stop next, given where it has stopped so far.
   * Asked at the lift (with `via: []`), after each waypoint, and for the
   * snapshot's destination dots.
   */
  stops(state: string, path: CarryPath, options: GameOptions): NextStops;
  /**
   * Play the move this carry ends with a place on `to`, or null if it is not
   * a legal move. Never throws.
   */
  play(
    state: string,
    path: CarryPath,
    to: Square,
    choice: string | undefined,
    options: GameOptions,
  ): PlayedMove | null;
  /** The result the position itself has reached, or null while play goes on. */
  ending(state: string, options: GameOptions): GameEnd | null;
  /**
   * The result when `flagged` runs out of time. Chess draws when the other
   * side could never mate; otherwise the other side wins on time.
   */
  timeout(state: string, flagged: Color): GameEnd;
  /** The game's record file (PGN, PDN), built from a report alone (decision 0041). */
  writeRecord(report: GameReport): string;
  /** What that file is called when it is downloaded. */
  recordFileName(report: Pick<GameReport, 'fieldName' | 'startedAt'>): string;
}
