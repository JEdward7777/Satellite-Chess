/**
 * The server's rules for each game (decision 0056). The Worker bundles every
 * game's engine statically: size does not matter here, and an engine fetched
 * on demand would be a second thing to go wrong mid-move.
 */

import { type GameRules, type GameType, parseGameType } from '../../shared/games/types.js';
import { CHESS_RULES } from './chess.js';

const RULES: Record<GameType, GameRules> = {
  chess: CHESS_RULES,
};

/**
 * The rules for a stored or requested type: absent is chess, and a name this
 * build does not know is null — a game the server cannot judge refuses its
 * moves rather than being played as chess.
 */
export function rulesFor(value: unknown): GameRules | null {
  const type = parseGameType(value);
  return type === null ? null : RULES[type];
}
