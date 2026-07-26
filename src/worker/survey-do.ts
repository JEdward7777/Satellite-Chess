/**
 * SurveyDO — a place for the phone to confess what its GPS actually did.
 *
 * The riskiest assumption in this project is that consumer GPS can tell 8 m
 * squares apart on grass (stage 1.9.3). Nothing in a container can answer that:
 * the simulator encodes *my* assumptions about noise, so a passing test suite
 * proves the code matches the model, not that the model matches the sky.
 *
 * So this stores raw traces uploaded from a real phone on real ground, for
 * offline analysis. One object, addressed by name `survey`, holding whole
 * traces as JSON blobs.
 *
 * **This is a debug facility and it is off unless `SURVEY_SECRET` is set.**
 * A trace is a precise record of where a person stood and when, which is exactly
 * the data decisions 0017–0019 are careful with. It is opt-in per session, the
 * uploader must know the secret, and traces expire — see `PRUNE_AFTER_MS`.
 */

import { DurableObject } from 'cloudflare:workers';

/** A single position report, exactly as the browser gave it. */
export interface TraceFix {
  /** Client clock, milliseconds. */
  t: number;
  lat: number;
  lng: number;
  /** Reported horizontal accuracy in metres. */
  acc: number;
  /** Whatever else the platform offered; all optional and all untrusted. */
  alt?: number | null;
  altAcc?: number | null;
  spd?: number | null;
  hdg?: number | null;
}

/** A point the surveyor said something about, tying a fix to the real world. */
export interface TraceMarker {
  t: number;
  /** Which protocol step this belongs to. */
  step: string;
  label: string;
  /** Index into `fixes` of the fix nearest in time. */
  atFix: number;
  note?: string;
}

export interface Trace {
  id: string;
  label: string;
  startedAt: number;
  endedAt: number;
  /** User agent, so a trace can be read against the phone that made it. */
  device: string;
  fixes: TraceFix[];
  markers: TraceMarker[];
}

/**
 * Traces are deleted after a fortnight.
 *
 * Long enough to analyse a weekend's fieldwork, short enough that a debug
 * facility does not quietly become a location history.
 */
export const PRUNE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** A ceiling on one upload, so a bad client cannot fill the object. */
export const MAX_FIXES = 20_000;

export class SurveyDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Idempotent, because the object is re-created on every wake.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        device TEXT NOT NULL,
        fix_count INTEGER NOT NULL,
        body TEXT NOT NULL,
        -- Server clock. Expiry must never depend on the phone's idea of the
        -- time: a device with a wrong clock would otherwise have its trace
        -- pruned the instant it arrived, which is exactly the phone whose data
        -- is most worth having.
        received_at INTEGER NOT NULL
      )
    `);
  }

  /** Store one trace. Returns what was kept, so the phone can show a receipt. */
  async put(trace: Trace): Promise<{ id: string; fixes: number; markers: number }> {
    const fixes = trace.fixes.slice(0, MAX_FIXES);
    const stored: Trace = { ...trace, fixes };

    this.sql.exec(
      `INSERT OR REPLACE INTO traces
         (id, label, started_at, ended_at, device, fix_count, body, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      trace.id,
      trace.label,
      trace.startedAt,
      trace.endedAt,
      trace.device,
      fixes.length,
      JSON.stringify(stored),
      Date.now(),
    );

    this.prune();
    return { id: trace.id, fixes: fixes.length, markers: trace.markers.length };
  }

  /** Everything but the fixes, so a listing stays small. */
  async list(): Promise<
    { id: string; label: string; startedAt: number; endedAt: number; device: string; fixes: number }[]
  > {
    this.prune();
    return [
      ...this.sql.exec<{
        id: string;
        label: string;
        started_at: number;
        ended_at: number;
        device: string;
        fix_count: number;
      }>(`SELECT id, label, started_at, ended_at, device, fix_count FROM traces
          ORDER BY started_at DESC`),
    ].map((row) => ({
      id: row.id,
      label: row.label,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      device: row.device,
      fixes: row.fix_count,
    }));
  }

  async get(id: string): Promise<Trace | null> {
    const [row] = [...this.sql.exec<{ body: string }>(`SELECT body FROM traces WHERE id = ?`, id)];
    return row ? (JSON.parse(row.body) as Trace) : null;
  }

  async remove(id: string): Promise<void> {
    this.sql.exec(`DELETE FROM traces WHERE id = ?`, id);
  }

  /**
   * Drop anything past its expiry. Called on every write and every listing.
   *
   * Measured from when the server received it, never from the client's
   * `startedAt` — see the schema comment.
   */
  private prune(now = Date.now()): void {
    this.sql.exec(`DELETE FROM traces WHERE received_at < ?`, now - PRUNE_AFTER_MS);
  }
}
