/**
 * The head-to-head record: what two players have done against each other
 * (stage 8.5.4, decision 0054).
 *
 * Decision 0018 calls this the richest social surface there is without the
 * location hazard, because the only person it describes you to is somebody
 * who was standing on the same field for every game in it. The shape follows
 * from that, and from the record it is folded out of (decision 0040):
 *
 * - **It is read from the player's own record rows, and from nothing else.**
 *   Each row of a game played since 0054 carries a *pair id*: a digest of the
 *   two players' accounts, the same in both players' records and different
 *   for every pair. Grouping one's own rows by it is the whole of "who did I
 *   play". No row names the other account, nothing here can be asked about
 *   anybody but the reader, and there is no table anywhere that lists who
 *   played whom.
 * - **Both players see the same tally, by construction.** Each of the two
 *   rows for a game is built by the same `GameDO` from the same stored
 *   columns, and each carries *both* distances, so the games, the meters
 *   walked between them and the counts agree, with the wins and losses the
 *   other way round. Nothing is stored once and shared: a shared copy would
 *   be a second source of truth, and a place for one player to read the other.
 * - **Meters come first; games never lead** (decision 0019). The headline is
 *   the distance the two of them walked in their games together.
 * - **Totals are folded on read**, so a game reported twice is one row and is
 *   counted once, exactly as in the record.
 * - **Rows from before 0054 hold no opponent**, and stay out of it: they are
 *   counted, so the screen can say how many, and never guessed at.
 */

import { SMALL_SQUARE_M } from './field.js';
import {
  type PersonalResult,
  type RecordGame,
  type RecordStanding,
  personalResult,
} from './record.js';
import type { ResultReason } from './protocol.js';

/** What a pair id looks like: 128 bits of a SHA-256, in lower-case hex. */
export const PAIR_ID_PATTERN = /^[0-9a-f]{32}$/;

export function isPairId(value: unknown): value is string {
  return typeof value === 'string' && PAIR_ID_PATTERN.test(value);
}

/**
 * The longest name a player may give an opponent. A nickname, not a
 * biography; long enough for "Sam from the Tuesday club".
 */
export const MAX_OPPONENT_NAME_CHARS = 40;

/**
 * A name as a player typed it, made safe to keep: control characters out,
 * runs of space folded, trimmed, and cut to {@link MAX_OPPONENT_NAME_CHARS}.
 * Null for one that is empty afterwards, which clears the name.
 */
export function cleanOpponentName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const folded = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (folded === '') return null;
  return [...folded].slice(0, MAX_OPPONENT_NAME_CHARS).join('').trim();
}

/**
 * How a game stands *between the two players*.
 *
 * The record's own rule ({@link standingOf} in `record.ts`), asked of both
 * sides at once: unmeasured if either player's distance is unknown, because
 * the headline here is both distances added up. Everything else it reads —
 * plies, the narrowest square — is the same in both players' rows, so the
 * two records judge every game alike.
 */
export function pairStandingOf(
  game: Pick<RecordGame, 'plies' | 'squareM' | 'travelM' | 'opponentTravelM'>,
): RecordStanding {
  if (game.travelM === null || game.opponentTravelM === null || game.opponentTravelM === undefined) {
    return 'unmeasured';
  }
  if (game.plies <= 0) return 'unplayed';
  if (game.squareM < SMALL_SQUARE_M) return 'practice';
  return 'counted';
}

/** One opponent, as the reader's own record adds them up. */
export interface OpponentTally {
  /** The pair id: the same in both players' records, and in nobody else's. */
  id: string;
  /** The name the *reader* gave them, or null. Never seen by anybody else. */
  name: string | null;
  /** Counted games only, as in the record's totals. */
  games: number;
  wins: number;
  draws: number;
  losses: number;
  /** Both players' meters over counted games: the headline. */
  togetherM: number;
  youM: number;
  themM: number;
  practiceGames: number;
  unplayedGames: number;
  unmeasuredGames: number;
  /** The first and the latest game between them, of any standing. */
  firstAt: number;
  lastAt: number;
  /**
   * The field of their first game, which tells two unnamed opponents apart.
   * A name a player wrote, and already in the reader's own record.
   */
  firstFieldName: string | null;
}

/** One game against one opponent, as their detail lists it. */
export interface OpponentLine {
  joinCode: string;
  result: PersonalResult;
  reason: ResultReason;
  standing: RecordStanding;
  finishedAt: number;
  fieldName: string | null;
  /** Null where nobody measured it. */
  youM: number | null;
  themM: number | null;
  squareM: number;
}

/** Everything the head-to-head list shows. */
export interface HeadToHead {
  /** Meters walked together, most first; then the latest game first. */
  opponents: OpponentTally[];
  /** Finished games recorded before rows held an opponent (decision 0054). */
  earlierGames: number;
}

/** One opponent in full: the tally and every game behind it, newest first. */
export interface OpponentDetail {
  opponent: OpponentTally;
  games: OpponentLine[];
}

/**
 * Fold the reader's own rows into one tally per opponent.
 *
 * Rows are taken **oldest first, ties by join code**, before anything is
 * added: the two players' records hold the same games, so they then add the
 * same numbers in the same order, and floating-point addition gives both of
 * them the same total to the last bit.
 */
export function summarizeHeadToHead(
  games: readonly RecordGame[],
  names: ReadonlyMap<string, string> = new Map(),
): HeadToHead {
  const tallies = new Map<string, OpponentTally>();
  let earlierGames = 0;
  for (const game of inPairOrder(games)) {
    if (!isPairId(game.pairId)) {
      earlierGames += 1;
      continue;
    }
    const tally = tallies.get(game.pairId) ?? emptyTally(game, names);
    addGame(tally, game);
    tallies.set(game.pairId, tally);
  }
  return {
    opponents: [...tallies.values()].sort(
      (a, b) => b.togetherM - a.togetherM || b.lastAt - a.lastAt || a.id.localeCompare(b.id),
    ),
    earlierGames,
  };
}

/** One opponent's tally and games, or null when the reader has none with them. */
export function opponentDetail(
  games: readonly RecordGame[],
  id: string,
  names: ReadonlyMap<string, string> = new Map(),
): OpponentDetail | null {
  if (!isPairId(id)) return null;
  const theirs = inPairOrder(games).filter((game) => game.pairId === id);
  if (theirs.length === 0) return null;
  const tally = emptyTally(theirs[0], names);
  for (const game of theirs) addGame(tally, game);
  return {
    opponent: tally,
    games: theirs
      .map(
        (game): OpponentLine => ({
          joinCode: game.joinCode,
          result: personalResult(game.outcome, game.color),
          reason: game.reason,
          standing: pairStandingOf(game),
          finishedAt: game.finishedAt,
          fieldName: game.fieldName,
          youM: game.travelM === null ? null : safeMeters(game.travelM),
          themM: game.opponentTravelM == null ? null : safeMeters(game.opponentTravelM),
          squareM: game.squareM,
        }),
      )
      .reverse(),
  };
}

function inPairOrder(games: readonly RecordGame[]): RecordGame[] {
  return [...games].sort(
    (a, b) => a.finishedAt - b.finishedAt || (a.joinCode < b.joinCode ? -1 : a.joinCode > b.joinCode ? 1 : 0),
  );
}

function emptyTally(first: RecordGame, names: ReadonlyMap<string, string>): OpponentTally {
  const id = first.pairId as string;
  return {
    id,
    name: names.get(id) ?? null,
    games: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    togetherM: 0,
    youM: 0,
    themM: 0,
    practiceGames: 0,
    unplayedGames: 0,
    unmeasuredGames: 0,
    firstAt: first.finishedAt,
    lastAt: first.finishedAt,
    firstFieldName: first.fieldName,
  };
}

/** Games must arrive in {@link inPairOrder}, so `firstAt` and the sums agree. */
function addGame(tally: OpponentTally, game: RecordGame): void {
  tally.lastAt = Math.max(tally.lastAt, game.finishedAt);
  const standing = pairStandingOf(game);
  if (standing === 'practice') tally.practiceGames += 1;
  if (standing === 'unplayed') tally.unplayedGames += 1;
  if (standing === 'unmeasured') tally.unmeasuredGames += 1;
  if (standing !== 'counted') return;
  const you = safeMeters(game.travelM);
  const them = safeMeters(game.opponentTravelM);
  tally.games += 1;
  tally.youM += you;
  tally.themM += them;
  // Per game, then summed, so each side adds `you + them` and `them + you`:
  // the same number, since addition of two floats is commutative.
  tally.togetherM += you + them;
  const result = personalResult(game.outcome, game.color);
  if (result === 'win') tally.wins += 1;
  else if (result === 'loss') tally.losses += 1;
  else tally.draws += 1;
}

function safeMeters(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
