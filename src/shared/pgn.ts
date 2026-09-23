/**
 * A game as a PGN file (stage 8.1).
 *
 * Two things have to be true at once, and they pull against each other:
 *
 * 1. **It has to open in any chess program.** Standard seven-tag roster,
 *    standard movetext, standard result token, lines under eighty columns. A
 *    file that only our app can read is a file nobody will ever open again.
 * 2. **It has to be a record of the walk as well as of the game** (8.1.2). That
 *    is the only thing this game has that no other chess program's PGN does.
 *
 * Both are satisfied by putting the satellite data where the standard already
 * says a reader may ignore it: in `{}` move comments and in tag pairs outside
 * the roster. A program that knows nothing about us shows the moves; a person
 * reading the file sees how far each piece was carried and where its owner was
 * standing.
 *
 * **Positions are in board space** — squares from the center of a1, never a
 * latitude (decision 0041). A PGN is a file that travels: it goes through a
 * share sheet, into a chat, onto a laptop. Coordinates in it would make every
 * shared game a disclosure of a place somebody stands regularly, which is the
 * hazard decisions 0017 and 0018 exist to avoid.
 *
 * Built from a {@link GameReport}, which comes out of stored rows — so stage
 * 8.4 can archive a finished game's PGN after the Durable Object is gone,
 * without this file learning anything about Durable Objects.
 */

import type { ResultReason } from './protocol.js';
import type { GameReport, ReportMove, ReportPosition } from './review.js';

/** Longest line a PGN writer should emit. From the export-format standard. */
const MAX_LINE = 80;

/** What the file calls itself, and what the `Event` tag says. */
export const PGN_EVENT = 'Satellite Chess';

/**
 * The legend, as a comment before the first move.
 *
 * Without it the numbers in the move comments are unreadable a year later, and
 * the person most likely to open this file is the person who walked it.
 */
export const PGN_LEGEND =
  'Positions are squares from the center of a1, as files,ranks. ' +
  "Distances are meters walked on the ground, as each player's phone measured them, " +
  'and never less than the sum of that player\'s carries.';

export interface PgnOptions {
  /** Overridden in tests. */
  now?: number;
}

/**
 * The whole file: tag pairs, a blank line, movetext, a trailing newline.
 */
export function buildPgn(report: GameReport, options: PgnOptions = {}): string {
  const tags = tagPairs(report, options.now ?? Date.now());
  const head = tags.map(([name, value]) => `[${name} "${escapeTag(value)}"]`).join('\n');
  return `${head}\n\n${moveText(report)}\n`;
}

/**
 * The tag pairs, in order: the seven-tag roster first, because a reader that
 * only understands those reads them off the top.
 *
 * `White` and `Black` are `?`. There are no names to put there: the record
 * deliberately never names an opponent (decision 0040), and writing an account
 * id or an email address into a file that gets shared would hand over the one
 * thing this project is careful with. A player who wants their own name on it
 * can type it into the file, which is a two-second edit and their decision.
 */
function tagPairs(report: GameReport, now: number): [string, string][] {
  const started = new Date(report.startedAt > 0 ? report.startedAt : now);
  const tags: [string, string][] = [
    ['Event', PGN_EVENT],
    // The name a player gave the ground. Never a place worked out from a
    // position — nothing in this project reverse-geocodes anything.
    ['Site', report.fieldName ?? '?'],
    ['Date', pgnDate(started)],
    // "-" is the standard value for a game that is not part of a round.
    ['Round', '-'],
    ['White', '?'],
    ['Black', '?'],
    ['Result', resultToken(report)],
  ];

  tags.push(['UTCDate', pgnDate(started)], ['UTCTime', pgnTime(started)]);
  tags.push(['TimeControl', timeControl(report)]);
  if (report.reason !== null) {
    tags.push(['Termination', termination(report.reason)]);
    // `Termination` has a small fixed vocabulary, so "checkmate" and "agreed a
    // draw" both land on "normal". The reason this game actually ended is worth
    // keeping, and it is the word the app itself shows.
    tags.push(['SatelliteEnd', report.reason]);
  }
  tags.push(['SatelliteBoardM', meters(report.boardM)]);
  tags.push(['SatelliteSquareM', meters(report.squareM)]);
  // Left out rather than written as zero where nobody measured it — a zero is a
  // claim that somebody walked nowhere (decision 0040, rule 7).
  if (report.travelM.w !== null) tags.push(['SatelliteWhiteWalkedM', meters(report.travelM.w)]);
  if (report.travelM.b !== null) tags.push(['SatelliteBlackWalkedM', meters(report.travelM.b)]);
  return tags;
}

/** `1-0`, `0-1`, `1/2-1/2`, or `*` for a game still going. */
export function resultToken(report: Pick<GameReport, 'outcome'>): string {
  return report.outcome ?? '*';
}

/**
 * The movetext: numbered moves, each with its walk in a comment, then the
 * result token.
 *
 * Wrapped to {@link MAX_LINE} on whitespace. A comment may be broken across
 * lines — it runs to its closing brace — so nothing has to overflow.
 */
function moveText(report: GameReport): string {
  // The legend is one comment and many tokens: at 140-odd characters it would
  // be a single over-long line otherwise, and a comment may be broken on
  // whitespace because it runs to its closing brace.
  const tokens: string[] = `{${PGN_LEGEND}}`.split(' ');
  let expected = 1;
  for (const move of report.moves) {
    const number = Math.floor((move.seq - 1) / 2) + 1;
    if (move.color === 'w') {
      tokens.push(`${number}.`);
    } else if (move.seq !== expected || move.seq === 1) {
      // Black to move with no white move printed before it: the standard's
      // `12...` form. Happens for a report that begins mid-game, which is not a
      // case we produce today but is cheap to be correct about.
      tokens.push(`${number}...`);
    }
    expected = move.seq + 1;
    tokens.push(move.san);
    const comment = moveComment(move);
    if (comment !== null) tokens.push(...comment.split(' '));
  }
  tokens.push(resultToken(report));

  const lines: string[] = [];
  let line = '';
  for (const token of tokens) {
    if (line === '') {
      line = token;
    } else if (line.length + 1 + token.length <= MAX_LINE) {
      line += ` ${token}`;
    } else {
      lines.push(line);
      line = token;
    }
  }
  if (line !== '') lines.push(line);
  return lines.join('\n');
}

/**
 * One move's walk, as a `{}` comment — or null for a move with nothing to say.
 *
 * A move played before stage 4.1.4 stored fixes, or one whose phone had no fix
 * at either end, gets no comment rather than a comment full of dashes.
 */
export function moveComment(move: ReportMove): string | null {
  const parts: string[] = [];
  if (move.carriedM > 0 || move.carriedMs > 0) {
    parts.push(`carry ${meters(move.carriedM)} m in ${seconds(move.carriedMs)} s`);
  }
  if (move.lift !== null) parts.push(`lift ${position(move.lift)}`);
  if (move.place !== null) parts.push(`place ${position(move.place)}`);
  if (parts.length === 0) return null;
  // No braces can reach this: every part is built from numbers.
  return `{${parts.join('; ')}}`;
}

/** `4.20,1.05 acc 5 m` — where they stood, and how sure the phone was. */
function position(pos: ReportPosition): string {
  const where = `${squares(pos.file)},${squares(pos.rank)}`;
  return pos.accuracyM > 0 ? `${where} acc ${meters(pos.accuracyM)} m` : where;
}

/**
 * The PGN `Termination` tag, whose vocabulary is fixed by the standard.
 *
 * Everything that is chess ending normally is "normal", including a
 * resignation and an agreed draw. A flag fall is "time forfeit" and a game
 * nobody came back to is "abandoned" — which is exactly what `ResultReason`
 * calls it.
 */
export function termination(reason: ResultReason): string {
  if (reason === 'timeout') return 'time forfeit';
  if (reason === 'abandoned') return 'abandoned';
  return 'normal';
}

/**
 * `600+5`, in seconds, as the standard spells a sudden-death control — or `?`,
 * which is what the standard says for a control nobody recorded.
 *
 * A game created before the starting time had a column of its own (schema 5)
 * is the `?` case: its clocks hold what is left rather than what they began
 * with, so there is no honest number to write.
 */
function timeControl(report: Pick<GameReport, 'initialMs' | 'incrementMs'>): string {
  if (report.initialMs === null || !Number.isFinite(report.initialMs)) return '?';
  const initial = Math.max(0, Math.round(report.initialMs / 1000));
  const increment = Math.max(0, Math.round(report.incrementMs / 1000));
  return `${initial}+${increment}`;
}

function pgnDate(date: Date): string {
  const y = String(date.getUTCFullYear()).padStart(4, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}.${m}.${d}`;
}

function pgnTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/**
 * A distance for the file: one decimal, and no trailing `.0`.
 *
 * Tenths of a meter is already finer than any phone knows (O-12), and a PGN
 * full of `12.4000000001` reads as a machine's file rather than a record of an
 * afternoon.
 */
function meters(value: number): string {
  return trim(Number.isFinite(value) && value > 0 ? value : 0, 1);
}

function seconds(ms: number): string {
  return trim(Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0, 1);
}

/** Squares, to a hundredth — about 8 cm on an 8 m board, so nothing is lost. */
function squares(value: number): string {
  return trim(Number.isFinite(value) ? value : 0, 2);
}

function trim(value: number, places: number): string {
  return value.toFixed(places).replace(/\.?0+$/, '') || '0';
}

/**
 * Tag values are quoted strings, so a quote and a backslash are escaped and a
 * newline cannot appear at all. A field name is player-written text and is the
 * one value here that did not come from us.
 */
function escapeTag(value: string): string {
  return value.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\r\n\t]+/g, ' ');
}

/**
 * What to call the file.
 *
 * Deliberately **not** the join code. A code is a live pointer at the field a
 * game was played on, for anyone holding it and for ever (O-34), so it has no
 * business being the first thing a shared file says about itself. The date and
 * the field's own name are what a player would have written on it.
 */
export function pgnFileName(report: Pick<GameReport, 'fieldName' | 'startedAt'>): string {
  const date = new Date(report.startedAt > 0 ? report.startedAt : Date.now());
  const day = pgnDate(date).replace(/\./g, '-');
  const where = slug(report.fieldName ?? '');
  return `satellite-chess-${day}${where === '' ? '' : `-${where}`}.pgn`;
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}
