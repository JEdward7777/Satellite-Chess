import { describe, expect, it } from 'vitest';

import {
  boardIndexOf,
  boardPointOfIndex,
  boardSizeM,
  calibrationResiduals,
  checkCalibration,
  deriveGeometry,
  distanceToSquareM,
  fromBoardPoint,
  makeFieldSpec,
  nearestSquare,
  recalibrate,
  snapshotField,
  squareCentreLatLng,
  squareCornersLatLng,
  squareAt,
  toBoardIndex,
  toBoardPoint,
} from '../src/shared/field.js';
import { distanceM, fromLocal, toLocal, unitFromBearing } from '../src/shared/geo.js';
import { fromSquare, toSquare } from '../src/shared/squares.js';

/** A field near Greenwich, laid out due east/north with 8 m squares. */
const A1 = { lat: 51.4779, lng: -0.0015 };

function axisAlignedField(squareM: number, a1 = A1) {
  // a1 -> h8 is 7 squares east and 7 squares north.
  const h8 = fromLocal(a1, { e: 7 * squareM, n: 7 * squareM });
  return makeFieldSpec('test', { a1: a1, h8: h8 });
}

describe('geo projection', () => {
  it('round-trips through the tangent plane', () => {
    const p = { lat: 51.478, lng: -0.001 };
    const back = fromLocal(A1, toLocal(A1, p));
    expect(back.lat).toBeCloseTo(p.lat, 12);
    expect(back.lng).toBeCloseTo(p.lng, 12);
  });

  it('measures a known distance', () => {
    // 100 m north.
    const p = fromLocal(A1, { e: 0, n: 100 });
    expect(distanceM(A1, p)).toBeCloseTo(100, 6);
  });

  it('agrees with a geodesic reference to well under GPS accuracy', () => {
    // Haversine on the same sphere, as an independent implementation.
    const haversine = (a: typeof A1, b: typeof A1) => {
      const R = 6378137;
      const toRad = (d: number) => (d * Math.PI) / 180;
      const dLat = toRad(b.lat - a.lat);
      const dLng = toRad(b.lng - a.lng);
      const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(s));
    };
    // Across a 400 m diagonal, far bigger than any real field.
    const far = fromLocal(A1, { e: 300, n: 300 });
    const diff = Math.abs(distanceM(A1, far) - haversine(A1, far));
    expect(diff).toBeLessThan(0.05);
  });
});

describe('deriveGeometry', () => {
  it('recovers square size from the diagonal', () => {
    const geo = deriveGeometry(axisAlignedField(8));
    expect(geo.fileM).toBeCloseTo(8, 6);
    expect(boardSizeM(geo)).toBeCloseTo(64, 6);
  });

  it('recovers a due-east file axis for a north-east diagonal', () => {
    const geo = deriveGeometry(axisAlignedField(8));
    expect(geo.bearingDeg).toBeCloseTo(90, 6);
    expect(geo.uHat.e).toBeCloseTo(1, 6);
    expect(geo.uHat.n).toBeCloseTo(0, 6);
    expect(geo.vHat.e).toBeCloseTo(0, 6);
    expect(geo.vHat.n).toBeCloseTo(1, 6);
  });

  it('keeps the axes orthonormal at any rotation', () => {
    for (const bearing of [0, 17, 45, 90, 133.7, 200, 271, 359]) {
      const s = 6;
      // Place h8 by walking 7 squares along each axis of a board at `bearing`.
      const uFile = unitFromBearing(bearing);
      const uRank = unitFromBearing(((bearing - 90) % 360 + 360) % 360);
      const h8 = fromLocal(A1, {
        e: 7 * s * (uFile.e + uRank.e),
        n: 7 * s * (uFile.n + uRank.n),
      });
      const geo = deriveGeometry({ a1: A1, h8 });
      expect(geo.fileM).toBeCloseTo(s, 4);
      // Compare as angles: bearing 0 may legitimately come back as 359.9999…
      const angularError = Math.abs(((geo.bearingDeg - bearing + 540) % 360) - 180);
      expect(angularError).toBeLessThan(1e-3);
      // Orthonormal.
      expect(geo.uHat.e * geo.vHat.e + geo.uHat.n * geo.vHat.n).toBeCloseTo(0, 9);
      expect(Math.hypot(geo.uHat.e, geo.uHat.n)).toBeCloseTo(1, 9);
    }
  });

  it('rejects a degenerate field', () => {
    expect(() => deriveGeometry({ a1: A1, h8: A1 })).toThrow(/degenerate/);
  });
});

describe('board coordinates', () => {
  const spec = axisAlignedField(8);
  const geo = deriveGeometry(spec);

  it('puts a1 at the origin and h8 at 7 squares on both axes', () => {
    expect(toBoardPoint(geo, spec.a1)).toMatchObject({ u: expect.closeTo(0, 6), v: expect.closeTo(0, 6) });
    const h8 = toBoardPoint(geo, spec.h8);
    expect(h8.u).toBeCloseTo(56, 4);
    expect(h8.v).toBeCloseTo(56, 4);
  });

  it('round-trips every square centre', () => {
    for (let f = 0; f < 8; f++) {
      for (let r = 0; r < 8; r++) {
        const ll = squareCentreLatLng(geo, { file: f, rank: r });
        const bp = toBoardPoint(geo, ll);
        expect(bp.u).toBeCloseTo(f * 8, 4);
        expect(bp.v).toBeCloseTo(r * 8, 4);
        expect(squareAt(geo, ll)).toEqual({ file: f, rank: r });
      }
    }
  });

  it('reports the square you are standing on, anywhere within it', () => {
    const centre = squareCentreLatLng(geo, fromSquare('d4'));
    // 3.9 m off centre in both axes is still inside an 8 m square.
    const offset = fromBoardPoint(geo, {
      u: toBoardPoint(geo, centre).u + 3.9,
      v: toBoardPoint(geo, centre).v - 3.9,
    });
    expect(squareAt(geo, offset)).toEqual(fromSquare('d4'));
  });

  it('returns null off the board but still clamps for nearestSquare', () => {
    const off = fromBoardPoint(geo, { u: -30, v: -30 });
    expect(squareAt(geo, off)).toBeNull();
    expect(nearestSquare(geo, off)).toEqual({ file: 0, rank: 0 });

    const beyond = fromBoardPoint(geo, { u: 200, v: 100 });
    expect(squareAt(geo, beyond)).toBeNull();
    expect(nearestSquare(geo, beyond)).toEqual({ file: 7, rank: 7 });
  });

  it('draws squares of the right size', () => {
    const corners = squareCornersLatLng(geo, fromSquare('a1'));
    expect(corners).toHaveLength(4);
    // Adjacent corners are one square apart, opposite ones the diagonal.
    expect(distanceM(corners[0], corners[1])).toBeCloseTo(8, 3);
    expect(distanceM(corners[0], corners[2])).toBeCloseTo(8 * Math.SQRT2, 3);
  });
});

describe('distanceToSquareM', () => {
  const geo = deriveGeometry(axisAlignedField(8));

  it('is zero anywhere on the square', () => {
    const c = toBoardPoint(geo, squareCentreLatLng(geo, fromSquare('e4')));
    for (const [du, dv] of [[0, 0], [3.99, 0], [-3.99, 3.99], [3.99, -3.99]]) {
      const p = fromBoardPoint(geo, { u: c.u + du, v: c.v + dv });
      expect(distanceToSquareM(geo, p, fromSquare('e4'))).toBeCloseTo(0, 6);
    }
  });

  it('measures to the nearest edge, not the centre', () => {
    const c = toBoardPoint(geo, squareCentreLatLng(geo, fromSquare('e4')));
    // 10 m along the file axis from the centre = 6 m past the 4 m half-width.
    const p = fromBoardPoint(geo, { u: c.u + 10, v: c.v });
    expect(distanceToSquareM(geo, p, fromSquare('e4'))).toBeCloseTo(6, 4);
  });

  it('measures to the nearest corner when offset on both axes', () => {
    const c = toBoardPoint(geo, squareCentreLatLng(geo, fromSquare('e4')));
    const p = fromBoardPoint(geo, { u: c.u + 7, v: c.v + 7 });
    expect(distanceToSquareM(geo, p, fromSquare('e4'))).toBeCloseTo(Math.hypot(3, 3), 4);
  });

  it('makes adjacent squares reachable from a shared edge', () => {
    // Standing on the boundary between d4 and e4 reaches both.
    const d4 = toBoardPoint(geo, squareCentreLatLng(geo, fromSquare('d4')));
    const p = fromBoardPoint(geo, { u: d4.u + 4, v: d4.v });
    expect(distanceToSquareM(geo, p, fromSquare('d4'))).toBeCloseTo(0, 6);
    expect(distanceToSquareM(geo, p, fromSquare('e4'))).toBeCloseTo(0, 6);
  });
});

describe('checkCalibration', () => {
  it('accepts a sensible field', () => {
    const c = checkCalibration(axisAlignedField(8));
    expect(c.ok).toBe(true);
    expect(c.errors).toEqual([]);
    expect(c.fileM).toBeCloseTo(8, 4);
  });

  it('rejects a field too small for GPS', () => {
    const c = checkCalibration(axisAlignedField(1.5));
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toMatch(/smaller than GPS/);
  });

  it('warns on a small-but-playable field', () => {
    const c = checkCalibration(axisAlignedField(3));
    expect(c.ok).toBe(true);
    expect(c.warnings.join(' ')).toMatch(/ambiguity/);
  });

  it('rejects an absurdly large field', () => {
    const c = checkCalibration(axisAlignedField(60));
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toMatch(/mis-tap/);
  });

  it('warns when calibration accuracy was poor relative to square size', () => {
    const c = checkCalibration(axisAlignedField(6), { worstAccuracyM: 20 });
    expect(c.warnings.join(' ')).toMatch(/Re-calibrate/);
  });

  it('reports the same-point case as an error, not a throw', () => {
    const c = checkCalibration({ a1: A1, h8: A1 });
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toMatch(/same place/);
  });
});

describe('snapshots and versioning', () => {
  it('snapshots derived values but keeps raw corners as truth', () => {
    const spec = axisAlignedField(8);
    const snap = snapshotField(spec, 1000);
    expect(snap.a1).toEqual(spec.a1);
    expect(snap.h8).toEqual(spec.h8);
    expect(snap.fileM).toBeCloseTo(8, 6);
    expect(snap.version).toBe(1);
    expect(snap.snapshotAt).toBe(1000);
    // A snapshot re-derives to exactly the same geometry.
    expect(deriveGeometry(snap).fileM).toBeCloseTo(deriveGeometry(spec).fileM, 12);
  });

  it('re-calibrating bumps the version and leaves old snapshots untouched', () => {
    const spec = axisAlignedField(8);
    const snap = snapshotField(spec, 1000);
    const moved = recalibrate(
      spec,
      { a1: spec.a1, h8: fromLocal(spec.a1, { e: 70, n: 70 }) },
      { now: 2000 },
    );
    expect(moved.version).toBe(2);
    expect(deriveGeometry(moved).fileM).toBeCloseTo(10, 4);
    // The snapshot the game holds is unaffected.
    expect(snap.fileM).toBeCloseTo(8, 6);
  });
});

describe('squares', () => {
  it('round-trips names', () => {
    expect(toSquare(0, 0)).toBe('a1');
    expect(toSquare(7, 7)).toBe('h8');
    expect(fromSquare('e4')).toEqual({ file: 4, rank: 3 });
  });

  it('rejects nonsense', () => {
    expect(() => fromSquare('i9')).toThrow();
    expect(() => toSquare(8, 0)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Four corners, and a board that need not be square (decision 0028)
// ---------------------------------------------------------------------------

/** A board `fileM` x `rankM`, laid due east/north, with all four corners. */
function pitch(fileM: number, rankM = fileM, a1 = A1) {
  return makeFieldSpec('pitch', {
    a1,
    h1: fromLocal(a1, { e: 7 * fileM, n: 0 }),
    h8: fromLocal(a1, { e: 7 * fileM, n: 7 * rankM }),
    a8: fromLocal(a1, { e: 0, n: 7 * rankM }),
  });
}

describe('four-corner fields', () => {
  it('reads a square board exactly as the two-tap version did', () => {
    // The compatibility claim, checked rather than assumed: a field walked out
    // with four corners on square ground must land on the same geometry as the
    // same ground walked with two, or every saved field shifts underfoot.
    const four = deriveGeometry(pitch(8));
    const two = deriveGeometry(axisAlignedField(8));
    expect(four.fileM).toBeCloseTo(two.fileM, 6);
    expect(four.rankM).toBeCloseTo(two.rankM, 6);
    expect(four.bearingDeg).toBeCloseTo(two.bearingDeg, 6);
    expect(distanceM(four.origin, two.origin)).toBeLessThan(1e-6);
  });

  it('keeps a rectangle rectangular instead of forcing a square onto it', () => {
    const geo = deriveGeometry(pitch(10, 6));
    expect(geo.fileM).toBeCloseTo(10, 6);
    expect(geo.rankM).toBeCloseTo(6, 6);
    expect(geo.axisAngleDeg).toBeCloseTo(90, 6);
  });

  it('puts every square centre back where it was walked', () => {
    const spec = pitch(10, 6);
    const geo = deriveGeometry(spec);
    for (const [name, index] of [
      ['a1', { file: 0, rank: 0 }],
      ['h1', { file: 7, rank: 0 }],
      ['h8', { file: 7, rank: 7 }],
      ['a8', { file: 0, rank: 7 }],
    ] as const) {
      const tapped = spec[name] as { lat: number; lng: number };
      expect(squareAt(geo, tapped), name).toEqual(index);
      expect(distanceM(squareCentreLatLng(geo, index), tapped), name).toBeLessThan(1e-6);
    }
  });

  it('identifies squares across a sheared board', () => {
    // Ranks running 20 degrees off perpendicular — a board laid into a corner
    // of a park. Every square centre must still name itself.
    const a1 = A1;
    const skew = unitFromBearing(90 - 20);
    const spec = makeFieldSpec('skew', {
      a1,
      h1: fromLocal(a1, { e: 56, n: 0 }),
      h8: fromLocal(a1, { e: 56 + 56 * skew.e, n: 56 * skew.n }),
      a8: fromLocal(a1, { e: 56 * skew.e, n: 56 * skew.n }),
    });
    const geo = deriveGeometry(spec);
    for (let file = 0; file < 8; file++) {
      for (let rank = 0; rank < 8; rank++) {
        const centre = squareCentreLatLng(geo, { file, rank });
        expect(squareAt(geo, centre), `${file},${rank}`).toEqual({ file, rank });
      }
    }
  });

  it('round-trips a point through the index and back', () => {
    const geo = deriveGeometry(pitch(11, 5));
    const p = fromLocal(A1, { e: 23, n: 17 });
    const bi = toBoardIndex(geo, p);
    expect(distanceM(fromBoardPoint(geo, boardPointOfIndex(geo, bi)), p)).toBeLessThan(1e-6);
    // And the two entry points to the index agree.
    expect(boardIndexOf(geo, toBoardPoint(geo, p)).file).toBeCloseTo(bi.file, 9);
    expect(boardIndexOf(geo, toBoardPoint(geo, p)).rank).toBeCloseTo(bi.rank, 9);
  });

  it('measures reach on the ground, not in square counts', () => {
    // The trap the two frames exist to avoid. On a 12 x 4 board, b1 is 12 m away
    // along the files and a2 is 4 m away along the ranks — both "one square", and
    // three times apart in the only unit that matters to a player's legs.
    const geo = deriveGeometry(pitch(12, 4));
    const a1Centre = squareCentreLatLng(geo, { file: 0, rank: 0 });
    const alongFile = distanceToSquareM(geo, a1Centre, { file: 1, rank: 0 });
    const alongRank = distanceToSquareM(geo, a1Centre, { file: 0, rank: 1 });
    // Nearest point of the neighbouring square: half a step out from the centre.
    expect(alongFile).toBeCloseTo(6, 4);
    expect(alongRank).toBeCloseTo(2, 4);
  });

  it('gives distance zero anywhere inside a skewed square', () => {
    const geo = deriveGeometry(pitch(10, 6));
    const centre = squareCentreLatLng(geo, { file: 3, rank: 4 });
    expect(distanceToSquareM(geo, centre, { file: 3, rank: 4 })).toBe(0);
    for (const corner of squareCornersLatLng(geo, { file: 3, rank: 4 })) {
      // On the boundary, so zero to within rounding rather than exactly zero.
      expect(distanceToSquareM(geo, corner, { file: 3, rank: 4 })).toBeLessThan(1e-6);
    }
  });

  it('reports no residual for four clean corners, and some for a bent one', () => {
    expect(Math.max(...calibrationResiduals(pitch(8), deriveGeometry(pitch(8))))).toBeCloseTo(0, 6);
    const bent = makeFieldSpec('bent', {
      a1: A1,
      h1: fromLocal(A1, { e: 56, n: 0 }),
      h8: fromLocal(A1, { e: 56, n: 56 }),
      a8: fromLocal(A1, { e: 0, n: 96 }),
    });
    expect(Math.max(...calibrationResiduals(bent, deriveGeometry(bent)))).toBeGreaterThan(2);
  });

  it('has no residual to report for a two-corner field', () => {
    // Not zero-because-perfect: zero because there is nothing to check. Two taps
    // and four unknowns always fit exactly, which is why a mis-tap was invisible.
    const spec = axisAlignedField(8);
    expect(calibrationResiduals(spec, deriveGeometry(spec))).toEqual([]);
  });

  it('refuses corners that do not describe a board at all', () => {
    const collapsed = makeFieldSpec('flat', {
      a1: A1,
      h1: fromLocal(A1, { e: 56, n: 0 }),
      h8: fromLocal(A1, { e: 56, n: 0 }),
      a8: A1,
    });
    expect(() => deriveGeometry(collapsed)).toThrow();
  });

  it('carries all four corners through a snapshot', () => {
    const spec = pitch(10, 6);
    const snap = snapshotField(spec, 1000);
    expect(snap.h1).toEqual(spec.h1);
    expect(snap.a8).toEqual(spec.a8);
    const geo = deriveGeometry(snap);
    expect(geo.fileM).toBeCloseTo(10, 6);
    expect(geo.rankM).toBeCloseTo(6, 6);
  });

  it('leaves a two-corner snapshot without corners it never had', () => {
    const snap = snapshotField(axisAlignedField(8), 1000);
    expect(snap.h1).toBeUndefined();
    expect(snap.a8).toBeUndefined();
    expect(deriveGeometry(snap).fileM).toBeCloseTo(8, 6);
  });
});
