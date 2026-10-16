/**
 * A game of checkers as a PDN file (Portable Draughts Notation; decision
 * 0057), the checkers counterpart of `shared/pgn.ts`, and built the same way
 * from a {@link GameReport} alone (decision 0041).
 *
 * - **It opens in a draughts program.** Standard tag pairs with `GameType
 *   "21"` (American checkers), and standard movetext: squares numbered 1–32,
 *   `11-15` for a move and `9x18x27` for a jump, naming every landing.
 * - **It records the walk as well**, where PDN lets a reader ignore it: tag
 *   pairs outside the standard set and `{}` comments after each move. A
 *   walked jump's waypoints are in its comment, as `via`.
 * - **Board space only**, never a latitude (decision 0041), as for the PGN.
 *
 * The `w` seat plays the dark pieces and moves first (decision 0057), so PDN's
 * `1-0` is the dark pieces winning, and each move number comes before a dark
 * move — the order the PGN writer already numbers in.
 *
 * Whether jumps were required is a creation setting that changes what was
 * legal, so it is a tag (`SatelliteJumpsRequired`): a reader of the file must
 * be able to tell a skipped capture from a mistake.
 */

import { jumpsRequired } from './games/checkers.js';
import {
  escapeTag,
  meters,
  moveText,
  pgnDate,
  pgnTime,
  position,
  resultToken,
  seconds,
  slug,
  termination,
  timeControl,
} from './pgn.js';
import type { GameReport, ReportMove } from './review.js';

/** What the `Event` tag says. */
export const PDN_EVENT = 'Satellite Checkers';

/** PDN's number for American checkers (English draughts). */
export const PDN_GAME_TYPE = '21';

/** The legend, as a comment before the first move: positions are not PDN squares. */
export const PDN_LEGEND =
  'Positions are board squares from the center of square 4 (the corner on the left of the side that moves first), ' +
  'as files across,ranks forward. ' +
  "Distances are meters walked on the ground, as each player's phone measured them, " +
  "and never less than the sum of that player's carries.";

export interface PdnOptions {
  /** Overridden in tests. */
  now?: number;
}

/** The whole file: tag pairs, a blank line, movetext, a trailing newline. */
export function buildPdn(report: GameReport, options: PdnOptions = {}): string {
  const tags = tagPairs(report, options.now ?? Date.now());
  const head = tags.map(([name, value]) => `[${name} "${escapeTag(value)}"]`).join('\n');
  return `${head}\n\n${moveText(report, PDN_LEGEND, pdnMoveComment)}\n`;
}

/**
 * The tag pairs. `Black` and `White` are `?` for the reason the PGN's are
 * (decision 0040): no names travel in a file that gets shared.
 */
function tagPairs(report: GameReport, now: number): [string, string][] {
  const started = new Date(report.startedAt > 0 ? report.startedAt : now);
  const tags: [string, string][] = [
    ['Event', PDN_EVENT],
    ['Site', report.fieldName ?? '?'],
    ['Date', pgnDate(started)],
    ['Round', '-'],
    // The side that moves first, first.
    ['Black', '?'],
    ['White', '?'],
    ['Result', resultToken(report)],
    ['GameType', PDN_GAME_TYPE],
  ];
  tags.push(['UTCDate', pgnDate(started)], ['UTCTime', pgnTime(started)]);
  tags.push(['TimeControl', timeControl(report)]);
  tags.push(['SatelliteJumpsRequired', jumpsRequired(report.options) ? 'yes' : 'no']);
  if (report.reason !== null) {
    tags.push(['Termination', termination(report.reason)]);
    tags.push(['SatelliteEnd', report.reason]);
  }
  tags.push(['SatelliteBoardM', meters(report.boardM)]);
  tags.push(['SatelliteSquareM', meters(report.squareM)]);
  // As the PGN: left out rather than a zero where nobody measured it.
  if (report.travelM.w !== null) tags.push(['SatelliteBlackWalkedM', meters(report.travelM.w)]);
  if (report.travelM.b !== null) tags.push(['SatelliteWhiteWalkedM', meters(report.travelM.b)]);
  return tags;
}

/**
 * One move's walk: the carry (every leg, lift to place), the lift, each
 * waypoint, the place. Null for a move with nothing to say.
 */
export function pdnMoveComment(move: ReportMove): string | null {
  const parts: string[] = [];
  if (move.carriedM > 0 || move.carriedMs > 0) {
    parts.push(`carry ${meters(move.carriedM)} m in ${seconds(move.carriedMs)} s`);
  }
  if (move.lift !== null) parts.push(`lift ${position(move.lift)}`);
  for (const stop of move.via ?? []) {
    if (stop !== null) parts.push(`via ${position(stop)}`);
  }
  if (move.place !== null) parts.push(`place ${position(move.place)}`);
  if (parts.length === 0) return null;
  return `{${parts.join('; ')}}`;
}

/** What to call the file: the date and the field's own name, never the code. */
export function pdnFileName(report: Pick<GameReport, 'fieldName' | 'startedAt'>): string {
  const date = new Date(report.startedAt > 0 ? report.startedAt : Date.now());
  const day = pgnDate(date).replace(/\./g, '-');
  const where = slug(report.fieldName ?? '');
  return `satellite-checkers-${day}${where === '' ? '' : `-${where}`}.pdn`;
}
