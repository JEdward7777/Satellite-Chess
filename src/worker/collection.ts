/**
 * When a game's Durable Object may stop existing (stages 8.4 and 3.6.2,
 * decision 0042).
 *
 * Pure, so the whole rule can be read and tested in one place: `GameDO` hands
 * in what its tables say and gets back a deadline, and nothing here touches
 * storage, the clock or the alarm. The object turns the answer into its `gc`
 * timer through the one alarm (decision 0006), and asks again every time the
 * timer fires — so a deadline that has moved since it was set (somebody came
 * back to look) is honoured rather than acted on early.
 *
 * Three kinds of game may go, and nothing else ever does:
 *
 * - **Unclaimed** — created, never joined. Half an hour, as since stage 3.6.1.
 * - **Unplayed** — both seats taken and not one move played, then nothing for
 *   a month. Nobody has anything invested in it: no result, no record line, no
 *   walk worth a number. Decision 0025's promise was "once two people have
 *   *played*, the game persists", and these two never did.
 * - **Finished** — a day after the last sign of anybody looking at it. It is not
 *   lost: it leaves as one KV value holding its PGN and its report (decision
 *   0042), and the review screen reads that instead. The day is for the evening
 *   after the game, when the board is still worth opening.
 *
 * **A game with moves on it and no result is never collected**, however long
 * it sits suspended. That is decision 0025 unchanged: the claim button waits
 * for as long as it takes, and a timer that deleted the game would take the
 * button with it.
 */

import type { GameStatus } from '../shared/protocol.js';
import { UNCLAIMED_GAME_TTL_MS } from '../shared/protocol.js';

/**
 * How long a game with both seats taken and no move played may sit untouched.
 *
 * The same month a suspended game waits before it can be claimed, and for a
 * related reason: it is how long two people might reasonably take to get back
 * to a field. Measured from the last change the game saw, so a pair who keep
 * opening it and not starting are not cut off mid-plan.
 */
export const UNPLAYED_GAME_TTL_MS = 30 * 24 * 3600_000;

/**
 * How long a finished game stays a live object after anybody last looked at
 * it — its result, a re-opened board, a socket closing.
 *
 * Not a privacy measure and not a storage one: the review, the file and the
 * record all survive the object (decision 0042). It is the evening after the
 * game, when a player is likeliest to open the board again, and it is long
 * enough that the record's own retries (about eight and a half hours, stage
 * 2.3.5) have normally finished before anything is deleted.
 */
export const FINISHED_GAME_GRACE_MS = 24 * 3600_000;

/**
 * Between writing the archive and deleting the object.
 *
 * Workers KV is eventually consistent: a value written in one place can take up
 * to a minute to be readable everywhere else. Deleting the object the moment
 * the write returned would leave a window in which a player somewhere else asks
 * for their review and finds neither. Ten minutes is ten times the published
 * propagation bound and costs nothing, since the object answers until it goes.
 */
export const ARCHIVE_SETTLE_MS = 10 * 60_000;

/**
 * How many times a failed archive write — or a read-back that disagreed — is
 * retried before the object stops spending alarms and KV writes on it.
 * Doubling from a minute, the eleven waits between twelve attempts add up to
 * about 34 hours. Deliberately longer than a UTC day: the likeliest persistent
 * failure is the free tier's daily KV write cap, which resets at midnight UTC,
 * and a ladder that gave up first would never see it lift. After that the game
 * simply stays alive until a player re-opens it, which starts the count again.
 * Nothing is lost by giving up — the game is still there.
 */
export const ARCHIVE_RETRY_BASE_MS = 60_000;
export const ARCHIVE_MAX_ATTEMPTS = 12;

/**
 * How many days in a row a finished game will wait for its record and index
 * lines to be delivered before it stops asking. Each day restarts the record's
 * own retry ladder. After a week the object stays as it is — undeleted, and
 * therefore still holding everything — until a player re-opens it.
 */
export const DELIVERY_MAX_DEFERRALS = 7;

/** What a game's tables say, as far as collection is concerned. */
export interface CollectionFacts {
  status: GameStatus;
  createdAt: number;
  /** The game row's `updated_at`: moved by joins, sockets, moves and results. */
  updatedAt: number;
  /** When it finished, or null. */
  resultAt: number | null;
  /** The last time a player re-took a seat in it, or null. */
  seenAt: number | null;
  /** How many moves have been played. */
  plies: number;
  /**
   * Who stopped a suspended game, or null — for a game nobody is recorded as
   * stopping, or one that is not suspended.
   */
  suspendedBy: 'w' | 'b' | null;
}

/**
 * The durations above, overridable as one set.
 *
 * Only ever different from {@link DEFAULT_COLLECTION_TIMES} in a local server,
 * through the dev seam's two locks (decision 0029), so a browser driver can
 * watch a finished game be archived and deleted without waiting a day.
 */
export interface CollectionTimes {
  unclaimedMs: number;
  unplayedMs: number;
  graceMs: number;
  settleMs: number;
}

/**
 * The shortest any overridden duration may be. A driver asks for zero; zero
 * with a board still open would re-arm the alarm for "now" on every firing, a
 * hot loop through the one alarm. A second is fast enough for a driver.
 */
export const MIN_OVERRIDE_MS = 1_000;

export const DEFAULT_COLLECTION_TIMES: CollectionTimes = {
  unclaimedMs: UNCLAIMED_GAME_TTL_MS,
  unplayedMs: UNPLAYED_GAME_TTL_MS,
  graceMs: FINISHED_GAME_GRACE_MS,
  settleMs: ARCHIVE_SETTLE_MS,
};

/** Which rule applies, or null when none does and the game must be kept. */
export type CollectionKind = 'unclaimed' | 'unplayed' | 'finished';

export function collectionKind(facts: CollectionFacts): CollectionKind | null {
  switch (facts.status) {
    case 'waiting':
      return 'unclaimed';
    case 'staging':
      return facts.plies === 0 ? 'unplayed' : null;
    case 'suspended':
      // Suspended after a move is decision 0025's frozen game, which waits for
      // ever. So is one suspended *before* a move if somebody is recorded as
      // having stopped it: from thirty days on, the other player is offered a
      // claim — by "Your games" and by the board — and deleting it on that same
      // day would take the button away the moment it appeared. Only a game
      // nobody could ever claim (both vanished at once) is unplayed.
      return facts.plies === 0 && facts.suspendedBy === null ? 'unplayed' : null;
    case 'finished':
      return 'finished';
    default:
      // `active`: somebody is playing it.
      return null;
  }
}

/**
 * When this game may be collected, or null if it may not be at all.
 *
 * For a finished game this is when the *archive* may be written, measured
 * from the latest of its result, its last change and its last re-join. The
 * settle interval after the write is the object's own business, since it
 * depends on when the write actually happened.
 */
export function collectionDue(
  facts: CollectionFacts,
  times: CollectionTimes = DEFAULT_COLLECTION_TIMES,
): number | null {
  switch (collectionKind(facts)) {
    case 'unclaimed':
      return facts.createdAt + times.unclaimedMs;
    case 'unplayed':
      return Math.max(facts.updatedAt, facts.seenAt ?? 0) + times.unplayedMs;
    case 'finished':
      return (
        Math.max(facts.resultAt ?? 0, facts.updatedAt, facts.seenAt ?? 0) + times.graceMs
      );
    default:
      return null;
  }
}
