import { Chess, type Square as ChessSquare } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { descriptorFor, descriptorOf } from '../src/shared/games/catalog.js';
import { CHESS, START_FEN, parsePlacement } from '../src/shared/games/chess.js';
import { DEFAULT_GAME_TYPE, parseGameType } from '../src/shared/games/types.js';
import { startZoneSquares } from '../src/shared/squares.js';
import { CHESS_RULES } from '../src/worker/games/chess.js';
import { rulesFor } from '../src/worker/games/index.js';

/**
 * Chess behind the game interface (stage 11.1, decision 0056) must judge
 * exactly as the code it replaced. The reference functions below are copied
 * from `GameDO` as it was at 762d8f3, and every legal move of many random
 * games is asked of both.
 */

/** A small seeded generator, so a failure names a game that can be replayed. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** `GameDO.detectTerminal` at 762d8f3. */
function oldEnding(chess: Chess): { outcome: string; reason: string } | null {
  if (chess.isCheckmate()) return { outcome: chess.turn() === 'w' ? '0-1' : '1-0', reason: 'checkmate' };
  if (chess.isStalemate()) return { outcome: '1/2-1/2', reason: 'stalemate' };
  if (chess.isInsufficientMaterial()) return { outcome: '1/2-1/2', reason: 'insufficient_material' };
  if (chess.isThreefoldRepetition()) return { outcome: '1/2-1/2', reason: 'threefold_repetition' };
  if (chess.isDraw()) return { outcome: '1/2-1/2', reason: 'fifty_move_rule' };
  return null;
}

/** `hasMatingMaterial` and `onFlagFall` at 762d8f3. */
function oldTimeout(fen: string, flagged: 'w' | 'b'): { outcome: string; reason: string } {
  const winner = flagged === 'w' ? 'b' : 'w';
  let minors = 0;
  let enough = false;
  for (const row of new Chess(fen).board()) {
    for (const square of row) {
      if (square === null || square.color !== winner) continue;
      if (square.type === 'b' || square.type === 'n') minors += 1;
      else if (square.type !== 'k') enough = true;
    }
  }
  if (!enough && minors < 2) return { outcome: '1/2-1/2', reason: 'insufficient_material' };
  return { outcome: winner === 'w' ? '1-0' : '0-1', reason: 'timeout' };
}

describe('game types', () => {
  it('reads an absent type as chess and refuses one it does not know', () => {
    expect(parseGameType(undefined)).toBe('chess');
    expect(parseGameType(null)).toBe('chess');
    expect(parseGameType('')).toBe('chess');
    expect(parseGameType('chess')).toBe('chess');
    expect(parseGameType('checkers')).toBeNull();
    expect(parseGameType(7)).toBeNull();
    expect(DEFAULT_GAME_TYPE).toBe('chess');
  });

  it('gives the server no rules for an unknown type, and chess for none', () => {
    expect(rulesFor(undefined)).toBe(CHESS_RULES);
    expect(rulesFor(null)).toBe(CHESS_RULES);
    expect(rulesFor('backgammon')).toBeNull();
    expect(descriptorOf('chess')).toBe(CHESS);
    expect(descriptorFor(undefined)).toBe(CHESS);
  });

  it('describes chess as it always was: 8 × 8, the back rank, no waypoints, no options', () => {
    expect(CHESS.lattice.files).toBe(8);
    expect(CHESS.lattice.ranks).toBe(8);
    expect(CHESS.startZone('w')).toEqual(startZoneSquares('w'));
    expect(CHESS.startZone('b')).toEqual(startZoneSquares('b'));
    expect(CHESS.waypoints).toBe(false);
    expect(CHESS.options).toEqual([]);
    expect(CHESS_RULES.normaliseOptions({ jumpsRequired: true })).toEqual({});
    expect(CHESS.initialState({})).toBe(START_FEN);
    expect(CHESS.record).toEqual({ name: 'PGN', extension: 'pgn', mime: 'application/x-chess-pgn' });
  });
});

describe('chess rules against the code they replaced', () => {
  it('agree on every piece, destination, move, ending and flag over 20 random games', () => {
    const wrong: string[] = [];
    let plies = 0;
    let endings = 0;
    for (let seed = 1; seed <= 20 && wrong.length < 5; seed++) {
      const next = random(seed);
      let fen = START_FEN;
      for (let ply = 0; ply < 160; ply++) {
        const chess = new Chess(fen);
        const moves = chess.moves({ verbose: true });
        // Every square: what stands on it, and where it may go — on every
        // fifth ply, since each question builds a position from scratch.
        for (const row of ply % 5 === 0 ? chess.board() : []) {
          for (const cell of row) {
            if (cell === null) continue;
            const piece = CHESS_RULES.pieceAt(fen, cell.square);
            if (piece?.type !== cell.type || piece.color !== cell.color) wrong.push(`${seed}/${ply} pieceAt ${cell.square}`);
            const codec = CHESS.pieceAt(fen, cell.square);
            if (codec?.type !== cell.type || codec.color !== cell.color) wrong.push(`${seed}/${ply} codec ${cell.square}`);
            // Destinations for the side to move: the only pieces a lift asks about.
            if (cell.color !== chess.turn()) continue;
            const stops = CHESS_RULES.stops(fen, { from: cell.square, via: [] }, {});
            const old = new Chess(fen).moves({ square: cell.square as ChessSquare, verbose: true }).map((m) => m.to);
            if (stops.waypoints.length !== 0 || JSON.stringify(stops.places) !== JSON.stringify(old)) {
              wrong.push(`${seed}/${ply} stops ${cell.square}`);
            }
          }
        }
        if (ply % 5 === 0 && JSON.stringify(CHESS_RULES.timeout(fen, 'w')) !== JSON.stringify(oldTimeout(fen, 'w'))) wrong.push(`${seed}/${ply} timeout w`);
        if (ply % 5 === 0 && JSON.stringify(CHESS_RULES.timeout(fen, 'b')) !== JSON.stringify(oldTimeout(fen, 'b'))) wrong.push(`${seed}/${ply} timeout b`);
        if (moves.length === 0) break;
        const pick = moves[Math.floor(next() * moves.length)]!;
        const reference = new Chess(fen);
        const move = reference.move({ from: pick.from, to: pick.to, promotion: pick.promotion ?? 'q' });
        const played = CHESS_RULES.play(fen, { from: pick.from, via: [] }, pick.to, pick.promotion, {});
        if (
          played === null ||
          played.state !== reference.fen() ||
          played.notation !== move.san ||
          played.uci !== move.lan ||
          played.from !== move.from ||
          played.to !== move.to
        ) {
          wrong.push(`${seed}/${ply} play ${pick.lan}`);
          break;
        }
        // The phone's codec moves the same pieces the engine did.
        const drawn = CHESS.applyKnown(fen, { from: pick.from, via: [] }, pick.to, CHESS.choiceOf(move.lan));
        if (JSON.stringify(parsePlacement(drawn)) !== JSON.stringify(parsePlacement(played.state))) {
          wrong.push(`${seed}/${ply} applyKnown ${pick.lan}`);
        }
        const end = CHESS_RULES.ending(played.state, {});
        if (JSON.stringify(end) !== JSON.stringify(oldEnding(new Chess(played.state)))) wrong.push(`${seed}/${ply} ending`);
        plies += 1;
        fen = played.state;
        if (end !== null) {
          endings += 1;
          break;
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(plies).toBeGreaterThan(700);
    expect(endings).toBeGreaterThan(0);
  }, 60_000);

  it('refuses an illegal move, and any carry that stopped on the way, without throwing', () => {
    expect(CHESS_RULES.play(START_FEN, { from: 'e2', via: [] }, 'e5', undefined, {})).toBeNull();
    expect(CHESS_RULES.play(START_FEN, { from: 'e2', via: ['e3'] }, 'e4', undefined, {})).toBeNull();
    expect(CHESS_RULES.stops(START_FEN, { from: 'e2', via: ['e3'] }, {})).toEqual({ waypoints: [], places: [] });
  });

  it('promotes to a queen when the choice is missing or unknown, as the server always did', () => {
    const fen = '8/P7/8/8/8/8/8/k6K w - - 0 1';
    expect(CHESS_RULES.play(fen, { from: 'a7', via: [] }, 'a8', undefined, {})?.notation).toBe('a8=Q+');
    expect(CHESS_RULES.play(fen, { from: 'a7', via: [] }, 'a8', 'x', {})?.notation).toBe('a8=Q+');
    expect(CHESS_RULES.play(fen, { from: 'a7', via: [] }, 'a8', 'n', {})?.uci).toBe('a7a8n');
  });

  it('still never sees a threefold repetition, which O-59 records rather than fixes here', () => {
    let fen = START_FEN;
    const seen: (string | null)[] = [];
    for (const [from, to] of [
      ['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8'],
      ['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8'],
    ] as const) {
      const played = CHESS_RULES.play(fen, { from, via: [] }, to, undefined, {});
      fen = played!.state;
      seen.push(CHESS_RULES.ending(fen, {})?.reason ?? null);
    }
    expect(seen.every((reason) => reason === null)).toBe(true);
  });
});
