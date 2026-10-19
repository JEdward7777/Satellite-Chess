/**
 * Checkers' art on the phone (decisions 0056, 0058): the pieces and the PDN
 * writer. Built as its own file, `/games/checkers.js`, and fetched the first
 * time a checkers board, review or watch page is shown (`../registry.ts`).
 *
 * Nothing here may import from the main bundle's stateful modules: this file
 * is bundled on its own, so anything it imports is a second copy. Pure
 * functions and constants only.
 */

import { buildPdn, pdnFileName } from '../../../shared/pdn.js';
import type { GameArt } from '../types.js';
import { CHECKERS_ART_CREDIT, CHECKERS_ART_LICENSE, drawPiece, pieceSvg } from './pieces.js';

export const CHECKERS_ART: GameArt = {
  type: 'checkers',
  drawPiece,
  pieceSvg,
  // The king: the piece whose look matters most to tell apart.
  samplePiece: 'k',
  credit: CHECKERS_ART_CREDIT,
  license: CHECKERS_ART_LICENSE,
  writeRecord: (report) => buildPdn(report),
  recordFileName: (report) => pdnFileName(report),
};
