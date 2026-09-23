/**
 * What one game looks like once it is over (stages 8.1, 8.2).
 *
 * The `moves` table has stored both position fixes of every move since stage
 * 4.1.4 — a move is a lift, a walk and a place (decision 0001), so there is no
 * single "position of a move" — and this is the shape that data is read back
 * in. One structure serves three readers, which is why it is here rather than
 * inside either of them:
 *
 * - the **PGN** (`shared/pgn.ts`), which is this report rendered as a file any
 *   chess program can open;
 * - the **post-game screen** (`client/views/review.ts`), which is the same
 *   report read as "you covered 2.4 km";
 * - and, later, **stage 8.4**, which archives a finished game to KV and deletes
 *   the Durable Object. It will build its PGN from a report exactly like this
 *   one, out of the same stored rows, which is why nothing here is derived from
 *   anything that only exists while a game is live.
 *
 * ## Positions are in board space, and there are no coordinates anywhere
 *
 * A latitude and a longitude say where somebody was standing; a file and a rank
 * say where they were on the board. This report carries the second and never the
 * first (decision 0041). The board has no anchor in it, so a report — and
 * therefore a PGN — is unlocatable by construction, which is the same rule
 * decision 0018 sets for the share card and the same reason the permanent record
 * holds no coordinates (decision 0040). The game itself keeps the fixes; a file
 * that travels does not.
 */

import type { ResultOutcome, ResultReason } from './protocol.js';
import type { Color } from './squares.js';

/**
 * Where a player stood, in squares from the center of a1.
 *
 * Fractional and signed: `{ file: 4.2, rank: -0.4 }` is a little past the middle
 * of e1 and a little way off the back edge of the board. **Not metric** — on a
 * board that is not square a step along a file and a step along a rank are
 * different distances (`BoardIndex` in `shared/field.ts` says why) — so nothing
 * here may be fed to a distance function. The distances in this report were all
 * measured on the ground before they were put in it.
 */
export interface ReportPosition {
  file: number;
  rank: number;
  /** Accuracy the phone claimed for the fix, in meters. */
  accuracyM: number;
}

/** One ply, with the walk that carried it. */
export interface ReportMove {
  /** Ply number, from 1. */
  seq: number;
  color: Color;
  san: string;
  uci: string;
  from: string;
  to: string;
  /** Ground distance walked while carrying the piece, in meters. */
  carriedM: number;
  /** How long the piece was in hand. */
  carriedMs: number;
  /** Where the mover stood to lift, or null for a move with no fix stored. */
  lift: ReportPosition | null;
  place: ReportPosition | null;
}

/**
 * One game, as everything after it reads it.
 *
 * Built by `GameDO` out of stored columns only, so it says the same thing
 * however often it is asked and whether or not anybody is still connected.
 */
export interface GameReport {
  joinCode: string;
  /** The name a player gave the field, or null for one nobody named. */
  fieldName: string | null;
  /** When the game was created. */
  startedAt: number;
  /** When it ended, or null while it is still going. */
  finishedAt: number | null;
  outcome: ResultOutcome | null;
  reason: ResultReason | null;
  /**
   * The time control, as the game was created with it.
   *
   * `initialMs` is null for a game created before it was stored in its own
   * column (schema 5): the clock columns hold what is *left*, so once a move
   * has been played there is nothing left to read it off. The PGN writes the
   * standard's `TimeControl "?"` rather than a figure nobody measured.
   */
  initialMs: number | null;
  incrementMs: number;
  /** The narrowest square, in meters — the one that decides a practice game. */
  squareM: number;
  /** Across the board, the longer side. */
  boardM: number;
  /** Corner to corner: the denominator of board crossings (decision 0019). */
  diagonalM: number;
  /**
   * Meters each player walked while the game was active, as their phone
   * measured it and the game credited it (decision 0040).
   *
   * **Null means nobody measured it**, and is not the same as zero — a game
   * already in play when the per-game rule arrived has only the phone's whole
   * counter, which is not a distance walked in this game. The screen and the
   * PGN both leave the number out rather than inventing one.
   */
  travelM: Record<Color, number | null>;
  /** Every completed move, in order. */
  moves: ReportMove[];
}

/** One player's walk, folded out of a report. */
export interface PlayerWalk {
  color: Color;
  /** Null where nobody measured it — see {@link GameReport.travelM}. */
  travelM: number | null;
  /** Moves this player made. */
  moves: number;
  /** The longest single carry, lift to place. */
  longestCarryM: number;
  /**
   * Meters walked ÷ the board's diagonal, or null where the distance is
   * unmeasured. The field-independent answer to "how much chess was that?"
   * (decision 0019).
   */
  crossings: number | null;
}

/**
 * The distance a player walked in one game: what their phone counted, but
 * never less than the carries the game measured for them (decision 0041).
 *
 * The phone's count runs short on stop-and-start walking (O-38), and a carry
 * is a straight line between the lift and place fixes — a lower bound on the
 * walk it is part of. Without this floor a one-move game could read "You
 * covered 0 m" above "carried 16 m", on the screen, in the PGN and in the
 * record alike. **The larger of the two, never their sum**: the carries are
 * inside the walk, not beside it.
 *
 * This is about the numbers agreeing, not about cheating. The fixes a carry is
 * measured between come from the same phone (O-03 stands).
 *
 * Null stays null. A game nobody measured (decision 0040, rule 7) is not given
 * a figure made of its carries alone: that would be a number, and the honest
 * answer is that there is none.
 */
export function flooredTravelM(travelM: number | null, carriedSumM: number): number | null {
  if (travelM === null) return null;
  return Math.max(positive(travelM), positive(carriedSumM));
}

/**
 * Each color's carries, summed — the floor {@link flooredTravelM} takes.
 *
 * One function for every reader, because the record line (`GameDO.recordLine`)
 * and the report (`GameDO.buildReport`, then {@link walkOf}) must floor by the
 * same number to the last bit, or the record and the screen disagree about
 * the same game. A carry that is not a positive finite number is not a carry.
 */
export function carriedByColor(
  moves: readonly { color: Color; carriedM: number }[],
): Record<Color, number> {
  const sum: Record<Color, number> = { w: 0, b: 0 };
  for (const move of moves) sum[move.color] += positive(move.carriedM);
  return sum;
}

export function walkOf(report: GameReport, color: Color): PlayerWalk {
  let moves = 0;
  let longestCarryM = 0;
  for (const move of report.moves) {
    if (move.color !== color) continue;
    moves += 1;
    longestCarryM = Math.max(longestCarryM, positive(move.carriedM));
  }
  // Already floored by the game that built the report; applied again so a
  // report from anywhere else reads the same way. The larger of two numbers is
  // the same however often it is taken.
  const travelM = flooredTravelM(report.travelM[color], carriedByColor(report.moves)[color]);
  return {
    color,
    travelM,
    moves,
    longestCarryM,
    crossings:
      travelM === null || !(report.diagonalM > 0) ? null : positive(travelM) / report.diagonalM,
  };
}

/** Both walks, the reader's first. */
export function walksOf(report: GameReport, you: Color | null): PlayerWalk[] {
  const order: Color[] = you === 'b' ? ['b', 'w'] : ['w', 'b'];
  return order.map((color) => walkOf(report, color));
}

/** A stored number, or zero for one that is not a distance at all. */
function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
