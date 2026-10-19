/**
 * Every game's descriptor, by type (decision 0056).
 *
 * Small on purpose and statically imported by both runtimes: a descriptor is
 * metadata and an engine-free position codec, a few hundred bytes a game. What
 * is heavy stays behind its own door — the rules engine on the server only
 * (`worker/games/`), the piece art and record writer fetched by the phone on
 * demand (`client/games/`).
 */

import { CHECKERS } from './checkers.js';
import { CHESS } from './chess.js';
import type { Color } from '../squares.js';
import { DEFAULT_GAME_TYPE, type GameDescriptor, type GameType, parseGameType } from './types.js';

const DESCRIPTORS: Record<GameType, GameDescriptor> = {
  chess: CHESS,
  checkers: CHECKERS,
};

/** A game's descriptor. */
export function descriptorOf(type: GameType): GameDescriptor {
  return DESCRIPTORS[type];
}

/**
 * The descriptor for a type as it arrived on a snapshot, a report or a row,
 * for drawing it: absent is chess. **Null for a name this build does not
 * know** (decision 0058): since stage 11.2 a server sends a stored type as it
 * is, so a phone left on older code by the service worker can meet a game
 * that is newer than it. Drawing that as chess would show a board of the
 * wrong pieces and predict moves by the wrong codec; the phone says
 * {@link UPDATE_APP_WORDS} instead. The server never draws, and refuses a type
 * it does not know (`worker/games/`).
 */
export function descriptorFor(value: unknown): GameDescriptor | null {
  const type = parseGameType(value);
  return type === null ? null : DESCRIPTORS[type];
}

/** Said wherever a game arrives whose type this build does not know. */
export const UPDATE_APP_WORDS =
  'This game is one this version of the app does not know. Close the app and open it again to update it.';

/**
 * What a seat is called in a game, for every sentence a player reads
 * (decision 0058): chess's `w` is White, checkers' `w` is Black. A type this
 * build does not know names its seats as chess does, which is only ever
 * words beside the update notice.
 */
export function seatName(value: unknown, color: Color): string {
  return (descriptorFor(value) ?? DESCRIPTORS[DEFAULT_GAME_TYPE]).seats[color].name;
}

/** Whether a seat plays the dark pieces in a game, for inks that follow the pieces. */
export function seatIsDark(value: unknown, color: Color): boolean {
  return (descriptorFor(value) ?? DESCRIPTORS[DEFAULT_GAME_TYPE]).seats[color].dark;
}

/** "Checkers", or null for chess, which every label leaves unsaid as it always has. */
export function gameLabel(value: unknown): string | null {
  const game = descriptorFor(value);
  if (game === null) return 'A newer game';
  return game.type === DEFAULT_GAME_TYPE ? null : game.name;
}
