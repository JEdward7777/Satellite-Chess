/**
 * Chess's art on the phone (decision 0056): the cburnett pieces and the PGN
 * writer. Built as its own file, `/games/chess.js`, and fetched the first time
 * a chess board, review or watch page is shown (`../registry.ts`).
 *
 * Nothing here may import from the main bundle's stateful modules: this file
 * is bundled on its own, so anything it imports is a second copy. Pure
 * functions and constants only.
 */

import { buildPgn, pgnFileName } from '../../../shared/pgn.js';
import type { GameReport } from '../../../shared/review.js';
import type { GameArt } from '../types.js';
import { PIECE_ART_CREDIT, PIECE_ART_LICENSE, drawPiece, pieceSvg } from './pieces.js';

/**
 * The game as a PGN file, and what to call it (decision 0041). Built on the
 * phone from the report it already holds, so Share has nothing to await.
 */
export function pgnOf(report: GameReport): { text: string; fileName: string } {
  return { text: buildPgn(report), fileName: pgnFileName(report) };
}

export const CHESS_ART: GameArt = {
  type: 'chess',
  drawPiece,
  pieceSvg,
  // The bishop: what the look switch has always shown.
  samplePiece: 'b',
  credit: PIECE_ART_CREDIT,
  license: PIECE_ART_LICENSE,
  writeRecord: (report) => buildPgn(report),
  recordFileName: (report) => pgnFileName(report),
};
