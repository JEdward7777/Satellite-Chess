import { describe, expect, it } from 'vitest';

import {
  SMALL_SQUARE_M,
  boardDiagonalM,
  checkCalibration,
  deriveGeometry,
  makeFieldSpec,
} from '../src/shared/field.js';
import { fromLocal } from '../src/shared/geo.js';
import {
  RECENT_LINES,
  type RecordGame,
  personalResult,
  standingOf,
  summarizeRecord,
} from '../src/shared/record.js';
import {
  DISTANCE_HONESTY,
  coverageWords,
  crossingsWords,
  distanceWords,
  lineWords,
  resultsWords,
} from '../src/client/record.js';
import { privacyHtml, recordHtml } from '../src/client/views/record.js';

/**
 * The permanent record (stage 2.3.5): which games count, what they add up to,
 * and the words a player reads about it.
 */

const NOW = Date.UTC(2026, 8, 19, 12);
let seq = 0;

function game(overrides: Partial<RecordGame> = {}): RecordGame {
  seq += 1;
  return {
    joinCode: `G${seq}`,
    color: 'w',
    outcome: '1-0',
    reason: 'checkmate',
    finishedAt: NOW - seq * 60_000,
    plies: 40,
    moves: 20,
    travelM: 1000,
    longestCarryM: 30,
    fieldName: 'The common',
    fieldKey: '0000000000000001',
    squareM: 8,
    boardM: 64,
    diagonalM: 64 * Math.SQRT2,
    ...overrides,
  };
}

describe('which games count (decision 0019, stage 2.3.5.2)', () => {
  it('counts a played game on squares of at least the floor', () => {
    expect(standingOf({ plies: 1, squareM: SMALL_SQUARE_M, travelM: 100 })).toBe('counted');
  });

  it('keeps a game on smaller squares as practice', () => {
    expect(standingOf({ plies: 40, squareM: SMALL_SQUARE_M - 0.01, travelM: 100 })).toBe('practice');
  });

  it('does not count a game in which nobody moved, whatever the field', () => {
    expect(standingOf({ plies: 0, squareM: 12, travelM: 0 })).toBe('unplayed');
  });

  it('counts a measured zero: walking nowhere is a distance', () => {
    expect(standingOf({ plies: 4, squareM: 12, travelM: 0 })).toBe('counted');
  });

  it('calls a game with no measurement unmeasured, before anything else', () => {
    // A game already in play when the per-game rule arrived. Whatever else is
    // true of it, it cannot be in a total whose headline is the distance.
    expect(standingOf({ plies: 40, squareM: 12, travelM: null })).toBe('unmeasured');
    expect(standingOf({ plies: 0, squareM: 2, travelM: null })).toBe('unmeasured');
  });

  it('uses the same floor as the calibration warning, so the two cannot drift', () => {
    const a1 = { lat: 51.4779, lng: -0.0015 };
    const at = (squareM: number) =>
      checkCalibration(makeFieldSpec('x', { a1, h8: fromLocal(a1, { e: 7 * squareM, n: 7 * squareM }) }));
    const just = (squareM: number) => at(squareM).warnings.some((w) => w.includes('narrowest'));
    expect(just(SMALL_SQUARE_M - 0.1)).toBe(true);
    expect(just(SMALL_SQUARE_M + 0.1)).toBe(false);
  });
});

describe('personalResult', () => {
  it('reads a result from each side of the board', () => {
    expect(personalResult('1-0', 'w')).toBe('win');
    expect(personalResult('1-0', 'b')).toBe('loss');
    expect(personalResult('0-1', 'b')).toBe('win');
    expect(personalResult('1/2-1/2', 'w')).toBe('draw');
  });
});

describe('summarizeRecord', () => {
  it('leaves practice and unplayed games out of every total, and says how many', () => {
    const record = summarizeRecord([
      game({ travelM: 1200 }),
      game({ squareM: 3, travelM: 5000, fieldName: 'Back garden', fieldKey: 'b' }),
      game({ plies: 0, moves: 0, travelM: 0 }),
    ]);
    expect(record.totals).toMatchObject({ games: 1, travelM: 1200, wins: 1, fields: 1 });
    expect(record.practiceGames).toBe(1);
    expect(record.unplayedGames).toBe(1);
    // All three are still in the player's own history.
    expect(record.recent.map((line) => line.standing).sort()).toEqual([
      'counted',
      'practice',
      'unplayed',
    ]);
  });

  it('adds up results, moves, crossings, longest carry and biggest board', () => {
    const record = summarizeRecord([
      game({ color: 'w', outcome: '1-0', moves: 20, longestCarryM: 30 }),
      game({ color: 'b', outcome: '1-0', moves: 19, longestCarryM: 55 }),
      game({
        outcome: '1/2-1/2',
        moves: 10,
        boardM: 96,
        diagonalM: 96 * Math.SQRT2,
        fieldName: 'The pitch',
        fieldKey: '2',
      }),
    ]);
    expect(record.totals).toMatchObject({
      games: 3,
      wins: 1,
      losses: 1,
      draws: 1,
      moves: 49,
      longestCarryM: 55,
      travelM: 3000,
      fields: 2,
    });
    expect(record.totals.biggestBoard).toEqual({ boardM: 96, fieldName: 'The pitch' });
    expect(record.totals.crossings).toBeCloseTo(
      2000 / (64 * Math.SQRT2) + 1000 / (96 * Math.SQRT2),
      9,
    );
    expect(record.fields[0]).toMatchObject({ name: 'The common', games: 2, travelM: 2000 });
  });

  it('counts copies of one field as one field, by lineage key', () => {
    const record = summarizeRecord([
      game({ fieldName: 'Riverside', fieldKey: 'k' }),
      game({ fieldName: 'Riverside (from Sam)', fieldKey: 'k' }),
    ]);
    expect(record.totals.fields).toBe(1);
  });

  it('lists the newest games first, and only so many', () => {
    const games = Array.from({ length: RECENT_LINES + 5 }, () => game());
    const record = summarizeRecord([...games].reverse());
    expect(record.recent).toHaveLength(RECENT_LINES);
    expect(record.recent[0].joinCode).toBe(games[0].joinCode);
  });

  it('leaves an unmeasured game out of the totals, and says how many', () => {
    const record = summarizeRecord([game({ travelM: 900 }), game({ travelM: null })]);
    expect(record.totals).toMatchObject({ games: 1, travelM: 900, fields: 1 });
    expect(record.unmeasuredGames).toBe(1);
    expect(record.recent.map((line) => line.standing)).toContain('unmeasured');
    expect(record.recent.find((line) => line.standing === 'unmeasured')?.travelM).toBeNull();
  });

  it('refuses to add a distance that is not one', () => {
    const record = summarizeRecord([game({ travelM: Number.NaN }), game({ travelM: -50 })]);
    expect(record.totals.travelM).toBe(0);
    expect(record.totals.games).toBe(2);
  });
});

describe('boardDiagonalM', () => {
  it('is corner to corner across the outer edges', () => {
    const a1 = { lat: 51.4779, lng: -0.0015 };
    const geo = deriveGeometry(makeFieldSpec('x', { a1, h8: fromLocal(a1, { e: 56, n: 56 }) }));
    expect(boardDiagonalM(geo)).toBeCloseTo(64 * Math.SQRT2, 3);
  });
});

describe('the words', () => {
  it('says a distance the way it would be repeated: meters, then one decimal of km', () => {
    expect(distanceWords(0)).toBe('0 m');
    expect(distanceWords(840.4)).toBe('840 m');
    expect(distanceWords(2430)).toBe('2.4 km');
    expect(distanceWords(126_400)).toBe('126 km');
    expect(distanceWords(Number.NaN)).toBe('0 m');
  });

  it('pluralizes crossings and results', () => {
    expect(crossingsWords(0)).toBe('no board crossings yet');
    expect(crossingsWords(1.02)).toBe('1.0 board crossing');
    expect(crossingsWords(3.14)).toBe('3.1 board crossings');
    expect(resultsWords({ wins: 3, draws: 1, losses: 2 })).toBe('3 won · 1 drawn · 2 lost');
  });

  it('names what the headline left out', () => {
    const record = summarizeRecord([
      game(),
      game({ squareM: 3 }),
      game({ plies: 0 }),
      game({ plies: 0 }),
    ]);
    const words = coverageWords(record);
    expect(words).toContain('Walked across 1 game');
    expect(words).toContain(`One game on squares under ${SMALL_SQUARE_M} m is kept as practice`);
    expect(words).toContain('2 games that ended before anyone moved are not counted');
  });

  it('says plainly that an old game has no distance to count', () => {
    const record = summarizeRecord([game({ travelM: null }), game({ travelM: null })]);
    expect(coverageWords(record)).toContain(
      '2 games played before the app measured distance per game have no distance to count',
    );
    expect(lineWords(record.recent[0]).detail).toContain('distance was not measured for this game');
  });

  it('marks a line that did not count, and says why', () => {
    const [practice] = summarizeRecord([game({ squareM: 3.2, fieldName: 'Yard' })]).recent;
    expect(lineWords(practice)).toEqual({
      title: 'Yard',
      detail: 'Won — checkmate · practice, not counted — 3.2 m squares',
    });
    const [counted] = summarizeRecord([game({ color: 'b', travelM: 2430 })]).recent;
    expect(lineWords(counted).detail).toBe('Lost — checkmate · 2.4 km');
  });

  it('is American English with metric units (decision 0036)', () => {
    const text = [
      recordHtml(summarizeRecord([game(), game({ squareM: 3 }), game({ travelM: null })]), NOW),
      privacyHtml(),
      ...DISTANCE_HONESTY,
    ].join(' ');
    expect(text).not.toMatch(/metre|kilometre|colour|neighbour|organis|recognis|travelled/i);
    expect(text).not.toMatch(/\b(yards?|miles?|feet|ft)\b/i);
  });
});

describe('the record screen', () => {
  it('leads with meters walked, and puts games played after it', () => {
    const html = recordHtml(summarizeRecord([game({ travelM: 2430 }), game({ travelM: 0 })]), NOW);
    const distance = html.indexOf('data-record-distance');
    const games = html.indexOf('Walked across 2 games');
    expect(distance).toBeGreaterThan(-1);
    expect(games).toBeGreaterThan(distance);
    expect(html).toContain('>2.4 km<');
  });

  it('says how far to trust the distance, both ways (O-03, O-12)', () => {
    const html = recordHtml(summarizeRecord([game()]), NOW);
    expect(html).toContain('taken on trust');
    expect(html).toContain('leans short');
    // And says it when there is nothing yet, too.
    expect(recordHtml(summarizeRecord([]), NOW)).toContain('taken on trust');
  });

  it('escapes a field name, which a player typed', () => {
    const html = recordHtml(summarizeRecord([game({ fieldName: '<img src=x>' })]), NOW);
    expect(html).not.toContain('<img');
  });
});

describe('the privacy statement (stage 2.3.5.1)', () => {
  it('says what is stored, what an opponent sees, and what cannot be done yet', () => {
    const text = privacyHtml();
    expect(text).toContain('Your opponent sees where you are');
    expect(text).toContain('no coordinates');
    expect(text).toContain('Anyone with a game');
    expect(text).toContain('Not possible yet');
    expect(text).toContain('no place names worked out from your');
  });
});
