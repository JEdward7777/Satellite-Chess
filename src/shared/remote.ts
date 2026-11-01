/**
 * A remote game: two fields, one square size, and only board space between
 * them (stage 12, decision 0060, O-32).
 *
 * In an ordinary game both players stand on one field and the game holds that
 * field. In a remote game **each seat brings its own field**, and the two
 * fields are made fair by one number: the shared square, `s`, the smaller of
 * the two fields' `meanSquareM`. The larger field's board is shrunk by one
 * uniform factor about its own center, so its shape and orientation are kept
 * and its mean square becomes `s`. Reach in meters is derived from the
 * board's `meanSquareM`, which is then `s` on both boards, so a move is the
 * same number of meters for both players without a single rule in
 * `reach.ts` knowing that there are two fields.
 *
 * **This file is the arithmetic of the seam.** {@link shrinkBoard} is the one
 * shrink. The server applies it to both seats at once (`GameDO.boards`, from
 * which every judgement of a move, a waypoint or the back rank takes the
 * mover's own board through `GameDO.boardFor`); {@link playableBoard} is the
 * same step for one field, the entry point for the phone (stage 12.2, with
 * the snapshot's `field` and `remote.squareM`) and for tests, so both ends
 * shrink by the same arithmetic. Given no square size it returns
 * `geometryFromSnapshot` exactly, which is every same-field game.
 *
 * What crosses between the two players is board space and nothing else: the
 * receiver's own field goes to the receiver, the shared square goes to both,
 * and the opponent's position arrives as squares (`watchSpot`, the same
 * projection a watcher is given). Never the other field, its name, or a
 * latitude.
 */

import { add, fromLocal, scale } from './geo.js';
import {
  type FieldGeometry,
  type FieldSnapshot,
  boardDiagonalM,
  boardSizeM,
  geometryFromSnapshot,
} from './field.js';

/**
 * What a remote game's snapshot says about the game being remote. Present
 * only in a remote game, so a same-field snapshot is what it always was.
 */
export interface RemoteView {
  /**
   * The shared square, in meters: the smaller field's `meanSquareM`, and the
   * receiver's playable board is shrunk to it (decision 0060). Before the
   * second seat is taken it is the one field there is.
   */
  squareM: number;
}

/**
 * The shared square: the smallest `meanSquareM` of the boards given, which is
 * one field before anybody has joined and two after.
 */
export function sharedSquareM(boards: readonly Pick<FieldGeometry, 'meanSquareM'>[]): number {
  let s = Infinity;
  for (const board of boards) {
    if (Number.isFinite(board.meanSquareM) && board.meanSquareM > 0) s = Math.min(s, board.meanSquareM);
  }
  if (!Number.isFinite(s)) throw new Error('no usable board to take a square size from');
  return s;
}

/**
 * A board shrunk about its own center so that its mean square is `squareM`.
 *
 * One factor for both axes, so the board keeps its shape (a 12 × 6 m board
 * stays twice as long one way as the other) and its bearing; the center of
 * the board, index (3.5, 3.5), stays where it is on the ground. A board whose
 * mean square is already `squareM` or smaller is returned as it is — the
 * smaller field is never enlarged, and is the board `s` came from.
 *
 * `meanSquareM` is set to `squareM` exactly rather than recomputed, so the
 * reach on the shrunk board is to the bit the reach on the other one.
 */
export function shrinkBoard(geo: FieldGeometry, squareM: number): FieldGeometry {
  if (!(squareM > 0) || !(squareM < geo.meanSquareM)) return geo;
  const k = squareM / geo.meanSquareM;
  // In the tangent plane at the old a1: the center is 3.5 steps along each
  // axis, and the new a1 is 3.5 shrunk steps back from it.
  const diagonal = add(geo.fileStep, geo.rankStep);
  const origin = fromLocal(geo.origin, scale(diagonal, 3.5 * (1 - k)));
  const fileStep = scale(geo.fileStep, k);
  const rankStep = scale(geo.rankStep, k);
  return {
    origin,
    fileM: geo.fileM * k,
    rankM: geo.rankM * k,
    meanSquareM: squareM,
    axisAngleDeg: geo.axisAngleDeg,
    bearingDeg: geo.bearingDeg,
    fileStep,
    rankStep,
    uHat: geo.uHat,
    vHat: geo.vHat,
    inv: { a: geo.inv.a / k, b: geo.inv.b / k, c: geo.inv.c / k, d: geo.inv.d / k },
  };
}

/**
 * The board a player plays on: their field, shrunk to the shared square in a
 * remote game. **With no square size it is the field's own board**, exactly
 * `geometryFromSnapshot`, which is every same-field game. Throws, as that
 * does, for a field that describes no board.
 */
export function playableBoard(field: FieldSnapshot, squareM?: number): FieldGeometry {
  const geo = geometryFromSnapshot(field);
  return squareM === undefined ? geo : shrinkBoard(geo, squareM);
}

/**
 * The board a remote game is described by wherever it is told to both
 * players or to nobody in particular — the report, the archive, the record
 * file, a watcher's view: eight shared squares a side. Neither field's shape
 * or size is in it, only `s`, which both players already have.
 */
export function sharedBoardFigures(squareM: number): { squareM: number; boardM: number; diagonalM: number } {
  return { squareM, boardM: 8 * squareM, diagonalM: 8 * squareM * Math.SQRT2 };
}

/** The same figures for one real board, as a same-field game reports them. */
export function boardFigures(geo: FieldGeometry): { squareM: number; boardM: number; diagonalM: number } {
  return {
    // The narrower step, as `checkCalibration` judges it: a board with 12 m
    // files and 3 m ranks is as ambiguous as a 3 m board.
    squareM: Math.min(geo.fileM, geo.rankM),
    boardM: boardSizeM(geo),
    diagonalM: boardDiagonalM(geo),
  };
}
