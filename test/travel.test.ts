import { describe, expect, it } from 'vitest';

import { MAX_PLAUSIBLE_SPEED_MPS } from '../src/shared/reach.js';
import { MAX_OWED_TRAVEL_M, creditTravel } from '../src/worker/travel.js';

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
  owedM: 0,
  active: true,
  budgetMs: 10_000,
};

describe('creditTravel', () => {
  it('credits what the same counter adds between two reports', () => {
    expect(creditTravel({ ...base, reportedM: 130 })).toEqual({
      creditM: 30,
      leg: 'page-1',
      seenM: 130,
      owedM: 0,
    });
  });

  it('credits nothing for a counter it has not seen, and takes its baseline', () => {
    // A counter already at 2 km walked those 2 km somewhere else — calibrating,
    // crossing town, or in the last game.
    expect(creditTravel({ ...base, leg: 'page-2', reportedM: 2000 })).toEqual({
      creditM: 0,
      leg: 'page-2',
      seenM: 2000,
      owedM: 0,
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
      owedM: 0,
    });
  });

  it('moves the baseline but credits nothing outside active play', () => {
    // The walk to the back rank, a suspension, the walk home: not chess, and
    // not credited later either, because the baseline has moved past them.
    const paused = creditTravel({ ...base, active: false, reportedM: 400 });
    expect(paused).toEqual({ creditM: 0, leg: 'page-1', seenM: 400, owedM: 0 });
    expect(creditTravel({ ...base, seenM: paused.seenM, reportedM: 410 }).creditM).toBe(10);
  });

  it('caps a credit at a sprint over the window it is given', () => {
    const credit = creditTravel({ ...base, budgetMs: 2_500, reportedM: 100_100 });
    expect(credit.creditM).toBeCloseTo(2.5 * MAX_PLAUSIBLE_SPEED_MPS, 6);
    // The baseline still moves to what was reported. Of the excess, no more
    // than a relay interval's sprint is kept to pay later (O-36): a claimed
    // hundred kilometers is not paid out at a sprint for the rest of the game.
    expect(credit.seenM).toBe(100_100);
    expect(credit.owedM).toBe(MAX_OWED_TRAVEL_M);
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

  describe('what the cap clips is owed, not lost (O-36)', () => {
    it('pays a relay landing just after a ply in full, over the next window', () => {
      // A ply re-stamped the window 250 ms ago, and the relay carries a hop
      // the accumulator confirmed just after it: 3 m of ceiling for 10 m.
      const clipped = creditTravel({ ...base, budgetMs: 250, reportedM: 110 });
      expect(clipped.creditM).toBeCloseTo(3, 6);
      expect(clipped.owedM).toBeCloseTo(7, 6);
      // The next report, 2.5 s on, adds 2 m of its own: 9 m, well inside 30.
      const next = creditTravel({ ...base, seenM: 110, owedM: clipped.owedM, budgetMs: 2_500, reportedM: 112 });
      expect(next.creditM).toBeCloseTo(9, 6);
      expect(next.owedM).toBe(0);
      // Nothing gained or lost overall: exactly what the counter added.
      expect(clipped.creditM + next.creditM).toBeCloseTo(12, 6);
    });

    it('pays what is owed only under a ceiling, a little at a time', () => {
      const once = creditTravel({ ...base, owedM: 20, budgetMs: 1_000, reportedM: 100 });
      expect(once.creditM).toBeCloseTo(12, 6);
      expect(once.owedM).toBeCloseTo(8, 6);
      expect(creditTravel({ ...base, owedM: 20, budgetMs: 0, reportedM: 100 })).toMatchObject({
        creditM: 0,
        owedM: 20,
      });
    });

    it('never holds more than a relay interval at a sprint, however much is claimed', () => {
      expect(MAX_OWED_TRAVEL_M).toBe(30);
      expect(creditTravel({ ...base, owedM: 1e9, budgetMs: 60_000, reportedM: 100 })).toMatchObject({
        creditM: MAX_OWED_TRAVEL_M,
        owedM: 0,
      });
      for (const owedM of [Number.NaN, -5, Infinity]) {
        expect(creditTravel({ ...base, owedM, budgetMs: 60_000, reportedM: 100 }).creditM).toBe(0);
      }
    });

    it('never makes the total exceed what the counter reported', () => {
      // 5 m a report, every window cut to 50 ms, then reports that add nothing:
      // the cap binds, and what is owed is paid down but never past the claim.
      let state = { seenM: 100, owedM: 0 };
      let credited = 0;
      for (let i = 1; i <= 40; i++) {
        const r = creditTravel({ ...base, ...state, budgetMs: 50, reportedM: 100 + i * 5 });
        credited += r.creditM;
        state = { seenM: r.seenM, owedM: r.owedM };
      }
      for (let i = 0; i < 10; i++) {
        const r = creditTravel({ ...base, ...state, budgetMs: 2_500, reportedM: 300 });
        credited += r.creditM;
        state = { seenM: r.seenM, owedM: r.owedM };
      }
      expect(credited).toBeLessThanOrEqual(200 + 1e-9);
      expect(state.owedM).toBe(0);
    });

    it('drops what is owed outside active play, and keeps it across a reload in play', () => {
      expect(creditTravel({ ...base, owedM: 7, active: false, reportedM: 120 })).toEqual({
        creditM: 0,
        leg: 'page-1',
        seenM: 120,
        owedM: 0,
      });
      expect(creditTravel({ ...base, owedM: 7, active: false, reportedM: 'x' }).owedM).toBe(0);
      expect(creditTravel({ ...base, owedM: 7, leg: 'page-2', reportedM: 3 })).toEqual({
        creditM: 0,
        leg: 'page-2',
        seenM: 3,
        owedM: 7,
      });
    });
  });

  it('ignores a report with no usable distance on it', () => {
    for (const reportedM of [undefined, null, 'far', Number.NaN, -5, Infinity]) {
      expect(creditTravel({ ...base, owedM: 4, reportedM })).toEqual({
        creditM: 0,
        leg: 'page-1',
        seenM: 100,
        owedM: 4,
      });
    }
  });
});
