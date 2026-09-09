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
 * ## The phone is still the primary store
 *
 * `fields` is a **replica, not the origin** (decision 0013). A field is saved on
 * the phone the instant it is calibrated, with no account and no network, and
 * this object is what makes it also appear on the player's second phone. That
 * ordering is the whole reason the feature is safe to have: every failure here —
 * no signal, no session, a 500 — costs synchronisation and never costs ground
 * somebody walked.
 *
 * So {@link UserDO.syncFields} is the shape of the API rather than a REST
 * resource per field. One round trip pushes what changed, names what was
 * deleted, and returns the account's list, because the phone doing the calling
 * is outdoors on one bar and every request is billed against a 100k/day budget.
 *
 * ## The game index is written by the game, never by the phone
 *
 * `fields` and `game_index` arrive here from opposite directions, and the
 * asymmetry is deliberate (decision 0033). A field is the phone's, pushed up by
 * its owner; an index entry is the *game's*, pushed in by `GameDO` over the
 * `USER` binding when a game changes state. There is no endpoint that lets a
 * client write one, which is what makes these rows worth building `2.3.5`'s
 * permanent record on: a result the player could POST to themselves would be a
 * record of what they felt like claiming.
 *
 * ## What is not here yet
 *
 * `2.3.5` builds the permanent record over both tables. Metres walked is the
 * headline figure there, not games played (decision 0019).
 */

import { DurableObject } from 'cloudflare:workers';

import type { FieldSpec } from '../shared/field.js';
import {
  type GameIndexEntry,
  type GameIndexUpdate,
  forgetIsRefused,
} from '../shared/game-index.js';
import {
  FIELD_COLUMNS,
  type FieldRow,
  MAX_FIELDS_PER_ACCOUNT,
  bindValuesFor,
  specFromRow,
} from './user-fields.js';
import {
  GAME_INDEX_COLUMNS,
  type GameIndexRow,
  MAX_GAMES_PER_ACCOUNT,
  bindValuesFor as gameBindValuesFor,
  entryFromRow,
} from './user-games.js';
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
    return this.stamp(sub, now);
  }

  /**
   * The create-or-update behind {@link touch}, so every entry point stamps the
   * visit and re-checks the addressing invariant rather than only the one route
   * that happens to be called first.
   */
  private stamp(sub: string, now: number): Account {
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

  // -------------------------------------------------------------------------
  // Saved fields (stage 2.3.3.2)
  // -------------------------------------------------------------------------

  /** Every field this account holds, most recently touched first. */
  async listFields(): Promise<FieldSpec[]> {
    return this.fields();
  }

  /**
   * One round trip: apply what the phone has changed, then hand back the list.
   *
   * Takes the `sub` and stamps the account for the same reason `/api/me` does —
   * with `getByName` addressing there is no sign-up step, so the first request
   * from a new player may perfectly well be a sync, and it has to work rather
   * than write fields into an account that does not exist.
   *
   * Pushes are applied before deletions so that a phone which renamed a field
   * and then deleted it in the same offline stretch ends with it gone — the two
   * cannot both be honoured and the later act is the one the player would
   * remember making.
   *
   * The returned list is the whole truth rather than a diff, and that is what
   * makes the client's merge simple enough to be correct: a field the phone
   * holds, has already had acknowledged, and does not find in this list was
   * deleted on another phone. A diff would need a cursor, and a cursor that
   * skipped would delete somebody's fields.
   */
  async syncFields(
    sub: string,
    push: readonly FieldSpec[],
    remove: readonly string[],
    now: number = Date.now(),
  ): Promise<{ account: Account; fields: FieldSpec[]; rejected: string[] }> {
    const rejected: string[] = [];
    let account!: Account;
    // One transaction, so a phone that loses signal mid-request finds either all
    // of its changes applied or none of them — and syncs again either way.
    this.ctx.storage.transactionSync(() => {
      account = this.stamp(sub, now);
      for (const spec of push) {
        if (!this.upsertField(spec)) rejected.push(spec.id);
      }
      for (const id of remove) {
        this.sql.exec(`DELETE FROM fields WHERE id = ?`, id);
      }
    });
    return { account, fields: this.fields(), rejected };
  }

  /**
   * Write one field, newest wins. False when the account is full.
   *
   * Last-write-wins on `updated_at` rather than on arrival order, because
   * arrival order is whichever phone reconnected first after a walk in the
   * park, and that has nothing to do with which rename the player made second.
   * The two phones are the same person, so there is no conflict to resolve
   * beyond "which of my own edits is later".
   */
  private upsertField(spec: FieldSpec): boolean {
    const [existing] = [
      ...this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM fields WHERE id = ?`, spec.id),
    ];
    if (existing.n === 0 && this.fieldCount() >= MAX_FIELDS_PER_ACCOUNT) return false;

    const columns = FIELD_COLUMNS.join(', ');
    const placeholders = FIELD_COLUMNS.map(() => '?').join(', ');
    // Everything except `id` and `created_at` is overwritten; the earliest
    // creation stamp survives, because a copy taken on a second phone is the
    // same field and did not come into existence twice.
    const updates = FIELD_COLUMNS.filter((c) => c !== 'id' && c !== 'created_at')
      .map((c) => `${c} = excluded.${c}`)
      .join(', ');
    this.sql.exec(
      `INSERT INTO fields (${columns}) VALUES (${placeholders})
         ON CONFLICT (id) DO UPDATE SET
           ${updates},
           created_at = MIN(fields.created_at, excluded.created_at)
         WHERE excluded.updated_at >= fields.updated_at`,
      ...bindValuesFor(spec),
    );
    return true;
  }

  private fieldCount(): number {
    const [row] = [...this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM fields`)];
    return row.n;
  }

  // -------------------------------------------------------------------------
  // The game index (stage 2.3.4)
  // -------------------------------------------------------------------------

  /**
   * Record what a game has become, for the seat this account holds in it.
   *
   * Called by `GameDO`, never by a route — see the note at the head of this file
   * and decision 0033. The `sub` is passed and stamped for the same reason
   * `syncFields` takes one: with `getByName` addressing there is no sign-up
   * step, so a player's very first act may be to create a game, and this may
   * therefore be the request that brings their account into existence.
   *
   * Returns false only when the index is full and this is a game it has never
   * heard of. The game does not retry and must not: it is mid-move on a field,
   * and an index line is not worth failing a move over.
   */
  async recordGame(
    sub: string,
    entry: GameIndexUpdate,
    now: number = Date.now(),
  ): Promise<boolean> {
    let recorded = false;
    this.ctx.storage.transactionSync(() => {
      this.stamp(sub, now);
      const [existing] = [
        ...this.sql.exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM game_index WHERE join_code = ?`,
          entry.joinCode,
        ),
      ];
      if (existing.n === 0 && this.gameCount() >= MAX_GAMES_PER_ACCOUNT) return;

      // `joined_at` is stamped here and never again: it is when this account
      // sat down, and every write after the first is the same seat being
      // described again by a game that has long since forgotten the moment.
      // Everything else is the game's current answer and wins.
      const columns = GAME_INDEX_COLUMNS.join(', ');
      const placeholders = GAME_INDEX_COLUMNS.map(() => '?').join(', ');
      const updates = GAME_INDEX_COLUMNS.filter((c) => c !== 'join_code')
        .map((c) => `${c} = excluded.${c}`)
        .join(', ');
      this.sql.exec(
        `INSERT INTO game_index (${columns}, joined_at) VALUES (${placeholders}, ?)
           ON CONFLICT (join_code) DO UPDATE SET ${updates}`,
        ...gameBindValuesFor(entry),
        now,
      );
      recorded = true;
    });
    return recorded;
  }

  /**
   * The game itself has ceased to exist, so the pointer to it should too.
   *
   * Only `GameDO.collect` calls this, and only for a code nobody ever joined —
   * a played game is never deleted server-side (decision 0025). Unconditional,
   * because unlike {@link forgetGames} this is not a player choosing to lose a
   * row: the row is already pointing at nothing.
   */
  async dropGame(joinCode: string): Promise<void> {
    this.sql.exec(`DELETE FROM game_index WHERE join_code = ?`, joinCode);
  }

  /** Every game this account has a seat in. */
  async listGames(): Promise<GameIndexEntry[]> {
    return this.games();
  }

  /**
   * Forget games at the player's request (stage 2.3.4.2).
   *
   * The refusal lives here rather than in the route, because this is the only
   * place that knows what a row actually says. Clearing out old games is an
   * offer and never a timer (decision 0025), and the offer must never be able to
   * take away a game that is not over — `forgetIsRefused` is the one statement
   * of that rule and it is shared with the client, so the button is not offered
   * for a row the server would refuse anyway.
   *
   * A code that is not in the index counts as forgotten. The player asked for it
   * to be gone and it is gone; reporting "no such game" would be true and
   * useless.
   */
  async forgetGames(
    joinCodes: readonly string[],
  ): Promise<{ forgotten: string[]; kept: { joinCode: string; reason: string }[] }> {
    const forgotten: string[] = [];
    const kept: { joinCode: string; reason: string }[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const joinCode of joinCodes) {
        const [row] = [
          ...this.sql.exec<GameIndexRow>(
            `SELECT * FROM game_index WHERE join_code = ?`,
            joinCode,
          ),
        ];
        const refusal = row === undefined ? null : forgetIsRefused(entryFromRow(row));
        if (refusal !== null) {
          kept.push({ joinCode, reason: refusal });
          continue;
        }
        this.sql.exec(`DELETE FROM game_index WHERE join_code = ?`, joinCode);
        forgotten.push(joinCode);
      }
    });
    return { forgotten, kept };
  }

  private gameCount(): number {
    const [row] = [...this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM game_index`)];
    return row.n;
  }

  private games(): GameIndexEntry[] {
    return [
      ...this.sql.exec<GameIndexRow>(`SELECT * FROM game_index ORDER BY updated_at DESC`),
    ].map(entryFromRow);
  }

  private fields(): FieldSpec[] {
    return [
      ...this.sql.exec<FieldRow>(`SELECT * FROM fields ORDER BY updated_at DESC`),
    ].map(specFromRow);
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
