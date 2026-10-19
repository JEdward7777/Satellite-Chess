/**
 * Chess, as both the Worker and the phone know it (decision 0056): its name,
 * its lattice and start zones, and the **position codec** — reading a FEN and
 * moving a piece the server has already called legal.
 *
 * **No rules engine.** Legality is the server's (decision 0008), and the
 * server's chess rules (`worker/games/chess.ts`) are chess.js. This file is
 * what the phone needs to *draw* a position and to predict a move the server
 * has already listed as legal: where the pieces are, and the three cases where
 * a legal move changes the board somewhere other than its two squares —
 * castling's rook, an en passant capture, and a promotion. Bundling chess.js
 * into the phone would add ~36 kB for a phone with one bar, and none of it is
 * needed for that.
 *
 * Moved here from `client/optimistic.ts` (the codec), `client/render.ts` (the
 * piece map), `client/replay.ts` (the starting FEN) and `client/views/game.ts`
 * (promotion), unchanged, when chess went behind the game interface.
 */

import { type Color, type Square, fromSquare, startZoneSquares, toSquare } from '../squares.js';
import type { CarryPath, GameDescriptor, PieceOn } from './types.js';

export type PieceType = 'k' | 'q' | 'r' | 'b' | 'n' | 'p';

/** Where every game of chess starts. */
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// ---------------------------------------------------------------------------
// Reading a position
// ---------------------------------------------------------------------------

/** The placement field of a FEN as `board[rank][file]`, `''` for an empty square. */
type Placement = string[][];

export function parsePlacement(fen: string): Placement {
  const board: Placement = Array.from({ length: 8 }, () => Array<string>(8).fill(''));
  const rows = fen.split(' ')[0]?.split('/') ?? [];
  // FEN lists rank 8 first; rank indices here count up from rank 1, as everywhere
  // else in this project.
  rows.forEach((row, index) => {
    const rank = 7 - index;
    if (rank < 0) return;
    let file = 0;
    for (const ch of row) {
      const skip = Number(ch);
      if (Number.isFinite(skip) && skip > 0) {
        file += skip;
        continue;
      }
      if (file > 7) break;
      board[rank][file] = ch;
      file += 1;
    }
  });
  return board;
}

export function formatPlacement(board: Placement): string {
  const rows: string[] = [];
  for (let rank = 7; rank >= 0; rank -= 1) {
    let row = '';
    let empty = 0;
    for (let file = 0; file < 8; file += 1) {
      const piece = board[rank][file];
      if (piece === '') {
        empty += 1;
        continue;
      }
      if (empty > 0) {
        row += String(empty);
        empty = 0;
      }
      row += piece;
    }
    if (empty > 0) row += String(empty);
    rows.push(row);
  }
  return rows.join('/');
}

/**
 * Read a FEN's placement field into a piece map.
 *
 * Deliberately not chess.js: the server is the only rules authority and sends
 * legal destinations with every carry, so the client needs to know *where the
 * pieces are* and nothing more. Twenty lines here against ~50 kB of bundle on a
 * phone with one bar.
 */
export function piecesFromFen(fen: string): Partial<Record<Square, { type: PieceType; color: Color }>> {
  const pieces: Partial<Record<Square, { type: PieceType; color: Color }>> = {};
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
 * The starting position, so the board can be looked at before phase 4 exists.
 *
 * The real position comes from the game state; nothing here is authoritative.
 */
export function startingPieces(): Partial<Record<Square, { type: PieceType; color: Color }>> {
  const back: PieceType[] = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  const pieces: Partial<Record<Square, { type: PieceType; color: Color }>> = {};
  for (let file = 0; file < 8; file++) {
    pieces[toSquare(file, 0)] = { type: back[file], color: 'w' };
    pieces[toSquare(file, 1)] = { type: 'p', color: 'w' };
    pieces[toSquare(file, 6)] = { type: 'p', color: 'b' };
    pieces[toSquare(file, 7)] = { type: back[file], color: 'b' };
  }
  return pieces;
}

// ---------------------------------------------------------------------------
// Moving a piece the server called legal
// ---------------------------------------------------------------------------

/**
 * Apply a known-legal move to a FEN, for rendering only.
 *
 * Only the placement field and the side to move are updated. Castling rights,
 * the en passant target and the halfmove clocks are left as they were, because
 * **the client reads none of them** — `piecesFromFen` takes the placement field
 * and nothing else, and whose turn it is comes from `clock.active`. The next
 * snapshot replaces the whole string a moment later anyway.
 *
 * The move must already be known legal: this is only ever called for a
 * destination the server itself enumerated. Nothing here validates anything.
 */
export function applyMoveToFen(
  fen: string,
  from: Square,
  to: Square,
  promotion?: 'q' | 'r' | 'b' | 'n',
): string {
  const board = parsePlacement(fen);
  const a = fromSquare(from);
  const b = fromSquare(to);
  const piece = board[a.rank][a.file];
  if (piece === '') return fen;

  const white = piece === piece.toUpperCase();
  const kind = piece.toLowerCase();
  const captured = board[b.rank][b.file];

  board[a.rank][a.file] = '';
  board[b.rank][b.file] = promotion
    ? (white ? promotion.toUpperCase() : promotion)
    : piece;

  // Castling: the king moves two files, and the rook jumps over it. chess.js
  // encodes castling as a king move only, so the rook has to be moved here or it
  // is left stranded on the corner.
  if (kind === 'k' && Math.abs(b.file - a.file) === 2) {
    const kingside = b.file > a.file;
    const rookFrom = kingside ? 7 : 0;
    const rookTo = kingside ? b.file - 1 : b.file + 1;
    board[a.rank][rookTo] = board[a.rank][rookFrom];
    board[a.rank][rookFrom] = '';
  }

  // En passant: a pawn changing file onto an empty square captures the pawn
  // beside it, not the one under it.
  if (kind === 'p' && a.file !== b.file && captured === '') {
    board[a.rank][b.file] = '';
  }

  const fields = fen.split(' ');
  fields[0] = formatPlacement(board);
  if (fields.length > 1) fields[1] = white ? 'b' : 'w';
  return fields.join(' ');
}

// ---------------------------------------------------------------------------
// Promotion: the one choice made as a piece goes down
// ---------------------------------------------------------------------------

/** What a pawn may become. Not a king, and not another pawn. */
export type PromotionPiece = 'q' | 'r' | 'b' | 'n';

export const PROMOTION_CHOICES: readonly { type: PromotionPiece; name: string }[] = [
  { type: 'q', name: 'Queen' },
  { type: 'r', name: 'Rook' },
  { type: 'b', name: 'Bishop' },
  { type: 'n', name: 'Knight' },
];

/**
 * Would putting the carried piece down on `to` promote it?
 *
 * Asked of the carry rather than of the FEN, because mid-carry the position
 * still shows the pawn on its origin — the board only changes when the piece
 * goes down — and `piece` is the server's word for what is actually in hand.
 */
export function promotesOn(carry: { piece: string; color: Color }, to: Square): boolean {
  if (carry.piece.toLowerCase() !== 'p') return false;
  return fromSquare(to).rank === (carry.color === 'w' ? 7 : 0);
}

/** The promotion a stored move made, from its long algebraic form (`e7e8q`). */
export function promotionOf(uci: string): PromotionPiece | undefined {
  const p = uci.slice(4, 5).toLowerCase();
  return p === 'q' || p === 'r' || p === 'b' || p === 'n' ? p : undefined;
}

function asPromotion(choice: string | undefined): PromotionPiece | undefined {
  return choice === 'q' || choice === 'r' || choice === 'b' || choice === 'n' ? choice : undefined;
}

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

export const CHESS: GameDescriptor = {
  type: 'chess',
  name: 'Chess',
  seats: { w: { name: 'White', dark: false }, b: { name: 'Black', dark: true } },
  pieceNames: { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' },
  lattice: { files: 8, ranks: 8, playable: () => true },
  // The back rank (decision 0005), as it always was.
  startZone: (color: Color) => startZoneSquares(color),
  // A chess move is a lift and a place, never a stop between (decision 0001).
  waypoints: false,
  options: [],
  record: { name: 'PGN', extension: 'pgn', mime: 'application/x-chess-pgn' },
  initialState: () => START_FEN,
  pieceAt(state: string, square: Square): PieceOn | null {
    const { file, rank } = fromSquare(square);
    const piece = parsePlacement(state)[rank]?.[file];
    if (!piece) return null;
    return { type: piece.toLowerCase(), color: piece === piece.toUpperCase() ? 'w' : 'b' };
  },
  piecesOf: (state: string) => piecesFromFen(state),
  applyKnown: (state: string, path: CarryPath, to: Square, choice?: string) =>
    applyMoveToFen(state, path.from, to, asPromotion(choice)),
  pieceTypes: ['k', 'q', 'r', 'b', 'n', 'p'],
  choices: PROMOTION_CHOICES,
  asksChoice: (piece: PieceOn, to: Square) => promotesOn({ piece: piece.type, color: piece.color }, to),
  choiceOf: (uci: string) => promotionOf(uci),
};
