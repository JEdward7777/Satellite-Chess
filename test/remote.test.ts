import { describe, expect, it } from 'vitest';

import {
  deriveGeometry,
  geometryFromSnapshot,
  makeFieldSpec,
  snapshotField,
  squareCentreLatLng,
  toBoardIndex,
} from '../src/shared/field.js';
import { fromLocal, scale, unitFromBearing, add } from '../src/shared/geo.js';
import { effectiveReachM, DEFAULT_REACH } from '../src/shared/reach.js';
import {
  playableBoard,
  sharedBoardFigures,
  sharedSquareM,
  shrinkBoard,
} from '../src/shared/remote.js';

/**
 * The geometry of a remote game (decision 0060): one shared square, the larger
 * board shrunk about its own center by one factor, and nothing else changed.
 */

const A1 = { lat: 47.61, lng: -122.33 };

/** A four-corner board: `fileM` by `rankM` squares, its files on `bearingDeg`. */
function board(fileM: number, rankM: number, bearingDeg: number, at = A1) {
  const f = scale(unitFromBearing(bearingDeg), fileM);
  const r = scale(unitFromBearing(bearingDeg - 90), rankM);
  const corner = (file: number, rank: number) => fromLocal(at, add(scale(f, file), scale(r, rank)));
  return snapshotField(
    makeFieldSpec('Test', { a1: corner(0, 0), h1: corner(7, 0), h8: corner(7, 7), a8: corner(0, 7) }),
  );
}

describe('the shared square', () => {
  it('is the smaller mean square', () => {
    const big = geometryFromSnapshot(board(12, 6, 20));
    const small = geometryFromSnapshot(board(5, 5, 0));
    expect(sharedSquareM([big, small])).toBe(small.meanSquareM);
    expect(sharedSquareM([small, big])).toBe(small.meanSquareM);
    expect(sharedSquareM([big])).toBe(big.meanSquareM);
  });

  it('refuses to be taken from no board', () => {
    expect(() => sharedSquareM([])).toThrow();
  });
});

describe('shrinking a board', () => {
  const field = board(12, 6, 30);
  const geo = geometryFromSnapshot(field);
  // The smaller field's own mean square, as a game takes it.
  const other = geometryFromSnapshot(board(5, 5, 0));
  const s = sharedSquareM([geo, other]);
  const shrunk = shrinkBoard(geo, s);
  const k = s / geo.meanSquareM;

  it('makes its mean square the shared square exactly, so reach in meters is equal', () => {
    expect(shrunk.meanSquareM).toBe(s);
    expect(shrinkBoard(other, s)).toBe(other);
    expect(effectiveReachM(shrunk.meanSquareM, DEFAULT_REACH)).toBe(
      effectiveReachM(other.meanSquareM, DEFAULT_REACH),
    );
  });

  it('keeps the shape and the bearing: one factor for both axes', () => {
    expect(shrunk.fileM / shrunk.rankM).toBeCloseTo(geo.fileM / geo.rankM, 12);
    expect(shrunk.fileM).toBeCloseTo(geo.fileM * k, 12);
    expect(shrunk.bearingDeg).toBe(geo.bearingDeg);
    expect(shrunk.axisAngleDeg).toBe(geo.axisAngleDeg);
  });

  it('keeps the center of the board where it was on the ground', () => {
    // The center (3.5, 3.5) on the old board is (3.5, 3.5) on the new one.
    const center = fromLocal(geo.origin, add(scale(geo.fileStep, 3.5), scale(geo.rankStep, 3.5)));
    const at = toBoardIndex(shrunk, center);
    // To a hundred-thousandth of a square: the tangent plane moves with a1,
    // which is micrometers on a field.
    expect(at.file).toBeCloseTo(3.5, 5);
    expect(at.rank).toBeCloseTo(3.5, 5);
  });

  it('puts every square center on its own index, and pulls the corners in', () => {
    const wrong: string[] = [];
    for (let file = 0; file < 8; file++) {
      for (let rank = 0; rank < 8; rank++) {
        const at = toBoardIndex(shrunk, squareCentreLatLng(shrunk, { file, rank }));
        if (Math.abs(at.file - file) > 1e-6 || Math.abs(at.rank - rank) > 1e-6) wrong.push(`${file},${rank}`);
      }
    }
    expect(wrong).toEqual([]);
    // The old a1, on the shrunk board, is 3.5 (1/k - 1) squares out along each axis.
    const oldA1 = toBoardIndex(shrunk, geo.origin);
    expect(oldA1.file).toBeCloseTo(-3.5 * (1 / k - 1), 5);
    expect(oldA1.rank).toBeCloseTo(-3.5 * (1 / k - 1), 5);
  });

  it('never enlarges a board, and leaves the smaller one exactly as it is', () => {
    expect(shrinkBoard(geo, geo.meanSquareM)).toBe(geo);
    expect(shrinkBoard(geo, geo.meanSquareM * 2)).toBe(geo);
  });

  it('works on a two-corner board too', () => {
    const square = snapshotField(
      makeFieldSpec('Old', { a1: A1, h8: fromLocal(A1, { e: 70, n: 70 }) }),
    );
    const shrunkSquare = playableBoard(square, 6);
    expect(shrunkSquare.meanSquareM).toBe(6);
    expect(shrunkSquare.fileM).toBeCloseTo(6, 9);
    expect(shrunkSquare.rankM).toBeCloseTo(6, 9);
  });
});

describe('a same-field game', () => {
  it('is played on the field’s own board, exactly', () => {
    const field = board(9, 7, 110);
    expect(playableBoard(field)).toEqual(deriveGeometry(field));
    expect(playableBoard(field)).toEqual(geometryFromSnapshot(field));
  });
});

describe('the shared board', () => {
  it('is eight shared squares a side', () => {
    expect(sharedBoardFigures(5)).toEqual({ squareM: 5, boardM: 40, diagonalM: 40 * Math.SQRT2 });
  });
});
