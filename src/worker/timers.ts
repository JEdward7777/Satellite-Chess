/**
 * Deadline multiplexing over the single alarm a Durable Object has.
 *
 * The design needs at least three independent deadlines:
 *
 * - `flag` — the exact instant the active player's clock expires.
 * - `disconnect` — the grace period after which a dropped player suspends the
 *   game and freezes both clocks.
 * - `gc` — garbage collection of an unclaimed, abandoned or finished game.
 *
 * A DO has one alarm. Calling `setAlarm` for one of these silently cancels
 * whichever other was pending, and the resulting bug — "the clock sometimes
 * doesn't flag" — surfaces weeks later and is miserable to trace. So no feature
 * code calls `setAlarm`: it schedules here, and the alarm is always set to the
 * earliest outstanding deadline.
 *
 * All state is in SQLite because the object hibernates. Nothing here may be
 * cached in memory.
 */

export type TimerKind = 'flag' | 'disconnect' | 'gc';

// The index signature is what `sql.exec<T>()` requires of a row type: it returns
// `Record<string, SqlStorageValue>`, so a plain interface does not satisfy it.
interface TimerRow {
  kind: TimerKind;
  due_at: number;
  [key: string]: SqlStorageValue;
}

export class Timers {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly sql: SqlStorage = ctx.storage.sql,
  ) {}

  /**
   * Set or move a deadline. Scheduling a kind that already exists replaces it,
   * which is what re-arming the flag alarm after every move needs.
   */
  async schedule(kind: TimerKind, dueAt: number): Promise<void> {
    this.sql.exec(
      `INSERT INTO timers (kind, due_at) VALUES (?, ?)
         ON CONFLICT (kind) DO UPDATE SET due_at = excluded.due_at`,
      kind,
      Math.floor(dueAt),
    );
    await this.sync();
  }

  async cancel(kind: TimerKind): Promise<void> {
    this.sql.exec(`DELETE FROM timers WHERE kind = ?`, kind);
    await this.sync();
  }

  /** When a kind is due, or null if it is not scheduled. */
  peek(kind: TimerKind): number | null {
    const [row] = [...this.sql.exec<{ due_at: number }>(
      `SELECT due_at FROM timers WHERE kind = ?`,
      kind,
    )];
    return row?.due_at ?? null;
  }

  list(): TimerRow[] {
    return [...this.sql.exec<TimerRow>(`SELECT kind, due_at FROM timers ORDER BY due_at`)];
  }

  /**
   * Claim every deadline at or before `now`, removing them.
   *
   * Removing as part of claiming means a handler that throws does not leave a
   * timer to fire forever in a loop. The cost is that a failed handler's deadline
   * is lost rather than retried, which is the right trade here: every caller can
   * re-derive its own deadline from stored state on the next wake, and an alarm
   * that retries indefinitely on a persistent error would burn the request budget.
   */
  claimDue(now: number): TimerKind[] {
    const due = [...this.sql.exec<TimerRow>(
      `SELECT kind, due_at FROM timers WHERE due_at <= ? ORDER BY due_at`,
      Math.floor(now),
    )];
    for (const row of due) {
      this.sql.exec(`DELETE FROM timers WHERE kind = ?`, row.kind);
    }
    return due.map((row) => row.kind);
  }

  /**
   * Point the single alarm at the earliest outstanding deadline, or clear it.
   *
   * Idempotent, and safe to call after any change. Reads the current alarm first
   * so an unchanged deadline does not cause a redundant write on every wake.
   */
  async sync(): Promise<void> {
    const [next] = [...this.sql.exec<{ due_at: number }>(
      `SELECT due_at FROM timers ORDER BY due_at LIMIT 1`,
    )];
    const current = await this.ctx.storage.getAlarm();

    if (next === undefined) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    if (current !== next.due_at) {
      await this.ctx.storage.setAlarm(next.due_at);
    }
  }
}
