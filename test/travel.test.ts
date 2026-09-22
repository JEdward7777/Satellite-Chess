import { describe, expect, it } from 'vitest';

import { MAX_PLAUSIBLE_SPEED_MPS } from '../src/shared/reach.js';
import { creditTravel } from '../src/worker/travel.js';

/**
 * How a game credits the distance a phone reports (stage 2.3.5.3, decision
 * 0040).
 *
 * The phone's counter runs for the life of the page. Until this rule, the game
 * took its value as the game's own distance, so a player who calibrated a field
 * and then played was credited the calibration walk, and a second game in the
 * same sitting inherited the first game's distance. Each case below is one of
 * the ways that number was wrong.
 */

const base = {
  leg: 'page-1',
  storedLeg: 'page-1',
  seenM: 100,
  active: true,
  budgetMs: 10_000,
};

describe('creditTravel', () => {
  it('credits what the same counter adds between two reports', () => {
    expect(creditTravel({ ...base, reportedM: 130 })).toEqual({
      creditM: 30,
      leg: 'page-1',
      seenM: 130,
    });
  });

  it('credits nothing for a counter it has not seen, and takes its baseline', () => {
    // A counter already at 2 km walked those 2 km somewhere else — calibrating,
    // crossing town, or in the last game.
    expect(creditTravel({ ...base, leg: 'page-2', reportedM: 2000 })).toEqual({
      creditM: 0,
      leg: 'page-2',
      seenM: 2000,
    });
  });

  it('credits nothing for a first report ever', () => {
    expect(
      creditTravel({ ...base, storedLeg: null, seenM: 0, budgetMs: null, reportedM: 42 }),
    ).toMatchObject({ creditM: 0, seenM: 42 });
  });

  it('never takes distance away', () => {
    expect(creditTravel({ ...base, reportedM: 60 })).toEqual({
      creditM: 0,
      leg: 'page-1',
      seenM: 100,
    });
  });

  it('moves the baseline but credits nothing outside active play', () => {
    // The walk to the back rank, a suspension, the walk home: not chess, and
    // not credited later either, because the baseline has moved past them.
    const paused = creditTravel({ ...base, active: false, reportedM: 400 });
    expect(paused).toEqual({ creditM: 0, leg: 'page-1', seenM: 400 });
    expect(creditTravel({ ...base, seenM: paused.seenM, reportedM: 410 }).creditM).toBe(10);
  });

  it('caps a credit at a sprint over the window it is given', () => {
    const credit = creditTravel({ ...base, budgetMs: 2_500, reportedM: 100_100 });
    expect(credit.creditM).toBeCloseTo(2.5 * MAX_PLAUSIBLE_SPEED_MPS, 6);
    // The baseline still moves to what was reported, so the excess is gone for
    // good rather than paid out a little at a time afterwards.
    expect(credit.seenM).toBe(100_100);
  });

  it('cannot be paid for a window it was not given', () => {
    // The caller measures the window from the later of the last report and the
    // last clock start, so a phone that says nothing through staging, a
    // suspension or a long think has no ceiling saved up to spend.
    expect(creditTravel({ ...base, budgetMs: 0, reportedM: 5_000 })).toMatchObject({
      creditM: 0,
      seenM: 5_000,
    });
  });

  it('ignores a report with no usable distance on it', () => {
    for (const reportedM of [undefined, null, 'far', Number.NaN, -5, Infinity]) {
      expect(creditTravel({ ...base, reportedM })).toEqual({
        creditM: 0,
        leg: 'page-1',
        seenM: 100,
      });
    }
  });
});
