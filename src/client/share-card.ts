/**
 * The share card (stages 8.5.1–8.5.3, decisions 0018 and 0053): one finished
 * game as a picture a player can send, made on the phone, sent through the
 * share sheet, and kept nowhere.
 *
 * ## What is on it, and what is not
 *
 * Decision 0018 is the brief and every one of its four rules applies here.
 * Decision 0053 is how this card meets them:
 *
 * - **The board in squares, and each carry as a straight line** from where
 *   the piece was picked up to where it was put down. Those two points per
 *   move are already in the PGN either player can share (decision 0041), so
 *   the card shows nothing a shared game file does not. **No walk**: not the
 *   walk to a piece, not the other player meanwhile, not even the fixes sent
 *   while a piece was in hand. The walk is the players' (decision 0052), and
 *   a card goes further than a file — it is a picture, made to be posted.
 * - **No map, no coordinates, no north, no scale bar.** The board is
 *   `REPLAY_GEOMETRY`'s unit board. Its size is stated as a number ("64 m
 *   board"), which is a dimension, not a place.
 * - **No date, no time, no join code, and no names.** The opponent is a
 *   color, as everywhere else. A date beside a place name is a record of
 *   where somebody was and when, which is the combination 0017 exists to
 *   prevent.
 * - **The field's name only if a player wrote it and this player ticks the
 *   box**, which is off every time the card is opened. Never a name the app
 *   made up ("My field", "Shared field"), and never one worked out from
 *   where the field is.
 * - **The figures are the sharer's own**: what they walked and their longest
 *   carry. The game's: the result from their side, the move count and the
 *   board size. The opponent's distance is theirs to brag about.
 *
 * ## How it is sent
 *
 * The picture is drawn when the player opens the card and turned into a PNG
 * then, so that Share has nothing to await before `navigator.share`
 * (`gotchas.md`). The PNG is rebuilt chunk by chunk with only what a picture
 * needs to be drawn — `IHDR`, `PLTE`, `tRNS`, `gAMA`, `sRGB`, `IDAT` and
 * `IEND` ({@link stripPngMetadata}) — so whatever a browser's
 * encoder might add — a text chunk, a timestamp, EXIF — never leaves the
 * phone. Then: the share sheet with the file, or a download, or the picture on
 * screen to be pressed and saved. No request is made at any point, there is
 * no URL that serves a card, and the server never sees one.
 */

import { personalResult } from '../shared/record.js';
import type { GameReport } from '../shared/review.js';
import { walksOf } from '../shared/review.js';
import type { Color, Square } from '../shared/squares.js';
import { type Units, boardWords } from '../shared/units.js';
import { DEFAULT_FIELD_NAME, SHARED_FIELD_NAME } from './fields.js';
import type { PieceLook } from './pieces.js';
import { distanceWords } from './record.js';
import { drawBoard, piecesFromFen } from './render.js';
import { REPLAY_GEOMETRY, type StraightCarry, drawCarries } from './replay-draw.js';
import { replayFens } from './replay.js';
import { colorWords, resultWords } from './review.js';
import { reasonWords } from './views/games.js';

/**
 * 1080 × 1350: four by five, portrait.
 *
 * The board is square and it is the picture (0018: "the striking image"), so
 * the frame is chosen to give it the whole width and leave a band above and
 * below for the words. Four by five is the tallest shape the common feeds
 * show without cropping, and in a chat it shows whole. 1200 × 630, the link
 * preview shape, would shrink the board to under half the card's width.
 */
export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1350;

/** What the file is called. No date, no field and no code: the name travels with it. */
export const CARD_FILE_NAME = 'satellite-chess.png';

/** One figure on the card: a value over its label. */
export interface CardFigure {
  value: string;
  label: string;
}

/** Everything the card shows, as data, so a test can read it. */
export interface ShareCard {
  /** "Won as Black — checkmate". */
  result: string;
  /** The field's name, only when a player wrote one and this one chose to show it. */
  fieldName: string | null;
  /** Walked, longest carry, moves, board: in that order. */
  figures: CardFigure[];
  /** The final position. */
  fen: string;
  lastMove: { from: Square; to: Square } | null;
  /** Every move with both fixes stored, straight from lift to place. */
  carries: StraightCarry[];
  /** Whose side is at the bottom: the sharer's. */
  orientation: Color;
  /** The line under the figures. */
  footnote: string;
}

export interface ShareCardOptions {
  /** Whether the player ticked "show the field's name". Off unless they do. */
  showFieldName?: boolean;
}

/**
 * The field's name, if a player wrote it: the name the card *may* show.
 *
 * Null for a field nobody named and for the two names the app gives a field
 * by itself, which say nothing true about it and which nobody chose.
 */
export function authoredFieldName(report: Pick<GameReport, 'fieldName'>): string | null {
  const name = report.fieldName?.trim() ?? '';
  if (name === '' || name === DEFAULT_FIELD_NAME || name === SHARED_FIELD_NAME) return null;
  return name;
}

/**
 * How many moves, as a chess player counts them: the number of the last
 * move in the list, so Fool's mate is two. Zero for a game nobody moved in.
 */
export function cardMoveCount(report: Pick<GameReport, 'moves'>): number {
  const last = report.moves[report.moves.length - 1];
  return last === undefined ? 0 : Math.floor((last.seq - 1) / 2) + 1;
}

/**
 * The result in the sharer's voice: "Won as Black — checkmate", "Lost as
 * White — on time", "Drew as White — agreement". The review's own words for
 * a reader with no seat, and for a game with no result.
 */
export function cardResultWords(report: GameReport, you: Color | null): string {
  if (you === null || report.outcome === null || report.reason === null || report.reason === 'aborted') {
    return resultWords(report, you);
  }
  const mine = personalResult(report.outcome, you);
  const verdict = mine === 'win' ? 'Won' : mine === 'loss' ? 'Lost' : 'Drew';
  return `${verdict} as ${colorWords(you)} — ${reasonWords(report.reason)}`;
}

/**
 * Whether a game gets a card at all: one that ended with a result, seen
 * from a seat. An aborted game has none (decision 0050), and a game still
 * being played is not a thing to brag about yet. Without a seat the card
 * would put White's distance under "walked" as if it were the reader's: the
 * review is seat-only, so that is a malformed answer, and it gets no card.
 */
export function cardOffered(report: GameReport, you: Color | null): boolean {
  return you !== null && report.outcome !== null && report.reason !== null && report.reason !== 'aborted';
}

/**
 * The card, read out of a report. Pure.
 *
 * Null without a seat: the card is one player's, and with no seat it would
 * put White's distance under "walked" as if it were the reader's.
 * {@link cardOffered} already keeps the fold off the screen; this refuses
 * too, so no other caller can make that card.
 */
export function shareCard(
  report: GameReport,
  you: Color | null,
  units: Units = 'metric',
  options: ShareCardOptions = {},
): ShareCard | null {
  if (you === null) return null;
  const walk = walksOf(report, you)[0] ?? null;
  const moves = cardMoveCount(report);
  const fens = replayFens(report);
  const last = fens.length > 1 ? (report.moves[fens.length - 2] ?? null) : null;
  const authored = authoredFieldName(report);
  return {
    result: cardResultWords(report, you),
    fieldName: options.showFieldName === true ? authored : null,
    figures: [
      {
        value: walk === null || walk.travelM === null ? 'not measured' : distanceWords(walk.travelM, units),
        label: 'walked',
      },
      {
        value: walk === null || !(walk.longestCarryM > 0) ? 'none' : distanceWords(walk.longestCarryM, units),
        label: 'longest carry',
      },
      { value: String(moves), label: moves === 1 ? 'move' : 'moves' },
      { value: report.boardM > 0 ? boardWords(report.boardM, units) : 'unknown', label: 'board' },
    ],
    fen: fens[fens.length - 1]!,
    lastMove: last === null ? null : { from: last.from as Square, to: last.to as Square },
    carries: straightCarries(report),
    orientation: you,
    footnote: 'Each line is a carry, from where the piece was picked up (ring) to where it went down (disc).',
  };
}

/**
 * Each move's carry as the PGN holds it: the lift fix and the place fix, in
 * squares, and nothing between. A move missing either fix has no line.
 * The game's tracks are never read here (decision 0053).
 */
export function straightCarries(report: Pick<GameReport, 'moves'>): StraightCarry[] {
  const carries: StraightCarry[] = [];
  for (const move of report.moves) {
    if (move.lift === null || move.place === null) continue;
    const lift = { file: move.lift.file, rank: move.lift.rank };
    const place = { file: move.place.file, rank: move.place.rank };
    if (![lift.file, lift.rank, place.file, place.rank].every(Number.isFinite)) continue;
    carries.push({ color: move.color, lift, place });
  }
  return carries;
}

/**
 * What the card is, next to the button that sends it. It says what is *not*
 * on it, because that is the question a player should be asking before they
 * post a picture of a walk.
 */
export const CARD_EXPLANATION =
  'A picture of this game, made on this phone and sent only where you send it. ' +
  'It shows the board in squares and each carry, from where the piece was picked ' +
  'up to where it was put down. Not your walks, no map, no date and no names.';

/** The picture in words, for a screen reader and for a driver. */
export function cardAltWords(card: ShareCard): string {
  const figures = card.figures.map((f) => `${f.label}: ${f.value}`).join(', ');
  const where = card.fieldName === null ? '' : ` Field: ${card.fieldName}.`;
  const carries = `${card.carries.length} carr${card.carries.length === 1 ? 'y' : 'ies'} drawn`;
  return `${card.result}.${where} ${figures}. ${carries} on the board.`;
}

/** The sentence that rides beside the picture in a share sheet. */
export function cardMessageWords(card: ShareCard): string {
  const walked = card.figures[0]!;
  return walked.value === 'not measured'
    ? `${card.result}. A game of Satellite Chess.`
    : `${card.result}, and walked ${walked.value}. A game of Satellite Chess.`;
}

// ---------------------------------------------------------------------------
// The PNG
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * The chunks a PNG keeps on its way out: what it takes to draw the picture
 * and its colors, and nothing else. No text (`tEXt`, `zTXt`, `iTXt`), no
 * `eXIf`, no `tIME`, and nothing a future encoder invents.
 */
export const PNG_KEPT_CHUNKS: ReadonlySet<string> = new Set(['IHDR', 'PLTE', 'tRNS', 'gAMA', 'sRGB', 'IDAT', 'IEND']);

/**
 * A PNG with every chunk but {@link PNG_KEPT_CHUNKS} taken out, or null for
 * bytes that are not a well-formed PNG. Chunks are copied whole, CRC
 * included, so what is kept is byte for byte what the encoder wrote.
 */
export function stripPngMetadata(bytes: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  let at = 8;
  let ended = false;
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at);
    const end = at + 12 + length;
    if (end > bytes.length) return null;
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (PNG_KEPT_CHUNKS.has(type)) kept.push(bytes.subarray(at, end));
    at = end;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended) return null;
  const out = new Uint8Array(kept.reduce((n, part) => n + part.length, 0));
  let o = 0;
  for (const part of kept) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

/** The chunk types of a PNG, in order — for a test or a driver. */
export function pngChunkTypes(bytes: Uint8Array): string[] {
  const types: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at);
    types.push(String.fromCharCode(...bytes.subarray(at + 4, at + 8)));
    at += 12 + length;
  }
  return types;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const INK = {
  bg: '#0d1117',
  fg: '#ffffff',
  dim: '#9aa4b2',
  accent: '#58a6ff',
  line: '#2b3441',
};
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MARGIN = 56;
/** The board's canvas: square, the card's width less a little. Its own 6% padding sits inside it. */
const BOARD_PX = 1000;
const BOARD_TOP = 166;
/**
 * One backing pixel per pixel of the card, whatever the phone's own ratio:
 * the picture is the same size on every phone.
 */
const BOARD_RATIO = 1;

/**
 * The card, drawn onto `canvas` at {@link CARD_WIDTH} × {@link CARD_HEIGHT}
 * whatever the phone's pixel ratio: a picture has one size.
 */
export function drawShareCard(canvas: HTMLCanvasElement, card: ShareCard, look?: PieceLook): void {
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = INK.bg;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  // The words over the board: the name of the game, the result, and the
  // field's name when the player asked for it.
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = INK.accent;
  ctx.font = `700 30px ${FONT}`;
  fillFitted(ctx, 'SATELLITE CHESS', MARGIN, 84, CARD_WIDTH - 2 * MARGIN, 30, '700', 1.5);
  ctx.fillStyle = INK.fg;
  fillFitted(ctx, card.result, MARGIN, 148, CARD_WIDTH - 2 * MARGIN, 56, '700');
  if (card.fieldName !== null) {
    ctx.fillStyle = INK.dim;
    ctx.textAlign = 'right';
    fillFitted(ctx, card.fieldName, CARD_WIDTH - MARGIN, 84, (CARD_WIDTH - 2 * MARGIN) / 2, 30, '600');
    ctx.textAlign = 'left';
  }

  // The board, drawn by the game's own renderer on a board of squares that is
  // no place, then every carry over it.
  const board = document.createElement('canvas');
  board.width = BOARD_PX;
  board.height = BOARD_PX;
  const projection = drawBoard(board, {
    geo: REPLAY_GEOMETRY,
    orientation: card.orientation,
    pieces: piecesFromFen(card.fen),
    pos: null,
    accuracyM: 0,
    reachM: 0,
    over: true,
    lastMove: card.lastMove,
    look,
    north: false,
    pixelRatio: BOARD_RATIO,
  });
  if (projection !== null) drawCarries(board, projection, card.carries, BOARD_RATIO);
  ctx.drawImage(board, (CARD_WIDTH - BOARD_PX) / 2, BOARD_TOP, BOARD_PX, BOARD_PX);

  // The figures, four across under the board.
  const top = BOARD_TOP + BOARD_PX + 14;
  const column = (CARD_WIDTH - 2 * MARGIN) / card.figures.length;
  ctx.strokeStyle = INK.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(MARGIN, top);
  ctx.lineTo(CARD_WIDTH - MARGIN, top);
  ctx.stroke();
  ctx.textAlign = 'center';
  card.figures.forEach((figure, i) => {
    const x = MARGIN + column * (i + 0.5);
    ctx.fillStyle = INK.fg;
    fillFitted(ctx, figure.value, x, top + 62, column - 16, 48, '700');
    ctx.fillStyle = INK.dim;
    fillFitted(ctx, figure.label, x, top + 100, column - 16, 26, '500');
  });
  ctx.fillStyle = INK.dim;
  fillFitted(ctx, card.footnote, CARD_WIDTH / 2, CARD_HEIGHT - 30, CARD_WIDTH - 2 * MARGIN, 22, '400');
  ctx.textAlign = 'left';
}

/**
 * Text at the largest size up to `px` that fits `maxWidth`, down to 60% of
 * it; past that, cut with an ellipsis. A field's name is the player's own and
 * can be any length.
 */
function fillFitted(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  px: number,
  weight: string,
  spacing = 0,
): void {
  let size = px;
  const set = () => {
    ctx.font = `${weight} ${size}px ${FONT}`;
    if ('letterSpacing' in ctx) (ctx as { letterSpacing: string }).letterSpacing = `${spacing}px`;
  };
  set();
  while (ctx.measureText(text).width > maxWidth && size > px * 0.6) {
    size -= 1;
    set();
  }
  let shown = text;
  while (ctx.measureText(shown).width > maxWidth && shown.length > 1) {
    shown = `${[...shown].slice(0, -2).join('')}…`;
  }
  ctx.fillText(shown, x, y);
  if ('letterSpacing' in ctx) (ctx as { letterSpacing: string }).letterSpacing = '0px';
}

/**
 * The card as a PNG with nothing in it but the picture. Asynchronous,
 * because `toBlob` is: called when the card is opened, never from the Share
 * tap.
 */
export function cardPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        resolve(null);
        return;
      }
      void blob.arrayBuffer().then(
        (buffer) => {
          const clean = stripPngMetadata(new Uint8Array(buffer));
          resolve(clean === null ? null : new Blob([clean], { type: 'image/png' }));
        },
        () => resolve(null),
      );
    }, 'image/png');
  });
}
