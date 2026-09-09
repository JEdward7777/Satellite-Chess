/**
 * The game index on the server side: moving one game between a
 * {@link GameIndexEntry} and a row in the account's `game_index` table
 * (stage 2.3.4).
 *
 * Split out of `user-do.ts` for the same reason `user-fields.ts` was — the
 * object is about storage and ordering, and this is about the shape of what is
 * stored — but the two files differ in one way worth saying out loud.
 *
 * ## Nothing on this path came from a phone
 *
 * `user-fields.ts` exists because a field arrives as JSON from a client that
 * may be a browser, a script, or somebody with `curl` and an opinion. An index
 * entry does not: it is written by `GameDO`, over an RPC binding, out of its own
 * SQLite row, and there is **no endpoint anywhere that lets a client write one**
 * (decision 0033). The API surface is a list and a delete.
 *
 * That is not a detail of the plumbing, it is the reason the index is worth
 * having. Stage 2.3.5 builds the permanent record over these rows, and a record
 * of results that the player could POST to themselves would be a record of what
 * they felt like claiming. Distance walked is already client-reported and
 * knowingly so (decision 0019, observation O-03); results are not, and this is
 * where that is kept true.
 *
 * So the functions here are a codec rather than a validator. The narrowing that
 * does happen — {@link asStatus}, {@link asColor}, {@link asOutcome} — is about
 * **reading rows back**, not about distrusting the writer: a row written by an
 * older version of this code outlives the version that wrote it, and a status
 * string nobody recognises must read as something rather than crash a list.
 */

import type { GameIndexEntry, GameIndexUpdate } from '../shared/game-index.js';
import type { GameStatus, ResultOutcome, ResultReason } from '../shared/protocol.js';
import type { Color } from '../shared/squares.js';

/**
 * How many games one account's index may hold.
 *
 * Not a quota on playing: it is the bound that stops the table growing without
 * anybody's consent, and it is set where a real person will never meet it. A
 * game costs both players a walk across a field, so a thousand of them is a
 * decade of Sundays.
 *
 * When it is reached, an **existing** row still updates — a full index must not
 * freeze the game you are actually playing — and only a new game is refused a
 * line. That failure is silent to the player by design: they are mid-game on a
 * field, and the thing that has gone wrong is that a list is long.
 */
export const MAX_GAMES_PER_ACCOUNT = 1000;

/** The field name is stored for the list line only; long ones are truncated. */
export const MAX_FIELD_NAME_CHARS = 120;

/** One row of `game_index`, exactly as the table spells it. */
export interface GameIndexRow {
  join_code: string;
  color: string;
  status: string;
  field_name: string | null;
  last_move_at: number | null;
  suspended_at: number | null;
  suspended_by: string | null;
  result_outcome: string | null;
  result_reason: string | null;
  result_at: number | null;
  joined_at: number;
  updated_at: number;
  [key: string]: SqlStorageValue;
}

/**
 * The columns of an upsert, in the order {@link bindValuesFor} supplies them.
 *
 * One list rather than eleven arguments spelled out at the call site, for the
 * same reason `FIELD_COLUMNS` is one list: positional parameters that have to be
 * kept in step by hand go out of step.
 */
export const GAME_INDEX_COLUMNS = [
  'join_code',
  'color',
  'status',
  'field_name',
  'last_move_at',
  'suspended_at',
  'suspended_by',
  'result_outcome',
  'result_reason',
  'result_at',
  'updated_at',
] as const;

/**
 * `joined_at` is not in that list, and that is the point of the list.
 *
 * The account stamps it once on insert and the upsert never touches it again,
 * so it is the one column the game does not get a say in — see
 * {@link GameIndexUpdate}.
 */
export function bindValuesFor(entry: GameIndexUpdate): SqlStorageValue[] {
  return [
    entry.joinCode,
    entry.color,
    entry.status,
    entry.fieldName === null ? null : [...entry.fieldName].slice(0, MAX_FIELD_NAME_CHARS).join(''),
    entry.lastMoveAt,
    entry.suspendedAt,
    entry.suspendedBy,
    entry.result?.outcome ?? null,
    entry.result?.reason ?? null,
    entry.result?.at ?? null,
    entry.updatedAt,
  ];
}

/** A row as the game that wrote it would recognise it. */
export function entryFromRow(row: GameIndexRow): GameIndexEntry {
  const outcome = asOutcome(row.result_outcome);
  return {
    joinCode: row.join_code,
    color: asColor(row.color),
    status: asStatus(row.status),
    fieldName: row.field_name,
    lastMoveAt: row.last_move_at,
    suspendedAt: row.suspended_at,
    suspendedBy: row.suspended_by === null ? null : asColor(row.suspended_by),
    result:
      outcome === null || row.result_at === null
        ? null
        : {
            outcome,
            // The reason is a label on a result that has already been decided, so
            // an unfamiliar one reads as "the game ended somehow" rather than
            // discarding the result it belongs to.
            reason: (row.result_reason ?? 'agreement') as ResultReason,
            at: row.result_at,
          },
    joinedAt: row.joined_at,
    updatedAt: row.updated_at,
  };
}

const STATUSES: readonly string[] = ['waiting', 'staging', 'active', 'suspended', 'finished'];

/**
 * A stored status, or `finished` for one this version does not know.
 *
 * `finished` rather than `waiting` deliberately: an unrecognised status is a row
 * from a future or a corrupted one, and the safe reading is "over", which shows
 * it in the list and makes it removable. Guessing "in play" would pin a row that
 * may be nothing at all in place for ever, since a game in play cannot be tidied
 * away.
 */
function asStatus(value: string): GameStatus {
  return (STATUSES.includes(value) ? value : 'finished') as GameStatus;
}

/** Black only where it says so. A colour is one character and cannot be repaired. */
function asColor(value: string): Color {
  return value === 'b' ? 'b' : 'w';
}

function asOutcome(value: string | null): ResultOutcome | null {
  return value === '1-0' || value === '0-1' || value === '1/2-1/2' ? value : null;
}

/**
 * A join code as it may be used to address a row.
 *
 * Deliberately not `normaliseJoinCode`: this is only ever matching a primary key
 * that the game itself wrote, so the question is "could this be one of ours?"
 * rather than "what did the player mean by this?". A caller that wants to
 * forgive a typed O for a 0 normalises first — `POST /api/games/forget` does.
 */
export function asJoinCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^[A-Za-z0-9]{4,12}$/.test(value) ? value : null;
}
