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
}

/**
 * Colours, chosen for a phone at arm's length in direct sun.
 *
 * The dark squares are green rather than brown because the thing underneath
 * really is grass, and the pairing has to survive being seen through a
 * translucent reach circle without either square reading as the other.
 */
const LIGHT_SQUARE = '#efe6cf';
const DARK_SQUARE = '#4f7a46';
const BOARD_EDGE = '#20261c';
const LABEL_ON_LIGHT = '#5c5646';
const LABEL_ON_DARK = '#d8e6d2';
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
 * Solid glyphs for both colours, distinguished by fill — decision 0011.
 *
 * Exported because the HUD and the promotion picker name pieces too, and a
 * knight that is one glyph on the board and another in the picker is a puzzle
 * for someone who is trying to read it at arm's length in the sun.
 */
export const PIECE_GLYPHS: Record<PieceType, string> = {
  k: '♚︎',
  q: '♛︎',
  r: '♜︎',
  b: '♝︎',
  n: '♞︎',
  p: '♟︎',
};

/** U+FE0E alone is not always enough; a concrete serif stack finishes the job. */
const GLYPH_FONT = '"DejaVu Sans", "Segoe UI Symbol", "Apple Symbols", serif';

/** Fraction of the canvas kept clear around the board. */
const PADDING = 0.06;

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
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const projection = projectionFor(view.geo, view.orientation, width, height);
  const here = view.pos ? toBoardPoint(view.geo, view.pos) : null;

  drawSquares(ctx, view, projection, here);
  drawCarry(ctx, view, projection, here);
  drawPieces(ctx, view, projection);
  drawNorth(ctx, view, width, height);
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
 * A representative cell size in screen pixels, for glyphs and line widths.
 *
 * Deliberately one number even where the two axes differ: a piece is drawn as a
 * glyph, not stretched to fill its cell, so it wants a single size. Never use
 * this to position anything.
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

  for (let file = 0; file < 8; file++) {
    for (let rank = 0; rank < 8; rank++) {
      const light = isLightSquare(file, rank);
      traceSquare(ctx, geo, projection, { file, rank });
      ctx.fillStyle = light ? LIGHT_SQUARE : DARK_SQUARE;
      ctx.fill();

      // In reach: the squares you could actually lift from or place on right
      // now. This is the rule made visible, so it has to be unmissable.
      if (here && distanceFromBoardPointToSquareM(geo, here, { file, rank }) <= view.reachM) {
        ctx.fillStyle = IN_REACH_TINT;
        ctx.fill();
      }

      if (underFoot && underFoot.file === file && underFoot.rank === rank) {
        ctx.strokeStyle = UNDER_FOOT;
        ctx.lineWidth = Math.max(2, size * 0.06);
        ctx.stroke();
      }

      drawLabels(ctx, view, squareCentrePx(geo, projection, { file, rank }), size, {
        file,
        rank,
      }, light);
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
 */
/**
 * Placed by offsetting from the cell's centre in *screen* space rather than
 * from the corners of a rectangle, because a cell no longer has corners at
 * predictable screen positions. On a square board this lands where it always
 * did; on a skewed one it stays inside the cell, which corner arithmetic on a
 * parallelogram would not guarantee.
 */
function drawLabels(
  ctx: CanvasRenderingContext2D,
  view: BoardView,
  centre: { x: number; y: number },
  size: number,
  fr: FileRank,
  light: boolean,
): void {
  const nearRank = view.orientation === 'w' ? 0 : 7;
  const leftFile = view.orientation === 'w' ? 0 : 7;
  const showFile = fr.rank === nearRank;
  const showRank = fr.file === leftFile;
  if (!showFile && !showRank) return;

  ctx.fillStyle = light ? LABEL_ON_LIGHT : LABEL_ON_DARK;
  ctx.font = `600 ${Math.max(9, size * 0.22)}px system-ui, sans-serif`;
  const inset = size * 0.34;

  if (showFile) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(toSquare(fr.file, fr.rank)[0], centre.x + inset, centre.y + inset);
  }
  if (showRank) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(String(fr.rank + 1), centre.x - inset, centre.y - inset);
  }
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
function drawCarry(
  ctx: CanvasRenderingContext2D,
  view: BoardView,
  projection: Projection,
  here: BoardPoint | null,
): void {
  const carry = view.carry;
  if (!carry) return;

  const size = cellPx(view.geo, projection);
  const origin = fromSquare(carry.from);

  traceSquare(ctx, view.geo, projection, origin);
  ctx.strokeStyle = LIFTED_FROM;
  ctx.lineWidth = Math.max(2, size * 0.08);
  ctx.setLineDash([size * 0.15, size * 0.1]);
  ctx.stroke();
  ctx.setLineDash([]);

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

function drawPieces(
  ctx: CanvasRenderingContext2D,
  view: BoardView,
  projection: Projection,
): void {
  const size = cellPx(view.geo, projection);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${size * 0.72}px ${GLYPH_FONT}`;
  ctx.lineWidth = Math.max(1, size * 0.03);

  for (const [square, piece] of Object.entries(view.pieces)) {
    if (!piece) continue;
    const fr = fromSquare(square);
    const centre = squareCentrePx(view.geo, projection, fr);
    const glyph = PIECE_GLYPHS[piece.type];
    // Same solid glyph for both colours; fill and stroke carry the difference.
    ctx.fillStyle = piece.color === 'w' ? '#ffffff' : '#16181d';
    ctx.strokeStyle = piece.color === 'w' ? '#16181d' : '#e8e8e8';
    ctx.fillText(glyph, centre.x, centre.y);
    ctx.strokeText(glyph, centre.x, centre.y);
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
