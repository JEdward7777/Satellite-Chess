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
const spec = makeFieldSpec('t', A1, fromLocal(A1, { e: 7 * SQUARE_M, n: 7 * SQUARE_M }));
const geo = deriveGeometry(spec);

/** A coordinate `du`/`dv` metres from the centre of `sq`, in board space. */
function nearSquare(sq: string, du: number, dv: number) {
  const c = toBoardPoint(geo, squareCentreLatLng(geo, fromSquare(sq)));
  return fromBoardPoint(geo, { u: c.u + du, v: c.v + dv });
}

describe('effectiveReachM', () => {
  it('adds accuracy to the base reach', () => {
    expect(effectiveReachM(0)).toBe(DEFAULT_REACH.minM > 5 ? DEFAULT_REACH.minM : 5);
    expect(effectiveReachM(3)).toBe(8);
  });

  it('clamps to the floor and the ceiling', () => {
    // Base 5 already exceeds the floor of 4, so the floor only binds if base is
    // configured lower.
    expect(effectiveReachM(0, { ...DEFAULT_REACH, baseM: 1 })).toBe(4);
    expect(effectiveReachM(100)).toBe(DEFAULT_REACH.maxM);
  });

  it('lets a handicap raise the ceiling as well as the reach', () => {
    expect(effectiveReachM(0, DEFAULT_REACH, 4)).toBe(9);
    // A large accuracy still clamps, but to the raised ceiling.
    expect(effectiveReachM(100, DEFAULT_REACH, 4)).toBe(DEFAULT_REACH.maxM + 4);
  });

  it('is symmetric by default', () => {
    expect(effectiveReachM(5, DEFAULT_REACH, 0)).toBe(effectiveReachM(5, DEFAULT_REACH, 0));
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
    expect(v.reachM).toBe(6);
    expect(v.squares[0].distanceM).toBeCloseTo(0, 6);
  });

  it('accepts a neighbouring square you can stretch to', () => {
    // e2 centre to e3's near edge is half a square: 4 m, inside a 6 m reach.
    expect(checkReachTo(geo, squareCentreLatLng(geo, fromSquare('e2')), 1, 'e3').ok).toBe(true);
  });

  it('rejects a square across the board and says how far off you are', () => {
    const v = checkReachTo(geo, squareCentreLatLng(geo, fromSquare('a1')), 1, 'a8');
    expect(v.ok).toBe(false);
    expect(v.code).toBe('out_of_reach');
    expect(v.message).toMatch(/from a8/);
    // a1 centre to a8's near edge: 7 squares less one half-square.
    expect(v.squares[0].distanceM).toBeCloseTo(7 * SQUARE_M - SQUARE_M / 2, 4);
  });

  it('lets a vague fix buy reach, up to the ceiling', () => {
    const pos = squareCentreLatLng(geo, fromSquare('e2'));
    // e4's near edge is 12 m from e2's centre: out of a 6 m reach.
    expect(checkReachTo(geo, pos, 1, 'e4').ok).toBe(false);
    // A ±14 m fix clamps to the 15 m ceiling, which spans it.
    expect(checkReachTo(geo, pos, 14, 'e4').ok).toBe(true);
    // But not e8, 44 m away, past any ceiling.
    expect(checkReachTo(geo, pos, 14, 'e8').ok).toBe(false);
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
    // Standing on e3 you can reach both e2 and e4, so the carry is ~0 m.
    const spot = { pos: nearSquare('e3', 0, 0), accuracyM: 2, at: 0 };
    const v = checkCarry(geo, spot, { ...spot, at: 1_500 }, 'e2', 'e4');
    expect(v.ok).toBe(true);
    expect(v.carriedM).toBeCloseTo(0, 6);
  });

  it('uses the worse of the two fixes for the reach it reports', () => {
    const v = checkCarry(
      geo,
      { ...at('a1', 0), accuracyM: 1 },
      { ...at('a8', 40_000), accuracyM: 9 },
      'a1',
      'a8',
    );
    expect(v.reachM).toBe(14);
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
      expect(inStartZone(geo, squareCentreLatLng(geo, fromSquare(sq)), 1, 'w').ok).toBe(true);
    }
  });

  it('accepts black anywhere on rank 8 but not rank 1', () => {
    expect(inStartZone(geo, squareCentreLatLng(geo, fromSquare('d8')), 1, 'b').ok).toBe(true);
    expect(inStartZone(geo, squareCentreLatLng(geo, fromSquare('d1')), 1, 'b').ok).toBe(false);
  });

  it('rejects the middle of the board for either colour', () => {
    const mid = squareCentreLatLng(geo, fromSquare('d4'));
    expect(inStartZone(geo, mid, 1, 'w').ok).toBe(false);
    expect(inStartZone(geo, mid, 1, 'b').ok).toBe(false);
  });

  it('reports how far you still have to walk', () => {
    const z = inStartZone(geo, squareCentreLatLng(geo, fromSquare('d4')), 1, 'w');
    // d4 centre to rank 1's near edge: three squares less one half-square.
    expect(z.nearestM).toBeCloseTo(3 * SQUARE_M - SQUARE_M / 2, 4);
    expect(z.reachM).toBe(6);
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
