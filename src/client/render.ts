/**
 * Draw the field as a chessboard.
 *
 * Everything is drawn in **board space** — metres along the file axis and the
 * rank axis — so however the board is rotated on the ground, the screen shows an
 * ordinary chessboard with your own side at the bottom. That is the whole trick:
 * a player should be able to read the position as chess, and separately relate it
 * to the ground via the north arrow, rather than having to do both at once.
 *
 * The canvas is the only place the two coordinate systems meet. Reach, legality
 * and distance are all computed in metres by `shared/`; this file only decides
 * where a metre lands in pixels.
 */

import {
  type BoardPoint,
  type FieldGeometry,
  boardExtentM,
  boardIndexOf,
  boardPointOfIndex,
  distanceFromBoardPointToSquareM,
  squareCentre,
  squareCornersBoard,
  toBoardPoint,
} from '../shared/field.js';
import type { LatLng } from '../shared/geo.js';
import { type Rect, type ZoomFrame, type ZoomView, zoomProjection } from './board-zoom.js';
import { type PieceLook, drawPiece } from './pieces.js';
import {
  type Color,
  type FileRank,
  type Square,
  fromSquare,
  isLightSquare,
  toSquare,
} from '../shared/squares.js';

export type PieceType = 'k' | 'q' | 'r' | 'b' | 'n' | 'p';

export interface Piece {
  type: PieceType;
  color: Color;
}

export type PieceMap = Partial<Record<Square, Piece>>;

export interface BoardView {
  geo: FieldGeometry;
  /** Whose side is at the bottom of the screen. */
  orientation: Color;
  pieces: PieceMap;
  /** Where the player is, or null before the first fix. */
  pos: LatLng | null;
  accuracyM: number;
  /** Effective reach, already including the accuracy allowance and any handicap. */
  reachM: number;
  /**
   * A piece in hand, if anyone is carrying one.
   *
   * `destinations` comes from the server — it is the authority on legality, and
   * sending it at lift time means the client never needs a rules engine of its
   * own just to draw dots.
   */
  carry?: { from: Square; destinations: Square[]; mine: boolean } | null;
  /**
   * Where the opponent is, already interpolated by `client/opponent.ts`.
   *
   * `connected` is the honest signal for whether the dot is live. Age is not:
   * the relay speaks only on movement, so silence means they are standing still,
   * and fading the dot for it would report a player who has not moved as a
   * player who has gone.
   */
  opponent?: { pos: LatLng; connected: boolean } | null;
  /** How pieces are drawn (decision 0045). The standard set when omitted. */
  look?: PieceLook;
  /**
   * The last completed move, tinted on both squares the way lichess and
   * chess.com do, so a player glancing back at the phone sees what changed
   * while they were walking. Read from the snapshot's `lastMove`; nothing new
   * is asked of the server.
   */
  lastMove?: { from: Square; to: Square } | null;
  /**
   * The pinch zoom (stage 10.8, `client/board-zoom.ts`). Whole board when
   * omitted. Everything in board space goes through the zoomed projection;
   * the north arrow, the dots for the two players and the thin strokes stay
   * at screen size, and the few strokes sized from a cell are capped.
   */
  zoom?: ZoomView | null;
}

/**
 * Colours, chosen for a phone at arm's length in direct sun.
 *
 * The dark squares are green rather than brown because the thing underneath
 * really is grass, and the pairing has to survive being seen through a
 * translucent reach circle without either square reading as the other.
 *
 * Both are **mid-tones** (decision 0045), the way every board app's squares
 * are, so that both sides' pieces stand off both squares. The dark square is
 * chess.com's green, about 3.4:1 against a white piece and 6.3:1 against a
 * black one; the old `#4f7a46` gave a black piece only 4.2:1. The light square
 * is lichess's lightness in this board's cream (about 1.4:1 against white,
 * which is what the black outline of a white piece is for).
 */
const LIGHT_SQUARE = '#e6dcbc';
const DARK_SQUARE = '#769656';
const BOARD_EDGE = '#20261c';
const LABEL_ON_LIGHT = '#4f5a3c';
const LABEL_ON_DARK = '#f4efdc';
/** The outline round a label: the other tone, so it reads over any piece. */
const LABEL_HALO_ON_LIGHT = 'rgba(244, 239, 220, 0.9)';
const LABEL_HALO_ON_DARK = 'rgba(32, 38, 28, 0.85)';
/**
 * The last move's two squares: translucent yellow, as on chess.com.
 *
 * A fill, where everything else yellow on this board is an outline (the square
 * under foot is solid, the square a piece was lifted from is dashed), so the
 * three never read as one another even where they meet.
 */
const LAST_MOVE = 'rgba(255, 236, 51, 0.5)';
const REACH_FILL = 'rgba(88, 166, 255, 0.22)';
const REACH_EDGE = 'rgba(88, 166, 255, 0.9)';
const IN_REACH_TINT = 'rgba(88, 166, 255, 0.28)';
const UNDER_FOOT = 'rgba(255, 214, 10, 0.85)';
/** Where the piece was lifted from — it is coming back here if you drop it. */
const LIFTED_FROM = 'rgba(255, 214, 10, 0.5)';
/** A legal destination you could reach right now. */
const DESTINATION_NEAR = 'rgba(255, 255, 255, 0.92)';
/** A legal destination you would have to walk to. */
const DESTINATION_FAR = 'rgba(255, 255, 255, 0.34)';
const ACCURACY_RING = 'rgba(255, 255, 255, 0.5)';
const PLAYER_DOT = '#ffffff';
const PLAYER_EDGE = '#0d1117';
/**
 * The opponent. Warm, because everything else on this board that means anything
 * is blue (reach), yellow (under foot) or white (you), and the one thing that
 * moves on its own has to be identifiable at a glance from ten metres away.
 */
const OPPONENT_DOT = '#ff4d6d';

/**
 * How much of a cell a piece's box fills. The art has its own margin inside
 * the box, so this leaves the square's color showing round every piece.
 */
const PIECE_BOX = 0.94;

/** Fraction of the canvas kept clear around the board. */
const PADDING = 0.06;

/**
 * The widest a stroke sized from a cell may get. At 6x zoom a cell can be a
 * few hundred pixels across, and the square-under-foot outline, drawn at 6%
 * of that, would be a bar rather than an outline. Nothing at 1x on a phone
 * reaches it.
 */
const MAX_CELL_STROKE_PX = 6;

/**
 * Board space to screen pixels.
 *
 * Both orientations are a rigid transform of the same board space, so nothing
 * downstream needs to know which way up the player is holding the game.
 */
export interface Projection {
  scale: number;
  toScreen(bp: BoardPoint): { x: number; y: number };
  /** The inverse, for turning a touch on the canvas back into a place. */
  toBoard(x: number, y: number): BoardPoint;
}

export function projectionFor(
  geo: FieldGeometry,
  orientation: Color,
  width: number,
  height: number,
): Projection {
  const extent = boardExtentM(geo);
  const size = Math.min(width, height);
  const pad = size * PADDING;
  const scale = (size - 2 * pad) / extent.sizeM;
  // Centre the board's own bounding box, not a square of the longer side. On a
  // square board these are the same number; on a 12 x 6 pitch the square version
  // pushes the board to the top of the canvas and leaves the gap underneath.
  const offsetX = (width - (extent.maxU - extent.minU) * scale) / 2;
  const offsetY = (height - (extent.maxV - extent.minV) * scale) / 2;

  return {
    scale,
    toScreen(bp: BoardPoint) {
      // White at the bottom means v increases upward, which is the opposite of
      // canvas y. Black's view is the same board turned through 180 degrees.
      const u = orientation === 'w' ? bp.u - extent.minU : extent.maxU - bp.u;
      const v = orientation === 'w' ? extent.maxV - bp.v : bp.v - extent.minV;
      return { x: offsetX + u * scale, y: offsetY + v * scale };
    },
    toBoard(x: number, y: number) {
      const u = (x - offsetX) / scale;
      const v = (y - offsetY) / scale;
      return {
        u: orientation === 'w' ? u + extent.minU : extent.maxU - u,
        v: orientation === 'w' ? extent.maxV - v : v + extent.minV,
      };
    },
  };
}

/**
 * The board's outline in a projection's pixels, outer half-squares included:
 * what a zoomed view is kept on the canvas by.
 */
export function boardBoundsPx(geo: FieldGeometry, projection: Projection): Rect {
  const corners = [
    { file: -0.5, rank: -0.5 },
    { file: 7.5, rank: -0.5 },
    { file: 7.5, rank: 7.5 },
    { file: -0.5, rank: 7.5 },
  ].map((bi) => projection.toScreen(boardPointOfIndex(geo, bi)));
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/**
 * Everything a zoomed view needs to know about the canvas, from the fitted
 * (unzoomed) projection: its size, where the board sits on it, and the
 * margin the board may come in from the edge — the same padding the whole
 * board already has, so zooming never shows more bare canvas than 1x does.
 */
export function zoomFrameFor(
  geo: FieldGeometry,
  orientation: Color,
  width: number,
  height: number,
): { frame: ZoomFrame; base: Projection } {
  const base = projectionFor(geo, orientation, width, height);
  return {
    base,
    frame: {
      width,
      height,
      board: boardBoundsPx(geo, base),
      margin: Math.min(width, height) * PADDING,
    },
  };
}

/** The canvas's size in CSS pixels, as `drawBoard` measures it. */
export function canvasSizePx(canvas: HTMLCanvasElement): { width: number; height: number } {
  return {
    width: canvas.clientWidth || canvas.width,
    height: canvas.clientHeight || canvas.height,
  };
}

/**
 * The screen direction of true north, as a unit vector.
 *
 * North in board space has components `cos(bearing)` along the file axis and
 * `sin(bearing)` along the rank axis, because the file axis points along
 * `bearingDeg` and the rank axis 90 degrees counter-clockwise of it.
 */
export function northOnScreen(geo: FieldGeometry, orientation: Color): { x: number; y: number } {
  const radians = (geo.bearingDeg * Math.PI) / 180;
  const u = Math.cos(radians);
  const v = Math.sin(radians);
  return orientation === 'w' ? { x: u, y: -v } : { x: -u, y: v };
}

/**
 * The starting position, so the board can be looked at before phase 4 exists.
 *
 * The real position comes from the game state; nothing here is authoritative.
 */
export function startingPieces(): PieceMap {
  const back: PieceType[] = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  const pieces: PieceMap = {};
  for (let file = 0; file < 8; file++) {
    pieces[toSquare(file, 0)] = { type: back[file], color: 'w' };
    pieces[toSquare(file, 1)] = { type: 'p', color: 'w' };
    pieces[toSquare(file, 6)] = { type: 'p', color: 'b' };
    pieces[toSquare(file, 7)] = { type: back[file], color: 'b' };
  }
  return pieces;
}

/**
 * Size the backing store to the element and the device, then draw.
 *
 * Returns the projection it used, so a caller can turn a touch back into a
 * place on the field without recomputing it.
 */
export function drawBoard(canvas: HTMLCanvasElement, view: BoardView): Projection | null {
  const dpr = globalThis.devicePixelRatio ?? 1;
  const { width, height } = canvasSizePx(canvas);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const base = projectionFor(view.geo, view.orientation, width, height);
  const projection = view.zoom ? zoomProjection(base, view.zoom) : base;
  const here = view.pos ? toBoardPoint(view.geo, view.pos) : null;

  drawSquares(ctx, view, projection, here);
  drawLiftedFrom(ctx, view, projection);
  // Under the pieces: the art fills most of its cell (decision 0045), and on a
  // rotated field the arrow overlaps the corner square, so it would cover h8.
  drawNorth(ctx, view, width, height);
  drawPieces(ctx, view, projection);
  // Over the pieces, both. The art fills most of its cell (decision 0045), so a
  // coordinate or a capture's destination dot drawn underneath would be hidden
  // by the very piece it is about.
  drawCoordinates(ctx, view, projection);
  drawDestinations(ctx, view, projection, here);
  drawOpponent(ctx, view, projection);
  if (here) drawPlayer(ctx, view, projection, here);
  return projection;
}

/**
 * A square as four screen points, wound in order.
 *
 * Not a rectangle any more: since decision 0028 a board may be a parallelogram,
 * and `fillRect` would draw the board the calibration *wished* for rather than
 * the one the player walked out. The path is the honest shape, and on a square
 * board it is pixel-for-pixel the old rectangle.
 */
function squarePath(
  geo: FieldGeometry,
  projection: Projection,
  fr: FileRank,
): { x: number; y: number }[] {
  return squareCornersBoard(geo, fr).map((bp: BoardPoint) => projection.toScreen(bp));
}

function traceSquare(
  ctx: CanvasRenderingContext2D,
  geo: FieldGeometry,
  projection: Projection,
  fr: FileRank,
): void {
  const points = squarePath(geo, projection, fr);
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
}

/**
 * A representative cell size in screen pixels, for labels, dots and line widths.
 *
 * Deliberately one number even where the two axes differ. Pieces use
 * {@link pieceBoxPx} instead, which fits the narrow way across. Never use this
 * to position anything.
 */
function cellPx(geo: FieldGeometry, projection: Projection): number {
  return geo.meanSquareM * projection.scale;
}

/** Screen position of a square's centre. */
function squareCentrePx(
  geo: FieldGeometry,
  projection: Projection,
  fr: FileRank,
): { x: number; y: number } {
  return projection.toScreen(squareCentre(geo, fr));
}

function drawSquares(
  ctx: CanvasRenderingContext2D,
  view: BoardView,
  projection: Projection,
  here: BoardPoint | null,
): void {
  const { geo } = view;
  const size = cellPx(geo, projection);
  const underFoot = here ? squareUnderFoot(geo, here) : null;
  const moved = new Set<string>(view.lastMove ? [view.lastMove.from, view.lastMove.to] : []);

  for (let file = 0; file < 8; file++) {
    for (let rank = 0; rank < 8; rank++) {
      const light = isLightSquare(file, rank);
      traceSquare(ctx, geo, projection, { file, rank });
      ctx.fillStyle = light ? LIGHT_SQUARE : DARK_SQUARE;
      ctx.fill();

      // Under the reach tint rather than over it: reach is the rule and has to
      // read the same on every square, and blue over yellow still reads as
      // "this one moved" where yellow over blue would hide "you can reach it".
      if (moved.has(toSquare(file, rank))) {
        ctx.fillStyle = LAST_MOVE;
        ctx.fill();
      }

      // In reach: the squares you could actually lift from or place on right
      // now. This is the rule made visible, so it has to be unmissable.
      if (here && distanceFromBoardPointToSquareM(geo, here, { file, rank }) <= view.reachM) {
        ctx.fillStyle = IN_REACH_TINT;
        ctx.fill();
      }

      if (underFoot && underFoot.file === file && underFoot.rank === rank) {
        ctx.strokeStyle = UNDER_FOOT;
        ctx.lineWidth = Math.min(MAX_CELL_STROKE_PX, Math.max(2, size * 0.06));
        ctx.stroke();
      }
    }
  }

  // The outline of the playing surface, traced round the four outer corners
  // rather than assembled from a width and a height — on a skewed board those
  // two numbers do not describe the edge.
  const outline = [
    { file: -0.5, rank: -0.5 },
    { file: 7.5, rank: -0.5 },
    { file: 7.5, rank: 7.5 },
    { file: -0.5, rank: 7.5 },
  ].map((bi) => projection.toScreen(boardPointOfIndex(geo, bi)));
  ctx.beginPath();
  ctx.moveTo(outline[0].x, outline[0].y);
  for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i].x, outline[i].y);
  ctx.closePath();
  ctx.strokeStyle = BOARD_EDGE;
  ctx.lineWidth = 2;
  ctx.stroke();
}

/**
 * File letters along the near edge, rank numbers up the left — from the
 * player's own point of view, which is what "own side at the bottom" means.
 *
 * Drawn over the pieces, so they are sized from the *narrow* way across a
 * cell ({@link pieceBoxPx}) and pushed into its corners. On a 120 x 24 m
 * field a cell is five times wider than it is tall: a label sized from the
 * mean cell was as tall as the whole square and sat on the a-file and
 * rank-1 pieces. In the corner of a long cell there is room beside the piece.
 */
function drawCoordinates(
  ctx: CanvasRenderingContext2D,
  view: BoardView,
  projection: Projection,
): void {
  const box = pieceBoxPx(view.geo, projection);
  const fontPx = Math.max(8, Math.min(14, box * 0.24));
  ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
  ctx.lineJoin = 'round';
  const nearRank = view.orientation === 'w' ? 0 : 7;
  const leftFile = view.orientation === 'w' ? 0 : 7;
  for (let i = 0; i < 8; i++) {
    const fileSquare = { file: i, rank: nearRank };
    drawLabel(ctx, view, projection, fileSquare, toSquare(i, nearRank)[0], 'bottom-right', fontPx);
    const rankSquare = { file: leftFile, rank: i };
    drawLabel(ctx, view, projection, rankSquare, String(i + 1), 'top-left', fontPx);
  }
}

/**
 * One label, anchored just inside a corner of its cell as the player sees it.
 *
 * The corner is found in board *index* space — a fraction of a square along
 * each axis — and projected, so it stays inside the cell on a rectangular or
 * skewed board, where a screen-space offset from the centre would not. The
 * text gets a thin outline in the opposite tone, so it reads over a piece or
 * a disc of either color as well as over the bare square.
 */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  view: BoardView,
  projection: Projection,
  fr: FileRank,
  text: string,
  corner: 'bottom-right' | 'top-left',
  fontPx: number,
): void {
  const { geo } = view;
  // A couple of pixels in from each edge, as a fraction of that edge.
  const inFile = 0.5 - Math.min(0.2, 2 / (geo.fileM * projection.scale));
  const inRank = 0.5 - Math.min(0.2, 2 / (geo.rankM * projection.scale));
  // White's screen right is +file and screen down is -rank; Black's is turned.
  const dir = view.orientation === 'w' ? 1 : -1;
  const sign = corner === 'bottom-right' ? 1 : -1;
  const anchor = projection.toScreen(
    boardPointOfIndex(geo, {
      file: fr.file + sign * dir * inFile,
      rank: fr.rank - sign * dir * inRank,
    }),
  );
  const light = isLightSquare(fr.file, fr.rank);
  ctx.textAlign = corner === 'bottom-right' ? 'right' : 'left';
  ctx.textBaseline = corner === 'bottom-right' ? 'bottom' : 'top';
  ctx.strokeStyle = light ? LABEL_HALO_ON_LIGHT : LABEL_HALO_ON_DARK;
  ctx.lineWidth = Math.max(2, fontPx * 0.28);
  ctx.strokeText(text, anchor.x, anchor.y);
  ctx.fillStyle = light ? LABEL_ON_LIGHT : LABEL_ON_DARK;
  ctx.fillText(text, anchor.x, anchor.y);
}

/**
 * The piece in hand: where it came from, and everywhere it could legally go.
 *
 * Destinations are drawn as dots rather than as square tints, because the square
 * tint already means "in reach" and two overlapping tints would say neither
 * clearly. A solid dot is somewhere you can reach *and* legally place; a faint
 * one is legal but needs walking — which is the decision the whole game is made
 * of, so it has to be readable at a glance while moving.
 */
function drawLiftedFrom(
  ctx: CanvasRenderingContext2D,
  view: BoardView,
  projection: Projection,
): void {
  const carry = view.carry;
  if (!carry) return;

  const size = cellPx(view.geo, projection);
  traceSquare(ctx, view.geo, projection, fromSquare(carry.from));
  ctx.strokeStyle = LIFTED_FROM;
  ctx.lineWidth = Math.min(MAX_CELL_STROKE_PX, Math.max(2, size * 0.08));
  ctx.setLineDash([size * 0.15, size * 0.1]);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Drawn after the pieces, so a capture's dot sits on the piece it would take. */
function drawDestinations(
  ctx: CanvasRenderingContext2D,
  view: BoardView,
  projection: Projection,
  here: BoardPoint | null,
): void {
  const carry = view.carry;
  if (!carry) return;
  const size = cellPx(view.geo, projection);

  // Only your own carry gets destination dots. Seeing the opponent's options
  // drawn on your board would be both confusing and a small act of espionage.
  if (!carry.mine) return;

  for (const square of carry.destinations) {
    const fr = fromSquare(square);
    const centre = squareCentrePx(view.geo, projection, fr);
    const reachable =
      here !== null && distanceFromBoardPointToSquareM(view.geo, here, fr) <= view.reachM;

    ctx.beginPath();
    ctx.arc(centre.x, centre.y, size * (reachable ? 0.17 : 0.11), 0, Math.PI * 2);
    ctx.fillStyle = reachable ? DESTINATION_NEAR : DESTINATION_FAR;
    ctx.fill();
    ctx.strokeStyle = 'rgba(13, 17, 23, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/**
 * Read a FEN's placement field into a piece map.
 *
 * Deliberately not chess.js: the server is the only rules authority and sends
 * legal destinations with every carry, so the client needs to know *where the
 * pieces are* and nothing more. Twenty lines here against ~50 kB of bundle on a
 * phone with one bar.
 */
export function piecesFromFen(fen: string): PieceMap {
  const pieces: PieceMap = {};
  const ranks = fen.split(' ')[0]?.split('/') ?? [];
  // FEN lists rank 8 first; our rank index counts up from rank 1.
  ranks.forEach((row, index) => {
    const rank = 7 - index;
    let file = 0;
    for (const ch of row) {
      const skip = Number(ch);
      if (Number.isFinite(skip) && skip > 0) {
        file += skip;
        continue;
      }
      if (file > 7 || rank < 0) break;
      const lower = ch.toLowerCase();
      if (lower === 'k' || lower === 'q' || lower === 'r' || lower === 'b' || lower === 'n' || lower === 'p') {
        pieces[toSquare(file, rank)] = {
          type: lower,
          color: ch === lower ? 'b' : 'w',
        };
      }
      file += 1;
    }
  });
  return pieces;
}

/**
 * The side of the largest upright square that fits inside one cell, in pixels.
 *
 * Not {@link cellPx}: on a rectangular or skewed board the mean cell is wider
 * than the narrow way across, and a piece sized to it spills into the next
 * square. A parallelogram's narrow width is the shorter step times the sine of
 * the angle between the axes; on a square board this is the cell itself.
 */
export function pieceBoxPx(geo: FieldGeometry, projection: Projection): number {
  const sin = Math.sin((geo.axisAngleDeg * Math.PI) / 180);
  return Math.min(geo.fileM, geo.rankM) * Math.abs(sin) * projection.scale * PIECE_BOX;
}

function drawPieces(
  ctx: CanvasRenderingContext2D,
  view: BoardView,
  projection: Projection,
): void {
  const box = pieceBoxPx(view.geo, projection);
  const look = view.look ?? 'standard';
  for (const [square, piece] of Object.entries(view.pieces)) {
    if (!piece) continue;
    const centre = squareCentrePx(view.geo, projection, fromSquare(square));
    drawPiece(ctx, piece, look, centre.x, centre.y, box);
  }
}

function drawPlayer(
  ctx: CanvasRenderingContext2D,
  view: BoardView,
  projection: Projection,
  here: BoardPoint,
): void {
  const centre = projection.toScreen(here);

  // Reach first, so the dot sits on top of its own circle.
  ctx.beginPath();
  ctx.arc(centre.x, centre.y, view.reachM * projection.scale, 0, Math.PI * 2);
  ctx.fillStyle = REACH_FILL;
  ctx.fill();
  ctx.strokeStyle = REACH_EDGE;
  ctx.lineWidth = 2;
  ctx.stroke();

  // The accuracy ring is drawn even when it is larger than the reach circle,
  // because "the game is being generous because your fix is poor" is exactly
  // what a player needs to see.
  ctx.beginPath();
  ctx.arc(centre.x, centre.y, view.accuracyM * projection.scale, 0, Math.PI * 2);
  ctx.strokeStyle = ACCURACY_RING;
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);

  // No heading indicator: a phone's course is meaningless below walking pace and
  // wrong when standing still, which is most of this game.
  ctx.beginPath();
  ctx.arc(centre.x, centre.y, 7, 0, Math.PI * 2);
  ctx.fillStyle = PLAYER_DOT;
  ctx.fill();
  ctx.strokeStyle = PLAYER_EDGE;
  ctx.lineWidth = 2;
  ctx.stroke();
}

/**
 * The opponent: a dot, and nothing else.
 *
 * No reach circle and no accuracy ring, for the same reason their carry gets no
 * destination dots — knowing exactly what they can touch from where they stand
 * is a small act of espionage, and the game is better when you have to judge it
 * by eye. A position and a colour is all the atmosphere needs.
 */
function drawOpponent(
  ctx: CanvasRenderingContext2D,
  view: BoardView,
  projection: Projection,
): void {
  const opponent = view.opponent;
  if (!opponent) return;
  const centre = projection.toScreen(toBoardPoint(view.geo, opponent.pos));

  ctx.beginPath();
  ctx.arc(centre.x, centre.y, 7, 0, Math.PI * 2);
  if (opponent.connected) {
    ctx.fillStyle = OPPONENT_DOT;
    ctx.fill();
    ctx.strokeStyle = PLAYER_EDGE;
    ctx.lineWidth = 2;
    ctx.stroke();
    return;
  }
  // Hollow while they are off the air: the position is the last one they sent
  // and nobody is updating it, which is a different thing from where they are.
  ctx.strokeStyle = OPPONENT_DOT;
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);
}

/** A north arrow, so the screen can be related back to the ground. */
function drawNorth(
  ctx: CanvasRenderingContext2D,
  view: BoardView,
  width: number,
  height: number,
): void {
  const north = northOnScreen(view.geo, view.orientation);
  const size = Math.min(width, height) * PADDING * 0.7;
  // Inset by twice the arrow, so the "N" — drawn a little beyond the tip — has
  // somewhere to go whichever way north happens to point.
  const cx = width - size * 2;
  const cy = size * 2;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.beginPath();
  ctx.moveTo(north.x * size, north.y * size);
  ctx.lineTo(-north.y * size * 0.4, north.x * size * 0.4);
  ctx.lineTo(-north.x * size * 0.3, -north.y * size * 0.3);
  ctx.lineTo(north.y * size * 0.4, -north.x * size * 0.4);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#0d1117';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', north.x * size * 1.6, north.y * size * 1.6);
  ctx.restore();
}

/** The square the player is standing on, or null when they are off the board. */
export function squareUnderFoot(geo: FieldGeometry, here: BoardPoint): FileRank | null {
  // Through the affine inverse, not a division: on a skewed board `u` and `v`
  // are metres in a rigid frame and do not divide into square counts.
  const bi = boardIndexOf(geo, here);
  const file = Math.round(bi.file);
  const rank = Math.round(bi.rank);
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return { file, rank };
}
