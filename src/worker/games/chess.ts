/**
 * Chess's rules, as the server — the only authority (decision 0008) — plays
 * them: chess.js behind the game interface (decision 0056).
 *
 * Moved here from `GameDO` unchanged when chess went behind the interface.
 * Every call builds a fresh `Chess` from the stored FEN, exactly as the object
 * always did: the object hibernates between messages, so nothing is kept, and
 * a position is all a FEN carries. One consequence is kept on purpose rather
 * than fixed in a refactor that promised no change: a `Chess` built from a FEN
 * has no history, so threefold repetition is never detected (O-59).
 */

import { Chess, type Square as ChessSquare } from 'chess.js';

import { CHESS } from '../../shared/games/chess.js';
import type {
  CarryPath,
  GameEnd,
  GameOptions,
  GameRules,
  NextStops,
  PlayedMove,
} from '../../shared/games/types.js';
import { buildPgn, pgnFileName } from '../../shared/pgn.js';
import type { Color, Square } from '../../shared/squares.js';

/**
 * Promotion is a pure UI choice with no travel involved, so anything unrecognised
 * becomes a queen rather than an error — that is what the player meant.
 */
function normalisePromotion(value: unknown): 'q' | 'r' | 'b' | 'n' {
  return value === 'r' || value === 'b' || value === 'n' ? value : 'q';
}

/**
 * Could `color` conceivably deliver mate with what is on the board?
 *
 * Used only for flag-fall: a lone king, or a king with a single bishop or knight,
 * cannot force mate, so an opponent running out of time draws rather than loses.
 * Deliberately the simple test rather than an exhaustive one — the rare
 * king-and-two-knights case is theoretically winnable and counts as material here,
 * which matches how the rule is usually applied.
 */
function hasMatingMaterial(chess: Chess, color: Color): boolean {
  let minors = 0;
  for (const row of chess.board()) {
    for (const square of row) {
      if (square === null || square.color !== color) continue;
      switch (square.type) {
        case 'k':
          break;
        case 'b':
        case 'n':
          minors += 1;
          break;
        default:
          // A pawn, rook or queen is always enough.
          return true;
      }
    }
  }
  return minors >= 2;
}

export const CHESS_RULES: GameRules = {
  ...CHESS,

  // Chess has no creation settings, so there is never anything to keep.
  normaliseOptions: (): GameOptions => ({}),

  /**
   * The legal destinations of the piece on `from`. Never a waypoint: a chess
   * move is a lift and a place (decision 0001).
   */
  stops(state: string, path: CarryPath): NextStops {
    if (path.via.length > 0) return { waypoints: [], places: [] };
    const places = new Chess(state)
      .moves({ square: path.from as ChessSquare, verbose: true })
      .map((move) => move.to);
    return { waypoints: [], places };
  },

  pieceAt(state: string, square: Square) {
    // chess.js rather than the codec, as the lift always asked it: the server
    // reads its own engine's board.
    const piece = new Chess(state).get(square as ChessSquare);
    return piece ? { type: piece.type, color: piece.color } : null;
  },

  play(state: string, path: CarryPath, to: Square, choice: string | undefined): PlayedMove | null {
    if (path.via.length > 0) return null;
    const chess = new Chess(state);
    try {
      const move = chess.move({ from: path.from, to, promotion: normalisePromotion(choice) });
      return { state: chess.fen(), notation: move.san, uci: move.lan, from: move.from, to: move.to };
    } catch {
      // chess.js 1.x throws on an illegal move where 0.x returned null. Catching
      // is not optional: an uncaught throw in a message handler would fault the
      // object.
      return null;
    }
  },

  ending(state: string): GameEnd | null {
    const chess = new Chess(state);
    if (chess.isCheckmate()) {
      // chess.js reports whose turn it is *after* the move, and that side is mated.
      return { outcome: chess.turn() === 'w' ? '0-1' : '1-0', reason: 'checkmate' };
    }
    if (chess.isStalemate()) return { outcome: '1/2-1/2', reason: 'stalemate' };
    if (chess.isInsufficientMaterial()) return { outcome: '1/2-1/2', reason: 'insufficient_material' };
    if (chess.isThreefoldRepetition()) return { outcome: '1/2-1/2', reason: 'threefold_repetition' };
    // Whatever is left is the fifty-move rule.
    if (chess.isDraw()) return { outcome: '1/2-1/2', reason: 'fifty_move_rule' };
    return null;
  },

  // A player who runs out of time but whose opponent could never deliver mate
  // draws rather than loses, as over the board.
  timeout(state: string, flagged: Color): GameEnd {
    const winner: Color = flagged === 'w' ? 'b' : 'w';
    if (!hasMatingMaterial(new Chess(state), winner)) {
      return { outcome: '1/2-1/2', reason: 'insufficient_material' };
    }
    return { outcome: winner === 'w' ? '1-0' : '0-1', reason: 'timeout' };
  },

  writeRecord: (report) => buildPgn(report),
  recordFileName: (report) => pgnFileName(report),
};
