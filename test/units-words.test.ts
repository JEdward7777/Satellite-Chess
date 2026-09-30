import { describe, expect, it } from 'vitest';

import {
  checkCalibration,
  deriveGeometry,
  describeSquares,
  makeFieldSpec,
  squareCentreLatLng,
  squareSizeWords,
} from '../src/shared/field.js';
import { fromLocal } from '../src/shared/geo.js';
import {
  DEFAULT_REACH,
  type Refusal,
  checkCarry,
  checkReachTo,
  outOfReachAdvice,
  refusalFromWire,
  refusalWords,
} from '../src/shared/reach.js';
import { fromSquare } from '../src/shared/squares.js';
import type { GameReport } from '../src/shared/review.js';
import { summarizeRecord, type RecordGame } from '../src/shared/record.js';
import { coverageWords, distanceWords, lineWords } from '../src/client/record.js';
import { headlineWords, moveWords, shareMessageWords, walkWords, whereWords } from '../src/client/review.js';
import { walkOf } from '../src/shared/review.js';
import { reviewHtml } from '../src/client/views/review.js';
import { recordHtml } from '../src/client/views/record.js';
import { type CarryGuidance, carryPrompt, carryReadout, errorWords, metres } from '../src/client/views/game.js';
import { myHandshakeLine, opponentHandshakeLine } from '../src/client/handshake.js';
import { sizeHint, tapRefusal } from '../src/client/views/calibrate.js';
import { emptyDraft as emptyCreateDraft, reachNote } from '../src/client/views/create.js';
import { describeGpsError, gpsErrorWords } from '../src/client/gps.js';
import { unitsSectionHtml, unitsStatusWords } from '../src/client/views/account.js';

/**
 * Every distance a player reads, said in US units (O-21, decision 0049) — and
 * the metric sentence unchanged, because a player who never touches the
 * setting must see nothing different.
 *
 * The rule under test everywhere here: the *numbers* underneath are meters and
 * the verdicts are the same whatever the units; only the words move.
 */

const A1 = { lat: 51.4779, lng: -0.0015 };
const SQUARE_M = 8;
const spec = makeFieldSpec('t', { a1: A1, h8: fromLocal(A1, { e: 7 * SQUARE_M, n: 7 * SQUARE_M }) });
const geo = deriveGeometry(spec);
const centre = (sq: string) => squareCentreLatLng(geo, fromSquare(sq));

describe('a refusal, from the server’s figures', () => {
  it('is the server’s own metric sentence, word for word', () => {
    const verdict = checkReachTo(geo, centre('a1'), 12, 'a8');
    expect(verdict.refusal).toBeDefined();
    expect(refusalWords(verdict.refusal as Refusal)).toBe(verdict.message);
    expect(verdict.message).toBe(
      'You are 52.0 m from a8 and your reach is 3.2 m. Walk closer, or if you are already ' +
        'there, your position is only accurate to ±12 m: hold the phone up in the open and ' +
        'wait for it to tighten.',
    );
  });

  it('says the same refusal in feet', () => {
    const verdict = checkReachTo(geo, centre('a1'), 12, 'a8');
    expect(refusalWords(verdict.refusal as Refusal, 'us')).toBe(
      'You are 171 ft from a8 and your reach is 10 ft. Walk closer, or if you are already ' +
        'there, your position is only accurate to ±39 ft: hold the phone up in the open and ' +
        'wait for it to tighten.',
    );
  });

  it('keeps the lift’s own prefix, in both units', () => {
    const at = (sq: string, t: number) => ({ pos: centre(sq), accuracyM: 2, at: t });
    const lifted = checkCarry(geo, at('d4', 0), at('a8', 40_000), 'a1', 'a8');
    expect(lifted.refusal).toMatchObject({ kind: 'reach', square: 'a1', liftedFrom: 'a1' });
    expect(refusalWords(lifted.refusal as Refusal)).toBe(lifted.message);
    expect(lifted.message).toMatch(/^When you picked the piece up you were not at a1\. You are [\d.]+ m from a1/);
    expect(refusalWords(lifted.refusal as Refusal, 'us')).toMatch(
      /^When you picked the piece up you were not at a1\. You are \d+ ft from a1 and your reach is 10 ft\. Walk closer\.$/,
    );
  });

  it('says a vague fix in feet, and "unknown" for no accuracy at all', () => {
    const vague = checkReachTo(geo, centre('e2'), 1200, 'e2');
    expect(vague.code).toBe('accuracy');
    expect(refusalWords(vague.refusal as Refusal)).toBe(vague.message);
    expect(refusalWords(vague.refusal as Refusal, 'us')).toBe(
      'Your position is only accurate to ±3,937 ft, and moves need ±82 ft or better. Step into ' +
        'the open and wait for the fix to tighten.',
    );
    const none = checkReachTo(geo, centre('e2'), Number.POSITIVE_INFINITY, 'e2');
    // Infinity cannot cross JSON; it travels as null and still reads "unknown".
    const wire = JSON.parse(JSON.stringify(none.refusal));
    expect(wire.accuracyM).toBeNull();
    expect(refusalWords(refusalFromWire(wire) as Refusal, 'us')).toMatch(/accurate to unknown, and moves need ±82 ft/);
  });

  it('sends figures for a lift whose fix was too vague, found at the place', () => {
    const lift = { pos: centre('a1'), accuracyM: 40, at: 0 };
    const place = { pos: centre('a8'), accuracyM: 2, at: 40_000 };
    const refused = checkCarry(geo, lift, place, 'a1', 'a8');
    expect(refused.code).toBe('accuracy');
    expect(refused.refusal).toEqual({ kind: 'accuracy', accuracyM: 40, maxAccuracyM: 25, liftedFrom: 'a1' });
    // The metric sentence is what the server always sent, word for word.
    expect(refused.message).toBe(
      'When you picked the piece up you were not at a1. Your position is only accurate to ±40 m, ' +
        'and moves need ±25 m or better. Step into the open and wait for the fix to tighten.',
    );
    expect(refusalWords(refused.refusal as Refusal)).toBe(refused.message);
    const wire = refusalFromWire(JSON.parse(JSON.stringify(refused.refusal)));
    expect(refusalWords(wire as Refusal, 'us')).toBe(
      'When you picked the piece up you were not at a1. Your position is only accurate to ±131 ft, ' +
        'and moves need ±82 ft or better. Step into the open and wait for the fix to tighten.',
    );
    expect(refusalFromWire({ kind: 'accuracy', accuracyM: 40, maxAccuracyM: 25, liftedFrom: 'z0' })).toBeNull();
  });

  it('says an implausible carry in feet', () => {
    const at = (sq: string, t: number) => ({ pos: centre(sq), accuracyM: 2, at: t });
    const jumped = checkCarry(geo, at('a1', 0), at('a8', 200), 'a1', 'a8');
    expect(refusalWords(jumped.refusal as Refusal)).toBe(jumped.message);
    expect(jumped.message).toBe('That is 56 m in 0.2 s. Either your GPS jumped or something is wrong.');
    expect(refusalWords(jumped.refusal as Refusal, 'us')).toBe(
      'That is 184 ft in 0.2 s. Either your GPS jumped or something is wrong.',
    );
  });

  it('says the back-rank refusal in feet', () => {
    const refusal: Refusal = {
      kind: 'back_rank',
      nearestM: 12,
      reachM: 3.2,
      accuracyM: 3,
      goodAccuracyM: DEFAULT_REACH.goodAccuracyM,
    };
    expect(refusalWords(refusal)).toBe(
      'You are 12 m from your back rank and your reach is 3.2 m. Walk to your own end of the board.',
    );
    expect(refusalWords(refusal, 'us')).toBe(
      'You are 39 ft from your back rank and your reach is 10 ft. Walk to your own end of the board.',
    );
  });

  it('gives advice about a vague fix only when the fix is vague, and never for a null one', () => {
    expect(outOfReachAdvice('Walk closer', 3)).toBe('Walk closer.');
    expect(outOfReachAdvice('Walk closer', null)).toBe('Walk closer.');
    expect(outOfReachAdvice('Walk closer', 12, DEFAULT_REACH, 'us')).toMatch(/±39 ft/);
  });

  it('refuses a refusal from the wire that it cannot say sensibly', () => {
    for (const bad of [
      null,
      'reach',
      { kind: 'reach' },
      { kind: 'reach', square: 'z9', distanceM: 1, reachM: 1, accuracyM: 1, goodAccuracyM: 5 },
      { kind: 'reach', square: 'a1', distanceM: 'far', reachM: 1, accuracyM: 1, goodAccuracyM: 5 },
      { kind: 'reach', square: 'a1', distanceM: 1, reachM: 1, accuracyM: 1, goodAccuracyM: 5, liftedFrom: 'x' },
      { kind: 'accuracy', accuracyM: 'bad', maxAccuracyM: 25 },
      { kind: 'implausible', carriedM: 5 },
      { kind: 'back_rank', nearestM: 1, reachM: 1, accuracyM: 1 },
      { kind: 'teleport' },
    ]) {
      expect(refusalFromWire(bad)).toBeNull();
    }
  });

  it('reads the server’s sentence when the error has no figures', () => {
    expect(errorWords({ message: 'It is not your turn.' }, 'us')).toBe('It is not your turn.');
    expect(errorWords({ message: 'kept', refusal: { kind: 'nonsense' } as unknown as Refusal }, 'us')).toBe('kept');
    const verdict = checkReachTo(geo, centre('a1'), 2, 'a8');
    expect(errorWords({ message: verdict.message as string, refusal: verdict.refusal }, 'us')).toMatch(/ft from a8/);
    expect(errorWords({ message: verdict.message as string, refusal: verdict.refusal }, 'metric')).toBe(verdict.message);
  });
});

describe('a field, described', () => {
  it('in metric exactly as before', () => {
    expect(describeSquares(geo)).toBe('8.0 m squares · 64 m a side');
    expect(squareSizeWords(8, 8)).toBe('8.0 m across');
    expect(squareSizeWords(12.1, 6)).toBe('12.1 m along the files, 6.0 m along the ranks');
  });

  it('in feet for a square and yards for the board', () => {
    expect(describeSquares(geo, 'us')).toBe('26 ft squares · 70 yd a side');
    expect(squareSizeWords(8, 8, 'us')).toBe('26 ft across');
    expect(squareSizeWords(12.1, 6, 'us')).toBe('40 ft along the files, 20 ft along the ranks');
  });

  it('a rectangle shares one unit between its two steps', () => {
    const rect = deriveGeometry(
      makeFieldSpec('r', {
        a1: A1,
        h1: fromLocal(A1, { e: 7 * 12, n: 0 }),
        h8: fromLocal(A1, { e: 7 * 12, n: 7 * 6 }),
        a8: fromLocal(A1, { e: 0, n: 7 * 6 }),
      }),
    );
    expect(describeSquares(rect)).toMatch(/^12\.0 × 6\.0 m squares · \d+ m across$/);
    expect(describeSquares(rect, 'us')).toMatch(/^39 × 20 ft squares · \d+ yd across$/);
  });
});

describe('the calibration warnings, and the sizes they offer', () => {
  const board = (squareM: number) =>
    makeFieldSpec('x', { a1: A1, h8: fromLocal(A1, { e: 7 * squareM, n: 7 * squareM }) });

  it('offers a round size in feet, not a converted one', () => {
    const small = checkCalibration(board(3), { units: 'us' });
    expect(small.warnings.join(' ')).toMatch(/only 9\.8 ft across at the narrowest.*15 ft or more plays much better/);
    const tiny = checkCalibration(board(1.5), { units: 'us' });
    expect(tiny.errors.join(' ')).toMatch(/at least 80 ft corner to corner/);
  });

  it('keeps the metric advice as it was', () => {
    expect(checkCalibration(board(3)).warnings.join(' ')).toMatch(/only 3\.0 m across.*5 m or more plays much better/);
    expect(checkCalibration(board(1.5)).errors.join(' ')).toMatch(/at least 25 m corner to corner/);
  });

  it('measures a big board in yards, and gives the same verdict in either unit', () => {
    const big = checkCalibration(board(25), { units: 'us' });
    expect(big.warnings.join(' ')).toMatch(/Squares are 82 ft across, so the board is 219 yd a side/);
    expect(big.ok).toBe(checkCalibration(board(25)).ok);
    expect(big.warnings.length).toBe(checkCalibration(board(25)).warnings.length);
    const huge = checkCalibration(board(50), { units: 'us' });
    expect(huge.errors.join(' ')).toMatch(/a 437 yd board/);
  });

  it('warns about a vague calibration in feet', () => {
    const vague = checkCalibration(board(8), { worstAccuracyM: 7, units: 'us' });
    expect(vague.warnings.join(' ')).toMatch(/±23 ft against 26 ft squares/);
  });

  it('suggests a board in round numbers of the player’s units before the first tap', () => {
    expect(sizeHint('us')).toContain('5 to 10 yards');
    expect(sizeHint('us')).toContain('40 to 80 yards');
    expect(sizeHint()).toContain('5 to 10 m');
  });

  it('refuses a vague tap in feet', () => {
    const fix = { pos: A1, accuracyM: 30, at: 0 };
    expect(tapRefusal(fix, 'us')).toMatch(/only good to ±98 ft/);
    expect(tapRefusal(fix)).toMatch(/only good to ±30 m/);
  });
});

describe('the create screen', () => {
  it('says the reach on this field in feet', () => {
    const draft = emptyCreateDraft([spec]);
    expect(reachNote(draft, spec)).toContain('about 3.2 m on this field');
    expect(reachNote(draft, spec, 'us')).toContain('about 10 ft on this field');
  });
});

describe('the game screen', () => {
  const guidance = (walkM: number): CarryGuidance =>
    ({
      from: 'e2',
      piece: 'p',
      color: 'w',
      mine: true,
      destinations: ['e4'],
      inReach: [],
      pending: false,
      nearest: { square: 'e4', distanceM: walkM + 3, walkM },
    }) as CarryGuidance;

  it('says the walk to a square in feet', () => {
    expect(metres(4.26, 'us')).toBe('14 ft');
    expect(carryPrompt(guidance(12), 'us')).toBe(
      'Carrying. Walk 39 ft to e4, or to any other marked square.',
    );
    expect(carryReadout(guidance(2), 'us')).toBe('e2 → e4 · 6.6 ft');
    expect(carryReadout(guidance(2))).toBe('e2 → e4 · 2.0 m');
  });

  it('says the walk to the back rank in feet', () => {
    expect(myHandshakeLine(false, { inZone: false, walkM: 23.4 }, 'us')).toBe(
      'Walk to your own back rank — 77 ft to go.',
    );
    expect(
      opponentHandshakeLine({ connected: true, inStartZone: false }, { inZone: false, walkM: 30 }, 'us'),
    ).toContain('about 98 ft away');
  });

  it('says a coarse fix as half a mile, not as 0.62 mi', () => {
    const coarse = describeGpsError('coarse', 'ios');
    expect(coarse.message).toContain('about a kilometer');
    expect(gpsErrorWords(coarse, 'us')).toContain('about half a mile');
    expect(gpsErrorWords(coarse, 'metric')).toBe(coarse.message);
    // An error with no distance in it reads the same either way.
    const denied = describeGpsError('permission_denied', 'android');
    expect(gpsErrorWords(denied, 'us')).toBe(denied.message);
  });
});

let seq = 0;
function game(overrides: Partial<RecordGame> = {}): RecordGame {
  seq += 1;
  return {
    joinCode: `G${seq}`,
    color: 'w',
    outcome: '1-0',
    reason: 'checkmate',
    finishedAt: Date.UTC(2026, 8, 19) - seq * 60_000,
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

describe('the record', () => {
  it('leads with yards, then miles', () => {
    expect(distanceWords(840, 'us')).toBe('919 yd');
    expect(distanceWords(2430, 'us')).toBe('1.5 mi');
    expect(distanceWords(Number.NaN, 'us')).toBe('0 yd');
  });

  it('writes a practice game’s squares and the floor in feet', () => {
    const record = summarizeRecord([game({ squareM: 3, travelM: 200 }), game()]);
    expect(coverageWords(record, 'us')).toContain('on squares under 13 ft');
    expect(coverageWords(record)).toContain('on squares under 4 m');
    const practice = record.recent.find((line) => line.standing === 'practice');
    expect(lineWords(practice!, 'us').detail).toContain('practice, not counted — 9.8 ft squares');
    expect(lineWords(practice!).detail).toContain('practice, not counted — 3.0 m squares');
  });

  it('draws the whole screen in US units', () => {
    const html = recordHtml(summarizeRecord([game({ travelM: 3000, longestCarryM: 40 })]), Date.UTC(2026, 8, 20), 'us');
    expect(html).toContain('1.9 mi');
    expect(html).toContain('44 yd');
    expect(html).toContain('70 yd');
    expect(html).not.toMatch(/\d m\b|\bkm\b/);
  });

  it('never turns an unmeasured game into a distance', () => {
    const record = summarizeRecord([game({ travelM: null })]);
    const line = record.recent[0];
    expect(lineWords(line, 'us').detail).toContain('distance was not measured');
  });
});

describe('the review', () => {
  const report: GameReport = {
    joinCode: 'K7M2PQ',
    fieldName: 'Riverside Park',
    startedAt: 0,
    finishedAt: 1_800_000,
    outcome: '0-1',
    reason: 'checkmate',
    initialMs: 600_000,
    incrementMs: 5_000,
    squareM: 8,
    boardM: 73.2,
    diagonalM: 64 * Math.SQRT2,
    travelM: { w: 400, b: 2_400 },
    moves: [
      {
        seq: 1,
        color: 'w',
        san: 'f3',
        uci: 'f2f3',
        from: 'f2',
        to: 'f3',
        carriedM: 16,
        carriedMs: 8_000,
        lift: null,
        place: null,
      },
    ],
  };

  it('says "You covered" in miles, and the share line with it', () => {
    expect(headlineWords(walkOf(report, 'b'), 'us')).toBe('You covered 1.5 mi');
    expect(headlineWords(walkOf(report, 'b'))).toBe('You covered 2.4 km');
    expect(shareMessageWords(walkOf(report, 'b'), 'us')).toBe('You covered 1.5 mi playing chess. Here is the game.');
    expect(headlineWords(walkOf({ ...report, travelM: { w: null, b: null } }, 'w'), 'us')).toBe(
      'Distance was not measured',
    );
  });

  it('measures the board in yards, with the article of the number read', () => {
    expect(whereWords(report, 'us')).toBe('Riverside Park · an 80 yd board');
    expect(whereWords(report)).toBe('Riverside Park · a 73 m board');
  });

  it('says every carry in yards', () => {
    expect(moveWords(report.moves[0], 'us').detail).toBe('carried 17 yd in 8 s');
    expect(walkWords(walkOf(report, 'w'), 'w', 'us')).toMatchObject({
      distance: '437 yd',
      detail: expect.stringContaining('longest carry 17 yd'),
    });
  });

  it('holds every US number to its unit on a narrow screen', () => {
    const html = reviewHtml(report, 'b', { text: '', fileName: 'x.pgn' }, 'K7M2PQ', 'us');
    expect(html).toContain('1.5&nbsp;mi');
    expect(html).toContain('17&nbsp;yd');
    // Everything but the field line, which is a caption and wraps as it
    // always has in metric too.
    const numbers = html.replace(/<p class="dim" data-review-where>.*?<\/p>/, '');
    expect(numbers).not.toMatch(/\d mi\b|\d yd\b/);
  });
});

describe('the account screen', () => {
  it('offers both, and says where the choice is kept', () => {
    const html = unitsSectionHtml();
    expect(html).toContain('data-units="us"');
    expect(html).toContain('data-units="metric"');
    expect(unitsStatusWords('saved')).toBe('Saved to your account.');
    expect(unitsStatusWords('pending')).toContain('next time you open the app');
    expect(unitsStatusWords('default')).toContain('language setting');
  });
});
