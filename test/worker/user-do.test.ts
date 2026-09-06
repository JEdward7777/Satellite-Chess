import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { UserDO } from '../../src/worker/user-do.js';
import { applyUserSchema } from '../../src/worker/user-schema.js';

/**
 * The UserDO (stages 2.3.1 and 2.3.2), against the real runtime.
 *
 * Two things are worth testing here and neither of them is CRUD, because there
 * is no CRUD yet — `2.3.3.2` and `2.3.4` fill the tables.
 *
 * The first is **addressing**: `getByName(sub)` is the whole of the user model,
 * so "two subs are two accounts" and "the same sub is the same account" are the
 * load-bearing claims. Everything phase 2 stores depends on them and nothing
 * else enforces them.
 *
 * The second is **read-after-write**, which is the entire argument for a Durable
 * Object over KV (stage 2.3.2). Asserting it in the runtime that will actually
 * run it is the difference between a design note and a verified property — and
 * the same test written against KV is the one that would fail intermittently.
 */

const SECRET = 'test-dev-auth-secret';
const LOCAL = 'http://127.0.0.1';

const mutableEnv = env as unknown as Record<string, unknown>;

/** As in `identity.test.ts`: secrets are set out of band, so tests set them here. */
function withSecret(): void {
  mutableEnv.DEV_AUTH_SECRET = SECRET;
}

/** A signed-in session for `sub`, as the `satchess_session=...` cookie pair. */
async function signIn(sub: string): Promise<string> {
  const response = await SELF.fetch(`${LOCAL}/api/dev/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-auth-secret': SECRET },
    body: JSON.stringify({ sub }),
  });
  expect(response.status).toBe(200);
  return (response.headers.get('set-cookie') as string).split(';')[0];
}

interface MeBody {
  sub: string;
  via: string;
  account: { sub: string; firstSeenAt: number; lastSeenAt: number };
}

async function me(cookie: string): Promise<MeBody> {
  const response = await SELF.fetch(`${LOCAL}/api/me`, { headers: { cookie } });
  expect(response.status).toBe(200);
  return response.json<MeBody>();
}

/** The object as addressed by the code under test, for direct inspection. */
function stubFor(sub: string) {
  return env.USER.getByName(sub) as unknown as DurableObjectStub<UserDO>;
}

describe('addressing', () => {
  it('creates an account on first contact, with no sign-up step', async () => {
    withSecret();
    // The first request from a new player is indistinguishable from the
    // thousandth, so it has to work rather than 404 into a registration flow.
    const body = await me(await signIn('brand-new-player'));
    expect(body.account.sub).toBe('brand-new-player');
    expect(body.account.firstSeenAt).toBeGreaterThan(0);
    expect(body.account.lastSeenAt).toBeGreaterThanOrEqual(body.account.firstSeenAt);
  });

  it('gives two subs two accounts', async () => {
    withSecret();
    const alice = await me(await signIn('alice-two-accounts'));
    const bob = await me(await signIn('bob-two-accounts'));

    expect(alice.account.sub).toBe('alice-two-accounts');
    expect(bob.account.sub).toBe('bob-two-accounts');

    // Not merely different in what they report — different objects. Everything
    // stored per-player rests on this and nothing else checks it.
    await runInDurableObject(stubFor('alice-two-accounts'), async (instance: UserDO) => {
      expect((await instance.account())?.sub).toBe('alice-two-accounts');
    });
    await runInDurableObject(stubFor('bob-two-accounts'), async (instance: UserDO) => {
      expect((await instance.account())?.sub).toBe('bob-two-accounts');
    });
  });

  it('returns the same account for the same sub, keeping first_seen_at', async () => {
    withSecret();
    const first = await me(await signIn('returning-player'));
    // A second sign-in is a new token but the same person, which is the case
    // that would break if the account were keyed on anything session-shaped.
    const second = await me(await signIn('returning-player'));

    expect(second.account.firstSeenAt).toBe(first.account.firstSeenAt);
    expect(second.account.lastSeenAt).toBeGreaterThanOrEqual(first.account.lastSeenAt);
  });

  it('refuses to hold a second account, because that means addressing broke', async () => {
    // The invariant is loud on purpose. The quiet version of this failure is one
    // player reading another player's saved fields.
    await runInDurableObject(stubFor('addressing-invariant'), async (instance: UserDO) => {
      await instance.touch('addressing-invariant');
      await expect(instance.touch('somebody-else')).rejects.toThrow(/addressed as/);
    });
  });
});

describe('a Durable Object rather than KV (stage 2.3.2)', () => {
  it('reads back a write immediately, which is the whole argument', async () => {
    // The deciding case, in miniature: walk out a field, tap confirm, and see it
    // on the home screen a second later. Against KV's propagation window that
    // read returns the *old* value, and the player calibrates the board again.
    await runInDurableObject(stubFor('read-after-write'), async (instance: UserDO) => {
      const written = await instance.touch('read-after-write', 1_000);
      const read = await instance.account();
      expect(read).toEqual(written);
    });
  });

  it('survives a restart, because the state is on disk rather than in memory', async () => {
    withSecret();
    const before = await me(await signIn('persistent-player'));

    // A fresh stub is a fresh instance of the class: the constructor runs again
    // and re-applies the schema. An account that lived in a field on the object
    // would be gone here, and the DO hibernates constantly.
    await runInDurableObject(stubFor('persistent-player'), async (instance: UserDO) => {
      const account = await instance.account();
      expect(account?.sub).toBe('persistent-player');
      expect(account?.firstSeenAt).toBe(before.account.firstSeenAt);
    });
  });
});

describe('the schema', () => {
  it('creates both tables named by the stage, and applies twice without error', async () => {
    await runInDurableObject(stubFor('schema-check'), async (instance: UserDO, state) => {
      const tables = [
        ...state.storage.sql.exec<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table'`,
        ),
      ].map((row) => row.name);

      expect(tables).toContain('fields');
      expect(tables).toContain('game_index');
      expect(tables).toContain('account');

      // Idempotent DDL is the substitute for a migration framework here, so
      // "applies cleanly on every wake" is the property that stands in for it.
      // The constructor has already run it once; this is the second wake.
      expect(() => applyUserSchema(state.storage.sql)).not.toThrow();
      expect(await instance.account()).toBeNull();
    });
  });

  it('has no route from a field back to the players on it (decision 0017)', async () => {
    // The asymmetry is the privacy model, and it is the kind of thing a future
    // session tidies away as a missing index. A field→players edge is a list of
    // where somebody can be found on a Sunday morning, so it is left
    // un-buildable rather than merely unbuilt.
    await runInDurableObject(stubFor('asymmetry-check'), async (_instance: UserDO, state) => {
      const columns = [
        ...state.storage.sql.exec<{ name: string }>(`PRAGMA table_info(fields)`),
      ].map((row) => row.name);

      // An assertion that something is absent passes for free against an empty
      // list, so prove the list is real first — a PRAGMA that returned nothing
      // would otherwise make this test permanently and silently green.
      expect(columns).toContain('lineage_key');
      expect(columns).toContain('a1_lat');

      for (const forbidden of ['owner_sub', 'player_id', 'shared_by', 'sub']) {
        expect(columns).not.toContain(forbidden);
      }
    });
  });
});
