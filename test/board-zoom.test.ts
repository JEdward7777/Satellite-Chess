import { describe, expect, it } from 'vitest';

import {
  BoardGesture,
  FOLLOW_EDGE,
  IDENTITY,
  MAX_ZOOM,
  TAP_SLOP_PX,
  type ZoomFrame,
  type ZoomView,
  centreOn,
  clampView,
  fromZoomed,
  keepInFrame,
  onCanvas,
  panView,
  pinchView,
  toZoomed,
  zoomProjection,
} from '../src/client/board-zoom.js';
import { zoomFrameFor } from '../src/client/render.js';
import { boardIndexOf, deriveGeometry, makeFieldSpec, squareCentre } from '../src/shared/field.js';
import { fromLocal } from '../src/shared/geo.js';
import { fromSquare, toSquare } from '../src/shared/squares.js';

const A1 = { lat: 51.4779, lng: -0.0015 };
const SQUARE_M = 8;
const SQUARE_BOARD = deriveGeometry(
  makeFieldSpec('east', { a1: A1, h8: fromLocal(A1, { e: 7 * SQUARE_M, n: 7 * SQUARE_M }) }),
);
/** 120 x 24 m, the 5:1 field the pieces are about seven pixels tall on. */
const THIN_BOARD = deriveGeometry(
  makeFieldSpec('thin', {
    a1: A1,
    h1: fromLocal(A1, { e: 7 * 15, n: 0 }),
    a8: fromLocal(A1, { e: 0, n: 7 * 3 }),
    h8: fromLocal(A1, { e: 7 * 15, n: 7 * 3 }),
  }),
);

const SIZE = 400;
const { frame: FRAME, base: BASE } = zoomFrameFor(SQUARE_BOARD, 'w', SIZE, SIZE);
const THIN = zoomFrameFor(THIN_BOARD, 'w', SIZE, SIZE);

/** What `game.ts` does with a tap: through the projection, to a square. */
function squareAt(view: ZoomView, x: number, y: number, geo = SQUARE_BOARD, base = BASE): string | null {
  const bp = zoomProjection(base, view).toBoard(x, y);
  const bi = boardIndexOf(geo, bp);
  const file = Math.round(bi.file);
  const rank = Math.round(bi.rank);
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return toSquare(file, rank);
}

/** Where a square's centre is drawn in a view. */
function screenOf(view: ZoomView, square: string, geo = SQUARE_BOARD, base = BASE) {
  return zoomProjection(base, view).toScreen(squareCentre(geo, fromSquare(square)));
}

/** The board's outline on screen in a view, for "is it still on the canvas". */
function boardOnScreen(view: ZoomView, frame: ZoomFrame) {
  const a = toZoomed(view, { x: frame.board.minX, y: frame.board.minY });
  const b = toZoomed(view, { x: frame.board.maxX, y: frame.board.maxY });
  return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
}

describe('zoomProjection', () => {
  it('is the fitted projection itself at 1x', () => {
    expect(zoomProjection(BASE, IDENTITY)).toBe(BASE);
  });

  it('scales metres with the zoom and round-trips', () => {
    const view = { k: 3, tx: -250, ty: -120 };
    const zoomed = zoomProjection(BASE, view);
    expect(zoomed.scale).toBeCloseTo(BASE.scale * 3, 9);
    const bp = { u: 13.7, v: 41.2 };
    const back = zoomed.toBoard(zoomed.toScreen(bp).x, zoomed.toScreen(bp).y);
    expect(back.u).toBeCloseTo(bp.u, 9);
    expect(back.v).toBeCloseTo(bp.v, 9);
  });

  it('maps a tap on a zoomed square back to that square, from either side', () => {
    for (const orientation of ['w', 'b'] as const) {
      const { frame, base } = zoomFrameFor(SQUARE_BOARD, orientation, SIZE, SIZE);
      const view = centreOn({ k: 4, tx: 0, ty: 0 }, base.toScreen(squareCentre(SQUARE_BOARD, fromSquare('e4'))), frame);
      for (const square of ['e4', 'd5', 'f3', 'e5']) {
        const at = screenOf(view, square, SQUARE_BOARD, base);
        expect(squareAt(view, at.x, at.y, SQUARE_BOARD, base)).toBe(square);
      }
    }
  });

  it('maps a tap on a thin field, where a square is a few pixels tall at 1x', () => {
    const view = centreOn({ k: MAX_ZOOM, tx: 0, ty: 0 }, THIN.base.toScreen(squareCentre(THIN_BOARD, fromSquare('c7'))), THIN.frame);
    const at = screenOf(view, 'c7', THIN_BOARD, THIN.base);
    // A quarter of a square off centre, towards c8: still c7.
    const c8 = screenOf(view, 'c8', THIN_BOARD, THIN.base);
    const y = at.y + (c8.y - at.y) * 0.25;
    expect(squareAt(view, at.x, y, THIN_BOARD, THIN.base)).toBe('c7');
    expect(squareAt(view, c8.x, c8.y, THIN_BOARD, THIN.base)).toBe('c8');
  });
});

describe('clampView', () => {
  it('holds the zoom between 1x and the maximum', () => {
    expect(clampView({ k: 40, tx: 0, ty: 0 }, FRAME).k).toBe(MAX_ZOOM);
    expect(clampView({ k: 0.4, tx: 12, ty: -8 }, FRAME)).toEqual(IDENTITY);
    expect(clampView({ k: 1, tx: 30, ty: 30 }, FRAME)).toEqual(IDENTITY);
  });

  it('never lets the board be pushed off the canvas', () => {
    for (const [tx, ty] of [
      [5000, 5000],
      [-5000, -5000],
      [5000, -5000],
    ]) {
      const view = clampView({ k: 3, tx, ty }, FRAME);
      const board = boardOnScreen(view, FRAME);
      expect(board.minX).toBeLessThanOrEqual(FRAME.margin + 1e-9);
      expect(board.minY).toBeLessThanOrEqual(FRAME.margin + 1e-9);
      expect(board.maxX).toBeGreaterThanOrEqual(SIZE - FRAME.margin - 1e-9);
      expect(board.maxY).toBeGreaterThanOrEqual(SIZE - FRAME.margin - 1e-9);
    }
  });

  it('keeps a thin board centred across its short way until it fills it', () => {
    // At 2x a 5:1 board is still well short of the canvas top to bottom.
    const view = clampView({ k: 2, tx: -100, ty: 900 }, THIN.frame);
    const board = boardOnScreen(view, THIN.frame);
    expect((board.minY + board.maxY) / 2).toBeCloseTo(SIZE / 2, 6);
  });

  it('meets the whole-board view continuously just above 1x', () => {
    const view = clampView({ k: 1.0001, tx: 0, ty: 0 }, FRAME);
    expect(view.tx).toBeCloseTo(0, 1);
    expect(view.ty).toBeCloseTo(0, 1);
  });
});

describe('pinchView', () => {
  const from: [{ x: number; y: number }, { x: number; y: number }] = [
    { x: 180, y: 200 },
    { x: 220, y: 200 },
  ];

  it('zooms about the pinch: the square under the fingers stays under them', () => {
    const to: typeof from = [
      { x: 140, y: 200 },
      { x: 260, y: 200 },
    ];
    const before = squareAt(IDENTITY, 200, 200);
    const view = pinchView(IDENTITY, from, to, FRAME);
    expect(view.k).toBeCloseTo(3, 9);
    expect(squareAt(view, 200, 200)).toBe(before);
    const under = fromZoomed(view, { x: 200, y: 200 });
    expect(under.x).toBeCloseTo(200, 6);
    expect(under.y).toBeCloseTo(200, 6);
  });

  it('stops at the maximum however far the fingers spread', () => {
    const to: typeof from = [
      { x: 0, y: 200 },
      { x: 4000, y: 200 },
    ];
    expect(pinchView(IDENTITY, from, to, FRAME).k).toBe(MAX_ZOOM);
  });

  it('comes back to exactly the whole board when pinched out past it', () => {
    const zoomed = { k: 2, tx: -200, ty: -200 };
    const to: typeof from = [
      { x: 195, y: 200 },
      { x: 205, y: 200 },
    ];
    expect(pinchView(zoomed, from, to, FRAME)).toEqual(IDENTITY);
  });
});

describe('panView, centreOn and keepInFrame', () => {
  it('does not pan the whole board', () => {
    expect(panView(IDENTITY, 50, 50, FRAME)).toEqual(IDENTITY);
  });

  it('pans a zoomed board by the finger, within the clamp', () => {
    const start = centreOn({ k: 3, tx: 0, ty: 0 }, { x: 200, y: 200 }, FRAME);
    const view = panView(start, 30, -20, FRAME);
    expect(view.tx - start.tx).toBeCloseTo(30, 9);
    expect(view.ty - start.ty).toBeCloseTo(-20, 9);
  });

  it('leaves a dot clear of the edge alone, and centres one that reaches the edge', () => {
    const view = centreOn({ k: 3, tx: 0, ty: 0 }, { x: 200, y: 200 }, FRAME);
    const inside = { x: 210, y: 190 };
    expect(keepInFrame(view, inside, FRAME)).toEqual(view);

    const nearEdge = { x: 245, y: 200 }; // 335 px on screen, in the 80 px band
    const moved = keepInFrame(view, nearEdge, FRAME);
    const p = toZoomed(moved, nearEdge);
    expect(p.x).toBeCloseTo(SIZE / 2, 6);
    expect(p.y).toBeCloseTo(SIZE / 2, 6);
  });

  it('holds still for a dot off the edge of the board, once it has shown that edge', () => {
    const view = centreOn({ k: 3, tx: 0, ty: 0 }, { x: 200, y: 200 }, FRAME);
    const offBoard = { x: 5, y: 200 };
    const first = keepInFrame(view, offBoard, FRAME);
    expect(toZoomed(first, { x: FRAME.board.minX, y: 0 }).x).toBeCloseTo(FRAME.margin, 6);
    expect(keepInFrame(first, offBoard, FRAME)).toEqual(first);
  });

  it('knows when a dot is off the canvas', () => {
    const view = centreOn({ k: 4, tx: 0, ty: 0 }, { x: 200, y: 200 }, FRAME);
    expect(onCanvas(view, { x: 200, y: 200 }, FRAME)).toBe(true);
    expect(onCanvas(view, { x: 30, y: 200 }, FRAME)).toBe(false);
  });
});

/** A gesture with a frame and a dot in the middle of the board. */
function gesture(dot: { x: number; y: number } | null = { x: 200, y: 200 }): BoardGesture {
  const g = new BoardGesture();
  g.settle(FRAME, dot);
  return g;
}

/** Pinch two fingers apart about (200, 200) to three times. */
function pinchIn(g: BoardGesture, about = { x: 200, y: 200 }): void {
  g.down(1, about.x - 20, about.y, true);
  g.down(2, about.x + 20, about.y, false);
  g.move(1, about.x - 60, about.y);
  g.move(2, about.x + 60, about.y);
  expect(g.up(1, about.x - 60, about.y)).toBeNull();
  expect(g.up(2, about.x + 60, about.y)).toBeNull();
}

describe('BoardGesture: taps', () => {
  it('is a tap when one finger goes down and up in place', () => {
    const g = gesture();
    g.down(1, 100, 120, true);
    expect(g.up(1, 100, 120)).toEqual({ x: 100, y: 120 });
  });

  it('forgives a wobble within the slop, and aims where the finger landed', () => {
    const g = gesture();
    g.down(1, 100, 120, true);
    g.move(1, 100 + TAP_SLOP_PX - 1, 120);
    expect(g.up(1, 100 + TAP_SLOP_PX - 1, 120)).toEqual({ x: 100, y: 120 });
  });

  it('is never a tap once the finger has strayed, even if it comes back', () => {
    const g = gesture();
    g.down(1, 100, 120, true);
    g.move(1, 100 + TAP_SLOP_PX + 1, 120);
    g.move(1, 100, 120);
    expect(g.up(1, 100, 120)).toBeNull();
  });

  it('never reads a pan of a zoomed board as a tap', () => {
    const g = gesture();
    pinchIn(g);
    const before = g.zoom;
    g.down(3, 200, 200, true);
    g.move(3, 240, 230);
    expect(g.up(3, 240, 230)).toBeNull();
    expect(g.zoom).not.toEqual(before);
  });

  it('never reads either finger of a pinch as a tap', () => {
    const g = gesture();
    pinchIn(g);
    expect(g.zoom.k).toBeCloseTo(3, 9);
  });

  it('never reads a second finger, or the last one off, as a tap, even without movement', () => {
    const g = gesture();
    g.down(1, 100, 100, true);
    g.down(2, 300, 300, false);
    expect(g.up(2, 300, 300)).toBeNull();
    expect(g.up(1, 100, 100)).toBeNull();
    // And the next touch is a fresh one.
    g.down(3, 100, 100, true);
    expect(g.up(3, 100, 100)).toEqual({ x: 100, y: 100 });
  });

  it('never reads a cancelled finger as a tap', () => {
    const h = gesture();
    h.down(1, 100, 100, true);
    h.down(2, 150, 100, false);
    h.cancel(2);
    expect(h.up(1, 100, 100)).toBeNull();
  });

  it('never takes a pointerup it did not see go down as a tap', () => {
    const g = gesture();
    expect(g.up(9, 50, 60)).toBeNull();
    g.down(1, 100, 100, true);
    expect(g.up(9, 50, 60)).toBeNull();
    expect(g.up(1, 100, 100)).toEqual({ x: 100, y: 100 });
  });

  it('never reads the fingers of a pinch as taps when the view is reset under them', () => {
    // The board turning round mid-pinch, when the first snapshot names the side.
    const g = gesture();
    g.down(1, 180, 200, true);
    g.down(2, 220, 200, false);
    g.move(1, 140, 200);
    g.move(2, 260, 200);
    g.reset();
    expect(g.zoom).toEqual(IDENTITY);
    expect(g.up(1, 140, 200)).toBeNull();
    expect(g.up(2, 260, 200)).toBeNull();
    g.down(3, 100, 100, true);
    expect(g.up(3, 100, 100)).toEqual({ x: 100, y: 100 });
  });

  it('never reads a press as a tap once the view was reset under it, even at 1x', () => {
    const g = gesture();
    g.down(1, 100, 100, true);
    g.reset();
    expect(g.up(1, 100, 100)).toBeNull();
  });

  it('never reads a press as a tap once Follow me moved the view under it', () => {
    const g = gesture();
    pinchIn(g);
    g.down(3, 200, 200, true);
    g.move(3, 150, 200);
    g.up(3, 150, 200);
    g.down(4, 120, 120, true);
    g.followMe();
    expect(g.up(4, 120, 120)).toBeNull();
  });

  it('never reads a press as a tap once the canvas was re-fitted under it', () => {
    const g = gesture();
    g.down(1, 100, 100, true);
    g.settle(FRAME, { x: 200, y: 200 }); // same size: an ordinary repaint
    g.settle(zoomFrameFor(SQUARE_BOARD, 'w', 300, 400).frame, { x: 150, y: 200 }); // rotated
    expect(g.up(1, 100, 100)).toBeNull();
    // A repaint at an unchanged size does not spend a press.
    g.down(2, 100, 100, true);
    g.settle(zoomFrameFor(SQUARE_BOARD, 'w', 300, 400).frame, { x: 150, y: 200 });
    expect(g.up(2, 100, 100)).toEqual({ x: 100, y: 100 });
  });

  it('carries a pinch on from the reset view rather than jumping back', () => {
    const g = gesture();
    pinchIn(g);
    g.down(1, 180, 200, true);
    g.down(2, 220, 200, false);
    g.reset();
    g.move(1, 179, 200);
    expect(g.zoom.k).toBeLessThan(1.1);
  });

  it('forgets a finger whose lift was lost, rather than refusing every tap after it', () => {
    const g = gesture();
    g.down(1, 100, 100, true);
    // No up for finger 1. The next touch starts afresh.
    g.down(2, 200, 200, true);
    expect(g.up(2, 200, 200)).toEqual({ x: 200, y: 200 });
  });

  it('maps a tap on a zoomed board to the square under the finger', () => {
    const g = gesture();
    pinchIn(g, screenOf(IDENTITY, 'g7'));
    const target = screenOf(g.zoom, 'f6');
    g.down(4, target.x, target.y, true);
    const tap = g.up(4, target.x, target.y)!;
    expect(squareAt(g.zoom, tap.x, tap.y)).toBe('f6');
  });
});

describe('BoardGesture: following', () => {
  it('follows by default, and keeps the dot in frame as it moves', () => {
    const g = gesture();
    pinchIn(g);
    expect(g.isFollowing).toBe(true);
    // A step is not enough to move the view...
    const still = g.zoom;
    expect(g.settle(FRAME, { x: 205, y: 200 })).toEqual(still);
    // ...but walking into the edge band brings you back to the middle.
    const view = g.settle(FRAME, { x: 260, y: 200 });
    const p = toZoomed(view, { x: 260, y: 200 });
    expect(p.x).toBeLessThan(SIZE - FOLLOW_EDGE * SIZE);
    expect(p.x).toBeCloseTo(SIZE / 2, 6);
  });

  it('stops following when the view is dragged by hand, and Follow me brings it back', () => {
    const g = gesture();
    pinchIn(g);
    g.down(3, 200, 200, true);
    g.move(3, 100, 200);
    g.up(3, 100, 200);
    expect(g.isFollowing).toBe(false);
    const panned = g.settle(FRAME, { x: 200, y: 200 });
    expect(g.settle(FRAME, { x: 230, y: 200 })).toEqual(panned);

    g.followMe();
    expect(g.isFollowing).toBe(true);
    const p = toZoomed(g.zoom, { x: 230, y: 200 });
    expect(p.x).toBeCloseTo(SIZE / 2, 6);
  });

  it('stops following after a pinch that leaves the dot off screen, not after one that keeps it', () => {
    const g = gesture({ x: 120, y: 200 });
    pinchIn(g, { x: 150, y: 200 });
    expect(g.isFollowing).toBe(true);

    const h = gesture({ x: 60, y: 200 });
    pinchIn(h, { x: 330, y: 200 });
    expect(h.isFollowing).toBe(false);
  });

  it('does not move the view under a finger that is down', () => {
    const g = gesture();
    pinchIn(g);
    g.down(5, 200, 200, true);
    const held = g.zoom;
    expect(g.settle(FRAME, { x: 270, y: 200 })).toEqual(held);
  });

  it('goes back to the whole board, following, on reset', () => {
    const g = gesture();
    pinchIn(g);
    g.down(3, 200, 200, true);
    g.move(3, 100, 200);
    g.up(3, 100, 200);
    g.reset();
    expect(g.zoom).toEqual(IDENTITY);
    expect(g.isFollowing).toBe(true);
  });
});
