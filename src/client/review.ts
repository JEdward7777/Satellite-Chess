/**
 * The phone's half of the post-game review (stages 8.1, 8.2): one request, and
 * the words the review screen is made of.
 *
 * Shaped exactly like `record.ts`, and for the same two reasons. **A read never
 * rejects** — a review is something to look at, so a phone with no signal says
 * so and carries on — and **every sentence a player reads lives here** rather
 * than in the view, so it can be checked in node.
 *
 * The report is fetched once, at mount, and held. That is not an optimisation:
 * `navigator.share` must be reached with nothing awaited in front of it
 * (`gotchas.md`), so by the time the Share button is tapped the PGN has to
 * already be a string in memory. The screen builds it from the held report with
 * {@link buildPgn}, which is pure — the `/pgn` route exists for the last tier,
 * a plain link the *server* answers with a `Content-Disposition`, which still
 * saves a file where a page-initiated download is blocked (decision 0041).
 */

import { buildPgn, pgnFileName } from '../shared/pgn.js';
import { personalResult } from '../shared/record.js';
import { type GameReport, type PlayerWalk, type ReportMove, walksOf } from '../shared/review.js';
import type { Color } from '../shared/squares.js';
import { DISTANCE_HONESTY, crossingsWords, distanceWords } from './record.js';
import { reasonWords } from './views/games.js';

/** The honesty sentences are the record's, word for word. See below. */
export { DISTANCE_HONESTY };

/** What a read came back with. */
export type ReviewResult =
  | { kind: 'ok'; you: Color | null; report: GameReport }
  | { kind: 'signed_out' }
  /** No signal, not a player in this game, or an answer that is not a report. */
  | { kind: 'unavailable' };

export interface ReviewTransport {
  read(joinCode: string): Promise<ReviewResult>;
}

export function browserReviewTransport(): ReviewTransport {
  return {
    async read(joinCode: string) {
      try {
        const response = await fetch(`/api/game/${encodeURIComponent(joinCode)}/review`, {
          headers: { accept: 'application/json' },
        });
        if (response.status === 401) return { kind: 'signed_out' };
        if (!response.ok) return { kind: 'unavailable' };
        const body = (await response.json()) as { you?: unknown; report?: GameReport };
        const report = body.report;
        if (
          typeof report !== 'object' ||
          report === null ||
          !Array.isArray(report.moves) ||
          typeof report.travelM !== 'object'
        ) {
          return { kind: 'unavailable' };
        }
        // The wire is not trusted about which seat this phone held, even though
        // it is our own server: `walksOf` puts that player's walk first, and a
        // stray value would silently show somebody the other side's game.
        const you = body.you === 'w' || body.you === 'b' ? body.you : null;
        return { kind: 'ok', you, report };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}

/** The file, ready to share. Pure, and therefore callable inside a tap. */
export function pgnOf(report: GameReport): { text: string; fileName: string } {
  return { text: buildPgn(report), fileName: pgnFileName(report) };
}

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

/**
 * The headline (stage 8.2.2): **"You covered 2.4 km"**.
 *
 * Distance leads, here as on the record, because it is the thing people repeat
 * to their friends and the only number that scales with the field (decision
 * 0019). Where nobody measured it the headline says so rather than showing a
 * zero — a zero is a claim about how far somebody walked (decision 0040).
 */
export function headlineWords(walk: PlayerWalk | null): string {
  if (walk === null || walk.travelM === null) return 'Distance was not measured';
  return `You covered ${distanceWords(walk.travelM)}`;
}

/**
 * The line that rides beside the file in a share sheet.
 *
 * The headline where there is a distance to brag about, and a plain line where
 * there is not — "Distance was not measured playing chess" is not a sentence
 * anybody would send.
 */
export function shareMessageWords(walk: PlayerWalk | null): string {
  if (walk === null || walk.travelM === null) return 'A game of Satellite Chess. Here it is.';
  return `${headlineWords(walk)} playing chess. Here is the game.`;
}

/** The line under it: what the distance was made of. */
export function headlineDetailWords(walk: PlayerWalk | null): string {
  if (walk === null) return 'This game has no walk recorded against your seat.';
  if (walk.travelM === null) {
    return 'This game was already under way before the app measured distance per game, so there is no figure for it.';
  }
  const parts = [`Walking during play only, over ${movesWords(walk.moves)}.`];
  if (walk.crossings !== null && walk.crossings > 0) {
    parts.push(`That is ${crossingsWords(walk.crossings)}.`);
  }
  return parts.join(' ');
}

/** "4 moves", "1 move". */
export function movesWords(moves: number): string {
  return `${moves} move${moves === 1 ? '' : 's'}`;
}

/** "White", "Black" — the one thing an opponent is ever called here. */
export function colorWords(color: Color): string {
  return color === 'w' ? 'White' : 'Black';
}

/**
 * One player's row: who, how far, and what that was made of.
 *
 * The opponent is **never named** (decision 0040). They are their color, which
 * is all the file says about them too, and all a player needs to read a row
 * that is not their own.
 */
export function walkWords(
  walk: PlayerWalk,
  you: Color | null,
): { who: string; distance: string; detail: string } {
  const mine = you !== null && walk.color === you;
  const who = `${mine ? 'You' : 'Them'} · ${colorWords(walk.color)}`;
  const parts = [movesWords(walk.moves)];
  if (walk.longestCarryM > 0) parts.push(`longest carry ${distanceWords(walk.longestCarryM)}`);
  // No total of the carries here. It would repeat the floor under the distance
  // above (decision 0041) — the walk is never less than the carries — and on a
  // game where the floor is what set the figure, the two would read as the
  // same number twice. The longest carry cannot exceed the distance, because
  // the distance is floored by the carries it is one of.
  if (walk.crossings !== null && walk.crossings > 0) parts.push(crossingsWords(walk.crossings));
  return {
    who,
    distance: walk.travelM === null ? 'not measured' : distanceWords(walk.travelM),
    detail: parts.join(' · '),
  };
}

/** Both rows, the reader's first. */
export function walkRows(
  report: GameReport,
  you: Color | null,
): { who: string; distance: string; detail: string }[] {
  return walksOf(report, you).map((walk) => walkWords(walk, you));
}

/**
 * How it ended, from the reader's side: "You won — checkmate".
 *
 * An unfinished game says so. The review screen is reachable from the board
 * whenever there is a result, but the report itself is built from stored rows
 * and is perfectly happy without one (the PGN writes `*`), so this has to have
 * something true to say either way.
 */
export function resultWords(report: GameReport, you: Color | null): string {
  if (report.outcome === null || report.reason === null) return 'Still playing';
  const how = reasonWords(report.reason);
  if (you === null) {
    const winner =
      report.outcome === '1/2-1/2' ? 'Drawn' : `${colorWords(report.outcome === '1-0' ? 'w' : 'b')} won`;
    return `${winner} — ${how}`;
  }
  const mine = personalResult(report.outcome, you);
  const verdict = mine === 'win' ? 'You won' : mine === 'loss' ? 'You lost' : 'Drawn';
  return `${verdict} — ${how}`;
}

/** "Riverside Park · a 64 m board", or the board alone for a field nobody named. */
export function whereWords(report: GameReport): string {
  const meters = Math.round(report.boardM);
  const board = report.boardM > 0 ? `${articleFor(meters)} ${meters} m board` : null;
  return [report.fieldName, board].filter((part) => part !== null && part !== '').join(' · ');
}

/**
 * "a" or "an", for a number read aloud: "an 80 m board", "an 11 m board", "a
 * 64 m board". An eight leads with a vowel sound wherever it stands first, and
 * eleven and eighteen do when they are the leading group — 11, 18, 11,000 —
 * but not in 110 or 1,100, which are read "one hundred…" and "one thousand…".
 */
export function articleFor(n: number): 'a' | 'an' {
  const digits = String(Math.abs(Math.round(n)));
  if (digits.startsWith('8')) return 'an';
  if ((digits.startsWith('11') || digits.startsWith('18')) && digits.length % 3 === 2) return 'an';
  return 'a';
}

/**
 * One move, as the list shows it: `12… Qh4#` and the walk that carried it.
 *
 * The carry is the number worth reading — it is the only thing in a chess move
 * list that no other chess program has. A move with nothing stored (one played
 * before stage 4.1.4, or one whose phone had no fix) says so rather than
 * showing a zero.
 */
export function moveWords(move: ReportMove): { ply: string; san: string; detail: string } {
  const number = Math.floor((move.seq - 1) / 2) + 1;
  const carried = move.carriedM > 0 ? distanceWords(move.carriedM) : null;
  const took = move.carriedMs > 0 ? secondsWords(move.carriedMs) : null;
  return {
    ply: `${number}${move.color === 'w' ? '.' : '…'}`,
    san: move.san,
    detail:
      carried === null
        ? took === null
          ? 'no walk recorded'
          : `carried for ${took}`
        : took === null
          ? `carried ${carried}`
          : `carried ${carried} in ${took}`,
  };
}

/** "31 s", "2 min 11 s" — how long a piece was in somebody's hand. */
export function secondsWords(ms: number): string {
  const total = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  if (total < 90) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

/**
 * What the PGN is, in one sentence, next to the button that sends it.
 *
 * It says what is *not* in the file as well as what is, because the reason a
 * player might hesitate to send a file about a walk is the obvious one, and the
 * answer is good (decision 0041): there is nothing in it to locate.
 */
export const PGN_EXPLANATION =
  'A PGN is the standard chess file — any chess program will open it. This one ' +
  'also carries how far each piece was carried and where on the board each ' +
  'player stood, in squares. It holds no coordinates, no map and no names, so ' +
  'it says nothing about where you were.';
