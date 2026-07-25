import { describe, expect, it } from 'vitest';

import { deriveGeometry, makeFieldSpec, toBoardPoint } from '../src/shared/field.js';
import { fromLocal } from '../src/shared/geo.js';
import {
  northOnScreen,
  projectionFor,
  squareUnderFoot,
  startingPieces,
} from '../src/client/render.js';

const A1 = { lat: 51.4779, lng: -0.0015 };
const SQUARE_M = 8;
/** a1 to h8 running due north-east, so the a→h axis points due east. */
const EAST = deriveGeometry(
  makeFieldSpec('east', A1, fromLocal(A1, { e: 7 * SQUARE_M, n: 7 * SQUARE_M })),
);

const SIZE = 400;

function screenOf(geo: typeof EAST, orientation: 'w' | 'b', square: { file: number; rank: number }) {
  const p = projectionFor(geo, orientation, SIZE, SIZE);
  return p.toScreen({ u: square.file * geo.squareM, v: square.rank * geo.squareM });
}

describe('projectionFor', () => {
  it('puts a1 at the bottom left for White', () => {
    const a1 = screenOf(EAST, 'w', { file: 0, rank: 0 });
    const h8 = screenOf(EAST, 'w', { file: 7, rank: 7 });
    expect(a1.x).toBeLessThan(h8.x);
    expect(a1.y).toBeGreaterThan(h8.y);
  });

  it('turns the same board through 180 degrees for Black', () => {
    const a1 = screenOf(EAST, 'b', { file: 0, rank: 0 });
    const h8 = screenOf(EAST, 'b', { file: 7, rank: 7 });
    expect(a1.x).toBeGreaterThan(h8.x);
    expect(a1.y).toBeLessThan(h8.y);
  });

  it('is a rigid transform — squares stay square', () => {
    const p = projectionFor(EAST, 'w', SIZE, SIZE);
    const origin = p.toScreen({ u: 0, v: 0 });
    const alongFile = p.toScreen({ u: EAST.squareM, v: 0 });
    const alongRank = p.toScreen({ u: 0, v: EAST.squareM });
    expect(Math.hypot(alongFile.x - origin.x, alongFile.y - origin.y)).toBeCloseTo(
      Math.hypot(alongRank.x - origin.x, alongRank.y - origin.y),
      6,
    );
  });

  it('fits the whole board, outer half-squares included', () => {
    const p = projectionFor(EAST, 'w', SIZE, SIZE);
    const half = EAST.squareM / 2;
    const corner = p.toScreen({ u: -half, v: -half });
    const far = p.toScreen({ u: 7 * EAST.squareM + half, v: 7 * EAST.squareM + half });
    for (const value of [corner.x, corner.y, far.x, far.y]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(SIZE);
    }
  });

  it('draws the board the same size whichever way up it is held', () => {
    const white = projectionFor(EAST, 'w', SIZE, SIZE);
    const black = projectionFor(EAST, 'b', SIZE, SIZE);
    expect(white.scale).toBe(black.scale);
  });
});

describe('northOnScreen', () => {
  it('points up when the files run east', () => {
    // a→h due east means rank 1→8 runs north, which is up the screen for White.
    const north = northOnScreen(EAST, 'w');
    expect(north.x).toBeCloseTo(0, 6);
    expect(north.y).toBeCloseTo(-1, 6);
  });

  it('points down for the player on the other side', () => {
    expect(northOnScreen(EAST, 'b').y).toBeCloseTo(1, 6);
  });

  it('follows the board round as the field is rotated on the ground', () => {
    // A field whose a→h axis runs due north: north is then to the right.
    const northward = deriveGeometry(
      makeFieldSpec('n', A1, fromLocal(A1, { e: -7 * SQUARE_M, n: 7 * SQUARE_M })),
    );
    // Bearings wrap, so this comes out as 360 rather than 0.
    expect(Math.cos((northward.bearingDeg * Math.PI) / 180)).toBeCloseTo(1, 6);
    const north = northOnScreen(northward, 'w');
    expect(north.x).toBeCloseTo(1, 6);
    expect(north.y).toBeCloseTo(0, 6);
  });

  it('is always a unit vector', () => {
    for (const orientation of ['w', 'b'] as const) {
      const n = northOnScreen(EAST, orientation);
      expect(Math.hypot(n.x, n.y)).toBeCloseTo(1, 9);
    }
  });
});

describe('squareUnderFoot', () => {
  it('finds the square you are standing on', () => {
    const centre = toBoardPoint(EAST, fromLocal(A1, { e: 4 * SQUARE_M, n: 4 * SQUARE_M }));
    // 4 squares east and 4 north of a1's centre, on a board whose axes are at
    // 45 degrees to the compass, is e5.
    const fr = squareUnderFoot(EAST, centre)!;
    expect(fr.file).toBe(4);
    expect(fr.rank).toBe(4);
  });

  it('is null off the board', () => {
    const outside = toBoardPoint(EAST, fromLocal(A1, { e: -200, n: -200 }));
    expect(squareUnderFoot(EAST, outside)).toBeNull();
  });

  it('claims the square you are on right to its edge', () => {
    const justInside = { u: 7 * EAST.squareM + EAST.squareM / 2 - 0.01, v: 0 };
    expect(squareUnderFoot(EAST, justInside)?.file).toBe(7);
    const justOutside = { u: 7 * EAST.squareM + EAST.squareM / 2 + 0.01, v: 0 };
    expect(squareUnderFoot(EAST, justOutside)).toBeNull();
  });
});

describe('startingPieces', () => {
  it('is a full army each', () => {
    const pieces = startingPieces();
    expect(Object.keys(pieces)).toHaveLength(32);
    expect(pieces.e1).toEqual({ type: 'k', color: 'w' });
    expect(pieces.d8).toEqual({ type: 'q', color: 'b' });
    expect(pieces.a2).toEqual({ type: 'p', color: 'w' });
    expect(pieces.e4).toBeUndefined();
  });
});
