/**
 * The replay, drawn (stage 8.3, decision 0052): the board at one ply, the
 * carry that made it, and both players' walks over it.
 *
 * **A board of squares, not a field.** Everything a replay has is in squares
 * from a1's centre (the report, the archive), and nothing in either says
 * where the board was or which way it faced. So the game's own renderer is
 * handed a unit board, {@link REPLAY_GEOMETRY} — one meter a square, facing
 * nowhere in particular, anchored at a point that is no place — and draws it
 * with the north arrow left out, because there is no north to point at. The
 * pieces, both looks, the last-move tint and the pinch zoom are then exactly
 * the board the players walked with.
 *
 * Square, whatever shape the real board was: the report keeps the narrowest
 * square and the longer side, not the shape, and an 8 × 8 grid is what the
 * share card (8.5.1) asks for too. A track is in squares, so it lands on the
 * same squares on this grid as it did on the field.
 *
 * Kept apart from the review screen so the share card can draw the same
 * picture onto its own canvas.
 */

import type { FieldGeometry } from '../shared/field.js';
import { boardPointOfIndex } from '../shared/field.js';
import type { Color } from '../shared/squares.js';
import type { ZoomView } from './board-zoom.js';
import type { PieceLook } from './pieces.js';
import { type Projection, drawBoard, piecesFromFen } from './render.js';
import type { ReplayFrame, Spot } from './replay.js';

/**
 * A square board of one-meter squares, with a1's centre at the origin and the
 * files running east. Only its shape is used: no latitude is ever made from
 * it, because nothing that is drawn came from one.
 */
export const REPLAY_GEOMETRY: FieldGeometry = Object.freeze({
  origin: { lat: 0, lng: 0 },
  fileM: 1,
  rankM: 1,
  meanSquareM: 1,
  axisAngleDeg: 90,
  bearingDeg: 90,
  fileStep: { e: 1, n: 0 },
  rankStep: { e: 0, n: 1 },
  uHat: { e: 1, n: 0 },
  vHat: { e: 0, n: 1 },
  inv: { a: 1, b: 0, c: 0, d: 1 },
});

export interface ReplayView {
  frame: ReplayFrame;
  /** Whose side is at the bottom: the reader's. */
  orientation: Color;
  look?: PieceLook;
  zoom?: ZoomView | null;
}

/**
 * The colors of the walks. Each player's walk is drawn in their own color
 * with a halo of the other, so either reads over a light or a dark square;
 * the carry is the one bright line, because it is the move.
 */
const WALK_INK: Record<Color, { line: string; halo: string }> = {
  w: { line: '#ffffff', halo: '#0d1117' },
  b: { line: '#151515', halo: '#ffffff' },
};
const CARRY_INK = '#ff8c1a';
const CARRY_HALO = '#0d1117';
/** How much of the earlier walks shows under this ply's. */
const EARLIER_ALPHA = 0.35;
const MAX_LINE_PX = 7;

/** A position in squares, on the canvas. */
export function spotToScreen(projection: Projection, spot: Spot): { x: number; y: number } {
  return projection.toScreen(boardPointOfIndex(REPLAY_GEOMETRY, spot));
}

/** Draw one ply. Returns the projection, as `drawBoard` does. */
export function drawReplay(canvas: HTMLCanvasElement, view: ReplayView): Projection | null {
  const { frame } = view;
  const lastMove = frame.move === null ? null : { from: frame.move.from, to: frame.move.to };
  const projection = drawBoard(canvas, {
    geo: REPLAY_GEOMETRY,
    orientation: view.orientation,
    pieces: piecesFromFen(frame.fen),
    pos: null,
    accuracyM: 0,
    reachM: 0,
    over: true,
    lastMove,
    look: view.look,
    zoom: view.zoom ?? null,
    north: false,
  });
  if (projection === null) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return projection;
  const dpr = globalThis.devicePixelRatio ?? 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // One square on screen. Line widths follow it, capped, as the board's own
  // strokes are, so a zoomed board does not draw ropes.
  const cell = projection.scale;
  const width = (fraction: number, floor: number) => Math.min(MAX_LINE_PX, Math.max(floor, cell * fraction));
  const toScreen = (spot: Spot) => spotToScreen(projection, spot);

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Earlier walks first and faint, so this ply's lie over them.
  ctx.globalAlpha = EARLIER_ALPHA;
  for (const color of ['w', 'b'] as const) {
    for (const line of frame.earlier[color]) {
      stroke(ctx, line.map(toScreen), WALK_INK[color].line, WALK_INK[color].halo, width(0.03, 1.5), []);
    }
  }
  ctx.globalAlpha = 1;

  if (frame.move !== null) {
    const mover = frame.move.color;
    const other: Color = mover === 'w' ? 'b' : 'w';
    const dot = width(0.05, 2);
    stroke(ctx, frame.waiting.map(toScreen), WALK_INK[other].line, WALK_INK[other].halo, width(0.04, 2), [1, dot * 2]);
    // The walk to the piece ends where it was lifted, which is where the carry
    // starts, so the two lines meet.
    const approach = frame.carry !== null && frame.carry.length > 0 ? [...frame.approach, frame.carry[0]!] : frame.approach;
    stroke(ctx, approach.map(toScreen), WALK_INK[mover].line, WALK_INK[mover].halo, width(0.05, 2), [dot * 3, dot * 2]);

    if (frame.carry !== null) {
      const path = frame.carry.map(toScreen);
      stroke(ctx, path, CARRY_INK, CARRY_HALO, width(0.08, 3), []);
      const r = Math.min(12, Math.max(4, cell * 0.12));
      const lifted = frame.move.lift !== null ? path[0] : null;
      const placed = frame.move.place !== null ? path[path.length - 1] : null;
      // Lifted: a ring. Put down: a filled disc. Told apart by shape as well
      // as by order, for a carry that ends where it began.
      if (lifted) marker(ctx, lifted, r, false);
      if (placed) marker(ctx, placed, r, true);
    }
  }
  ctx.restore();
  return projection;
}

/** A line with a halo under it, so it reads over either square color. */
function stroke(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  ink: string,
  halo: string,
  lineWidth: number,
  dash: number[],
): void {
  if (points.length === 0) return;
  ctx.setLineDash(dash);
  if (points.length === 1) {
    // A single fix is a place somebody stood, not a line: a dot.
    const p = points[0]!;
    ctx.beginPath();
    ctx.arc(p.x, p.y, lineWidth, 0, Math.PI * 2);
    ctx.fillStyle = halo;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, lineWidth * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = ink;
    ctx.fill();
    ctx.setLineDash([]);
    return;
  }
  for (const [style, w] of [
    [halo, lineWidth + 2],
    [ink, lineWidth],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = style;
    ctx.lineWidth = w;
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function marker(ctx: CanvasRenderingContext2D, at: { x: number; y: number }, r: number, filled: boolean): void {
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
  if (filled) {
    ctx.fillStyle = CARRY_INK;
    ctx.fill();
  }
  ctx.strokeStyle = CARRY_HALO;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  if (!filled) {
    ctx.beginPath();
    ctx.arc(at.x, at.y, r - 2, 0, Math.PI * 2);
    ctx.strokeStyle = CARRY_INK;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
}
