import { describe, expect, it } from 'vitest';

import {
  endingActions,
  endingConfirm,
  endingHint,
  incomingOffers,
  myOfferLine,
  offerEndedNotice,
  offerSentNotice,
} from '../src/client/endings.js';
import { describeGame, homeGames, shouldOfferTidy, tidyCandidates } from '../src/client/views/games.js';
import { resultWords } from '../src/client/review.js';
import { makeFieldSpec, snapshotField } from '../src/shared/field.js';
import {
  ABORT_ALONE_BEFORE_PLIES,
  abortsAlone,
  canAbort,
  canOfferDraw,
  canResign,
  isOver,
} from '../src/shared/endings.js';
import { type GameIndexEntry, byMostWanted, forgetIsRefused, listedGame } from '../src/shared/game-index.js';
import { fromLocal } from '../src/shared/geo.js';
import { ABORTED_COMMENT, buildPgn, termination } from '../src/shared/pgn.js';
import type { GameSnapshot, GameStatus } from '../src/shared/protocol.js';
import { DEFAULT_REACH } from '../src/shared/reach.js';
import type { GameReport } from '../src/shared/review.js';
import { collectionDue, collectionKind } from '../src/worker/collection.js';

/**
 * Ending a game early (stage 10.11, decision 0050): the rules, and the words
 * and buttons the phone makes of them. The runtime half is
 * `test/worker/endings.test.ts`.
 */

const STATUSES: GameStatus[] = ['waiting', 'staging', 'active', 'suspended', 'finished', 'aborted'];

describe('the rules', () => {
  it('lets a player abort alone until each side has moved, and never once it is over', () => {
    expect(ABORT_ALONE_BEFORE_PLIES).toBe(2);
    for (const status of ['staging', 'active', 'suspended'] as const) {
      expect(abortsAlone(status, 0)).toBe(true);
      expect(abortsAlone(status, 1)).toBe(true);
      expect(abortsAlone(status, 2)).toBe(false);
      expect(canAbort(status)).toBe(true);
    }
    for (const status of ['waiting', 'finished', 'aborted'] as const) {
      expect(canAbort(status)).toBe(false);
      expect(abortsAlone(status, 0)).toBe(false);
    }
  });

  it('allows resign and draw while active or suspended — the stuck states — and not while staging', () => {
    expect(STATUSES.filter(canResign)).toEqual(['active', 'suspended']);
    expect(STATUSES.filter(canOfferDraw)).toEqual(['active', 'suspended']);
  });

  it('calls finished and aborted over, and nothing else', () => {
    expect(STATUSES.filter(isOver)).toEqual(['finished', 'aborted']);
  });
});

// ---------------------------------------------------------------------------

const A1 = { lat: 51.4779, lng: -0.0015 };
const FIELD = snapshotField(makeFieldSpec('f', { a1: A1, h8: fromLocal(A1, { e: 56, n: 56 }) }));

function snapshot(over: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    v: 1,
    rev: 7,
    suspension: null,
    joinCode: 'ABC123',
    status: 'active',
    fen: '8/8/8/8/8/8/8/8 w - - 0 1',
    field: FIELD,
    reach: DEFAULT_REACH,
    clock: { whiteMs: 600_000, blackMs: 600_000, incrementMs: 0, active: 'w', startedAt: 1_000 },
    serverNow: 1_000,
    you: 'w',
    players: { w: null, b: null },
    lastMove: null,
    moveCount: 4,
    carry: null,
    result: null,
    drawOfferFrom: null,
    abortOfferFrom: null,
    createdAt: 0,
    ...over,
  };
}

const kinds = (game: GameSnapshot) => endingActions(game).map((a) => `${a.kind}:${a.label}`);

describe('what "End game…" offers', () => {
  it('offers only an abort, confirmed, before each side has moved', () => {
    for (const game of [
      snapshot({ status: 'staging', moveCount: 0 }),
      snapshot({ moveCount: 1 }),
      snapshot({ status: 'suspended', moveCount: 1 }),
    ]) {
      const actions = endingActions(game);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ kind: 'abort', ends: true, msg: { t: 'abort' } });
      expect(endingHint(game)).toMatch(/no result/);
    }
  });

  it('offers a draw, an abort offer and resign after, and only resign ends it outright', () => {
    const game = snapshot();
    expect(kinds(game)).toEqual(['draw:Offer a draw', 'abort:Offer to abort', 'resign:Resign']);
    expect(endingActions(game).map((a) => a.ends)).toEqual([false, false, true]);
    expect(endingHint(game)).toMatch(/needs your opponent to agree/);
  });

  it('shows my own open offers as pending, and theirs as something to accept', () => {
    const mine = endingActions(snapshot({ drawOfferFrom: 'w', abortOfferFrom: 'w' }));
    expect(mine.map((a) => [a.label, a.pending])).toEqual([
      ['Draw offered', true],
      ['Abort offered', true],
      ['Resign', false],
    ]);
    const theirs = endingActions(snapshot({ drawOfferFrom: 'b', abortOfferFrom: 'b' }));
    expect(theirs.map((a) => [a.label, a.ends, a.msg])).toEqual([
      ['Accept the draw', true, { t: 'draw', action: 'accept' }],
      ['Abort game', true, { t: 'abort', action: 'accept' }],
      ['Resign', true, { t: 'resign' }],
    ]);
  });

  it('offers nothing while waiting for an opponent, or once the game is over', () => {
    expect(endingActions(null)).toEqual([]);
    for (const status of ['waiting', 'finished', 'aborted'] as const) {
      expect(endingActions(snapshot({ status }))).toEqual([]);
      expect(incomingOffers(snapshot({ status, drawOfferFrom: 'b' }))).toEqual([]);
    }
  });

  it('asks a question for every ending, in plain words', () => {
    for (const action of [
      ...endingActions(snapshot({ drawOfferFrom: 'b', abortOfferFrom: 'b' })),
      ...endingActions(snapshot({ moveCount: 0 })),
    ]) {
      const words = endingConfirm(action);
      expect(words.title).toMatch(/\?$/);
      expect(words.yes.length).toBeGreaterThan(0);
    }
    expect(endingConfirm(endingActions(snapshot())[2]!).body).toMatch(/loss/);
    expect(endingConfirm(endingActions(snapshot({ moveCount: 0 }))[0]!).body).toMatch(
      /Nothing goes in either record/,
    );
  });
});

describe('offers under the board', () => {
  it('shows the opponent’s offers, abort first, each with a confirmed accept and a plain decline', () => {
    const offers = incomingOffers(snapshot({ drawOfferFrom: 'b', abortOfferFrom: 'b' }));
    expect(offers.map((o) => o.kind)).toEqual(['abort', 'draw']);
    expect(offers.every((o) => o.accept.ends)).toBe(true);
    expect(offers.map((o) => o.decline)).toEqual([
      { t: 'abort', action: 'decline' },
      { t: 'draw', action: 'decline' },
    ]);
    expect(incomingOffers(snapshot({ drawOfferFrom: 'w' }))).toEqual([]);
  });

  it('reminds me of my own open offers', () => {
    expect(myOfferLine(snapshot())).toBeNull();
    expect(myOfferLine(snapshot({ drawOfferFrom: 'w' }))).toMatch(/^You offered a draw\. It stands/);
    expect(myOfferLine(snapshot({ drawOfferFrom: 'w', abortOfferFrom: 'w' }))).toMatch(
      /^You offered a draw and to abort\. They stand/,
    );
    expect(myOfferLine(snapshot({ drawOfferFrom: 'b' }))).toBeNull();
  });

  it('tells a declined offer from one that lapsed with a move, and says nothing at the end', () => {
    const open = snapshot({ drawOfferFrom: 'w', abortOfferFrom: 'w' });
    expect(offerEndedNotice(open, snapshot())).toBe(
      'Your opponent declined the draw. Your opponent declined to abort.',
    );
    expect(offerEndedNotice(snapshot({ drawOfferFrom: 'w' }), snapshot({ moveCount: 5 }))).toBe(
      'Your draw offer lapsed with the move.',
    );
    expect(offerEndedNotice(open, snapshot({ status: 'aborted' }))).toBeNull();
    expect(offerEndedNotice(open, snapshot({ status: 'finished' }))).toBeNull();
    expect(offerEndedNotice(null, snapshot())).toBeNull();
    // Their offer going is not mine to be told about.
    expect(offerEndedNotice(snapshot({ drawOfferFrom: 'b' }), snapshot())).toBeNull();
    expect(offerSentNotice('draw')).toMatch(/^Draw offered/);
  });
});

// ---------------------------------------------------------------------------

const NOW = 1_800_000_000_000;

function entry(overrides: Partial<GameIndexEntry> = {}): GameIndexEntry {
  return {
    joinCode: 'ABC123',
    color: 'w',
    status: 'aborted',
    fieldName: 'Broken field',
    lastMoveAt: null,
    suspendedAt: null,
    suspendedBy: null,
    result: null,
    joinedAt: NOW - 3600_000,
    updatedAt: NOW - 60_000,
    ...overrides,
  };
}

describe('an aborted game on the list', () => {
  it('may be tidied away, says what happened, and sorts with the games that are over', () => {
    expect(forgetIsRefused(entry())).toBeNull();
    const aborted = listedGame(entry(), NOW);
    expect(aborted.removable).toBe(true);
    expect(describeGame(aborted, NOW).detail).toBe('White · aborted — no result');
    expect(tidyCandidates([aborted])).toEqual([aborted]);

    const live = listedGame(entry({ joinCode: 'LIVE01', status: 'active', updatedAt: NOW - 9 * 3600_000 }), NOW);
    expect([aborted, live].sort(byMostWanted).map((g) => g.joinCode)).toEqual(['LIVE01', 'ABC123']);
    expect(homeGames([aborted, live]).map((g) => g.joinCode)).toEqual(['LIVE01', 'ABC123']);
  });

  it('brings the tidy-up offer forward: one aborted game is enough', () => {
    const finished = listedGame(entry({ status: 'finished', result: { outcome: '1-0', reason: 'checkmate', at: NOW } }), NOW);
    expect(shouldOfferTidy([finished])).toBe(false);
    expect(shouldOfferTidy([finished, listedGame(entry({ joinCode: 'ABO123' }), NOW)])).toBe(true);
  });

  it('still refuses to tidy a game that is not over', () => {
    expect(forgetIsRefused(entry({ status: 'suspended' }))).toBe('suspended');
    expect(forgetIsRefused(entry({ status: 'active' }))).toBe('in_play');
    expect(forgetIsRefused(entry({ status: 'staging' }))).toBe('in_play');
  });
});

describe('an aborted game is collected like an unplayed one', () => {
  const facts = {
    status: 'aborted' as const,
    createdAt: NOW - 5 * 24 * 3600_000,
    updatedAt: NOW - 3600_000,
    resultAt: NOW - 3600_000,
    seenAt: null,
    suspendedBy: null,
  };
  it('whether or not it has moves', () => {
    for (const plies of [0, 1, 30]) {
      expect(collectionKind({ ...facts, plies })).toBe('unplayed');
      expect(collectionDue({ ...facts, plies })).toBe(NOW - 3600_000 + 30 * 24 * 3600_000);
    }
  });
});

// ---------------------------------------------------------------------------

function report(overrides: Partial<GameReport> = {}): GameReport {
  return {
    joinCode: 'K7M2PQ',
    fieldName: 'Broken field',
    startedAt: Date.UTC(2026, 8, 27, 10, 0, 0),
    finishedAt: Date.UTC(2026, 8, 27, 10, 5, 0),
    outcome: null,
    reason: 'aborted',
    initialMs: 600_000,
    incrementMs: 5_000,
    squareM: 8,
    boardM: 64,
    diagonalM: 64 * Math.SQRT2,
    travelM: { w: 20, b: 0 },
    moves: [
      {
        seq: 1,
        color: 'w',
        san: 'e4',
        uci: 'e2e4',
        from: 'e2',
        to: 'e4',
        carriedM: 16,
        carriedMs: 20_000,
        lift: null,
        place: null,
      },
    ],
    ...overrides,
  };
}

describe('an aborted game’s file', () => {
  it('says Result "*", abandoned, aborted, and why, in a closing comment', () => {
    const pgn = buildPgn(report(), { now: 0 });
    expect(pgn).toContain('[Result "*"]');
    expect(pgn).toContain('[Termination "abandoned"]');
    expect(pgn).toContain('[SatelliteEnd "aborted"]');
    // Wrapped at 80 columns, so the comment may break across lines.
    expect(pgn.replace(/\s+/g, ' ').trimEnd().endsWith(`${ABORTED_COMMENT} *`)).toBe(true);
    expect(termination('aborted')).toBe('abandoned');
  });

  it('adds nothing to a game still going', () => {
    const pgn = buildPgn(report({ reason: null, finishedAt: null }), { now: 0 });
    expect(pgn).not.toContain(ABORTED_COMMENT);
    expect(pgn).not.toContain('Termination');
  });

  it('reads as aborted on the review screen, not as still playing', () => {
    expect(resultWords(report(), 'w')).toBe('Aborted — no result');
    expect(resultWords(report({ reason: null }), 'w')).toBe('Still playing');
  });
});
