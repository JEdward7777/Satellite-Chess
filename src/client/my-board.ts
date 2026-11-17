/**
 * The board this phone plays on, asked of one place (stage 12.2, decisions
 * 0060 and 0061).
 *
 * In a same-field game that is the game's field, exactly as it always was. In
 * a remote game it is **the player's own field, shrunk to the shared square**
 * (`playableBoard(field, remote.squareM)`, the same arithmetic the server's
 * `GameDO.boardFor` uses), so the reach circle, the back rank, the squares a
 * tap lands on and the dot under foot are all judged on the board the server
 * judges by. Everything on the board screen that needs a board asks
 * {@link myBoard}; nothing else in the client says `remote`, apart from the
 * words that tell the player about it.
 *
 * Two more things come from here because they only make sense against that
 * board:
 *
 * - **The outline.** A shrunk board sits inside the field that was tapped out,
 *   and the field is drawn round it (0060 point 7), so it is obvious why the
 *   board does not reach the corners somebody walked to.
 * - **The opponent.** In a remote game they arrive as squares (`opp_spot`,
 *   `PlayerView.spot`), and are put on the same squares of *this* board: a
 *   player on a1 is drawn on a1 here, wherever that is on this ground.
 */

import {
  type FieldGeometry,
  SMALL_SQUARE_M,
  boardPointOfIndex,
  fromBoardPoint,
  geometryFromSnapshot,
} from '../shared/field.js';
import type { LatLng } from '../shared/geo.js';
import type { GameSnapshot } from '../shared/protocol.js';
import { playableBoard } from '../shared/remote.js';
import type { WatchSpot } from '../shared/watch.js';

export interface MyBoard {
  /** The board to draw and judge on. */
  geo: FieldGeometry;
  /**
   * The field as it was calibrated, when {@link geo} has been shrunk from it;
   * null when the board is the whole field, which is every same-field game and
   * the smaller field of a remote one.
   */
  outline: FieldGeometry | null;
  /** The shared square in a remote game, in meters; null in a same-field one. */
  sharedSquareM: number | null;
  /**
   * The board's narrower step is under {@link SMALL_SQUARE_M}. Only ever true
   * in a remote game: a same-field board was warned about when it was
   * calibrated, and a shrink matches *mean* squares, so a long, thin field can
   * come out narrower than its own calibration promised (the owner's rule,
   * 2026-11-01: say so with the warning there already is, add no floor).
   */
  smallSquares: boolean;
}

/**
 * One per snapshot. The board screen asks for the board several times a paint
 * and up to ten paints a second, and a snapshot never changes once it has
 * arrived, so the answer is worked out once per snapshot.
 */
const known = new WeakMap<object, MyBoard>();

/**
 * The board this phone plays on in this game. Throws, as
 * `geometryFromSnapshot` does, for a field that describes no board.
 */
export function myBoard(game: Pick<GameSnapshot, 'field' | 'remote'>): MyBoard {
  const cached = known.get(game);
  if (cached !== undefined) return cached;
  const squareM = game.remote?.squareM;
  const geo = playableBoard(game.field, squareM);
  // `shrinkBoard` hands back the board itself when there is nothing to shrink.
  const outline = squareM === undefined ? null : geometryFromSnapshot(game.field);
  const shrunk = outline !== null && outline.meanSquareM > geo.meanSquareM;
  const board: MyBoard = {
    geo,
    outline: shrunk ? outline : null,
    sharedSquareM: squareM ?? null,
    smallSquares: squareM !== undefined && Math.min(geo.fileM, geo.rankM) < SMALL_SQUARE_M,
  };
  known.set(game, board);
  return board;
}

/**
 * Where a square of board space is on this board, as a place on this ground:
 * the opponent of a remote game, put on the squares they are on.
 */
export function spotOnBoard(geo: FieldGeometry, spot: WatchSpot): LatLng {
  return fromBoardPoint(geo, boardPointOfIndex(geo, spot));
}
