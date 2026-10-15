/**
 * Every game's descriptor, by type (decision 0056).
 *
 * Small on purpose and statically imported by both runtimes: a descriptor is
 * metadata and an engine-free position codec, a few hundred bytes a game. What
 * is heavy stays behind its own door — the rules engine on the server only
 * (`worker/games/`), the piece art and record writer fetched by the phone on
 * demand (`client/games/`).
 */

import { CHESS } from './chess.js';
import { DEFAULT_GAME_TYPE, type GameDescriptor, type GameType, parseGameType } from './types.js';

const DESCRIPTORS: Record<GameType, GameDescriptor> = {
  chess: CHESS,
};

/** A game's descriptor. */
export function descriptorOf(type: GameType): GameDescriptor {
  return DESCRIPTORS[type];
}

/**
 * The descriptor for a type as it arrived on a snapshot, a report or a row,
 * for drawing it: absent is chess.
 *
 * A name this build does not know also draws as chess, for now, because chess
 * is the only game there is: no server can send another yet. When a second
 * game ships (phase 4 of run 3), a phone left on older code by the service
 * worker can meet one, and this is where it must learn to say "this game needs
 * the app to update" instead (decision 0056). The server never draws, and
 * refuses a type it does not know (`worker/games/`).
 */
export function descriptorFor(value: unknown): GameDescriptor {
  return DESCRIPTORS[parseGameType(value) ?? DEFAULT_GAME_TYPE];
}
