/**
 * The phone's half of the head-to-head record (stage 8.5.4, decision 0054):
 * reading one opponent, naming one, and the words both screens are made of.
 *
 * Like `record.ts`, nothing is stored here and **a read never rejects**. The
 * list itself arrives with the record (`GET /api/record`), so opening the
 * account screen costs no extra request; an opponent's games are one more,
 * asked only when somebody taps them.
 *
 * Every figure is said from the reader's side ("You 160 m · They 152 m") and
 * the opponent's screen says the same games and the same total with the
 * sides swapped. The words live here so tests can check exactly that.
 */

import type { HeadToHead, OpponentDetail, OpponentLine, OpponentTally } from '../shared/head-to-head.js';
import { type Units, lengthWords, walkedPairWords } from '../shared/units.js';
import { dateWords, gamesWords, resultsWords } from './record.js';
import { reasonWords } from './views/games.js';

/** Which opponent to open: from the list, or from a game's review. */
export type OpponentQuery = { id: string } | { game: string };

export type OpponentResult =
  | { kind: 'ok'; detail: OpponentDetail }
  /** The game was recorded before rows held an opponent. */
  | { kind: 'earlier' }
  /** No such opponent in this account's record — or not yet. */
  | { kind: 'unknown' }
  | { kind: 'signed_out' }
  | { kind: 'unavailable' };

export type NameResult =
  | { kind: 'ok'; name: string | null }
  | { kind: 'signed_out' }
  | { kind: 'unavailable' };

export interface OpponentTransport {
  read(query: OpponentQuery): Promise<OpponentResult>;
  rename(id: string, name: string | null): Promise<NameResult>;
}

export function browserOpponentTransport(): OpponentTransport {
  return {
    async read(query) {
      const param = 'id' in query ? `id=${encodeURIComponent(query.id)}` : `game=${encodeURIComponent(query.game)}`;
      try {
        const response = await fetch(`/api/record/opponent?${param}`, { headers: { accept: 'application/json' } });
        if (response.status === 401) return { kind: 'signed_out' };
        if (response.status === 404) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          return { kind: body?.error === 'earlier' ? 'earlier' : 'unknown' };
        }
        if (!response.ok) return { kind: 'unavailable' };
        const detail = (await response.json()) as OpponentDetail;
        if (typeof detail?.opponent !== 'object' || !Array.isArray(detail.games)) return { kind: 'unavailable' };
        return { kind: 'ok', detail };
      } catch {
        return { kind: 'unavailable' };
      }
    },
    async rename(id, name) {
      try {
        const response = await fetch('/api/record/opponent/name', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ id, name }),
        });
        if (response.status === 401) return { kind: 'signed_out' };
        if (!response.ok) return { kind: 'unavailable' };
        const body = (await response.json()) as { name?: string | null };
        return { kind: 'ok', name: typeof body.name === 'string' ? body.name : null };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}

/** What an opponent is called on this account: the reader's name for them, or a plain stand-in. */
export function opponentLabel(tally: Pick<OpponentTally, 'name'>): string {
  return tally.name ?? 'Unnamed opponent';
}

/**
 * The headline and the line under it. "312 m" walked "between you", then
 * "You 160 m · They 152 m". Over counted games only, as the record's totals
 * are, and from {@link walkedPairWords}, so the line adds up as read.
 */
export function pairDistanceWords(
  tally: Pick<OpponentTally, 'youM' | 'themM'>,
  units: Units = 'metric',
): { together: string; split: string } {
  const words = walkedPairWords(tally.youM, tally.themM, units);
  return { together: words.together, split: `You ${words.you} · They ${words.them}` };
}

/**
 * The results, in the record's own words, and what they were made of. Games
 * are the sentence under the distance and never the headline (decision 0019).
 */
export function pairResultsWords(tally: OpponentTally): string {
  if (tally.games === 0) return 'No counted games yet.';
  return `${resultsWords(tally)}, across ${gamesWords(tally.games)}.`;
}

/** What was left out of the tally, the way the record says it. */
export function pairLeftOutWords(tally: OpponentTally, smallSquareM: number, units: Units = 'metric'): string {
  const parts: string[] = [];
  const counted = (n: number, what: string) => `${n === 1 ? 'One game' : `${n} games`} ${what}`;
  if (tally.practiceGames > 0) {
    parts.push(
      `${counted(tally.practiceGames, `on squares under ${lengthWords(smallSquareM, units, Number.isInteger(smallSquareM) ? 0 : 1)}`)} ` +
        `${tally.practiceGames === 1 ? 'is' : 'are'} kept as practice and not counted.`,
    );
  }
  if (tally.unplayedGames > 0) {
    parts.push(`${counted(tally.unplayedGames, 'that ended before anyone moved')} ${tally.unplayedGames === 1 ? 'is' : 'are'} not counted.`);
  }
  if (tally.unmeasuredGames > 0) {
    parts.push(`${counted(tally.unmeasuredGames, 'with a distance nobody measured')} ${tally.unmeasuredGames === 1 ? 'is' : 'are'} not counted.`);
  }
  return parts.join(' ');
}

/** "First played Sep 20 at Riverside Park" — what tells two unnamed opponents apart. */
export function sinceWords(tally: Pick<OpponentTally, 'firstAt' | 'firstFieldName'>, now: number = Date.now()): string {
  const when = `First played ${dateWords(tally.firstAt, now)}`;
  return tally.firstFieldName ? `${when} at ${tally.firstFieldName}` : when;
}

/** Why some finished games are not in the list. */
export function earlierWords(head: Pick<HeadToHead, 'earlierGames'>): string {
  const n = head.earlierGames;
  if (n <= 0) return '';
  return `${n === 1 ? 'One earlier game was' : `${n} earlier games were`} recorded before the app ` +
    `kept track of who you played, so ${n === 1 ? 'it is' : 'they are'} not in this list.`;
}

/** One game against them: "Riverside Park" over "Won — checkmate · 312 m between you". */
export function opponentLineWords(line: OpponentLine, units: Units = 'metric'): { title: string; detail: string } {
  const verdict = line.result === 'win' ? 'Won' : line.result === 'loss' ? 'Lost' : 'Drawn';
  const counted =
    line.standing === 'counted'
      ? `${walkedPairWords(line.youM ?? 0, line.themM ?? 0, units).together} between you`
      : line.standing === 'practice'
        ? `practice, not counted — ${lengthWords(line.squareM, units, 1)} squares`
        : line.standing === 'unmeasured'
          ? 'distance was not measured for this game'
          : 'nobody moved, not counted';
  return { title: line.fieldName ?? 'Unnamed field', detail: `${verdict} — ${reasonWords(line.reason)} · ${counted}` };
}

/**
 * What the screen promises about the name and the tally. Each sentence is a
 * claim about the code (decision 0054), so it changes when that does.
 */
export const HEAD_TO_HEAD_EXPLANATION = [
  'Once each game has reached both your records, your opponent sees the same ' +
    'games and the same distance in theirs, with the wins and losses the other way around.',
  'The name is yours alone. It is kept on your account, and they never see it. ' +
    'Nobody can look either of you up, or see who else you have played.',
] as const;

/** For a list line: "312 m between you · 2 won · 0 drawn · 1 lost". */
export function opponentSummaryWords(tally: OpponentTally, units: Units = 'metric'): string {
  return `${pairDistanceWords(tally, units).together} between you · ${resultsWords(tally)}`;
}
