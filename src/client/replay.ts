/**
 * The replay's half that is not drawing (stage 8.3, decision 0052): which
 * position, which carry and which walks belong to a ply, and the words beside
 * them.
 *
 * Pure, and read only from a {@link GameReport}, so it says the same thing for
 * a live finished game and for one read back from the archive — the report is
 * the only thing both have — and it needs no network once the report is held.
 * Scrubbing sends nothing.
 *
 * **No rules engine.** The positions are the report's moves applied in order
 * by `applyMoveToFen`, as the board's own prediction does: every move in a
 * report was judged legal by the server when it was played, so all that is
 * needed is to move the pieces, including castling's rook, an en passant
 * capture and a promotion. chess.js stays out of the bundle (`optimistic.ts`
 * says why).
 *
 * Everything is in squares from a1's centre. Nothing here is a distance: on a
 * board that is not square a step along a file and a step along a rank are
 * different lengths (`ReportPosition`), so the only meters shown are the ones
 * the game measured on the ground and put in the report.
 */

import type { GameReport, ReportMove, ReportPosition } from '../shared/review.js';
import { type Color, type Square, toSquare } from '../shared/squares.js';
import { isCarryingTag, plyOfTag } from '../shared/track.js';
import type { Units } from '../shared/units.js';
import { applyMoveToFen } from './optimistic.js';
import { colorWords, moveWords } from './review.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** A place on the board, in squares from a1's centre. */
export interface Spot {
  file: number;
  rank: number;
}

/** Everything the replay shows at one ply. */
export interface ReplayFrame {
  /** 0 is the starting position; `n` is after the report's `n`th move. */
  ply: number;
  /** How far the scrubber goes. */
  plies: number;
  fen: string;
  /** The move that made this position, or null at the start. */
  move: ReportMove | null;
  /**
   * That move's carry: from the lift, through every fix sent while the piece
   * was in hand, to the place. Null at the start, and for a move with neither
   * fix stored.
   */
  carry: Spot[] | null;
  /** Where the mover walked to reach the piece during this move. */
  approach: Spot[];
  /** Where the other player walked while this move was being made. */
  waiting: Spot[];
  /** Each player's walk before this move, for the faint trail under it. */
  earlier: Record<Color, Spot[][]>;
}

/**
 * Every position, from the start to the last move that could be applied.
 *
 * A move that names an empty square stops the list there rather than drawing
 * a board nobody played. It cannot happen with a report the game built, which
 * only ever holds moves it judged legal.
 */
export function replayFens(report: GameReport): string[] {
  const fens = [START_FEN];
  let fen = START_FEN;
  for (const move of report.moves) {
    const promotion = promotionOf(move.uci);
    const next = applyMoveToFen(fen, move.from, move.to, promotion);
    if (next === fen) break;
    fen = next;
    fens.push(fen);
  }
  return fens;
}

function promotionOf(uci: string): 'q' | 'r' | 'b' | 'n' | undefined {
  const p = uci.slice(4, 5).toLowerCase();
  return p === 'q' || p === 'r' || p === 'b' || p === 'n' ? p : undefined;
}

/** A scrubber value, made a ply that exists. */
export function clampPly(ply: number, plies: number): number {
  if (!Number.isFinite(ply)) return 0;
  return Math.min(Math.max(0, Math.round(ply)), Math.max(0, plies));
}

/**
 * One ply, read out of a report. `fens` is {@link replayFens}'s answer, passed
 * in so a scrub does not replay the game from the start on every step.
 */
export function replayFrame(report: GameReport, fens: readonly string[], ply: number): ReplayFrame {
  const plies = Math.max(0, fens.length - 1);
  const at = clampPly(ply, plies);
  const move = at === 0 ? null : (report.moves[at - 1] ?? null);
  const tracks = report.tracks ?? null;

  const approach: Spot[] = [];
  const carried: Spot[] = [];
  const waiting: Spot[] = [];
  const earlier: Record<Color, Spot[][]> = { w: [], b: [] };

  if (tracks !== null && move !== null) {
    const mine: { tag: number; spot: Spot }[] = [];
    for (const color of ['w', 'b'] as const) {
      // Earlier fixes are one line per ply, so the faint trail does not join
      // the end of one move to the start of the next across a gap in the
      // relay — the line between two fixes is only drawn where they were sent
      // one after the other within a move.
      let line: Spot[] = [];
      let lineTag = -1;
      for (const [tag, file, rank] of tracks[color]) {
        const fixPly = plyOfTag(tag);
        const spot = { file, rank };
        if (fixPly < at) {
          if (tag >> 1 !== lineTag) {
            if (line.length > 0) earlier[color].push(line);
            line = [];
            lineTag = tag >> 1;
          }
          line.push(spot);
        } else if (fixPly === at) {
          if (color !== move.color) waiting.push(spot);
          else mine.push({ tag, spot });
        }
      }
      if (line.length > 0) earlier[color].push(line);
    }
    // The carry is what was in hand after the *last* time empty-handed: a
    // piece picked up and put back, then another lifted, is a walk with a
    // piece in it followed by the move's own carry, and only the second is
    // the move's.
    let lastEmpty = -1;
    mine.forEach((fix, index) => {
      if (!isCarryingTag(fix.tag)) lastEmpty = index;
    });
    mine.forEach((fix, index) => {
      if (index > lastEmpty && isCarryingTag(fix.tag)) carried.push(fix.spot);
      else approach.push(fix.spot);
    });
  }

  return {
    ply: at,
    plies,
    fen: fens[at] ?? START_FEN,
    move,
    carry: move === null ? null : carryPath(move, approach, carried),
    approach,
    waiting,
    earlier,
  };
}

/**
 * The carry as a line: the lift, every fix in hand, the place.
 *
 * The lift is the move's own lift fix when it was stored, which is the same
 * point as the last fix of the approach (a lift's fix is appended to the walk
 * before its carry exists). Where it was not, the walk is all there is. The
 * place is the same fix as the last one in hand, so it is not added twice.
 */
function carryPath(move: ReportMove, approach: readonly Spot[], carried: readonly Spot[]): Spot[] | null {
  const path: Spot[] = [];
  const lift = move.lift ?? approach[approach.length - 1] ?? null;
  if (lift !== null) path.push({ file: lift.file, rank: lift.rank });
  for (const spot of carried) path.push(spot);
  if (move.place !== null) {
    // The track holds the place's fix rounded to a hundredth of a square, so
    // the same fix is "the same" to within that grain, and the exact one wins.
    const last = path[path.length - 1];
    const same =
      last !== undefined &&
      Math.abs(last.file - move.place.file) <= 0.006 &&
      Math.abs(last.rank - move.place.rank) <= 0.006;
    if (same) path.pop();
    path.push({ file: move.place.file, rank: move.place.rank });
  }
  return path.length === 0 ? null : path;
}

/** Whether a report has any walk in it at all — for the note that says it does not. */
export function hasWalks(report: GameReport): boolean {
  const tracks = report.tracks ?? null;
  return tracks !== null && (tracks.w.length > 0 || tracks.b.length > 0);
}

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

/**
 * The square a position is on, or null for one off the board.
 *
 * A square is everything within half a square of its centre, so the answer
 * is the nearest centre: the point is inside the square this names, always.
 * The board's far edges are open (`7.5` is off it), the near ones closed,
 * so a point on a line between two squares names exactly one of them.
 */
export function squareAt(spot: Spot): Square | null {
  const { file, rank } = spot;
  if (!Number.isFinite(file) || !Number.isFinite(rank)) return null;
  if (file < -0.5 || file >= 7.5 || rank < -0.5 || rank >= 7.5) return null;
  // floor(x + 0.5), not Math.round: the same answer, and -0.5 stays a1 rather
  // than becoming the -0 that Math.round would hand `toSquare`.
  return toSquare(Math.floor(file + 0.5), Math.floor(rank + 0.5));
}

/** "standing on e3", "standing off the board", "no fix stored". */
export function standingWords(at: ReportPosition | null): string {
  if (at === null) return 'no fix stored';
  const square = squareAt(at);
  return square === null ? 'standing off the board' : `standing on ${square}`;
}

/**
 * The line over the board: "Step 3 of 4 · 2. g4". A step, not a move: in a
 * chess move list "2." is a move, and "Move 3 of 4" beside it would read as
 * two different numberings of the same thing.
 */
export function replayHeadWords(frame: ReplayFrame): string {
  if (frame.move === null) {
    return frame.plies === 0
      ? 'The start · nobody moved'
      : `The start · ${frame.plies} step${frame.plies === 1 ? '' : 's'} to go through`;
  }
  const number = Math.floor((frame.move.seq - 1) / 2) + 1;
  const dots = frame.move.color === 'w' ? '.' : '…';
  return `Step ${frame.ply} of ${frame.plies} · ${number}${dots} ${frame.move.san}`;
}

/**
 * What the carry was, under the board: who, from where, how far, to where.
 *
 * The distance is the move list's own words for it (`moveWords`), so the
 * replay and the list cannot show two figures for one carry. It is the
 * distance the game measured between the two fixes on the ground, not a
 * length read off this drawing — the drawing is in squares, which on a board
 * that is not square are not one length.
 */
export function carryWords(
  move: ReportMove | null,
  units: Units = 'metric',
): { who: string; lift: string; carried: string; place: string } | null {
  if (move === null) return null;
  return {
    who: `${colorWords(move.color)} moved ${move.from} to ${move.to}`,
    lift: `Picked up ${standingWords(move.lift)}`,
    carried: capitalize(moveWords(move, units).detail),
    place: `Put down ${standingWords(move.place)}`,
  };
}

/** The note under the board: what the lines are, or why there are none. */
export function walkNoteWords(report: GameReport): string {
  if (!hasWalks(report)) {
    return (
      'Walks were not kept for this game, so each carry is drawn straight from ' +
      'where the piece was picked up to where it was put down.'
    );
  }
  return (
    'Solid: the carry, from where the piece was picked up to where it was put ' +
    'down. Dashed: the walk to the piece. Dotted: the other player meanwhile. ' +
    'Faint: earlier moves. Drawn from the positions the phones sent during play.'
  );
}

function capitalize(text: string): string {
  return text === '' ? text : text[0]!.toUpperCase() + text.slice(1);
}
