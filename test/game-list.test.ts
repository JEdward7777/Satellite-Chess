import { describe, expect, it } from 'vitest';

import { type GameIndexEntry, listedGame } from '../src/shared/game-index.js';
import { CLAIM_AFTER_MS } from '../src/shared/protocol.js';
import {
  FINISHED_SHOWN,
  TIDY_SUGGEST_AT,
  describeGame,
  homeGames,
  shouldOfferTidy,
  tidyCandidates,
} from '../src/client/views/games.js';

/**
 * The words the home-screen list uses (stage 2.3.4.1).
 *
 * The model half of the view, tested in node because it is where decision 0025
 * is turned into a sentence somebody reads before deciding whether to walk to a
 * park. The countdown has to be right from *both* sides — the player who paused
 * the game is the one who most needs telling that a clock is running — and that
 * is the case a screenshot would never catch, because it looks identical.
 */

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600_000;

function listed(overrides: Partial<GameIndexEntry> = {}) {
  return listedGame(
    {
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
    },
    NOW,
  );
}

describe('describeGame', () => {
  it('leads with the ground and carries the code', () => {
    const line = describeGame(listed(), NOW);
    expect(line.title).toBe('The common');
    expect(line.code).toBe('ABC 123');
    expect(line.detail).toBe('White · in play');
  });

  it('falls back to the code when a game has no field name', () => {
    expect(describeGame(listed({ fieldName: null }), NOW).title).toBe('Game ABC 123');
  });

  it('tells the player who paused it that their opponent is on a clock', () => {
    const line = describeGame(
      listed({ status: 'suspended', suspendedAt: NOW - 3 * DAY, suspendedBy: 'w' }),
      NOW,
    );
    expect(line.detail).toContain('you paused it');
    expect(line.detail).toContain('your opponent can claim the win in 27 days');
  });

  it('tells the other player when they may take it', () => {
    const line = describeGame(
      listed({ status: 'suspended', suspendedAt: NOW - 3 * DAY, suspendedBy: 'b' }),
      NOW,
    );
    expect(line.detail).toContain('paused by your opponent');
    expect(line.detail).toContain('you can claim the win in 27 days');
  });

  it('says "now" once the month is up', () => {
    const line = describeGame(
      listed({ status: 'suspended', suspendedAt: NOW - CLAIM_AFTER_MS, suspendedBy: 'b' }),
      NOW,
    );
    expect(line.detail).toContain('you can claim the win now');
  });

  it('says "tomorrow" rather than "in 1 days"', () => {
    const line = describeGame(
      listed({
        status: 'suspended',
        suspendedAt: NOW - (CLAIM_AFTER_MS - DAY),
        suspendedBy: 'b',
      }),
      NOW,
    );
    expect(line.detail).toContain('you can claim the win tomorrow');
  });

  it('says that a game both players walked away from belongs to neither', () => {
    const line = describeGame(
      listed({ status: 'suspended', suspendedAt: NOW - DAY, suspendedBy: null }),
      NOW,
    );
    expect(line.detail).toContain('neither of you can claim it');
  });

  it('reads a result from the reader’s own side', () => {
    const win = { outcome: '1-0' as const, reason: 'checkmate' as const, at: NOW };
    expect(describeGame(listed({ status: 'finished', color: 'w', result: win }), NOW).detail).toBe(
      'White · you won — checkmate',
    );
    expect(describeGame(listed({ status: 'finished', color: 'b', result: win }), NOW).detail).toBe(
      'Black · you lost — checkmate',
    );
  });

  it('does not take sides over a draw', () => {
    const drawn = { outcome: '1/2-1/2' as const, reason: 'agreement' as const, at: NOW };
    expect(
      describeGame(listed({ status: 'finished', color: 'b', result: drawn }), NOW).detail,
    ).toBe('Black · drawn — agreement');
  });

  it('names the states a game passes through before it starts', () => {
    expect(describeGame(listed({ status: 'waiting' }), NOW).detail).toContain(
      'waiting for an opponent',
    );
    expect(describeGame(listed({ status: 'staging' }), NOW).detail).toContain('about to start');
  });
});

describe('homeGames', () => {
  it('keeps every game still going and only the last few results', () => {
    const live = [listed({ joinCode: 'AAA111', status: 'suspended', suspendedAt: NOW })];
    const finished = Array.from({ length: FINISHED_SHOWN + 4 }, (_, i) =>
      listed({ joinCode: `FIN${i}00`, status: 'finished' }),
    );
    const shown = homeGames([...live, ...finished]);
    expect(shown).toHaveLength(1 + FINISHED_SHOWN);
    expect(shown[0].joinCode).toBe('AAA111');
  });

  it('never hides a game that is still going, however many there are', () => {
    const live = Array.from({ length: 12 }, (_, i) =>
      listed({ joinCode: `LIV${i}00`, status: 'active' }),
    );
    expect(homeGames(live)).toHaveLength(12);
  });
});

describe('tidyCandidates', () => {
  it('offers only what the server would accept', () => {
    const games = [
      listed({ joinCode: 'FIN111', status: 'finished' }),
      listed({ joinCode: 'ACT222', status: 'active' }),
      listed({ joinCode: 'SUS333', status: 'suspended', suspendedAt: NOW, suspendedBy: 'b' }),
      listed({ joinCode: 'WAI444', status: 'waiting' }),
    ];
    expect(tidyCandidates(games).map((g) => g.joinCode)).toEqual(['FIN111', 'WAI444']);
  });

  it('makes the offer only once the list has grown', () => {
    const few = Array.from({ length: TIDY_SUGGEST_AT - 1 }, (_, i) =>
      listed({ joinCode: `FIN${i}00`, status: 'finished' }),
    );
    expect(shouldOfferTidy(few)).toBe(false);
    expect(shouldOfferTidy([...few, listed({ joinCode: 'FIN999', status: 'finished' })])).toBe(
      true,
    );
  });

  it('does not count games it could not remove towards making the offer', () => {
    const stuck = Array.from({ length: TIDY_SUGGEST_AT + 3 }, (_, i) =>
      listed({ joinCode: `SUS${i}00`, status: 'suspended', suspendedAt: NOW, suspendedBy: 'b' }),
    );
    expect(shouldOfferTidy(stuck)).toBe(false);
  });
});
