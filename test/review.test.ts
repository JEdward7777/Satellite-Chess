import { describe, expect, it } from 'vitest';

import { type GameReport, type ReportMove, walkOf, walksOf } from '../src/shared/review.js';
import {
  DISTANCE_HONESTY,
  PGN_EXPLANATION,
  colorWords,
  headlineDetailWords,
  headlineWords,
  moveWords,
  pgnOf,
  resultWords,
  secondsWords,
  walkRows,
  walkWords,
  whereWords,
} from '../src/client/review.js';
import { DISTANCE_HONESTY as RECORD_HONESTY } from '../src/client/record.js';
import { reviewHtml } from '../src/client/views/review.js';

/**
 * The post-game report (stages 8.1, 8.2): what one game adds up to, and the
 * sentences a player reads about it.
 *
 * The screen is checked by driving Chromium (`scripts/check-review.mjs`); what
 * is here is the arithmetic and the words, which is where a wrong claim would
 * be invisible in a screenshot.
 */

const STARTED = Date.UTC(2026, 8, 23, 14, 5, 9);
const DIAGONAL = 64 * Math.SQRT2;

function move(overrides: Partial<ReportMove> = {}): ReportMove {
  return {
    seq: 1,
    color: 'w',
    san: 'e4',
    uci: 'e2e4',
    from: 'e2',
    to: 'e4',
    carriedM: 16,
    carriedMs: 8_000,
    lift: null,
    place: null,
    ...overrides,
  };
}

function report(overrides: Partial<GameReport> = {}): GameReport {
  return {
    joinCode: 'K7M2PQ',
    fieldName: 'Riverside Park',
    startedAt: STARTED,
    finishedAt: STARTED + 1_800_000,
    outcome: '0-1',
    reason: 'checkmate',
    initialMs: 600_000,
    incrementMs: 5_000,
    squareM: 8,
    boardM: 64,
    diagonalM: DIAGONAL,
    travelM: { w: 400, b: 2_400 },
    moves: [
      move({ seq: 1, color: 'w', san: 'f3', carriedM: 16 }),
      move({ seq: 2, color: 'b', san: 'e5', carriedM: 24 }),
      move({ seq: 3, color: 'w', san: 'g4', carriedM: 12 }),
      move({ seq: 4, color: 'b', san: 'Qh4#', carriedM: 48, carriedMs: 95_000 }),
    ],
    ...overrides,
  };
}

describe('folding a report into one player’s walk', () => {
  it('counts only that player’s moves and carries', () => {
    expect(walkOf(report(), 'w')).toMatchObject({
      color: 'w',
      travelM: 400,
      moves: 2,
      carriedM: 28,
      longestCarryM: 16,
    });
    expect(walkOf(report(), 'b')).toMatchObject({ moves: 2, carriedM: 72, longestCarryM: 48 });
  });

  it('divides by the board’s diagonal for crossings (decision 0019)', () => {
    expect(walkOf(report(), 'b').crossings).toBeCloseTo(2_400 / DIAGONAL, 6);
  });

  it('keeps null for an unmeasured distance, and refuses to derive crossings from one', () => {
    const walk = walkOf(report({ travelM: { w: null, b: 2_400 } }), 'w');
    expect(walk.travelM).toBeNull();
    expect(walk.crossings).toBeNull();
  });

  it('has no crossings for a board with no size', () => {
    expect(walkOf(report({ diagonalM: 0 }), 'w').crossings).toBeNull();
  });

  it('puts the reader’s own walk first, whichever side they were', () => {
    expect(walksOf(report(), 'b').map((walk) => walk.color)).toEqual(['b', 'w']);
    expect(walksOf(report(), 'w').map((walk) => walk.color)).toEqual(['w', 'b']);
    // Nobody in particular reading it gets the board's own order.
    expect(walksOf(report(), null).map((walk) => walk.color)).toEqual(['w', 'b']);
  });
});

describe('the words', () => {
  it('leads with the distance the player walked (stage 8.2.2)', () => {
    expect(headlineWords(walkOf(report(), 'b'))).toBe('You covered 2.4 km');
    expect(headlineWords(walkOf(report(), 'w'))).toBe('You covered 400 m');
  });

  it('says nobody measured it rather than showing a zero', () => {
    const unmeasured = walkOf(report({ travelM: { w: null, b: 2_400 } }), 'w');
    expect(headlineWords(unmeasured)).toBe('Distance was not measured');
    expect(headlineDetailWords(unmeasured)).toContain('no figure for it');
    expect(headlineWords(null)).toBe('Distance was not measured');
  });

  it('puts the move count and the crossings in the line underneath', () => {
    const detail = headlineDetailWords(walkOf(report(), 'b'));
    expect(detail).toContain('2 moves');
    expect(detail).toContain('board crossing');
    // Decision 0040: what counts toward the number is stated, not implied.
    expect(detail).toContain('Walking during play only');
  });

  it('names the opponent by their color and nothing else', () => {
    const [mine, theirs] = walkRows(report(), 'b');
    expect(mine!.who).toBe('You · Black');
    expect(theirs!.who).toBe('Them · White');
    expect(mine!.distance).toBe('2.4 km');
    expect(theirs!.detail).toContain('longest carry 16 m');
    expect(colorWords('w')).toBe('White');
  });

  it('says a walk is unmeasured in the row too', () => {
    const rows = walkRows(report({ travelM: { w: null, b: null } }), 'w');
    expect(rows[0]!.distance).toBe('not measured');
  });

  it('reads the result from the player’s own side', () => {
    expect(resultWords(report(), 'b')).toBe('You won — checkmate');
    expect(resultWords(report(), 'w')).toBe('You lost — checkmate');
    expect(resultWords(report({ outcome: '1/2-1/2', reason: 'agreement' }), 'w')).toBe(
      'Drawn — agreement',
    );
    expect(resultWords(report(), null)).toBe('Black won — checkmate');
  });

  it('has something true to say about a game that is not over', () => {
    expect(resultWords(report({ outcome: null, reason: null }), 'w')).toBe('Still playing');
  });

  it('says where, without saying where', () => {
    // The field's name is player-written; the board size is a dimension, not a
    // position (decision 0018, rule 2 and rule 4).
    expect(whereWords(report())).toBe('Riverside Park · a 64 m board');
    expect(whereWords(report({ fieldName: null }))).toBe('a 64 m board');
  });

  it('gives every move its carry', () => {
    expect(moveWords(report().moves[0]!)).toEqual({
      ply: '1.',
      san: 'f3',
      detail: 'carried 16 m in 8 s',
    });
    expect(moveWords(report().moves[3]!)).toMatchObject({ ply: '2…', san: 'Qh4#' });
    expect(moveWords(report().moves[3]!).detail).toBe('carried 48 m in 1 min 35 s');
  });

  it('says so for a move with nothing stored, rather than showing zeroes', () => {
    expect(moveWords(move({ carriedM: 0, carriedMs: 0 })).detail).toBe('no walk recorded');
  });

  it('spells a carry’s duration in minutes once it is long', () => {
    expect(secondsWords(31_200)).toBe('31 s');
    expect(secondsWords(89_000)).toBe('89 s');
    expect(secondsWords(120_000)).toBe('2 min');
    expect(secondsWords(155_000)).toBe('2 min 35 s');
    expect(secondsWords(Number.NaN)).toBe('0 s');
  });

  it('reuses the record’s honesty sentences word for word (stage 8.2.3)', () => {
    // O-03 and O-12 are one set of claims about one number, and two wordings of
    // them would be two things to keep true.
    expect(DISTANCE_HONESTY).toBe(RECORD_HONESTY);
    expect(DISTANCE_HONESTY.join(' ')).toContain('taken on trust');
    expect(DISTANCE_HONESTY.join(' ')).toContain('leans short');
  });

  it('says what is in the file, and what is not', () => {
    expect(PGN_EXPLANATION).toContain('no coordinates');
  });
});

describe('the screen', () => {
  const pgn = pgnOf(report());
  const html = reviewHtml(report(), 'b', pgn, 'K7M2PQ');

  it('puts the distance above the sentence that explains it (decision 0019)', () => {
    expect(html.indexOf('data-review-distance')).toBeLessThan(
      html.indexOf('data-review-coverage'),
    );
    expect(html).toContain('You covered 2.4 km');
  });

  it('carries the honesty sentences on the screen, not behind a tap', () => {
    for (const sentence of DISTANCE_HONESTY) {
      expect(html).toContain(sentence.slice(0, 40));
    }
  });

  it('offers the file three ways, ending in a link the server answers', () => {
    expect(html).toContain('data-review-share');
    expect(html).toContain('data-review-copy');
    expect(html).toContain('data-review-text');
    expect(html).toContain('href="/api/game/K7M2PQ/pgn"');
    expect(html).toContain('satellite-chess-2026-09-23-riverside-park.pgn');
  });

  it('lists every carry', () => {
    expect(html).toContain('Qh4#');
    expect(html).toContain('carried 48 m in 1 min 35 s');
  });

  it('escapes a field name a player typed', () => {
    const nasty = reviewHtml(report({ fieldName: '<script>x</script>' }), 'w', pgn, 'K7M2PQ');
    expect(nasty).not.toContain('<script>');
    expect(nasty).toContain('&lt;script&gt;');
  });
});
