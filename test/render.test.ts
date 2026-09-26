import { describe, expect, it } from 'vitest';

import { boardIndexOf, boardPointOfIndex, deriveGeometry, makeFieldSpec, toBoardPoint } from '../src/shared/field.js';
import { fromLocal } from '../src/shared/geo.js';
import { type ZoomView, zoomProjection } from '../src/client/board-zoom.js';
import {
  type CoordinateLabel,
  coordinateLabels,
  northOnScreen,
  projectionFor,
  squareUnderFoot,
  startingPieces,
} from '../src/client/render.js';

const A1 = { lat: 51.4779, lng: -0.0015 };
const SQUARE_M = 8;
/** a1 to h8 running due north-east, so the a→h axis points due east. */
const EAST = deriveGeometry(
  makeFieldSpec('east', { a1: A1, h8: fromLocal(A1, { e: 7 * SQUARE_M, n: 7 * SQUARE_M }) }),
);

const SIZE = 400;

function screenOf(geo: typeof EAST, orientation: 'w' | 'b', square: { file: number; rank: number }) {
  const p = projectionFor(geo, orientation, SIZE, SIZE);
  return p.toScreen({ u: square.file * geo.fileM, v: square.rank * geo.fileM });
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
    const alongFile = p.toScreen({ u: EAST.fileM, v: 0 });
    const alongRank = p.toScreen({ u: 0, v: EAST.fileM });
    expect(Math.hypot(alongFile.x - origin.x, alongFile.y - origin.y)).toBeCloseTo(
      Math.hypot(alongRank.x - origin.x, alongRank.y - origin.y),
      6,
    );
  });

  it('fits the whole board, outer half-squares included', () => {
    const p = projectionFor(EAST, 'w', SIZE, SIZE);
    const half = EAST.fileM / 2;
    const corner = p.toScreen({ u: -half, v: -half });
    const far = p.toScreen({ u: 7 * EAST.fileM + half, v: 7 * EAST.fileM + half });
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
      makeFieldSpec('n', { a1: A1, h8: fromLocal(A1, { e: -7 * SQUARE_M, n: 7 * SQUARE_M }) }),
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
    const justInside = { u: 7 * EAST.fileM + EAST.fileM / 2 - 0.01, v: 0 };
    expect(squareUnderFoot(EAST, justInside)?.file).toBe(7);
    const justOutside = { u: 7 * EAST.fileM + EAST.fileM / 2 + 0.01, v: 0 };
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

describe('coordinateLabels (O-46)', () => {
  const FONT = 12;
  /** 120 x 24 m, the 5:1 field zoom exists for. */
  const THIN = deriveGeometry(
    makeFieldSpec('thin', {
      a1: A1,
      h1: fromLocal(A1, { e: 7 * 15, n: 0 }),
      a8: fromLocal(A1, { e: 0, n: 7 * 3 }),
      h8: fromLocal(A1, { e: 7 * 15, n: 7 * 3 }),
    }),
  );

  /** Zoomed `k` times about the canvas centre. */
  const about = (k: number): ZoomView => ({ k, tx: (SIZE / 2) * (1 - k), ty: (SIZE / 2) * (1 - k) });

  function labels(geo: typeof EAST, orientation: 'w' | 'b', view: ZoomView | null) {
    const base = projectionFor(geo, orientation, SIZE, SIZE);
    const projection = view ? zoomProjection(base, view) : base;
    const placed = coordinateLabels(geo, orientation, projection, {
      width: SIZE,
      height: SIZE,
      fontPx: FONT,
      zoomed: view !== null && view.k > 1,
    });
    return { placed, projection };
  }

  const where = (placed: CoordinateLabel[], corner: CoordinateLabel['corner']) =>
    placed.filter((l) => l.corner === corner).map((l) => `${l.text}@${l.square.file},${l.square.rank}`);

  /** Whether a label's text, anchored where it is, lies wholly on the canvas. */
  const fits = (corner: CoordinateLabel['corner'], x: number, y: number) => {
    const left = corner === 'bottom-right' ? x - FONT : x;
    const top = corner === 'bottom-right' ? y - FONT : y;
    return left >= 0 && top >= 0 && left + FONT <= SIZE && top + FONT <= SIZE;
  };

  for (const orientation of ['w', 'b'] as const) {
    const near = orientation === 'w' ? 0 : 7;

    it(`puts them where they always were on the whole board, for ${orientation}`, () => {
      const { placed } = labels(EAST, orientation, null);
      expect(where(placed, 'bottom-right')).toEqual(
        [...'abcdefgh'].map((letter, file) => `${letter}@${file},${near}`),
      );
      expect(where(placed, 'top-left')).toEqual(
        [1, 2, 3, 4, 5, 6, 7, 8].map((n, rank) => `${n}@${near},${rank}`),
      );
      // A little zoom that leaves both edges in view moves none of them.
      const slight = labels(EAST, orientation, about(1.05)).placed;
      expect(where(slight, 'bottom-right')).toEqual(where(placed, 'bottom-right'));
      expect(where(slight, 'top-left')).toEqual(where(placed, 'top-left'));
    });

    for (const [name, geo] of [
      ['square', EAST],
      ['5:1', THIN],
    ] as const) {
      it(`keeps them on screen, in the corners of whole cells, zoomed into the middle (${name}, ${orientation})`, () => {
        const { placed, projection } = labels(geo, orientation, about(4));
        expect(placed.some((l) => l.corner === 'bottom-right')).toBe(true);
        expect(placed.some((l) => l.corner === 'top-left')).toBe(true);
        // Zoomed into the middle, the rank numbers have left the left edge, and
        // on the square board the file letters the near one too. (Across its
        // short way the 5:1 board still fits at 4x, so its near rank is in view.)
        const moved = placed.filter((l) =>
          l.corner === 'top-left' ? l.square.file !== near : name === '5:1' || l.square.rank !== near,
        );
        expect(moved).toEqual(placed);
        if (name === '5:1') {
          expect(placed.filter((l) => l.corner === 'bottom-right').every((l) => l.square.rank === near)).toBe(true);
        }
        for (const label of placed) {
          expect(fits(label.corner, label.x, label.y)).toBe(true);
          // Inside its own cell, near the corner the whole board uses, so it
          // covers no more of a piece than a near-rank label always has.
          const bi = boardIndexOf(geo, projection.toBoard(label.x, label.y));
          expect(Math.round(bi.file) + 0).toBe(label.square.file);
          expect(Math.round(bi.rank) + 0).toBe(label.square.rank);
          expect(Math.abs(bi.file - label.square.file)).toBeGreaterThan(0.25);
          expect(Math.abs(bi.rank - label.square.rank)).toBeGreaterThan(0.25);
          if (label.corner === 'bottom-right') expect(label.text).toBe('abcdefgh'[label.square.file]);
          else expect(label.text).toBe(String(label.square.rank + 1));

          // And it is the nearest to the player's own edge (files) or the
          // leftmost (ranks): the same corner one cell further out is off.
          const out = orientation === 'w' ? -1 : 1;
          const next =
            label.corner === 'bottom-right'
              ? { file: label.square.file, rank: label.square.rank + out }
              : { file: label.square.file + out, rank: label.square.rank };
          if (next.file < 0 || next.file > 7 || next.rank < 0 || next.rank > 7) continue;
          const from = projection.toScreen(boardPointOfIndex(geo, label.square));
          const to = projection.toScreen(boardPointOfIndex(geo, next));
          expect(fits(label.corner, label.x + to.x - from.x, label.y + to.y - from.y)).toBe(false);
        }
      });
    }
  }
});
