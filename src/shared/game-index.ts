/**
 * The game index: one line per game you have a seat in (stage 2.3.4).
 *
 * Shared because both ends need the same arithmetic. The Worker computes the
 * claim countdown when it lists your games; the phone re-computes it every time
 * it redraws, because a countdown measured in days is stale by the time someone
 * has walked home. One rule, in one file, so the two can never disagree about
 * whether a month has passed.
 *
 * ## Why this exists at all
 *
 * A game is addressed by its join code (decision 0007) and nothing else. Before
 * this index, **the code was the only handle on a game** — close the tab and a
 * suspended game was gone, which since decision 0025 can mean losing one that
 * would still be claimable a month later. The index is the answer to "what was
 * I playing?" asked from a phone that was not there.
 *
 * ## An entry is a pointer, not a record
 *
 * Everything here is denormalised from the game, so a list of ten games reads
 * without waking ten Durable Objects — which would be ten requests against a
 * 100k/day budget every time somebody opened the app. The game remains the only
 * authority: tap a row and what you get is the game's own answer, not this one.
 *
 * The consequence is that an entry may lag. It is refreshed when a game changes
 * *state* — created, joined, started, suspended, resumed, finished — and not
 * when a piece moves, because a game you are in the middle of playing is not a
 * game you need help finding.
 */

import { CLAIM_AFTER_MS, type GameResult, type GameStatus } from './protocol.js';
import type { Color } from './squares.js';

/**
 * One game, as its own player's index holds it.
 *
 * Deliberately says nothing about the opponent — not their name, not their
 * account, not where they were. The index answers "which of my games is this?"
 * and anything more about the other player belongs to the game, which is the
 * only thing entitled to answer it (decision 0017).
 */
export interface GameIndexEntry {
  /** The join code, which is also the game's address (decision 0007). */
  joinCode: string;
  /** Which side this account plays. */
  color: Color;
  status: GameStatus;
  /** The field's name at the moment the game snapshotted it, for the list line. */
  fieldName: string | null;
  /** When the last move was played, or null in a game that never started. */
  lastMoveAt: number | null;
  suspendedAt: number | null;
  /** Who stopped it, and therefore who may *not* claim it (decision 0025). */
  suspendedBy: Color | null;
  result: GameResult | null;
  /** When this account took its seat. */
  joinedAt: number;
  /** When the index last heard from the game. */
  updatedAt: number;
}

/**
 * An entry as the game describes it — everything except when the seat was taken.
 *
 * `joinedAt` is missing on purpose. The game cannot know it: a seat is recorded
 * again every time the game changes state, and by the tenth of those the moment
 * somebody sat down is long gone. So the account stamps it once, when it first
 * writes the row, and never moves it again — which also keeps what the game
 * sends **deterministic**, so it can be compared against what was last sent and
 * a repeat push skipped rather than billed.
 */
export type GameIndexUpdate = Omit<GameIndexEntry, 'joinedAt'>;

/** An entry with the countdown worked out, which is what a list actually shows. */
export interface ListedGame extends GameIndexEntry {
  /** True when this player may end the game now (decision 0025). */
  canClaim: boolean;
  /** Milliseconds until {@link canClaim} could become true. Zero once it has. */
  claimableInMs: number;
  /** Whether {@link forgetIsRefused} would let this one go. */
  removable: boolean;
}

/**
 * The claim state of a suspended game, from the point of view of its owner.
 *
 * The same rule as `GameDO.suspensionFor`, and it has to be: a countdown that
 * said "claimable tomorrow" on the home screen and "in three days" inside the
 * game would be read as the app losing track of a month-long promise.
 *
 * `by !== color` is the whole of it. Only the player who did *not* stop the game
 * may end it, because after thirty days nobody is connected and "claim if your
 * opponent is absent" would otherwise hand the win to whoever walked off.
 */
export function claimStateFor(
  entry: Pick<GameIndexEntry, 'status' | 'suspendedAt' | 'suspendedBy' | 'color'>,
  now: number = Date.now(),
): { canClaim: boolean; claimableInMs: number } {
  if (entry.status !== 'suspended' || entry.suspendedAt === null) {
    return { canClaim: false, claimableInMs: 0 };
  }
  const eligible = entry.suspendedBy !== null && entry.suspendedBy !== entry.color;
  if (!eligible) return { canClaim: false, claimableInMs: 0 };
  const elapsed = now - entry.suspendedAt;
  return {
    canClaim: elapsed >= CLAIM_AFTER_MS,
    claimableInMs: Math.max(0, CLAIM_AFTER_MS - elapsed),
  };
}

/**
 * Why this game may not be tidied away, or null when it may.
 *
 * Stage 2.3.4.2 is emphatic that clearing out old games is **an offer, never a
 * timer**, and that the offer must never be able to remove a game that is still
 * live. So the rule is stated as a refusal with a reason attached, rather than
 * as a boolean somewhere in the UI that a later change could quietly invert.
 *
 * **A game that is not finished is never removable**, and that includes a
 * suspended one whose claim window is long past. It reads as harsh — the row
 * sits there for ever if the opponent never comes back — but the alternative is
 * worse: the join code is the only handle on the game (decision 0007), so
 * deleting the row while the game is still decidable destroys the only way
 * either player could ever finish it. There is always an exit that does not
 * need this button, and it is the one decision 0025 designed: claim the win
 * once the month is up, or resign, both of which are offered inside the game
 * and both of which end it properly. Tidying up is for games that are already
 * over.
 *
 * `waiting` is removable because it is the one status with no game behind it:
 * nobody ever took the second seat, and the object deletes itself after thirty
 * minutes anyway (`UNCLAIMED_GAME_TTL_MS`), so the row is already an orphan.
 */
export function forgetIsRefused(
  entry: Pick<GameIndexEntry, 'status'>,
): 'in_play' | 'suspended' | null {
  switch (entry.status) {
    case 'finished':
    case 'waiting':
      return null;
    case 'suspended':
      return 'suspended';
    default:
      return 'in_play';
  }
}

/** An entry with its countdown and its removability worked out. */
export function listedGame(entry: GameIndexEntry, now: number = Date.now()): ListedGame {
  return {
    ...entry,
    ...claimStateFor(entry, now),
    removable: forgetIsRefused(entry) === null,
  };
}

/**
 * Newest first, and "newest" means the game you would most likely want back.
 *
 * A game in play sorts above one that is over regardless of dates, because the
 * whole reason to open this list is to get back into something — and a player
 * with a hundred finished games would otherwise have to scroll past all of them
 * to find the one they suspended at lunchtime.
 */
export function byMostWanted(a: GameIndexEntry, b: GameIndexEntry): number {
  const live = (entry: GameIndexEntry) => (entry.status === 'finished' ? 1 : 0);
  const byLive = live(a) - live(b);
  if (byLive !== 0) return byLive;
  return lastTouched(b) - lastTouched(a);
}

function lastTouched(entry: GameIndexEntry): number {
  return Math.max(entry.updatedAt, entry.lastMoveAt ?? 0, entry.joinedAt);
}
