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
 * for drawing it: absent is chess.
 *
 * A name this build does not know still draws as chess, for now. Since stage
 * 11.2 a server can hold a second game (checkers), and since then it sends a
 * stored type it has no rules for as it is, rather than leaving it out; so a
 * phone left on older code by the service worker can meet a name it does not
 * know, and this is where it must learn to say "this game needs the app to
 * update" instead (stage 11.3, decision 0056). The server never draws, and
 * refuses a type it does not know (`worker/games/`).
 */
export function descriptorFor(value: unknown): GameDescriptor {
  return DESCRIPTORS[parseGameType(value) ?? DEFAULT_GAME_TYPE];
}
