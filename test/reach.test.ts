import { describe, expect, it } from 'vitest';

import {
  deriveGeometry,
  fromBoardPoint,
  makeFieldSpec,
  squareCentreLatLng,
  toBoardPoint,
} from '../src/shared/field.js';
import { fromLocal } from '../src/shared/geo.js';
import {
  DEFAULT_REACH,
  accuracyTooPoor,
  checkCarry,
  checkReachTo,
  checkSquareReach,
  effectiveReachM,
  inStartZone,
  isPlausibleStep,
  requiredSquares,
} from '../src/shared/reach.js';
import { fromSquare } from '../src/shared/squares.js';

const A1 = { lat: 51.4779, lng: -0.0015 };
const SQUARE_M = 8;
const spec = makeFieldSpec('t', { a1: A1, h8: fromLocal(A1, { e: 7 * SQUARE_M, n: 7 * SQUARE_M }) });
const geo = deriveGeometry(spec);

/** A coordinate `du`/`dv` metres from the centre of `sq`, in board space. */
function nearSquare(sq: string, du: number, dv: number) {
  const c = toBoardPoint(geo, squareCentreLatLng(geo, fromSquare(sq)));
  return fromBoardPoint(geo, { u: c.u + du, v: c.v + dv });
}

describe('effectiveReachM', () => {
  it('scales with the square, not with the metre', () => {
    // Decision 0031: reach is a fraction of a square, so the same config on a
    // bigger board gives proportionally more metres.
    expect(effectiveReachM(SQUARE_M)).toBeCloseTo(DEFAULT_REACH.baseSquares * SQUARE_M, 6);
    expect(effectiveReachM(SQUARE_M * 2)).toBeCloseTo(effectiveReachM(SQUARE_M) * 2, 6);
  });

  it('clamps to the floor and the ceiling', () => {
    expect(effectiveReachM(SQUARE_M, { ...DEFAULT_REACH, baseSquares: 0.01 })).toBeCloseTo(
      DEFAULT_REACH.minSquares * SQUARE_M,
      6,
    );
    expect(effectiveReachM(SQUARE_M, { ...DEFAULT_REACH, baseSquares: 9 })).toBeCloseTo(
      DEFAULT_REACH.maxSquares * SQUARE_M,
      6,
    );
  });

  it('does not let a handicap raise the ceiling — O-02', () => {
    // The bonus buys reach up to the ceiling and no further. Before decision
    // 0031 it raised the ceiling too, so a large handicap could span a move
    // that ought to require walking.
    const ceiling = DEFAULT_REACH.maxSquares * SQUARE_M;
    expect(effectiveReachM(SQUARE_M, DEFAULT_REACH, 0.5)).toBeCloseTo(
      (DEFAULT_REACH.baseSquares + 0.5) * SQUARE_M,
      6,
    );
    expect(effectiveReachM(SQUARE_M, { ...DEFAULT_REACH, baseSquares: 1.4 }, 0.5)).toBeCloseTo(
      ceiling,
      6,
    );
  });

  it('keeps the default game off the degenerate side of one square', () => {
    // At the default, reach must stay well inside a square or you play chess
    // standing still. Under the rule before 0031 this was 8.4 m on an 8 m board.
    expect(effectiveReachM(SQUARE_M)).toBeLessThan(SQUARE_M / 2);
  });
});

describe('a vague fix buys no reach — decision 0043 (O-33)', () => {
  // The owner's ruling after the first outdoor games: a worse signal must not
  // earn a longer reach, because signal is the one thing a player can degrade
  // on purpose (a phone in a pocket), invisibly to the opponent.
  const e2 = () => squareCentreLatLng(geo, fromSquare('e2'));

  it('gives the same circle at every accuracy the game accepts', () => {
    const base = DEFAULT_REACH.baseSquares * SQUARE_M;
    for (const acc of [0.5, 3, DEFAULT_REACH.goodAccuracyM, 9, 14, DEFAULT_REACH.maxAccuracyM]) {
      const v = checkReachTo(geo, e2(), acc, 'e2');
      expect(v.ok).toBe(true);
      expect(v.reachM).toBeCloseTo(base, 6);
    }
  });

  it('does not let a pocketed phone reach a square a good one cannot', () => {
    // e3's near edge is 4 m from e2's centre; the default reach is 3.2 m. Under
    // the old rule a ±14 m fix added 9 m and reached as far as e4.
    expect(checkReachTo(geo, e2(), 1, 'e3').ok).toBe(false);
    expect(checkReachTo(geo, e2(), 14, 'e3').ok).toBe(false);
    expect(checkReachTo(geo, e2(), 14, 'e4').ok).toBe(false);
    expect(checkReachTo(geo, e2(), DEFAULT_REACH.maxAccuracyM, 'e3').ok).toBe(false);
  });

  it('still refuses outright past the hard threshold, rather than widening', () => {
    const v = checkReachTo(geo, e2(), DEFAULT_REACH.maxAccuracyM + 1, 'e2');
    expect(v.ok).toBe(false);
    expect(v.code).toBe('accuracy');
  });

  it('does not widen the back rank either', () => {
    // The zone check takes no accuracy at all now. From e3's centre the gap to
    // rank 1 is a square and a half, 12 m, outside 3.2 m of reach.
    const e3 = squareCentreLatLng(geo, fromSquare('e3'));
    const z = inStartZone(geo, e3, 'w');
    expect(z.ok).toBe(false);
    expect(z.reachM).toBeCloseTo(DEFAULT_REACH.baseSquares * SQUARE_M, 6);
  });

  it('tells a player with a vague fix that the dot may be wrong, not only to walk', () => {
    // Without the bonus, a player standing on the square with a vague fix can
    // be placed metres away. "Walk closer" alone would send them off it.
    const vague = checkReachTo(geo, e2(), 12, 'e3');
    expect(vague.code).toBe('out_of_reach');
    expect(vague.message).toMatch(/Walk closer, or if you are already there/);
    expect(vague.message).toMatch(/±12 m/);
    const good = checkReachTo(geo, e2(), DEFAULT_REACH.goodAccuracyM, 'e3');
    expect(good.message).toMatch(/Walk closer\.$/);
  });
});

describe('accuracy gating', () => {
  it('refuses moves past the hard threshold', () => {
    expect(accuracyTooPoor(24)).toBe(false);
    expect(accuracyTooPoor(26)).toBe(true);
    expect(accuracyTooPoor(Number.NaN)).toBe(true);
    expect(accuracyTooPoor(Infinity)).toBe(true);
  });

  it('explains itself when rejecting a lift on accuracy', () => {
    const v = checkReachTo(geo, nearSquare('e2', 0, 0), 1200, 'e2');
    expect(v.ok).toBe(false);
    expect(v.code).toBe('accuracy');
    expect(v.message).toMatch(/1200 m/);
  });
});

describe('requiredSquares — the both-ends rule', () => {
  it('is origin and destination for a quiet move', () => {
    expect(requiredSquares('e2', 'e4')).toEqual(['e2', 'e4']);
  });

  it('covers the victim automatically for a capture', () => {
    // The captured piece stands on the destination, so no third square arises.
    expect(requiredSquares('d4', 'e5')).toEqual(['d4', 'e5']);
  });

  it('is the king only for castling — the rook is ignored', () => {
    expect(requiredSquares('e1', 'g1')).toEqual(['e1', 'g1']);
    expect(requiredSquares('e1', 'c1')).toEqual(['e1', 'c1']);
    expect(requiredSquares('e1', 'g1')).not.toContain('h1');
    expect(requiredSquares('e1', 'c1')).not.toContain('a1');
  });

  it('ignores the captured pawn for en passant', () => {
    // White pawn d5 takes e6 en passant; the black pawn sits on e5.
    expect(requiredSquares('d5', 'e6')).toEqual(['d5', 'e6']);
    expect(requiredSquares('d5', 'e6')).not.toContain('e5');
  });
});

describe('checkReachTo', () => {
  it('accepts the square you are standing on', () => {
    const v = checkReachTo(geo, squareCentreLatLng(geo, fromSquare('e2')), 1, 'e2');
    expect(v.ok).toBe(true);
    expect(v.reachM).toBeCloseTo(DEFAULT_REACH.baseSquares * SQUARE_M, 6);
    expect(v.squares[0].distanceM).toBeCloseTo(0, 6);
  });

  it('makes you step towards a neighbouring square rather than stretch to it', () => {
    // Decision 0031, and the point of the whole change: at the default 0.4
    // squares (3.2 m here) the half-square gap from e2's centre to e3's near
    // edge (4 m) is *outside* reach, so a move needs a real step. Under the old
    // metre-based rule this was accepted from a standing start.
    expect(checkReachTo(geo, squareCentreLatLng(geo, fromSquare('e2')), 1, 'e3').ok).toBe(false);
    // One metre of that step is enough.
    expect(checkReachTo(geo, nearSquare('e2', 0, 1), 1, 'e3').ok).toBe(true);
  });

  it('rejects a square across the board and says how far off you are', () => {
    const v = checkReachTo(geo, squareCentreLatLng(geo, fromSquare('a1')), 1, 'a8');
    expect(v.ok).toBe(false);
    expect(v.code).toBe('out_of_reach');
    expect(v.message).toMatch(/from a8/);
    // a1 centre to a8's near edge: 7 squares less one half-square.
    expect(v.squares[0].distanceM).toBeCloseTo(7 * SQUARE_M - SQUARE_M / 2, 4);
  });

  it('honours a per-player handicap', () => {
    const pos = squareCentreLatLng(geo, fromSquare('e2'));
    expect(checkReachTo(geo, pos, 1, 'e4', DEFAULT_REACH, 0).ok).toBe(false);
    expect(checkReachTo(geo, pos, 1, 'e4', DEFAULT_REACH, 8).ok).toBe(true);
  });

  it('reports per-square distances for the UI', () => {
    // a1 centre to a3's near edge: two squares less one half-square.
    const r = checkSquareReach(geo, squareCentreLatLng(geo, fromSquare('a1')), 'a3', 6);
    expect(r.distanceM).toBeCloseTo(2 * SQUARE_M - SQUARE_M / 2, 4);
    expect(r.reachable).toBe(false);
  });
});

describe('checkCarry — lift here, walk, place there', () => {
  const at = (sq: string, t: number) => ({
    pos: squareCentreLatLng(geo, fromSquare(sq)),
    accuracyM: 2,
    at: t,
  });

  it('accepts a move whose ends are nowhere near each other', () => {
    // The whole point: Ra1-a8 is 56 m, unreachable from any single spot.
    const v = checkCarry(geo, at('a1', 0), at('a8', 40_000), 'a1', 'a8');
    expect(v.ok).toBe(true);
    expect(v.carriedM).toBeCloseTo(7 * SQUARE_M, 2);
    expect(v.carriedMs).toBe(40_000);
  });

  it('rejects a lift taken away from the origin', () => {
    const v = checkCarry(geo, at('d4', 0), at('a8', 40_000), 'a1', 'a8');
    expect(v.ok).toBe(false);
    expect(v.code).toBe('out_of_reach');
    expect(v.message).toMatch(/picked the piece up/);
    expect(v.message).toMatch(/from a1/);
  });

  it('rejects a place taken away from the destination', () => {
    const v = checkCarry(geo, at('a1', 0), at('d4', 40_000), 'a1', 'a8');
    expect(v.ok).toBe(false);
    expect(v.code).toBe('out_of_reach');
    expect(v.message).toMatch(/from a8/);
    expect(v.message).not.toMatch(/picked the piece up/);
  });

  it('rejects a carry nobody could have walked', () => {
    // 56 m in a fifth of a second.
    const v = checkCarry(geo, at('a1', 0), at('a8', 200), 'a1', 'a8');
    expect(v.ok).toBe(false);
    expect(v.code).toBe('implausible');
    expect(v.message).toMatch(/GPS jumped/);
  });

  it('accepts a short move made without really walking', () => {
    // Standing on the e3/e4 boundary both squares are underfoot, so the carry
    // is ~0 m. A zero-length carry must not be read as implausible.
    const spot = { pos: nearSquare('e3', 0, SQUARE_M / 2), accuracyM: 2, at: 0 };
    const v = checkCarry(geo, spot, { ...spot, at: 1_500 }, 'e3', 'e4');
    expect(v.ok).toBe(true);
    expect(v.carriedM).toBeCloseTo(0, 6);
  });

  it('reports the same reach whatever either fix claimed', () => {
    const v = checkCarry(
      geo,
      { ...at('a1', 0), accuracyM: 1 },
      { ...at('a8', 40_000), accuracyM: 9 },
      'a1',
      'a8',
    );
    // Decision 0043: neither the 1 m fix nor the 9 m one moves the circle.
    expect(v.reachM).toBeCloseTo(DEFAULT_REACH.baseSquares * SQUARE_M, 6);
  });

  it('refuses to accept a move at all when accuracy is hopeless', () => {
    const v = checkCarry(geo, { ...at('a1', 0), accuracyM: 1200 }, at('a8', 40_000), 'a1', 'a8');
    expect(v.ok).toBe(false);
    expect(v.code).toBe('accuracy');
  });
});

describe('inStartZone', () => {
  it('accepts white anywhere on rank 1', () => {
    for (const sq of ['a1', 'd1', 'h1']) {
      expect(inStartZone(geo, squareCentreLatLng(geo, fromSquare(sq)), 'w').ok).toBe(true);
    }
  });

  it('accepts black anywhere on rank 8 but not rank 1', () => {
    expect(inStartZone(geo, squareCentreLatLng(geo, fromSquare('d8')), 'b').ok).toBe(true);
    expect(inStartZone(geo, squareCentreLatLng(geo, fromSquare('d1')), 'b').ok).toBe(false);
  });

  it('rejects the middle of the board for either colour', () => {
    const mid = squareCentreLatLng(geo, fromSquare('d4'));
    expect(inStartZone(geo, mid, 'w').ok).toBe(false);
    expect(inStartZone(geo, mid, 'b').ok).toBe(false);
  });

  it('reports how far you still have to walk', () => {
    const z = inStartZone(geo, squareCentreLatLng(geo, fromSquare('d4')), 'w');
    // d4 centre to rank 1's near edge: three squares less one half-square.
    expect(z.nearestM).toBeCloseTo(3 * SQUARE_M - SQUARE_M / 2, 4);
    expect(z.reachM).toBeCloseTo(DEFAULT_REACH.baseSquares * SQUARE_M, 6);
  });
});

describe('isPlausibleStep', () => {
  it('forgives jitter inside the error budget', () => {
    expect(isPlausibleStep(9, 1000, 10)).toBe(true);
  });

  it('accepts a sprint', () => {
    expect(isPlausibleStep(40, 5000, 6)).toBe(true);
  });

  it('flags a teleport', () => {
    expect(isPlausibleStep(500, 1000, 10)).toBe(false);
  });

  it('flags any movement in zero elapsed time beyond the error budget', () => {
    expect(isPlausibleStep(100, 0, 10)).toBe(false);
  });
});
