/**
 * The permanent record: what a player has done, added up (stage 2.3.5).
 *
 * This is the reason accounts are mandatory at all (decision 0014), so it is a
 * first-class feature rather than a stats footnote — and its shape is set by
 * decision 0019, which is worth reading before changing anything here.
 *
 * - **Meters walked is the headline.** Games played never is: a count that does
 *   not scale with the field rewards shrinking the field, and small fields are
 *   exactly where GPS makes the game worst.
 * - **Board crossings** — meters walked ÷ the board's diagonal — sits beside it
 *   as the field-independent answer to "how much chess have I played?".
 * - **Games, results and moves** are recorded and shown, but never lead.
 *
 * ## One line per finished game, and totals are always derived
 *
 * The account holds one {@link RecordGame} per finished game, keyed by join
 * code, written by `GameDO` and by nothing else (decision 0033's rule, carried
 * over — see decision 0040). Totals are **never stored**: they are folded out of
 * those lines on every read, by {@link summarizeRecord}. That is what makes the
 * push from the game idempotent for free. A game reported twice — an alarm
 * retried, a seat re-taken — overwrites its own line with the same facts, and a
 * sum over lines cannot count it twice. A running total incremented on arrival
 * would need exactly-once delivery across two Durable Objects to stay honest,
 * and there is no such thing.
 *
 * It also means a rule can change after the fact. Which games count is decided
 * here, at read time, from stored facts rather than from a flag written when
 * the game ended — so when stage 9.2 moves the small-square floor, every game
 * ever played is re-judged by the new one, rather than half the record being
 * judged by each.
 *
 * ## No coordinates, anywhere in it
 *
 * A line carries a field's *name* and its *lineage key* — never a latitude or a
 * longitude. The record is player → fields (decision 0017) and it is private to
 * the player, but it still has no business being a list of where somebody has
 * stood. The game itself keeps the positions; the record keeps what they added
 * up to.
 */

import { SMALL_SQUARE_M } from './field.js';
import type { ResultOutcome, ResultReason } from './protocol.js';
import type { Color } from './squares.js';

/**
 * One finished game, as the account of one of its players holds it.
 *
 * Everything the record can ever say about a game has to be here, because the
 * game it came from may not exist later — stage 8.4 archives a finished game to
 * KV and deletes the Durable Object, and this line must survive that intact.
 */
export interface RecordGame {
  /** The join code, and this line's key: one line per game, however often sent. */
  joinCode: string;
  /** Which side this account played. */
  color: Color;
  outcome: ResultOutcome;
  reason: ResultReason;
  finishedAt: number;
  /** Moves by both sides. Zero means nobody moved: see {@link standingOf}. */
  plies: number;
  /** Moves by this player. */
  moves: number;
  /**
   * Meters this player walked while the game was being played, as their phone
   * measured it. Client-reported, and so client-trusted (observation O-03) —
   * the one soft number in a record whose other facts come from the server.
   *
   * **Null means nobody measured it**, and is not the same as zero. A game
   * played before the per-game distance rule (2.3.5.3) has only the old
   * figure, which was the phone's whole counter — the calibration walk, the
   * walk to the park, the last game — and that is not a distance walked in
   * *this* game. Rather than invent a zero or delete the game, the row says so
   * and the game sits outside every total (see {@link standingOf}).
   */
  travelM: number | null;
  /** The longest single carry this player made, lift to place, in meters. */
  longestCarryM: number;
  /** The field's name when the game began. A player wrote it; nothing derived it. */
  fieldName: string | null;
  /** The field's lineage key, so copies of one common count as one field. */
  fieldKey: string | null;
  /** The narrowest square, in meters — the one that decides practice. */
  squareM: number;
  /** Across the board, the longer side — what "a 64 m board" means. */
  boardM: number;
  /** Corner to corner, the denominator of board crossings. */
  diagonalM: number;
}

/**
 * How a finished game stands in the record.
 *
 * - `counted` — in every total.
 * - `practice` — squares under {@link SMALL_SQUARE_M} (stage 2.3.5.2). It
 *   still played, and it still shows in the player's own history; it is left out
 *   of every total because GPS cannot reliably tell those squares apart, and a
 *   record that counted fifty back-garden games as fifty games would be lying
 *   (decision 0019). Excluded rather than discounted: a multiplier is an
 *   argument, a floor is a rule.
 * - `unplayed` — finished with no move made by either side: resigned, agreed
 *   or claimed before anybody lifted a piece. No chess happened, so there is
 *   nothing to count; it is listed so that the player can see where it went.
 * - `unmeasured` — nobody measured the walking. Only games that were already
 *   being played when the per-game distance rule arrived (2.3.5.3) are in this
 *   state, and there will never be more of them. Checked first, because a game
 *   whose distance is unknown cannot be in a total whose headline *is* the
 *   distance, whatever else is true about it.
 */
export type RecordStanding = 'counted' | 'practice' | 'unplayed' | 'unmeasured';

export function standingOf(
  game: Pick<RecordGame, 'plies' | 'squareM' | 'travelM'>,
): RecordStanding {
  if (game.travelM === null) return 'unmeasured';
  if (game.plies <= 0) return 'unplayed';
  if (game.squareM < SMALL_SQUARE_M) return 'practice';
  return 'counted';
}

/** A result from one side of the board. */
export type PersonalResult = 'win' | 'loss' | 'draw';

export function personalResult(outcome: ResultOutcome, color: Color): PersonalResult {
  if (outcome === '1/2-1/2') return 'draw';
  return (outcome === '1-0') === (color === 'w') ? 'win' : 'loss';
}

/** One field, as the player's own history on it. */
export interface RecordField {
  name: string | null;
  key: string;
  games: number;
  travelM: number;
}

/** One line of the history the record screen lists. */
export interface RecordLine {
  joinCode: string;
  result: PersonalResult;
  reason: ResultReason;
  standing: RecordStanding;
  finishedAt: number;
  fieldName: string | null;
  /** Null where nobody measured it — see {@link RecordGame.travelM}. */
  travelM: number | null;
  squareM: number;
}

/** Everything the record screen shows. */
export interface RecordSummary {
  /** Totals over `counted` games only. */
  totals: {
    travelM: number;
    /** Meters walked ÷ board diagonal, summed game by game. */
    crossings: number;
    games: number;
    wins: number;
    draws: number;
    losses: number;
    /** This player's moves. */
    moves: number;
    longestCarryM: number;
    /** The biggest board, with the name the player gave it. */
    biggestBoard: { boardM: number; fieldName: string | null } | null;
    /** Distinct fields, by lineage. */
    fields: number;
  };
  practiceGames: number;
  unplayedGames: number;
  /** Games from before the per-game distance rule. A closed set (2.3.5.3). */
  unmeasuredGames: number;
  /** Fields by meters walked on them, most first, at most {@link TOP_FIELDS}. */
  fields: RecordField[];
  /** Newest first, at most {@link RECENT_LINES}, every standing included. */
  recent: RecordLine[];
  /** The floor that decided `practice`, so the screen can name it. */
  smallSquareM: number;
}

export const TOP_FIELDS = 5;
export const RECENT_LINES = 10;

/**
 * Fold every line of an account's record into what the screen shows.
 *
 * Runs in the Worker over the whole table on each read. A thousand games is a
 * decade of Sundays and folds in well under a millisecond, and doing it there
 * means the phone downloads a summary rather than the record — it asks from a
 * field, on one bar.
 */
export function summarizeRecord(games: readonly RecordGame[]): RecordSummary {
  const totals: RecordSummary['totals'] = {
    travelM: 0,
    crossings: 0,
    games: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    moves: 0,
    longestCarryM: 0,
    biggestBoard: null,
    fields: 0,
  };
  let practiceGames = 0;
  let unplayedGames = 0;
  let unmeasuredGames = 0;
  const fields = new Map<string, RecordField>();

  for (const game of games) {
    const standing = standingOf(game);
    if (standing === 'practice') practiceGames += 1;
    if (standing === 'unplayed') unplayedGames += 1;
    if (standing === 'unmeasured') unmeasuredGames += 1;
    if (standing !== 'counted') continue;

    const travelM = safeMeters(game.travelM);
    totals.games += 1;
    totals.travelM += travelM;
    if (game.diagonalM > 0) totals.crossings += travelM / game.diagonalM;
    totals.moves += Math.max(0, game.moves);
    totals.longestCarryM = Math.max(totals.longestCarryM, safeMeters(game.longestCarryM));
    const result = personalResult(game.outcome, game.color);
    if (result === 'win') totals.wins += 1;
    else if (result === 'loss') totals.losses += 1;
    else totals.draws += 1;
    if (totals.biggestBoard === null || game.boardM > totals.biggestBoard.boardM) {
      totals.biggestBoard = { boardM: game.boardM, fieldName: game.fieldName };
    }

    // A game with no key still happened somewhere; it counts as a field of its
    // own rather than vanishing from "fields played on".
    const key = game.fieldKey ?? `game:${game.joinCode}`;
    const field = fields.get(key) ?? { name: game.fieldName, key, games: 0, travelM: 0 };
    field.games += 1;
    field.travelM += travelM;
    fields.set(key, field);
  }
  totals.fields = fields.size;

  const recent = [...games]
    .sort((a, b) => b.finishedAt - a.finishedAt)
    .slice(0, RECENT_LINES)
    .map(
      (game): RecordLine => ({
        joinCode: game.joinCode,
        result: personalResult(game.outcome, game.color),
        reason: game.reason,
        standing: standingOf(game),
        finishedAt: game.finishedAt,
        fieldName: game.fieldName,
        travelM: game.travelM === null ? null : safeMeters(game.travelM),
        squareM: game.squareM,
      }),
    );

  return {
    totals,
    practiceGames,
    unplayedGames,
    unmeasuredGames,
    fields: [...fields.values()]
      .sort((a, b) => b.travelM - a.travelM || b.games - a.games)
      .slice(0, TOP_FIELDS),
    recent,
    smallSquareM: SMALL_SQUARE_M,
  };
}

/** A stored distance, or zero for one that is not a distance at all. */
function safeMeters(value: number | null): number {
  return value !== null && Number.isFinite(value) && value > 0 ? value : 0;
}
