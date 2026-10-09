/**
 * The watcher's board, drawn (stage 10.14, decision 0055).
 *
 * **A board of squares, not a field**, as the replay's is (`replay-draw.ts`):
 * the watcher's view holds every position as squares from a1's centre and
 * nothing that says where the board is or which way it faces, so the game's
 * own renderer is handed the replay's unit board and draws it without a north
 * arrow. The pieces, both looks, the last move, the lifted piece left faint on
 * its square and the pinch zoom are the board the players see.
 *
 * On top of it, **both players' dots**, each filled in its own side's color —
 * the players' screens draw "me" white and "them" red, which a watcher is
 * neither of — inside the red ring that means "a person", and the piece in
 * hand beside the carrier's dot (O-44), on the plate the players' screens use,
 * ringed in the carrier's color.
 */

import { boardPointOfIndex } from '../shared/field.js';
import type { Color } from '../shared/squares.js';
import type { WatchSpot } from '../shared/watch.js';
import type { ZoomView } from './board-zoom.js';
import { type PieceLook, drawPiece } from './pieces.js';
import {
  type Piece,
  type PieceType,
  type Projection,
  canvasSizePx,
  drawBoard,
  inHandPlacement,
  pieceBoxPx,
  piecesFromFen,
} from './render.js';
import { REPLAY_GEOMETRY } from './replay-draw.js';

export interface WatchBoardView {
  fen: string;
  orientation: Color;
  look: PieceLook;
  zoom: ZoomView | null;
  lastMove: { from: string; to: string } | null;
  carry: { color: Color; from: string; piece: string } | null;
  /** Each player's dot, or null where there is none to draw. */
  dots: Record<Color, { at: WatchSpot; connected: boolean } | null>;
}

/** The two dots: each side's own color, with a rim of the other so it reads on either square. */
const DOT_INK: Record<Color, { fill: string; edge: string }> = {
  w: { fill: '#ffffff', edge: '#0d1117' },
  b: { fill: '#151515', edge: '#ffffff' },
};
const DOT_RADIUS_PX = 7;
/**
 * The ring round both dots: the players' screens' red for "a person", so a
 * dot reads as somebody standing there even on a piece of its own color —
 * a white dot on a white pawn is otherwise nearly invisible, and a player
 * stands on the square they just put a piece down on.
 */
const PERSON_RING = '#ff4d6d';
const PERSON_RING_PX = 3;
const IN_HAND_PLATE = '#f4efdc';

/** A watch spot on the canvas. */
export function watchSpotToScreen(projection: Projection, spot: WatchSpot): { x: number; y: number } {
  return projection.toScreen(boardPointOfIndex(REPLAY_GEOMETRY, spot));
}

/** What is in hand, as a piece to draw, or null for anything unrecognised. */
export function inHandPiece(carry: { color: Color; piece: string } | null): Piece | null {
  if (carry === null) return null;
  const type = carry.piece.toLowerCase();
  if (type.length !== 1 || !'kqrbnp'.includes(type)) return null;
  return { type: type as PieceType, color: carry.color };
}

export function drawWatch(canvas: HTMLCanvasElement, view: WatchBoardView): Projection | null {
  const projection = drawBoard(canvas, {
    geo: REPLAY_GEOMETRY,
    orientation: view.orientation,
    pieces: piecesFromFen(view.fen),
    pos: null,
    accuracyM: 0,
    reachM: 0,
    over: true,
    lastMove: view.lastMove,
    look: view.look,
    zoom: view.zoom,
    north: false,
    // The lifted piece faint on its square, under the dashed outline; nothing
    // in hand here, because the hand is drawn below beside the right dot.
    carry: view.carry && { from: view.carry.from, destinations: [], mine: false, piece: null, hand: null },
  });
  if (projection === null) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return projection;
  const dpr = globalThis.devicePixelRatio ?? 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { width, height } = canvasSizePx(canvas);

  for (const color of ['w', 'b'] as const) {
    const dot = view.dots[color];
    if (dot === null) continue;
    const at = watchSpotToScreen(projection, dot.at);
    if (dot.connected) {
      ctx.beginPath();
      ctx.arc(at.x, at.y, DOT_RADIUS_PX + PERSON_RING_PX, 0, Math.PI * 2);
      ctx.fillStyle = PERSON_RING;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(at.x, at.y, DOT_RADIUS_PX, 0, Math.PI * 2);
      ctx.fillStyle = DOT_INK[color].fill;
      ctx.fill();
      ctx.strokeStyle = DOT_INK[color].edge;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(at.x, at.y, DOT_RADIUS_PX, 0, Math.PI * 2);
      // Hollow while that phone is away: the last place it was seen, not
      // where its player is.
      ctx.strokeStyle = PERSON_RING;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // The piece in hand goes with the carrier's dot while their phone is live,
  // exactly as on the players' screens (`carrierPosition` in `views/game.ts`).
  const piece = inHandPiece(view.carry);
  const carrier = view.carry ? view.dots[view.carry.color] : null;
  if (piece !== null && carrier !== null && carrier.connected) {
    const dot = watchSpotToScreen(projection, carrier.at);
    const plate = inHandPlacement(dot, pieceBoxPx(REPLAY_GEOMETRY, projection), { width, height });
    ctx.beginPath();
    ctx.arc(plate.x, plate.y, plate.plateRadius, 0, Math.PI * 2);
    ctx.fillStyle = IN_HAND_PLATE;
    ctx.fill();
    ctx.strokeStyle = DOT_INK[piece.color].edge;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = DOT_INK[piece.color].fill;
    ctx.lineWidth = 3;
    ctx.stroke();
    drawPiece(ctx, piece, view.look, plate.x, plate.y, plate.size);
  }
  return projection;
}
