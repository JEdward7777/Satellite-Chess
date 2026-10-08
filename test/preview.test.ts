import { describe, expect, it } from 'vitest';

import {
  deriveGeometry,
  fromBoardPoint,
  makeFieldSpec,
  squareCentreLatLng,
  toBoardPoint,
} from '../src/shared/field.js';
import { fromLocal } from '../src/shared/geo.js';
import { DEFAULT_REACH, checkReachTo, reachFromSquares } from '../src/shared/reach.js';
import { fromSquare, toSquare } from '../src/shared/squares.js';
import { type Units, lengthNumber } from '../src/shared/units.js';
import { leewayM, previewVerdict, squareInsetM, testSquare } from '../src/client/preview.js';

/**
 * The solo preview's rules (O-49, decision 0051). The screen is checked by
 * `scripts/check-preview.mjs`; what is here is the verdict and the tap test.
 */

const A1 = { lat: 51.4779, lng: -0.0015 };

/** A square board with squares `m` across. */
function squareBoard(m: number) {
  return deriveGeometry(makeFieldSpec('t', { a1: A1, h8: fromLocal(A1, { e: 7 * m, n: 7 * m }) }));
}

/** A four-corner board from its two steps, as ground offsets. */
function board(file: { e: number; n: number }, rank: { e: number; n: number }) {
  const at = (f: number, r: number) =>
    fromLocal(A1, { e: f * file.e + r * rank.e, n: f * file.n + r * rank.n });
  return deriveGeometry(
    makeFieldSpec('t', { a1: at(0, 0), h1: at(7, 0), h8: at(7, 7), a8: at(0, 7) }),
  );
}

const geo8 = squareBoard(8);

/** `du`/`dv` meters from the centre of `sq`, in board space. */
function near(geo: ReturnType<typeof squareBoard>, sq: string, du: number, dv: number) {
  const c = toBoardPoint(geo, squareCentreLatLng(geo, fromSquare(sq)));
  return fromBoardPoint(geo, { u: c.u + du, v: c.v + dv });
}

describe('squareInsetM', () => {
  it('is half a square on a square board', () => {
    expect(squareInsetM(geo8)).toBeCloseTo(4, 3);
  });

  it('is half the narrow way across on a long board', () => {
    expect(squareInsetM(board({ e: 12, n: 0 }, { e: 0, n: 6 }))).toBeCloseTo(3, 3);
  });

  it('is less than half the shorter step when the board leans', () => {
    // 8 m steps at 60 degrees: the cell is 8 sin 60 = 6.93 m across, not 8.
    const leaning = board({ e: 8, n: 0 }, { e: 4, n: 8 * Math.sin(Math.PI / 3) });
    expect(squareInsetM(leaning)).toBeCloseTo((8 * Math.sin(Math.PI / 3)) / 2, 2);
  });

  it('is exactly where a move on your own square starts being refused', () => {
    // The leeway is the rule's own boundary, not an estimate of it: just inside
    // it the game takes the move, just outside it refuses.
    const leeway = leewayM(geo8);
    expect(leeway).toBeCloseTo(4 + 0.4 * 8, 3);
    const inside = checkReachTo(geo8, near(geo8, 'e4', 0, leeway - 0.05), 3, 'e4');
    const outside = checkReachTo(geo8, near(geo8, 'e4', 0, leeway + 0.05), 3, 'e4');
    expect(inside.ok).toBe(true);
    expect(outside.ok).toBe(false);
  });
});

describe('previewVerdict', () => {
  // On 8 m squares at the default 0.4: 4 m to the edge plus 3.2 m of reach,
  // give or take the projection's last few decimals.
  const leeway = leewayM(geo8);

  it('waits for a fix', () => {
    const v = previewVerdict(geo8, null);
    expect(v.level).toBe('waiting');
    expect(v.headline).toBe('Waiting for GPS');
  });

  it('refuses above the game’s own accuracy limit, whatever the field', () => {
    const v = previewVerdict(geo8, DEFAULT_REACH.maxAccuracyM + 1);
    expect(v.level).toBe('refused');
    expect(v.reason).toContain('±25 m');
    expect(previewVerdict(geo8, Infinity).level).toBe('refused');
    // At the limit itself the game still takes a move, so the field is judged.
    expect(previewVerdict(squareBoard(60), DEFAULT_REACH.maxAccuracyM).level).toBe('good');
  });

  it('calls it playable with the claim inside the leeway', () => {
    // The 2026-09-06 walk: median claim 3.37 m, never under 3.00 m, every fix
    // inside its circle, no refusals on 6 to 12 m squares (decision 0031).
    expect(previewVerdict(geo8, 3.37).level).toBe('good');
    expect(previewVerdict(squareBoard(6), 3.37).level).toBe('good');
    expect(previewVerdict(geo8, leeway).level).toBe('good'); // equal is a yes
  });

  it('warns of the odd refusal up to twice the leeway', () => {
    expect(previewVerdict(geo8, leeway + 0.1).level).toBe('tight');
    expect(previewVerdict(geo8, 2 * leeway).level).toBe('tight');
    expect(previewVerdict(geo8, leeway + 0.1).reason).toContain('try again');
  });

  it('calls it hard past twice the leeway, and says how to find out for sure', () => {
    const v = previewVerdict(geo8, 2 * leeway + 0.1);
    expect(v.level).toBe('poor');
    expect(v.reason).toContain('tap it');
  });

  it('judges with the reach it is given, as a game would', () => {
    // More reach is more leeway: 4 + 1.5 x 8 = 16 m, so ±15 m is fine.
    expect(previewVerdict(geo8, 15).level).toBe('poor');
    expect(previewVerdict(geo8, 15, reachFromSquares(1.5)).level).toBe('good');
    expect(previewVerdict(geo8, 8, reachFromSquares(1.5)).leewayM).toBeCloseTo(16, 3);
  });

  it('judges a long board by its narrow way', () => {
    // 12 x 4 m: 2 m to the long edges, plus 0.4 x sqrt(48) of reach.
    const long = board({ e: 12, n: 0 }, { e: 0, n: 4 });
    const v = previewVerdict(long, 5);
    expect(v.leewayM).toBeCloseTo(2 + 0.4 * Math.sqrt(48), 2);
    expect(v.level).toBe('tight');
  });

  it('says when squares are small enough to be only practice', () => {
    const small = previewVerdict(squareBoard(3), 3);
    expect(small.notes.join(' ')).toContain('practice');
    expect(previewVerdict(squareBoard(4), 1).notes).toEqual([]);
  });

  it('says the dot may name a neighbor only below a yes', () => {
    // ±5 m is past half of an 8 m square, but inside the leeway: a yes, and
    // the yes is the whole story.
    expect(previewVerdict(geo8, 5).notes).toEqual([]);
    expect(previewVerdict(geo8, 10).notes.join(' ')).toContain('neighbor');
  });

  it('speaks in the player’s units', () => {
    const us = previewVerdict(geo8, 10, DEFAULT_REACH, 'us');
    expect(us.reason).toContain('ft');
    expect(us.reason).not.toMatch(/\d m\b/);
    expect(previewVerdict(geo8, 30, DEFAULT_REACH, 'us').reason).toContain('±82 ft');
    const small = previewVerdict(squareBoard(3), 3, DEFAULT_REACH, 'us');
    expect(small.notes.join(' ')).toContain('9.8 ft');
  });
});

describe('the verdict sentence never contradicts itself', () => {
  /** The claim and the leeway as the sentence shows them, as numbers. */
  function shown(reason: string): { claim: number; leeway: number } {
    const m = /says ±([\d,.]+) (?:m|ft)\. .* strays ([\d,.]+) (?:m|ft) from/.exec(reason);
    if (!m) throw new Error(`no figures in: ${reason}`);
    const n = (x: string) => Number(x.replace(/,/g, ''));
    return { claim: n(m[1]), leeway: n(m[2]) };
  }

  /**
   * The verdict is decided on the figures the sentence shows: a yes exactly
   * when the shown claim is at most the shown leeway, "hard" exactly when it
   * is more than twice it.
   */
  function agrees(
    geo: ReturnType<typeof squareBoard>,
    accuracyM: number,
    units: Units,
    cfg = DEFAULT_REACH,
  ) {
    const v = previewVerdict(geo, accuracyM, cfg, units);
    if (v.level !== 'good' && v.level !== 'tight' && v.level !== 'poor') return v;
    const { claim, leeway } = shown(v.reason);
    const want = claim <= leeway ? 'good' : claim <= 2 * leeway ? 'tight' : 'poor';
    // Only a disagreement goes through `expect`: the sweep below makes over
    // 150,000 of these calls, and an `expect` each took it to 3.5 s of the
    // 5 s limit on a loaded run (10.13). The failure reads the same.
    if (v.level !== want) expect(v.level, v.reason).toBe(want);
    return v;
  }

  it('on a claim equal to the leeway, or to twice it, on the squares that showed it', () => {
    for (const units of ['metric', 'us'] as const) {
      // Equal figures on screen are a yes; twice them is still the odd refusal.
      expect(agrees(geo8, 7.2, units).level).toBe('good');
      expect(agrees(squareBoard(6), 5.4, units).level).toBe('good');
      expect(agrees(squareBoard(12), 10.8, units).level).toBe('good');
      expect(agrees(geo8, 14.4, units).level).toBe('tight');
      // The earlier cases: 12 m squares at ±10.6 m, 8 m at ±7.3 m, and 4 m
      // squares at 0.25 reach with ±2.95 m.
      expect(agrees(squareBoard(12), 10.6, units).level).toBe('good');
      agrees(geo8, 7.3, units);
      agrees(squareBoard(4), 2.95, units, reachFromSquares(0.25));
    }
    expect(previewVerdict(geo8, 7.2).reason).toContain('±7.2 m');
    expect(previewVerdict(geo8, 7.2).reason).toContain('strays 7.2 m');
    expect(previewVerdict(geo8, 7.3).level).toBe('tight');
    expect(previewVerdict(squareBoard(4), 2.95, reachFromSquares(0.25), 'us').reason).toContain(
      `±${lengthNumber(2.95, 'us')} ft`,
    );
  });

  it('across a sweep of fields, reaches and claims, every hundredth of a meter', () => {
    for (const squareM of [3, 4, 5.5, 6, 8, 10, 12, 17]) {
      const geo = squareBoard(squareM);
      for (const reach of [0.25, 0.4, 0.75, 1.5]) {
        const cfg = reachFromSquares(reach);
        for (let i = 50; i <= 2500; i++) {
          agrees(geo, i / 100, 'metric', cfg);
          agrees(geo, i / 100, 'us', cfg);
        }
      }
    }
  });
});

describe('testSquare', () => {
  const fix = (pos: { lat: number; lng: number }, accuracyM = 3) => ({ pos, accuracyM });

  it('takes the square you stand on', () => {
    const t = testSquare(geo8, fix(near(geo8, 'e4', 1, 1)), 'e4');
    expect(t.ok).toBe(true);
    expect(t.words).toContain('You are on e4');
  });

  it('takes a neighbor inside reach, and says how far', () => {
    // 3 m north of e4's centre: 1 m from e5's edge, inside 3.2 m.
    const t = testSquare(geo8, fix(near(geo8, 'e4', 0, 3)), 'e5');
    expect(t.ok).toBe(true);
    expect(t.words).toContain('1.0 m from it');
    expect(t.words).toContain('3.2 m reach');
  });

  it('refuses a square out of reach, with the game’s own words', () => {
    const t = testSquare(geo8, fix(near(geo8, 'e4', 0, 0)), 'e6', DEFAULT_REACH, 'us');
    expect(t.ok).toBe(false);
    expect(t.words).toContain('would be refused');
    expect(t.words).toContain('Walk closer');
    expect(t.words).toContain('ft');
  });

  it('refuses everything on a fix too vague to trust', () => {
    const t = testSquare(geo8, fix(near(geo8, 'e4', 0, 0), 30), 'e4');
    expect(t.ok).toBe(false);
    expect(t.words).toContain('accurate to ±30 m');
  });

  it('cannot judge with no fix', () => {
    expect(testSquare(geo8, null, 'e4').ok).toBeNull();
  });

  it('agrees with the server’s check on every square, from anywhere', () => {
    // The preview's promise is that it is the game's rule, not a copy of it.
    const cfg = reachFromSquares(0.6);
    for (const [du, dv, acc] of [
      [0, 0, 3],
      [3.9, -2, 8],
      [-6, 5, 20],
      [11, 13, 26],
    ]) {
      const pos = near(geo8, 'd4', du, dv);
      for (let file = 0; file < 8; file++) {
        for (let rank = 0; rank < 8; rank++) {
          const sq = toSquare(file, rank);
          expect(testSquare(geo8, fix(pos, acc), sq, cfg).ok).toBe(
            checkReachTo(geo8, pos, acc, sq, cfg).ok,
          );
        }
      }
    }
  });
});

describe('a claim too vague to move on', () => {
  it('reads past the limit, exactly as the tap test on the same screen says it', () => {
    expect(previewVerdict(geo8, 25.03).reason).toContain('±25.1 m, and moves need ±25 m');
    expect(previewVerdict(geo8, 25.01, DEFAULT_REACH, 'us').reason).toContain('±83 ft, and moves need ±82 ft');
    expect(previewVerdict(geo8, 30).reason).toContain('±30 m');
    for (const units of ['metric', 'us'] as const) {
      for (const acc of [25.01, 25.03, 25.4, 26, 30, 80]) {
        const fix = { pos: near(geo8, 'e4', 0, 0), accuracyM: acc };
        const claim = /accurate to (±\S+ \S+),/.exec(previewVerdict(geo8, acc, DEFAULT_REACH, units).reason)?.[1];
        expect(claim).toBeDefined();
        expect(testSquare(geo8, fix, 'e4', DEFAULT_REACH, units).words).toContain(`accurate to ${claim},`);
      }
    }
    expect(previewVerdict(geo8, Infinity).reason).toContain('unknown');
  });
});
