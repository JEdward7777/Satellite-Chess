import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_SETTLE_MS,
  type CollectionFacts,
  DEFAULT_COLLECTION_TIMES,
  FINISHED_GAME_GRACE_MS,
  UNPLAYED_GAME_TTL_MS,
  collectionDue,
  collectionKind,
} from '../src/worker/collection.js';
import { CLAIM_AFTER_MS, UNCLAIMED_GAME_TTL_MS } from '../src/shared/protocol.js';

/**
 * When a game's object may stop existing (decision 0042), as a rule on its own.
 *
 * The Durable Object end — the alarm, the archive, the delete — is in
 * `test/worker/archive.test.ts`. This is the table of which games may go and
 * when, where the one mistake that matters is easy to see: a game with moves on
 * it and no result must never be given a deadline at all (decision 0025).
 */

const T = 1_800_000_000_000;

function facts(over: Partial<CollectionFacts>): CollectionFacts {
  return {
    status: 'staging',
    createdAt: T,
    updatedAt: T,
    resultAt: null,
    seenAt: null,
    plies: 0,
    suspendedBy: null,
    ...over,
  };
}

describe('which games may be collected at all', () => {
  it('an unclaimed code, an unplayed game and a finished one — and nothing else', () => {
    expect(collectionKind(facts({ status: 'waiting' }))).toBe('unclaimed');
    expect(collectionKind(facts({ status: 'staging' }))).toBe('unplayed');
    expect(collectionKind(facts({ status: 'suspended', plies: 0 }))).toBe('unplayed');
    expect(collectionKind(facts({ status: 'finished', plies: 12, resultAt: T }))).toBe('finished');
    expect(collectionKind(facts({ status: 'active', plies: 0 }))).toBeNull();
    expect(collectionKind(facts({ status: 'active', plies: 30 }))).toBeNull();
  });

  it('never a game somebody could claim, even with no move played (decision 0025)', () => {
    // Paused before the first move, by White: from day thirty Black is offered
    // the claim, so day thirty must not also be the day it is deleted.
    const claimable = facts({ status: 'suspended', plies: 0, suspendedBy: 'w', updatedAt: T - 10 * CLAIM_AFTER_MS });
    expect(collectionKind(claimable)).toBeNull();
    expect(collectionDue(claimable)).toBeNull();
    // Nobody recorded as stopping it — both vanished at once — and nobody can
    // claim it, so it is an unplayed game like any other.
    expect(collectionKind(facts({ status: 'suspended', plies: 0, suspendedBy: null }))).toBe('unplayed');
  });

  it('never a suspended game with a move on it, however old (decision 0025)', () => {
    const frozen = facts({ status: 'suspended', plies: 1, updatedAt: T - 10 * CLAIM_AFTER_MS });
    expect(collectionKind(frozen)).toBeNull();
    expect(collectionDue(frozen)).toBeNull();
  });
});

describe('when', () => {
  it('an unclaimed code goes half an hour after it was made', () => {
    expect(collectionDue(facts({ status: 'waiting', updatedAt: T + 999 }))).toBe(T + UNCLAIMED_GAME_TTL_MS);
  });

  it('an unplayed game goes a month after anything last happened to it', () => {
    expect(collectionDue(facts({ updatedAt: T + 5 }))).toBe(T + 5 + UNPLAYED_GAME_TTL_MS);
    expect(collectionDue(facts({ seenAt: T + 9 }))).toBe(T + 9 + UNPLAYED_GAME_TTL_MS);
  });

  it('a finished game goes a day after the result, or after anybody last looked', () => {
    const base = facts({ status: 'finished', plies: 20, resultAt: T, updatedAt: T });
    expect(collectionDue(base)).toBe(T + FINISHED_GAME_GRACE_MS);
    expect(collectionDue({ ...base, updatedAt: T + 60_000 })).toBe(T + 60_000 + FINISHED_GAME_GRACE_MS);
    expect(collectionDue({ ...base, seenAt: T + 3_600_000 })).toBe(T + 3_600_000 + FINISHED_GAME_GRACE_MS);
  });

  it('takes a set of durations, for a local driver, as one set', () => {
    const quick = { unclaimedMs: 5, unplayedMs: 5, graceMs: 5, settleMs: 5 };
    expect(collectionDue(facts({ status: 'finished', resultAt: T }), quick)).toBe(T + 5);
    expect(collectionDue(facts({ status: 'active', plies: 3 }), quick)).toBeNull();
  });

  it('the defaults are the ones decision 0042 names', () => {
    expect(DEFAULT_COLLECTION_TIMES).toEqual({
      unclaimedMs: 30 * 60_000,
      unplayedMs: 30 * 24 * 3600_000,
      graceMs: 24 * 3600_000,
      settleMs: 10 * 60_000,
    });
    // The settle interval must outlast KV's published propagation (60 s) by a
    // wide margin, and the grace the record's retry ladder (~8.5 h).
    expect(ARCHIVE_SETTLE_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(FINISHED_GAME_GRACE_MS).toBeGreaterThan(9 * 3600_000);
  });
});
