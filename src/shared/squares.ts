/** Board square addressing. `file` and `rank` are always 0-indexed internally. */

export type Square = string; // 'a1' .. 'h8'
export type Color = 'w' | 'b';

export interface FileRank {
  /** 0 = a … 7 = h */
  file: number;
  /** 0 = rank 1 … 7 = rank 8 */
  rank: number;
}

const FILES = 'abcdefgh';

export function toSquare(file: number, rank: number): Square {
  if (!Number.isInteger(file) || !Number.isInteger(rank)) {
    throw new Error(`non-integer square: ${file},${rank}`);
  }
  if (file < 0 || file > 7 || rank < 0 || rank > 7) {
    throw new Error(`square off board: ${file},${rank}`);
  }
  return FILES[file] + String(rank + 1);
}

export function fromSquare(sq: Square): FileRank {
  const file = FILES.indexOf(sq[0]);
  const rank = Number(sq[1]) - 1;
  if (file < 0 || sq.length !== 2 || !Number.isInteger(rank) || rank < 0 || rank > 7) {
    throw new Error(`bad square: ${sq}`);
  }
  return { file, rank };
}

export function isSquare(sq: unknown): sq is Square {
  if (typeof sq !== 'string' || sq.length !== 2) return false;
  return FILES.includes(sq[0]) && sq[1] >= '1' && sq[1] <= '8';
}

export function allSquares(): Square[] {
  const out: Square[] = [];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) out.push(toSquare(f, r));
  return out;
}

/** The rank a colour starts on, and returns to for the resume handshake. */
export function backRank(color: Color): number {
  return color === 'w' ? 0 : 7;
}

/** Every square in a colour's start zone. */
export function startZoneSquares(color: Color): Square[] {
  const r = backRank(color);
  return Array.from({ length: 8 }, (_, f) => toSquare(f, r));
}

/** Light squares are the ones where file+rank is odd (a1 is dark). */
export function isLightSquare(file: number, rank: number): boolean {
  return (file + rank) % 2 === 1;
}
