/**
 * How a checker looks, everywhere one is drawn (decisions 0045, 0058).
 *
 * Drawn for this project, so there is no third party's license to carry. Two
 * pieces a side: a **man** and a **king**, and the king has to be told from
 * a man at arm's length in sun, on a phone held while walking. So a king
 * wears a **gold crown** that fills half the piece, where a man shows only
 * its rim's ridges — a difference of shape and color at once, not a thin line.
 *
 * Paint follows the seat's paint in checkers (decision 0057): the `w` seat
 * moves first and plays the **dark** pieces, the `b` seat the light ones. A
 * `Color` here is a seat, as everywhere in the game.
 *
 * ## Two looks, as for chess (decision 0045)
 *
 * - **`standard`**: a checker as a board game has it — a thick disc seen from
 *   above, its edge showing a little below it, two ridges round the top.
 * - **`disc`**: the owner's look. A flat disc of the team's color with the
 *   same **gray ring** (`#8a8a8a`) chess's discs have, so a light disc shows
 *   on a light square and a dark one on a dark square, and one ridge inside.
 *
 * Each piece is a list of shapes in a 45-unit box (chess's art box), drawn on
 * a canvas by {@link drawPiece} and written as SVG by {@link pieceSvg} from
 * the same list, so the board, the carry readout and anything else cannot
 * drift apart.
 */

import type { PieceOn } from '../../../shared/games/types.js';
import type { Color } from '../../../shared/squares.js';
import type { PieceLook } from '../types.js';

/** Our own drawing: what the account screen's credits say about it. */
export const CHECKERS_ART_CREDIT = 'Checkers pieces drawn for Satellite Chess.';
export const CHECKERS_ART_LICENSE = 'Part of this app; no separate license.';

const BOX = 45;
const MID = BOX / 2;

/** The gray ring of the disc look: chess's, so the two games' discs match. */
export const DISC_RING = '#8a8a8a';

/** Each seat's paint: `w` plays the dark pieces in checkers (decision 0057). */
const PAINT: Record<Color, { top: string; edge: string; ridge: string; outline: string }> = {
  w: { top: '#262626', edge: '#0b0b0b', ridge: '#7a7a7a', outline: '#000000' },
  b: { top: '#f6f2e6', edge: '#b9b2a0', ridge: '#8f8878', outline: '#000000' },
};

const CROWN_FILL = '#e3b11c';
const CROWN_LINE = '#000000';

/**
 * The crown, in the box, centred a little high so it reads as sitting on the
 * piece. Five points over a band.
 */
const CROWN =
  'M 12.5,28.5 L 10.5,16.5 L 16.5,21.5 L 22.5,12.5 L 28.5,21.5 L 34.5,16.5 L 32.5,28.5 Z ' +
  'M 12.5,28.5 L 32.5,28.5 L 32.5,32 L 12.5,32 Z';

/** One shape of a piece, in box units. */
type Shape =
  | { kind: 'circle'; cx: number; cy: number; r: number; fill?: string; stroke?: string; width?: number }
  | { kind: 'path'; d: string; fill?: string; stroke?: string; width?: number };

/**
 * The shapes of one piece in one look, back to front.
 *
 * Exported for the art test, which checks that a king is never drawn as a man.
 */
export function shapesOf(piece: PieceOn, look: PieceLook): Shape[] {
  const paint = PAINT[piece.color] ?? PAINT.b;
  const king = piece.type === 'k';
  const shapes: Shape[] = [];
  if (look === 'disc') {
    const r = BOX * 0.48;
    const ring = BOX * 0.07;
    shapes.push({ kind: 'circle', cx: MID, cy: MID, r, fill: paint.top });
    shapes.push({ kind: 'circle', cx: MID, cy: MID, r: r - ring / 2, stroke: DISC_RING, width: ring });
    if (!king) shapes.push({ kind: 'circle', cx: MID, cy: MID, r: r * 0.55, stroke: DISC_RING, width: 1.6 });
  } else {
    const r = BOX * 0.41;
    const lift = BOX * 0.05;
    // The edge of the disc, showing below its top: what makes it a checker.
    shapes.push({ kind: 'circle', cx: MID, cy: MID + lift / 2, r, fill: paint.edge, stroke: paint.outline, width: 1.5 });
    shapes.push({ kind: 'circle', cx: MID, cy: MID - lift / 2, r, fill: paint.top, stroke: paint.outline, width: 1.5 });
    shapes.push({ kind: 'circle', cx: MID, cy: MID - lift / 2, r: r * 0.78, stroke: paint.ridge, width: 1.4 });
    if (!king) shapes.push({ kind: 'circle', cx: MID, cy: MID - lift / 2, r: r * 0.5, stroke: paint.ridge, width: 1.4 });
  }
  if (king) shapes.push({ kind: 'path', d: CROWN, fill: CROWN_FILL, stroke: CROWN_LINE, width: 1.5 });
  return shapes;
}

/**
 * Lines never fall below one screen pixel, as chess's do: a 10 px piece on a
 * long, thin field still shows its rim.
 */
const MIN_LINE_PX = 1;

const pathCache = new Map<string, Path2D>();
function pathOf(d: string): Path2D {
  let path = pathCache.get(d);
  if (!path) {
    path = new Path2D(d);
    pathCache.set(d, path);
  }
  return path;
}

/**
 * Draw one piece centred on (`cx`, `cy`) in a box `boxPx` pixels across,
 * leaving the context's state as it found it.
 */
export function drawPiece(
  ctx: CanvasRenderingContext2D,
  piece: PieceOn,
  look: PieceLook,
  cx: number,
  cy: number,
  boxPx: number,
): void {
  const k = boxPx / BOX;
  ctx.save();
  ctx.translate(cx - boxPx / 2, cy - boxPx / 2);
  ctx.scale(k, k);
  ctx.lineJoin = 'round';
  for (const shape of shapesOf(piece, look)) {
    let path: Path2D | null = null;
    if (shape.kind === 'path') path = pathOf(shape.d);
    else {
      ctx.beginPath();
      ctx.arc(shape.cx, shape.cy, shape.r, 0, Math.PI * 2);
    }
    if (shape.fill) {
      ctx.fillStyle = shape.fill;
      if (path) ctx.fill(path);
      else ctx.fill();
    }
    if (shape.stroke) {
      ctx.strokeStyle = shape.stroke;
      ctx.lineWidth = Math.max(shape.width ?? 1.5, MIN_LINE_PX / k);
      if (path) ctx.stroke(path);
      else ctx.stroke();
    }
  }
  ctx.restore();
}

/** A number as markup, without floating-point tails. */
function short(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/**
 * The same piece as inline SVG markup, for the HTML around the board, built
 * from the same shapes. `aria-hidden`, because every place that shows one also
 * names the square in words.
 */
export function pieceSvg(piece: PieceOn, look: PieceLook): string {
  const body = shapesOf(piece, look)
    .map((shape) => {
      const paint = [
        `fill="${shape.fill ?? 'none'}"`,
        ...(shape.stroke ? [`stroke="${shape.stroke}"`, `stroke-width="${short(shape.width ?? 1.5)}"`] : []),
      ].join(' ');
      return shape.kind === 'circle'
        ? `<circle cx="${short(shape.cx)}" cy="${short(shape.cy)}" r="${short(shape.r)}" ${paint}/>`
        : `<path d="${shape.d}" stroke-linejoin="round" ${paint}/>`;
    })
    .join('');
  return (
    `<svg class="piece" viewBox="0 0 ${BOX} ${BOX}" aria-hidden="true" focusable="false" data-piece="${piece.color}${piece.type}">` +
    body +
    `</svg>`
  );
}
