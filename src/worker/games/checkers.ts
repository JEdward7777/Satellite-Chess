/**
 * Checkers' rules, as the server — the only authority (decision 0008) — plays
 * them (decision 0057): American checkers, behind the game interface
 * (decision 0056).
 *
 * - 8 × 8, the dark squares only, twelve men a side; the dark pieces (the `w`
 *   seat, see `shared/games/checkers.ts`) move first.
 * - A man steps one square diagonally forward, and jumps diagonally forward
 *   over an opposing piece onto the empty square beyond. A king does both in
 *   any diagonal direction, one square at a time: no flying kings.
 * - A man reaching the far row is crowned, and **a man crowned mid-jump ends
 *   its move there**.
 * - A multi-jump is **walked hop by hop**: each landing it goes on from is a
 *   waypoint the player stands on, and the last is the place.
 * - **"Jumps are required"** (`jumpsRequired`, a creation setting, off by
 *   default). On: a capture must be taken when there is one, and a multi-jump
 *   must go on while it can. Off: a player may make a plain move when a jump
 *   is there, and may stop a multi-jump after any hop.
 * - A side with no legal move, or no pieces, loses (`no_moves`). There is no
 *   automatic draw: a draw is agreed, and the clock bounds every game.
 *
 * Its own small engine rather than a dependency: it is a hundred-odd lines,
 * and the walked hops and the setting both want a move generator that answers
 * "where may this piece stop next?" rather than one that lists whole moves.
 *
 * A piece jumped earlier in the same move stays on the board until the move
 * is placed, and may not be jumped twice. (No landing square can ever be a
 * jumped piece's square, since landings keep their colour of both file and
 * rank, so the two common rulings agree on every move.)
 */

import {
  CHECKERS,
  type CheckersMan,
  type CheckersPosition,
  crownRank,
  formatCheckers,
  hopsOf,
  jumpsRequired,
  parseCheckers,
  pdnNumber,
} from '../../shared/games/checkers.js';
import type {
  CarryPath,
  GameEnd,
  GameOptions,
  GameRules,
  NextStops,
  PlayedMove,
} from '../../shared/games/types.js';
import { buildPdn, pdnFileName } from '../../shared/pdn.js';
import { type Color, type Square, fromSquare, toSquare } from '../../shared/squares.js';

const ALL_DIRECTIONS: readonly [number, number][] = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];

/** The diagonals a piece may move along: forward only for a man. */
function directions(man: CheckersMan): readonly [number, number][] {
  if (man.king) return ALL_DIRECTIONS;
  const forward = man.color === 'w' ? 1 : -1;
  return ALL_DIRECTIONS.filter(([, dr]) => dr === forward);
}

function onBoard(file: number, rank: number): boolean {
  return file >= 0 && file < 8 && rank >= 0 && rank < 8;
}

/** One jump: the piece it takes, and where it lands. */
interface Jump {
  over: Square;
  land: Square;
}

/**
 * The jumps `man` can make from `at`, never over a piece already in `taken`.
 * `board` is the position with the moving piece lifted off it, so its origin
 * counts as empty (a king may come back through it).
 */
function jumpsFrom(
  board: ReadonlyMap<Square, CheckersMan>,
  at: Square,
  man: CheckersMan,
  taken: ReadonlySet<Square>,
): Jump[] {
  const { file, rank } = fromSquare(at);
  const jumps: Jump[] = [];
  for (const [df, dr] of directions(man)) {
    if (!onBoard(file + 2 * df, rank + 2 * dr)) continue;
    const over = toSquare(file + df, rank + dr);
    const land = toSquare(file + 2 * df, rank + 2 * dr);
    const victim = board.get(over);
    if (victim === undefined || victim.color === man.color || taken.has(over)) continue;
    if (board.has(land)) continue;
    jumps.push({ over, land });
  }
  return jumps;
}

/** The plain one-square moves `man` can make from `at`. */
function stepsFrom(board: ReadonlyMap<Square, CheckersMan>, at: Square, man: CheckersMan): Square[] {
  const { file, rank } = fromSquare(at);
  const steps: Square[] = [];
  for (const [df, dr] of directions(man)) {
    if (!onBoard(file + df, rank + dr)) continue;
    const to = toSquare(file + df, rank + dr);
    if (!board.has(to)) steps.push(to);
  }
  return steps;
}

/** Whether a man landing on `at` is crowned there, which ends its move. */
function crownsOn(man: CheckersMan, at: Square): boolean {
  return !man.king && fromSquare(at).rank === crownRank(man.color);
}

/** Whether the move can go on from a landing: not crowned there, and a jump left. */
function continues(
  board: ReadonlyMap<Square, CheckersMan>,
  at: Square,
  man: CheckersMan,
  taken: ReadonlySet<Square>,
): boolean {
  return !crownsOn(man, at) && jumpsFrom(board, at, man, taken).length > 0;
}

/** Whether any piece of `color` has a jump. */
function sideCanJump(board: ReadonlyMap<Square, CheckersMan>, color: Color): boolean {
  for (const [square, man] of board) {
    if (man.color !== color) continue;
    const lifted = withoutSquare(board, square);
    if (jumpsFrom(lifted, square, man, new Set()).length > 0) return true;
  }
  return false;
}

/** Whether `color` has any legal move at all, whatever the setting. */
function sideCanMove(board: ReadonlyMap<Square, CheckersMan>, color: Color): boolean {
  for (const [square, man] of board) {
    if (man.color !== color) continue;
    if (stepsFrom(board, square, man).length > 0) return true;
    if (jumpsFrom(withoutSquare(board, square), square, man, new Set()).length > 0) return true;
  }
  return false;
}

function withoutSquare(board: ReadonlyMap<Square, CheckersMan>, square: Square): Map<Square, CheckersMan> {
  const copy = new Map(board);
  copy.delete(square);
  return copy;
}

/**
 * The jumps a carry has made so far, checked hop by hop, or null if any hop is
 * not a jump this piece could make (or goes on after a crowning). The pieces
 * jumped are `taken`; `at` is where the piece stands now.
 */
function walk(
  position: CheckersPosition,
  path: CarryPath,
): { man: CheckersMan; lifted: Map<Square, CheckersMan>; at: Square; taken: Set<Square> } | null {
  const man = position.board.get(path.from);
  if (man === undefined || man.color !== position.turn) return null;
  const lifted = withoutSquare(position.board, path.from);
  const taken = new Set<Square>();
  let at = path.from;
  for (const next of path.via) {
    // A crowned man's move is over; nothing goes on from there.
    if (at !== path.from && crownsOn(man, at)) return null;
    const jump = jumpsFrom(lifted, at, man, taken).find((j) => j.land === next);
    if (jump === undefined) return null;
    taken.add(jump.over);
    at = jump.land;
  }
  return { man, lifted, at, taken };
}

/**
 * Where the carried piece may stop next.
 *
 * - A landing the move can go on from (not crowned there, with a jump left)
 *   is a **waypoint**.
 * - A landing is a **place** when the move may end there: always with
 *   jumps not required, and only where it cannot go on with them required.
 * - With no hop made yet, a plain step is a place too, unless jumps are
 *   required and this side has a jump anywhere.
 * - After a hop, with jumps not required, the square already stood on is a
 *   place ("stop here"); so it is with them required where nothing goes on.
 */
function stopsOf(state: string, path: CarryPath, options: GameOptions): NextStops {
  const required = jumpsRequired(options);
  const position = parseCheckers(state);
  const walked = walk(position, path);
  if (walked === null) return { waypoints: [], places: [] };
  const { man, lifted, at, taken } = walked;

  const waypoints: Square[] = [];
  const places: Square[] = [];
  const jumps = path.via.length > 0 && crownsOn(man, at) ? [] : jumpsFrom(lifted, at, man, taken);
  for (const jump of jumps) {
    const taking = new Set(taken).add(jump.over);
    const goesOn = continues(lifted, jump.land, man, taking);
    if (goesOn) waypoints.push(jump.land);
    if (!required || !goesOn) places.push(jump.land);
  }

  if (path.via.length === 0) {
    if (!required || !sideCanJump(position.board, man.color)) {
      places.push(...stepsFrom(position.board, at, man));
    }
  } else if (!required || jumps.length === 0) {
    places.push(at);
  }
  return { waypoints, places };
}

export const CHECKERS_RULES: GameRules = {
  ...CHECKERS,

  /** The one setting, made whole: anything but a literal `true` is off. */
  normaliseOptions(raw: unknown): GameOptions {
    const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).jumpsRequired : undefined;
    return { jumpsRequired: value === true };
  },

  stops: (state: string, path: CarryPath, options: GameOptions): NextStops => stopsOf(state, path, options),

  play(state: string, path: CarryPath, to: Square, _choice: string | undefined, options: GameOptions): PlayedMove | null {
    // Exactly what `stops` offered: the place must be one of them.
    if (!stopsOf(state, path, options).places.includes(to)) return null;
    const position = parseCheckers(state);
    const man = position.board.get(path.from);
    if (man === undefined) return null;

    const squares = hopsOf(path, to);
    const a = fromSquare(squares[0]);
    const b = fromSquare(squares[1]);
    const capture = Math.abs(b.file - a.file) === 2;

    position.board.delete(path.from);
    for (let i = 1; i < squares.length; i++) {
      const p = fromSquare(squares[i - 1]);
      const q = fromSquare(squares[i]);
      if (Math.abs(q.file - p.file) === 2) position.board.delete(toSquare((p.file + q.file) / 2, (p.rank + q.rank) / 2));
    }
    const last = squares[squares.length - 1];
    position.board.set(last, { color: man.color, king: man.king || crownsOn(man, last) });
    position.turn = man.color === 'w' ? 'b' : 'w';

    return {
      state: formatCheckers(position),
      // PDN: `11-15` for a step, `9x18x27` naming every landing of a jump.
      notation: squares.map((s) => pdnNumber(s)).join(capture ? 'x' : '-'),
      // Every square stood on, in board names: `c3d4`, `g3e5c7`. The replay
      // reads the hops back out of it.
      uci: squares.join(''),
      from: path.from,
      to: last,
    };
  },

  /** The side to move with no legal move (no pieces is the same) loses. */
  ending(state: string): GameEnd | null {
    const position = parseCheckers(state);
    if (sideCanMove(position.board, position.turn)) return null;
    return { outcome: position.turn === 'w' ? '0-1' : '1-0', reason: 'no_moves' };
  },

  /** A fallen flag loses: unlike chess, there is no material that cannot win. */
  timeout(_state: string, flagged: Color): GameEnd {
    return { outcome: flagged === 'w' ? '0-1' : '1-0', reason: 'timeout' };
  },

  writeRecord: (report) => buildPdn(report),
  recordFileName: (report) => pdnFileName(report),

  /**
   * With jumps required, a piece with a plain move is refused when another
   * can jump: say so, or the refusal reads as "this piece is stuck" while it
   * plainly is not (stage 11.3).
   */
  whyStuck(state: string, from: Square, options: GameOptions): string | null {
    if (!jumpsRequired(options)) return null;
    const position = parseCheckers(state);
    const man = position.board.get(from);
    if (man === undefined || man.color !== position.turn) return null;
    if (!sideCanJump(position.board, man.color)) return null;
    return `Jumps are required, and another of your pieces can jump, so the piece on ${from} cannot move. Pick up a piece that can jump.`;
  },
};
