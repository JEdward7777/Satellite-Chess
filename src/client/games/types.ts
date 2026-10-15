/**
 * What the phone fetches for a game only when that game is on screen
 * (decision 0056): its pieces as drawn, and its record file's writer.
 *
 * The owner's rule is that a phone must not download many engines. The phone
 * holds no engine at all — legality is the server's (decision 0008) — and of
 * what it does hold per game, the descriptor (`shared/games/`) is a few
 * hundred bytes and always present, while this, the art and the file writer,
 * is most of a game's weight on the phone and loads on demand
 * (`registry.ts`). Each game's is its own file under `/games/`, which the
 * service worker precaches so a game opened with no signal still has pieces.
 */

import type { GameType, PieceOn } from '../../shared/games/types.js';
import type { GameReport } from '../../shared/review.js';

/**
 * How pieces are drawn (decision 0045): the standard set, or each piece on a
 * disc of its team's color. A per-phone preference (`piece-look.ts`) that
 * every game's art honors.
 */
export type PieceLook = 'standard' | 'disc';

export interface GameArt {
  type: GameType;
  /**
   * Draw one piece centered on (`cx`, `cy`) in a box `boxPx` pixels across,
   * leaving the context's state as it found it.
   */
  drawPiece(
    ctx: CanvasRenderingContext2D,
    piece: PieceOn,
    look: PieceLook,
    cx: number,
    cy: number,
    boxPx: number,
  ): void;
  /** The same piece as inline SVG markup, for the HTML around the board. */
  pieceSvg(piece: PieceOn, look: PieceLook): string;
  /** The piece the look switch shows, one of each side. */
  samplePiece: string;
  /** Who drew the pieces, and the license, for the account screen's credits. */
  credit: string;
  license: string;
  /** The game's record file (PGN, PDN), built from a report alone (decision 0041). */
  writeRecord(report: GameReport): string;
  recordFileName(report: Pick<GameReport, 'fieldName' | 'startedAt'>): string;
}
