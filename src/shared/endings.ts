/**
 * Ending a game early: resign, a draw by agreement, and abort (stage 10.11,
 * decision 0050).
 *
 * Shared because both ends ask the same questions. The server's answer is the
 * only one that counts; the phone asks so it never offers a button the server
 * is about to refuse. The rules are here, in one place, rather than spelled
 * once in `GameDO` and again in `views/game.ts` where the two could drift.
 *
 * ## Why abort exists at all (O-50)
 *
 * The owner started a game on a field that turned out to be unplayable, and
 * it sat on the list for good. Resign ends a game with a result: somebody lost,
 * and it counts. That is right for a game that was played and is wrong for one
 * that never really began. An **aborted** game ends with **no result**, writes
 * nothing to either player's record, and can be tidied off the list.
 *
 * ## The one rule worth getting right
 *
 * Either player may abort **alone** until each side has made its first move
 * ({@link ABORT_ALONE_BEFORE_PLIES}), which covers a handshake that never
 * completed. After that, only both together: one offers, the other accepts.
 * Otherwise abort would be a resignation that costs nothing, and a losing
 * player's best move would be to press it — the incentive decision 0025
 * exists to remove. The stuck player alone after that point can still resign.
 */

import type { GameStatus } from './protocol.js';

/**
 * How many plies may be on the board before an abort needs both players.
 *
 * Two: White's first move and Black's. The same line lichess draws, and for
 * the same reason — until both sides have moved, neither has anything to lose
 * that an abort could take from them.
 */
export const ABORT_ALONE_BEFORE_PLIES = 2;

/** Whether the game is over, with a result or without one. */
export function isOver(status: GameStatus): boolean {
  return status === 'finished' || status === 'aborted';
}

/**
 * Whether a player may resign now.
 *
 * Active or suspended — **including while the opponent is gone**, which is the
 * stuck case: nobody else is needed. Not while staging: nobody has moved, so
 * there is nothing to concede, and abort is the way out there.
 */
export function canResign(status: GameStatus): boolean {
  return status === 'active' || status === 'suspended';
}

/** Whether a draw may be offered, accepted or declined now. The same states as resign. */
export function canOfferDraw(status: GameStatus): boolean {
  return status === 'active' || status === 'suspended';
}

/**
 * Whether a game in this state can be aborted at all, alone or together.
 *
 * Not `waiting`: nobody has joined, the code evaporates by itself in half an
 * hour, and the row can already be tidied away. Not a game that is over.
 */
export function canAbort(status: GameStatus): boolean {
  return status === 'staging' || status === 'active' || status === 'suspended';
}

/** Whether one player may abort on their own, with no agreement needed. */
export function abortsAlone(status: GameStatus, plies: number): boolean {
  return canAbort(status) && plies < ABORT_ALONE_BEFORE_PLIES;
}
