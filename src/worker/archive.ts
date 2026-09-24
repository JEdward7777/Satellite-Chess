/**
 * A finished game, after its Durable Object has gone (stage 8.4, decision 0042).
 *
 * One Workers KV value per game: the PGN exactly as the review served it, and
 * the report the review screen is drawn from. Written once, by the game itself,
 * just before it deletes itself; read only by the Worker, and only when the
 * object answers that there is no game.
 *
 * ## What is in it, and what is not
 *
 * The value is built from a {@link GameReport} — which is already board space
 * and nothing else (decision 0041) — by naming every field it keeps, so a field
 * added to the report later is left out until somebody decides it belongs here.
 * So:
 *
 * - **No latitude or longitude.** Lifts and places are squares from a1's centre.
 *   The field snapshot, which *is* the place, is not archived at all.
 * - **No account.** A seat check against an archived game asks the player's own
 *   account whether it has a line for this code (its record, or failing that its
 *   game index), so nothing here says who played. Whoever can read this
 *   namespace learns what was played and how far people walked, and not by whom.
 * - **No join code in the value.** The key is the code — that is how a request
 *   finds it — but the report is stored without its `joinCode` and has it put
 *   back from the URL on the way out, so the value itself names nothing that
 *   could open anything.
 *
 * No expiry: a finished game's history is kept, as decision 0025 promised, and
 * the space it costs is in `reference/budget.md`.
 */

import type { GameReport, ReportMove, ReportPosition } from '../shared/review.js';

/** Bumped when the stored shape changes; a reader refuses what it does not know. */
export const ARCHIVE_VERSION = 1;

/**
 * Where one game lives in the `ARCHIVE` namespace.
 *
 * The join code because it is what every request arrives with, and because the
 * code *is* the game's address everywhere else (decision 0007). Prefixed and
 * versioned so a later shape can sit beside this one during a migration.
 */
export function archiveKey(joinCode: string): string {
  return `game/v${ARCHIVE_VERSION}/${joinCode}`;
}

/** A report with its join code taken out, which is what is stored. */
export type ArchivedReport = Omit<GameReport, 'joinCode'>;

/** The stored value. */
export interface ArchivedGame {
  v: typeof ARCHIVE_VERSION;
  /** When the archive was written. */
  archivedAt: number;
  /** The canonical file (decision 0041), byte for byte what `/pgn` served. */
  pgn: string;
  /**
   * The review screen's data, in board space. This is the game's "track": the
   * only positions the server ever held were the fix at each lift and each
   * place (decision 0008 keeps GPS off the wire otherwise), and they are here
   * as squares.
   */
  report: ArchivedReport;
}

/** A game read back: the report with its code restored, and the file. */
export interface Archived {
  archivedAt: number;
  pgn: string;
  report: GameReport;
}

function position(at: ReportPosition | null): ReportPosition | null {
  return at === null ? null : { file: at.file, rank: at.rank, accuracyM: at.accuracyM };
}

function move(m: ReportMove): ReportMove {
  return {
    seq: m.seq,
    color: m.color,
    san: m.san,
    uci: m.uci,
    from: m.from,
    to: m.to,
    carriedM: m.carriedM,
    carriedMs: m.carriedMs,
    lift: position(m.lift),
    place: position(m.place),
  };
}

/**
 * The value to store for a report and its file.
 *
 * Every field is named rather than spread, which is the whole of the guarantee
 * above: a spread would archive whatever the report grows next, and the report
 * is built by code whose job is the review screen, not this.
 */
export function toArchive(report: GameReport, pgn: string, now: number): ArchivedGame {
  return {
    v: ARCHIVE_VERSION,
    archivedAt: now,
    pgn,
    report: {
      fieldName: report.fieldName,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      outcome: report.outcome,
      reason: report.reason,
      initialMs: report.initialMs,
      incrementMs: report.incrementMs,
      squareM: report.squareM,
      boardM: report.boardM,
      diagonalM: report.diagonalM,
      travelM: { w: report.travelM.w, b: report.travelM.b },
      moves: report.moves.map(move),
    },
  };
}

/**
 * A stored value, checked for shape and given its join code back — or null
 * for anything that is not an archive this code can read.
 */
export function fromArchive(value: unknown, joinCode: string): Archived | null {
  if (typeof value !== 'object' || value === null) return null;
  const stored = value as Partial<ArchivedGame>;
  if (stored.v !== ARCHIVE_VERSION || typeof stored.pgn !== 'string') return null;
  const report = stored.report;
  if (
    typeof report !== 'object' ||
    report === null ||
    !Array.isArray(report.moves) ||
    typeof report.travelM !== 'object' ||
    report.travelM === null
  ) {
    return null;
  }
  return {
    archivedAt: typeof stored.archivedAt === 'number' ? stored.archivedAt : 0,
    pgn: stored.pgn,
    report: { ...report, joinCode },
  };
}

/**
 * Read one game's archive, or null if there is none — or if what is there is
 * not one, which a route should answer as "no such game" rather than as a 500.
 * A KV outage still throws: that is a failure, not an absence.
 */
export async function readArchive(kv: KVNamespace, joinCode: string): Promise<Archived | null> {
  const text = await kv.get(archiveKey(joinCode), 'text');
  if (text === null) return null;
  try {
    return fromArchive(JSON.parse(text), joinCode);
  } catch {
    return null;
  }
}

/** Whether a code has ever been archived — so that it is never handed out again. */
export async function isArchived(kv: KVNamespace, joinCode: string): Promise<boolean> {
  return (await kv.get(archiveKey(joinCode), 'text')) !== null;
}

export async function writeArchive(
  kv: KVNamespace,
  joinCode: string,
  archived: ArchivedGame,
): Promise<void> {
  await kv.put(archiveKey(joinCode), JSON.stringify(archived));
}
