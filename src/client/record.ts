/**
 * The phone's half of the permanent record (stage 2.3.5): one request, and the
 * words the record screen is made of.
 *
 * Like `games.ts`, there is no store here and nothing to merge. The record is
 * the account's, written by games and by nothing else (decision 0040), so the
 * phone reads it and never writes it — and like `games.ts`, **a read never
 * rejects**. The record is something to look at; a phone with no signal says
 * so and carries on.
 *
 * The words live here rather than in the view so that they can be tested in
 * node, which is where every sentence a player reads ought to be checked for
 * saying what it means.
 */

import type { RecordLine, RecordSummary } from '../shared/record.js';
import { reasonWords } from './views/games.js';

/** What a read came back with. */
export type RecordResult =
  | { kind: 'ok'; record: RecordSummary }
  | { kind: 'signed_out' }
  /** No signal, or an answer that is not a record. */
  | { kind: 'unavailable' };

export interface RecordTransport {
  read(): Promise<RecordResult>;
}

export function browserRecordTransport(): RecordTransport {
  return {
    async read() {
      try {
        const response = await fetch('/api/record', { headers: { accept: 'application/json' } });
        if (response.status === 401) return { kind: 'signed_out' };
        if (!response.ok) return { kind: 'unavailable' };
        const body = (await response.json()) as { record?: RecordSummary };
        const record = body.record;
        if (typeof record !== 'object' || record === null || typeof record.totals !== 'object') {
          return { kind: 'unavailable' };
        }
        return { kind: 'ok', record };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}

/**
 * A distance as the headline says it: "840 m", "2.4 km", "126 km".
 *
 * Metric (decision 0036). One decimal under a hundred kilometers, because
 * "2.4 km" is the thing people repeat to their friends and "2.43 km" is a
 * reading off an instrument.
 */
export function distanceWords(meters: number): string {
  const m = Number.isFinite(meters) && meters > 0 ? meters : 0;
  if (m < 1000) return `${Math.round(m)} m`;
  const km = m / 1000;
  return km < 100 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/** "3.1 board crossings", "1 board crossing", "no board crossings yet". */
export function crossingsWords(crossings: number): string {
  if (!(crossings > 0)) return 'no board crossings yet';
  const shown = crossings < 10 ? crossings.toFixed(1) : String(Math.round(crossings));
  return `${shown} board crossing${shown === '1.0' || shown === '1' ? '' : 's'}`;
}

/** "3 games", "1 game". */
export function gamesWords(games: number): string {
  return `${games} game${games === 1 ? '' : 's'}`;
}

/** "3 won · 1 drawn · 2 lost". */
export function resultsWords(totals: Pick<RecordSummary['totals'], 'wins' | 'draws' | 'losses'>): string {
  return `${totals.wins} won · ${totals.draws} drawn · ${totals.losses} lost`;
}

/**
 * The line under the headline, which says what the headline was made of — and
 * which games were left out of it, because a total that silently omits games
 * reads as a total that lost them.
 */
export function coverageWords(record: RecordSummary): string {
  const counted = record.totals.games;
  const parts = [
    counted === 0
      ? 'No finished games count yet.'
      : `Walked across ${gamesWords(counted)}, ${crossingsWords(record.totals.crossings)}.`,
  ];
  if (record.practiceGames > 0) {
    parts.push(
      `${countWords(record.practiceGames)} on squares under ${record.smallSquareM} m ` +
        `${record.practiceGames === 1 ? 'is' : 'are'} kept as practice and not counted.`,
    );
  }
  if (record.unplayedGames > 0) {
    parts.push(
      `${countWords(record.unplayedGames)} that ended before anyone moved ` +
        `${record.unplayedGames === 1 ? 'is' : 'are'} not counted.`,
    );
  }
  if (record.unmeasuredGames > 0) {
    const one = record.unmeasuredGames === 1;
    parts.push(
      `${countWords(record.unmeasuredGames)} played before the app measured ` +
        `distance per game ${one ? 'has' : 'have'} no distance to count, so ` +
        `${one ? 'it is' : 'they are'} listed without one.`,
    );
  }
  return parts.join(' ');
}

/** "One game" / "3 games" — the subject of a sentence, so it leads with a word. */
function countWords(n: number): string {
  return n === 1 ? 'One game' : `${n} games`;
}

/** One line of history: "Riverside Park" over "Won — checkmate · 840 m". */
export function lineWords(line: RecordLine): { title: string; detail: string } {
  const verdict = line.result === 'win' ? 'Won' : line.result === 'loss' ? 'Lost' : 'Drawn';
  const counted =
    line.standing === 'counted'
      ? distanceWords(line.travelM ?? 0)
      : line.standing === 'practice'
        ? `practice, not counted — ${line.squareM.toFixed(1)} m squares`
        : line.standing === 'unmeasured'
          ? 'distance was not measured for this game'
          : 'nobody moved, not counted';
  return {
    title: line.fieldName ?? 'Unnamed field',
    detail: `${verdict} — ${reasonWords(line.reason)} · ${counted}`,
  };
}

/** "Sep 19", or "Sep 19, 2025" outside the current year. */
export function dateWords(at: number, now: number = Date.now()): string {
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/**
 * How the distance was measured, and how far to trust it. Observations O-03
 * and O-12, in the record's own voice.
 *
 * Both are real and both are unfixed, and the record is the one place a player
 * reads the number as a fact about themselves — so the sentences say which way
 * each one leans, rather than a vague "may be inaccurate" that tells nobody
 * anything.
 */
export const DISTANCE_HONESTY = [
  // O-03
  'Distance is measured by your phone and taken on trust. The game caps it at ' +
    'a sprint, but a phone made to lie could still pad it, so treat it as a ' +
    'record of your walking, not a referee.',
  // O-12 and O-38. No fraction: the one this used to give (a tenth, from one
  // good handset) was not true of stop-and-start play, and there is no figure
  // for real phones yet that would be.
  'It leans short rather than long. To stop a phone lying on a bench from ' +
    'clocking up distance, small movements are ignored as possible GPS jitter. ' +
    'That means some real walking goes uncounted, and more of it the more you ' +
    'stop and start, which chess makes you do at every move.',
  // Decision 0040: what counts toward a game at all.
  'Only walking during play counts: not the walk to your back rank, a paused ' +
    'game, or the walk home.',
] as const;
