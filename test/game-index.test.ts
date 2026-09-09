import { describe, expect, it } from 'vitest';

import {
  type GameIndexEntry,
  byMostWanted,
  claimStateFor,
  forgetIsRefused,
  listedGame,
} from '../src/shared/game-index.js';
import { CLAIM_AFTER_MS } from '../src/shared/protocol.js';

/**
 * The rules a game index line carries (stage 2.3.4).
 *
 * Almost all of this is decision 0025 restated in one place: who may claim a
 * suspended game, when, and what may therefore be tidied away. The arithmetic is
 * trivial and the asymmetry is not — the same suspension is claimable for one
 * player and not the other, for ever — so it is the asymmetry that is tested.
 */

const NOW = 1_800_000_000_000;

function entry(overrides: Partial<GameIndexEntry> = {}): GameIndexEntry {
  return {
    joinCode: 'ABC123',
    color: 'w',
    status: 'active',
    fieldName: 'The common',
    lastMoveAt: NOW - 60_000,
    suspendedAt: null,
    suspendedBy: null,
    result: null,
    joinedAt: NOW - 3600_000,
    updatedAt: NOW - 60_000,
    ...overrides,
  };
}

describe('claimStateFor', () => {
  it('says nothing about a game that is not suspended', () => {
    expect(claimStateFor(entry(), NOW)).toEqual({ canClaim: false, claimableInMs: 0 });
  });

  it('counts down for the player who did not stop the game', () => {
    const game = entry({ status: 'suspended', suspendedAt: NOW - 1000, suspendedBy: 'b' });
    const state = claimStateFor(game, NOW);
    expect(state.canClaim).toBe(false);
    expect(state.claimableInMs).toBe(CLAIM_AFTER_MS - 1000);
  });

  it('lets that player claim once the month is up', () => {
    const game = entry({
      status: 'suspended',
      suspendedAt: NOW - CLAIM_AFTER_MS,
      suspendedBy: 'b',
    });
    expect(claimStateFor(game, NOW)).toEqual({ canClaim: true, claimableInMs: 0 });
  });

  it('never lets the player who stopped it claim, however long it has been', () => {
    // The whole point of storing `suspended_by`: after a month nobody is
    // connected, so "claim if your opponent is absent" would hand the win to
    // whoever walked off.
    const game = entry({
      status: 'suspended',
      suspendedAt: NOW - 10 * CLAIM_AFTER_MS,
      suspendedBy: 'w',
    });
    expect(claimStateFor(game, NOW)).toEqual({ canClaim: false, claimableInMs: 0 });
  });

  it('lets nobody claim when both players went missing at once', () => {
    const game = entry({ status: 'suspended', suspendedAt: NOW - CLAIM_AFTER_MS, suspendedBy: null });
    expect(claimStateFor(game, NOW).canClaim).toBe(false);
  });
});

describe('forgetIsRefused', () => {
  it('lets a finished game go', () => {
    expect(forgetIsRefused({ status: 'finished' })).toBe(null);
  });

  it('lets a game nobody ever joined go', () => {
    expect(forgetIsRefused({ status: 'waiting' })).toBe(null);
  });

  it('refuses a game in play', () => {
    expect(forgetIsRefused({ status: 'active' })).toBe('in_play');
    expect(forgetIsRefused({ status: 'staging' })).toBe('in_play');
  });

  it('refuses a suspended game even long after the claim window', () => {
    // Deleting the row destroys the only handle on a game that can still be
    // decided (decision 0007). The exit is to claim it or resign it, not to
    // lose it.
    expect(forgetIsRefused({ status: 'suspended' })).toBe('suspended');
  });
});

describe('listedGame', () => {
  it('marks a finished game removable and a suspended one not', () => {
    expect(listedGame(entry({ status: 'finished' }), NOW).removable).toBe(true);
    expect(
      listedGame(entry({ status: 'suspended', suspendedAt: NOW, suspendedBy: 'b' }), NOW)
        .removable,
    ).toBe(false);
  });

  it('carries the countdown with it', () => {
    const listed = listedGame(
      entry({ status: 'suspended', suspendedAt: NOW - CLAIM_AFTER_MS, suspendedBy: 'b' }),
      NOW,
    );
    expect(listed.canClaim).toBe(true);
  });
});

describe('byMostWanted', () => {
  it('puts a game still going above a finished one, whatever the dates say', () => {
    const old = entry({ joinCode: 'OLD111', status: 'suspended', updatedAt: NOW - 30 * 86_400_000 });
    const fresh = entry({ joinCode: 'NEW222', status: 'finished', updatedAt: NOW });
    expect([fresh, old].sort(byMostWanted).map((g) => g.joinCode)).toEqual(['OLD111', 'NEW222']);
  });

  it('orders games of the same kind by when they were last touched', () => {
    const older = entry({ joinCode: 'AAA111', updatedAt: NOW - 1000, lastMoveAt: null });
    const newer = entry({ joinCode: 'BBB222', updatedAt: NOW, lastMoveAt: null });
    expect([older, newer].sort(byMostWanted).map((g) => g.joinCode)).toEqual(['BBB222', 'AAA111']);
  });

  it('counts the last move as having touched a game', () => {
    // A game whose row was written when it started, and which has been played
    // since, is more recent than its `updatedAt` says.
    const played = entry({ joinCode: 'AAA111', updatedAt: NOW - 10_000, lastMoveAt: NOW });
    const idle = entry({ joinCode: 'BBB222', updatedAt: NOW - 5000, lastMoveAt: null });
    expect([idle, played].sort(byMostWanted).map((g) => g.joinCode)).toEqual(['AAA111', 'BBB222']);
  });
});
