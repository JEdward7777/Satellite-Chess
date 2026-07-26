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
  distanceFromBoardPointToSquareM,
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

/** Solid glyphs for both colours, distinguished by fill — decision 0011. */
const GLYPHS: Record<PieceType, string> = {
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
  const offsetX = (width - extent.sizeM * scale) / 2;
  const offsetY = (height - extent.sizeM * scale) / 2;

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
  if (here) drawPlayer(ctx, view, projection, here);
  return projection;
}

function squareRect(
  geo: FieldGeometry,
  projection: Projection,
  fr: FileRank,
): { x: number; y: number; size: number } {
  const half = geo.squareM / 2;
  const centre = { u: fr.file * geo.squareM, v: fr.rank * geo.squareM };
  const a = projection.toScreen({ u: centre.u - half, v: centre.v - half });
  const b = projection.toScreen({ u: centre.u + half, v: centre.v + half });
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    size: geo.squareM * projection.scale,
  };
}

function drawSquares(
  ctx: CanvasRenderingContext2D,
  view: BoardView,
  projection: Projection,
  here: BoardPoint | null,
): void {
  const { geo } = view;
  const size = geo.squareM * projection.scale;
  const underFoot = here ? squareUnderFoot(geo, here) : null;

  for (let file = 0; file < 8; file++) {
    for (let rank = 0; rank < 8; rank++) {
      const rect = squareRect(geo, projection, { file, rank });
      const light = isLightSquare(file, rank);
      ctx.fillStyle = light ? LIGHT_SQUARE : DARK_SQUARE;
      ctx.fillRect(rect.x, rect.y, rect.size, rect.size);

      // In reach: the squares you could actually lift from or place on right
      // now. This is the rule made visible, so it has to be unmissable.
      if (here && distanceFromBoardPointToSquareM(geo, here, { file, rank }) <= view.reachM) {
        ctx.fillStyle = IN_REACH_TINT;
        ctx.fillRect(rect.x, rect.y, rect.size, rect.size);
      }

      if (underFoot && underFoot.file === file && underFoot.rank === rank) {
        ctx.strokeStyle = UNDER_FOOT;
        ctx.lineWidth = Math.max(2, size * 0.06);
        ctx.strokeRect(
          rect.x + ctx.lineWidth / 2,
          rect.y + ctx.lineWidth / 2,
          rect.size - ctx.lineWidth,
          rect.size - ctx.lineWidth,
        );
      }

      drawLabels(ctx, view, rect, { file, rank }, light);
    }
  }

  const a1 = squareRect(geo, projection, { file: 0, rank: 0 });
  const h8 = squareRect(geo, projection, { file: 7, rank: 7 });
  ctx.strokeStyle = BOARD_EDGE;
  ctx.lineWidth = 2;
  ctx.strokeRect(
    Math.min(a1.x, h8.x),
    Math.min(a1.y, h8.y),
    8 * size,
    8 * size,
  );
}

/**
 * File letters along the near edge, rank numbers up the left — from the
 * player's own point of view, which is what "own side at the bottom" means.
 */
function drawLabels(
  ctx: CanvasRenderingContext2D,
  view: BoardView,
  rect: { x: number; y: number; size: number },
  fr: FileRank,
  light: boolean,
): void {
  const nearRank = view.orientation === 'w' ? 0 : 7;
  const leftFile = view.orientation === 'w' ? 0 : 7;
  const showFile = fr.rank === nearRank;
  const showRank = fr.file === leftFile;
  if (!showFile && !showRank) return;

  ctx.fillStyle = light ? LABEL_ON_LIGHT : LABEL_ON_DARK;
  ctx.font = `600 ${Math.max(9, rect.size * 0.22)}px system-ui, sans-serif`;
  const inset = rect.size * 0.08;

  if (showFile) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(toSquare(fr.file, fr.rank)[0], rect.x + rect.size - inset, rect.y + rect.size - inset);
  }
  if (showRank) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(String(fr.rank + 1), rect.x + inset, rect.y + inset);
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

  const size = view.geo.squareM * projection.scale;
  const origin = fromSquare(carry.from);
  const rect = squareRect(view.geo, projection, origin);

  ctx.strokeStyle = LIFTED_FROM;
  ctx.lineWidth = Math.max(2, size * 0.08);
  ctx.setLineDash([size * 0.15, size * 0.1]);
  ctx.strokeRect(
    rect.x + ctx.lineWidth / 2,
    rect.y + ctx.lineWidth / 2,
    rect.size - ctx.lineWidth,
    rect.size - ctx.lineWidth,
  );
  ctx.setLineDash([]);

  // Only your own carry gets destination dots. Seeing the opponent's options
  // drawn on your board would be both confusing and a small act of espionage.
  if (!carry.mine) return;

  for (const square of carry.destinations) {
    const fr = fromSquare(square);
    const centre = projection.toScreen({
      u: fr.file * view.geo.squareM,
      v: fr.rank * view.geo.squareM,
    });
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
  const size = view.geo.squareM * projection.scale;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${size * 0.72}px ${GLYPH_FONT}`;
  ctx.lineWidth = Math.max(1, size * 0.03);

  for (const [square, piece] of Object.entries(view.pieces)) {
    if (!piece) continue;
    const fr = fromSquare(square);
    const centre = projection.toScreen({ u: fr.file * view.geo.squareM, v: fr.rank * view.geo.squareM });
    const glyph = GLYPHS[piece.type];
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
  const file = Math.round(here.u / geo.squareM);
  const rank = Math.round(here.v / geo.squareM);
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return { file, rank };
}
