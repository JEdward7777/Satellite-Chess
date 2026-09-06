/**
 * UserDO — one Durable Object per player, holding saved fields, the game index
 * and the permanent record.
 *
 * Addressed by `env.USER.getByName(sub)` — the Google `sub` claim, never the
 * email, because an email changes and a `sub` does not (decision 0014). The
 * account key therefore *is* the address, so there is no user table anywhere and
 * no lookup to go stale, exactly as a join code addresses a game (decision 0007).
 *
 * ## Why a Durable Object and not KV (stage 2.3.2)
 *
 * This is the stage's whole content, so it is written down rather than left as a
 * shape someone later reads as an over-engineering to be simplified into a KV
 * namespace.
 *
 * The deciding case is the commonest thing anyone does: walk out a field, tap
 * confirm, and immediately see it on the home screen. That is a read straight
 * after a write, from the same phone, within a second — and KV is eventually
 * consistent, with a propagation window that makes exactly that read return the
 * *old* value. The player would tap save, watch nothing appear, and calibrate the
 * whole board again. Decision 0013's rule is that a hard-won field must never
 * live only in memory; a store that can silently answer "no fields yet" a second
 * after saving one breaks that rule while appearing to keep it.
 *
 * A Durable Object is serialised and read-after-write consistent by construction,
 * which turns that whole class of bug into something that cannot be written. The
 * cost — one object per player rather than one shared namespace — is what the
 * free tier is comfortable with, since an account is touched only when its owner
 * is holding their phone.
 *
 * KV is still right for the two things phase 2 gives it: sessions (stage 2.2.1,
 * where a stale read means a login is honoured a moment longer) and the
 * read-cached "fields near me" listing (stage 2.3.6, where staleness is the
 * point). Neither is read immediately after being written by the same person.
 *
 * ## What is not here yet
 *
 * The tables are real and documented in `user-schema.ts`; the behaviour that
 * fills them is still ahead. `2.3.3.2` moves saved fields off the phone's local
 * storage and onto `fields`, `2.3.4` populates `game_index`, and `2.3.5` builds
 * the permanent record over both. Metres walked is the headline figure there, not
 * games played (decision 0019).
 */

import { DurableObject } from 'cloudflare:workers';

import { applyUserSchema } from './user-schema.js';

/** The account, as anything outside the object sees it. */
export interface Account {
  /** The account key, and this object's own name. */
  sub: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

interface AccountRow {
  sub: string;
  first_seen_at: number;
  last_seen_at: number;
  [key: string]: SqlStorageValue;
}

export class UserDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Idempotent, because the object is re-created on every wake.
    applyUserSchema(this.sql);
  }

  /**
   * Say hello. Creates the account on first contact and stamps the visit.
   *
   * Every authenticated route goes through here rather than assuming an account
   * exists, because with `getByName` addressing there is no sign-up step to hang
   * creation on — the first request from a new player is indistinguishable from
   * the thousandth, and has to work.
   *
   * The `sub` is passed in rather than read from `ctx.id.name` because a name is
   * only carried by a name-derived id: a stub obtained any other way would give
   * `null` here, and an account row that is sometimes anonymous is worse than
   * one that is always explicit.
   */
  async touch(sub: string, now: number = Date.now()): Promise<Account> {
    const existing = this.read();

    if (existing === null) {
      this.sql.exec(
        `INSERT INTO account (id, sub, first_seen_at, last_seen_at) VALUES (1, ?, ?, ?)`,
        sub,
        now,
        now,
      );
      return { sub, firstSeenAt: now, lastSeenAt: now };
    }

    // Two accounts inside one object means the addressing is broken, and every
    // guarantee above it — that a field belongs to one player, that a game index
    // is one person's — is broken with it. Loud, because the quiet version is
    // one player reading another's saved fields.
    if (existing.sub !== sub) {
      throw new Error(
        `UserDO addressed as ${sub} but holds ${existing.sub}; getByName(sub) is the only correct address`,
      );
    }

    this.sql.exec(`UPDATE account SET last_seen_at = ? WHERE id = 1`, now);
    return { ...existing, lastSeenAt: now };
  }

  /** The account as stored, or null if this object has never been touched. */
  async account(): Promise<Account | null> {
    return this.read();
  }

  private read(): Account | null {
    const [row] = [
      ...this.sql.exec<AccountRow>(`SELECT sub, first_seen_at, last_seen_at FROM account WHERE id = 1`),
    ];
    return row
      ? { sub: row.sub, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at }
      : null;
  }
}
