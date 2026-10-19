/**
 * Checkers (American checkers, English draughts), as both the Worker and the
 * phone know it (decision 0056): its name, lattice and start zones, its one
 * creation setting, PDN's square numbers, and the **position codec** — reading
 * a PDN position and moving a piece the server has already called legal.
 *
 * **No rules engine.** Legality is the server's (decision 0008), in
 * `worker/games/checkers.ts`. What is here is what a phone needs to draw a
 * position and to predict a move the server has already listed as legal.
 *
 * ## Who is who (decision 0057)
 *
 * In checkers the dark pieces ("Black") move first. Everything around the
 * rules — the clock, the move numbering, the record's `1-0`, the handshake —
 * says the side that moves first is the `w` seat, so **the `w` seat plays the
 * dark pieces and moves first**, and the `b` seat plays the light pieces. A
 * `Color` here is a seat, not a paint: `w` is checkers' Black. The phone names
 * and paints the seats per game (stage 11.3).
 *
 * The `w` seat stands at rank 1, as in chess, and its men move up the board
 * (towards rank 8). PDN numbers the dark squares 1–32 from the first player's
 * back row: 1–4 is that row, square 4 is its left-hand corner (a1, the
 * "single corner"), and 1 and 5 its double corner (g1, h2). The light pieces
 * start on 21–32.
 *
 * ## The position string
 *
 * A PDN FEN: `B:W21,22,…,32:B1,2,…,12`, side to move first, then each side's
 * squares with `K` before a king. PDN's `B` is the `w` seat (see above). The
 * reader also takes PDN's ranges (`B1-12`); the writer never makes them.
 */

import { type Color, type Square, fromSquare, startZoneSquares, toSquare } from '../squares.js';
import type { CarryPath, GameDescriptor, GameOptions, PieceOn } from './types.js';

export type CheckersPiece = 'm' | 'k';

/** The one creation setting (decision 0057): forced capture, off by default. */
export const JUMPS_REQUIRED = 'jumpsRequired';

/** Whether a game's settings make jumps compulsory. Absent is off. */
export function jumpsRequired(options: GameOptions | undefined): boolean {
  return options?.[JUMPS_REQUIRED] === true;
}

// ---------------------------------------------------------------------------
// PDN square numbers
// ---------------------------------------------------------------------------

/**
 * A PDN square number (1–32) for a dark square, or null for a light one.
 *
 * Row `r` (rank index from the first player's side) holds 4r+1…4r+4, read
 * from the h-file side: on an even row the dark files are g, e, c, a; on an
 * odd row h, f, d, b. So 1 = g1, 4 = a1, 5 = h2, 32 = b8.
 */
export function pdnNumber(square: Square): number | null {
  const { file, rank } = fromSquare(square);
  if (file < 0 || file > 7 || rank < 0 || rank > 7 || (file + rank) % 2 !== 0) return null;
  const index = rank % 2 === 0 ? (6 - file) / 2 : (7 - file) / 2;
  return rank * 4 + index + 1;
}

/** The square a PDN number names, or null outside 1–32. */
export function pdnSquare(n: number): Square | null {
  if (!Number.isInteger(n) || n < 1 || n > 32) return null;
  const rank = Math.floor((n - 1) / 4);
  const index = (n - 1) % 4;
  const file = rank % 2 === 0 ? 6 - 2 * index : 7 - 2 * index;
  return toSquare(file, rank);
}

// ---------------------------------------------------------------------------
// Reading and writing a position
// ---------------------------------------------------------------------------

export interface CheckersMan {
  color: Color;
  king: boolean;
}

export interface CheckersPosition {
  /** Whose turn it is, as a seat (`w` moves first: decision 0057). */
  turn: Color;
  board: Map<Square, CheckersMan>;
}

/** The PDN letter for a seat: the `w` seat plays PDN's Black. */
const PDN_SIDE: Record<Color, 'B' | 'W'> = { w: 'B', b: 'W' };
const SEAT_OF: Record<'B' | 'W', Color> = { B: 'w', W: 'b' };

/** Where every game of checkers starts: 12 men each, the dark pieces to move. */
export const CHECKERS_START =
  'B:W21,22,23,24,25,26,27,28,29,30,31,32:B1,2,3,4,5,6,7,8,9,10,11,12';

/**
 * Read a PDN FEN. Anything it cannot read is left off the board rather than
 * thrown: a phone drawing a position must never fault on it, and the server
 * only ever reads strings it wrote.
 */
export function parseCheckers(state: string): CheckersPosition {
  const board = new Map<Square, CheckersMan>();
  const parts = state.trim().replace(/\.$/, '').split(':');
  const turn: Color = parts[0]?.trim().toUpperCase() === 'W' ? 'b' : 'w';
  for (const part of parts.slice(1)) {
    const side = part.trim().charAt(0).toUpperCase();
    if (side !== 'W' && side !== 'B') continue;
    const color = SEAT_OF[side];
    for (const raw of part.trim().slice(1).split(',')) {
      const item = raw.trim();
      if (item === '') continue;
      const king = item.charAt(0).toUpperCase() === 'K';
      const body = king ? item.slice(1) : item;
      const range = /^(\d+)-(\d+)$/.exec(body);
      const numbers = range
        ? Array.from({ length: Math.max(0, Number(range[2]) - Number(range[1]) + 1) }, (_, i) => Number(range[1]) + i)
        : [Number(body)];
      for (const n of numbers) {
        const square = pdnSquare(n);
        if (square !== null) board.set(square, { color, king });
      }
    }
  }
  return { turn, board };
}

/** Write a PDN FEN: the side to move, then each side's squares in number order. */
export function formatCheckers(position: CheckersPosition): string {
  const list = (color: Color): string =>
    [...position.board.entries()]
      .filter(([, man]) => man.color === color)
      .map(([square, man]) => ({ n: pdnNumber(square) ?? 0, king: man.king }))
      .filter((p) => p.n > 0)
      .sort((a, b) => a.n - b.n)
      .map((p) => `${p.king ? 'K' : ''}${p.n}`)
      .join(',');
  // PDN lists White first; the side to move leads.
  return `${PDN_SIDE[position.turn]}:W${list('b')}:B${list('w')}`;
}

/** The rank a seat's man is crowned on: the far side from where it starts. */
export function crownRank(color: Color): number {
  return color === 'w' ? 7 : 0;
}

// ---------------------------------------------------------------------------
// Moving a piece the server called legal
// ---------------------------------------------------------------------------

/**
 * Every square a carry stands on, in order: the origin, each waypoint, then
 * the place — once, where the place is the square the last waypoint already
 * stood on ("stop here", when jumps are not required).
 */
export function hopsOf(path: CarryPath, to: Square): Square[] {
  const squares: Square[] = [path.from, ...path.via];
  if (squares[squares.length - 1] !== to || path.via.length === 0) squares.push(to);
  return squares;
}

/**
 * Apply a known-legal move to a position, for drawing only: the piece walks
 * its hops, every piece it jumped (the square between two hops two apart) is
 * taken off, and a man reaching the far row is crowned. Validates nothing.
 */
export function applyCheckersMove(state: string, path: CarryPath, to: Square): string {
  const position = parseCheckers(state);
  const man = position.board.get(path.from);
  if (man === undefined) return state;
  const squares = hopsOf(path, to);
  position.board.delete(path.from);
  for (let i = 1; i < squares.length; i++) {
    const a = fromSquare(squares[i - 1]);
    const b = fromSquare(squares[i]);
    if (Math.abs(b.file - a.file) === 2 && Math.abs(b.rank - a.rank) === 2) {
      position.board.delete(toSquare((a.file + b.file) / 2, (a.rank + b.rank) / 2));
    }
  }
  const last = squares[squares.length - 1];
  const crowned = man.king || fromSquare(last).rank === crownRank(man.color);
  position.board.set(last, { color: man.color, king: crowned });
  position.turn = man.color === 'w' ? 'b' : 'w';
  return formatCheckers(position);
}

// ---------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------

function pieceOf(man: CheckersMan): PieceOn {
  return { type: man.king ? 'k' : 'm', color: man.color };
}

export const CHECKERS: GameDescriptor = {
  type: 'checkers',
  name: 'Checkers',
  // The seat that moves first plays the dark pieces (decision 0057), and
  // American players call them Black; the others White, as PDN does.
  seats: { w: { name: 'Black', dark: true }, b: { name: 'White', dark: false } },
  pieceNames: { m: 'man', k: 'king' },
  // The field's own 8 × 8, played on the dark squares (a1 is dark).
  lattice: { files: 8, ranks: 8, playable: (file, rank) => (file + rank) % 2 === 0 },
  // The back rank (decision 0005), as in chess: where a player stands, not
  // where their men are.
  startZone: (color: Color) => startZoneSquares(color),
  // Each hop of a multi-jump is walked (decision 0057).
  waypoints: true,
  options: [{ key: JUMPS_REQUIRED, kind: 'boolean', default: false, label: 'Jumps are required' }],
  // PDN has no registered media type; it is plain text (decision 0057).
  record: { name: 'PDN', extension: 'pdn', mime: 'text/plain' },
  initialState: () => CHECKERS_START,
  pieceAt(state: string, square: Square): PieceOn | null {
    const man = parseCheckers(state).board.get(square);
    return man === undefined ? null : pieceOf(man);
  },
  piecesOf(state: string): Partial<Record<Square, PieceOn>> {
    const pieces: Partial<Record<Square, PieceOn>> = {};
    for (const [square, man] of parseCheckers(state).board) pieces[square] = pieceOf(man);
    return pieces;
  },
  applyKnown: (state: string, path: CarryPath, to: Square) => applyCheckersMove(state, path, to),
  pieceTypes: ['m', 'k'],
  // Crowning is automatic: nothing is asked as a piece goes down.
  choices: [],
  asksChoice: () => false,
  choiceOf: () => undefined,
};
