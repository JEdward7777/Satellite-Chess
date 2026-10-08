/**
 * The permanent record on the server side: one finished game between a
 * {@link RecordGame} and a row of the account's `record` table (stage 2.3.5).
 *
 * The same shape as `user-games.ts`, and for the same reason it is a codec
 * rather than a validator: nothing on this path came from a phone. A record row
 * is written by `GameDO`, over the `USER` binding, out of its own tables, and
 * there is no endpoint that lets a client write one (decision 0040, carrying
 * 0033's rule over). The narrowing below is about reading back rows written by
 * an older version of this code, and about never storing a number that is not
 * a number.
 */

import type { ResultOutcome, ResultReason } from '../shared/protocol.js';
import { isPairId } from '../shared/head-to-head.js';
import type { RecordGame } from '../shared/record.js';
import type { Color } from '../shared/squares.js';
import { MAX_FIELD_NAME_CHARS } from './user-games.js';

/**
 * How many finished games one account's record may hold.
 *
 * Ten times the game index's bound, because the index is a list the player can
 * tidy and this is not: it is the one table here that only ever grows. Set where
 * nobody will meet it — ten thousand games is several lifetimes of Sundays —
 * and, as with the index, a game already recorded still updates once it is
 * reached, and only a new one is refused.
 */
export const MAX_RECORD_GAMES = 10_000;

/** One row of `record`, exactly as the table spells it. */
export interface RecordRow {
  join_code: string;
  color: string;
  outcome: string;
  reason: string;
  finished_at: number;
  plies: number;
  moves: number;
  travel_m: number | null;
  longest_carry_m: number;
  field_name: string | null;
  field_key: string | null;
  square_m: number;
  board_m: number;
  diagonal_m: number;
  recorded_at: number;
  /** Schema 4; null on a row written before it. */
  pair_id: string | null;
  opponent_travel_m: number | null;
  [key: string]: SqlStorageValue;
}

/** The columns of an upsert, in the order {@link bindValuesFor} supplies them. */
export const RECORD_COLUMNS = [
  'join_code',
  'color',
  'outcome',
  'reason',
  'finished_at',
  'plies',
  'moves',
  'travel_m',
  'longest_carry_m',
  'field_name',
  'field_key',
  'square_m',
  'board_m',
  'diagonal_m',
  'pair_id',
  'opponent_travel_m',
] as const;

export function bindValuesFor(game: RecordGame): SqlStorageValue[] {
  return [
    game.joinCode,
    game.color === 'b' ? 'b' : 'w',
    game.outcome,
    game.reason,
    Math.floor(game.finishedAt),
    count(game.plies),
    count(game.moves),
    // Null travels through: nobody measured this game's walking, which is a
    // different thing from having walked nowhere (decision 0040).
    game.travelM === null ? null : meters(game.travelM),
    meters(game.longestCarryM),
    game.fieldName === null ? null : [...game.fieldName].slice(0, MAX_FIELD_NAME_CHARS).join(''),
    game.fieldKey,
    meters(game.squareM),
    meters(game.boardM),
    meters(game.diagonalM),
    isPairId(game.pairId) ? game.pairId : null,
    game.opponentTravelM === null || game.opponentTravelM === undefined ? null : meters(game.opponentTravelM),
  ];
}

export function gameFromRow(row: RecordRow): RecordGame {
  return {
    joinCode: row.join_code,
    color: (row.color === 'b' ? 'b' : 'w') as Color,
    outcome: asOutcome(row.outcome),
    // A label on a result already decided; an unfamiliar one is still a result.
    reason: row.reason as ResultReason,
    finishedAt: row.finished_at,
    plies: row.plies,
    moves: row.moves,
    travelM: row.travel_m,
    longestCarryM: row.longest_carry_m,
    fieldName: row.field_name,
    fieldKey: row.field_key,
    squareM: row.square_m,
    boardM: row.board_m,
    diagonalM: row.diagonal_m,
    pairId: isPairId(row.pair_id) ? row.pair_id : null,
    opponentTravelM: row.opponent_travel_m ?? null,
  };
}

/**
 * The head-to-head key for two accounts (stage 8.5.4, decision 0054).
 *
 * A SHA-256 over both `sub`s, sorted so that either seat computes the same
 * value, under a label of its own, cut to 128 bits. It is what lets each
 * player's record group *their own* rows by opponent, and lets both players'
 * records agree on which games were between them, without either row naming
 * the other account.
 *
 * - **Pairwise, never per player.** A per-player id would be the same in
 *   every opponent's record, so two people comparing notes could learn they
 *   had both played the same third person. A pair id appears only in the
 *   records of the two people it is about.
 * - **Not a secret, and not meant to be one.** A `sub` is not secret
 *   (decision 0042), so someone holding two of them could compute the pair
 *   id. The id is only ever stored in, and shown to, the two players it
 *   names; nothing anywhere can be *asked* by pair id except the reader's own
 *   record, which is the protection. An HMAC would add a key whose rotation
 *   would split every head-to-head record in two.
 * - **Null for a game with one account in it**, or the same account twice,
 *   which has no opponent to keep a record against.
 */
export async function pairIdFor(white: string | null, black: string | null): Promise<string | null> {
  if (white === null || black === null || white === '' || black === '' || white === black) return null;
  const [first, second] = white < black ? [white, black] : [black, white];
  const bytes = new TextEncoder().encode(`satellite-chess/head-to-head/v1\n${first}\n${second}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A stored outcome, or a draw for one this version does not recognise.
 *
 * A draw because it is the reading that credits nobody with a win they may not
 * have had; the game still counts, and so do the meters walked in it.
 */
function asOutcome(value: string): ResultOutcome {
  return value === '1-0' || value === '0-1' ? value : '1/2-1/2';
}

function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function meters(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
