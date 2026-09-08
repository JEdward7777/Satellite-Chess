import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { type FieldSpec, makeFieldSpec } from '../../src/shared/field.js';
import { originKeyFor } from '../../src/shared/fieldlink.js';
import { fromLocal } from '../../src/shared/geo.js';
import type { UserDO } from '../../src/worker/user-do.js';
import { MAX_FIELDS_PER_ACCOUNT } from '../../src/worker/user-fields.js';

/**
 * `POST /api/fields/sync` against the real runtime (stage 2.3.3.2).
 *
 * The merge logic is tested in node (`test/field-sync.test.ts`); what needs the
 * runtime is everything that is really SQLite: the upsert's last-write-wins
 * clause, the transaction around a batch, and the claim the whole feature rests
 * on — **that one account's fields are unreachable from another's**, which is
 * the addressing invariant with real data behind it rather than an empty table.
 */

const SECRET = 'test-dev-auth-secret';
const LOCAL = 'http://127.0.0.1';
const A1 = { lat: 51.4779, lng: -0.0015 };

const mutableEnv = env as unknown as Record<string, unknown>;

function withSecret(): void {
  mutableEnv.DEV_AUTH_SECRET = SECRET;
}

async function signIn(sub: string): Promise<string> {
  withSecret();
  const response = await SELF.fetch(`${LOCAL}/api/dev/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-auth-secret': SECRET },
    body: JSON.stringify({ sub }),
  });
  expect(response.status).toBe(200);
  return (response.headers.get('set-cookie') as string).split(';')[0];
}

interface SyncBody {
  fields: FieldSpec[];
  rejected: string[];
}

async function sync(
  cookie: string | null,
  body: { push?: unknown[]; remove?: unknown[] } = {},
): Promise<Response> {
  return SELF.fetch(`${LOCAL}/api/fields/sync`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === null ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}

async function syncOk(cookie: string, body: { push?: unknown[]; remove?: unknown[] } = {}) {
  const response = await sync(cookie, body);
  expect(response.status).toBe(200);
  return response.json<SyncBody>();
}

function field(id: string, over: Partial<FieldSpec> = {}): FieldSpec {
  return {
    ...makeFieldSpec(id, { a1: A1, h8: fromLocal(A1, { e: 56, n: 56 }) }, { id, now: 1000 }),
    ...over,
  };
}

describe('the endpoint', () => {
  it('refuses to say anything to a request with no session', async () => {
    const response = await sync(null, { push: [field('a')] });
    expect(response.status).toBe(401);
    // Fields live on the phone whether or not anyone is signed in
    // (decision 0013), so the client reads this as "local only", not as failure.
    expect((await response.json<{ error: string }>()).error).toBe('unauthenticated');
  });

  it('creates the account on a first contact that is a sync', async () => {
    // There is no sign-up step to hang creation on, so a brand-new player's
    // very first request may perfectly well be this one.
    const cookie = await signIn('sync-first-contact');
    const body = await syncOk(cookie, { push: [field('a')] });
    expect(body.fields.map((f) => f.id)).toEqual(['a']);

    await runInDurableObject(
      env.USER.getByName('sync-first-contact') as unknown as DurableObjectStub<UserDO>,
      async (instance: UserDO) => {
        expect((await instance.account())?.sub).toBe('sync-first-contact');
      },
    );
  });

  it('reads back a write immediately, which is why this is not KV', async () => {
    const cookie = await signIn('sync-read-after-write');
    // The deciding case in miniature: tap confirm at the end of a calibration
    // and see the field. Against KV's propagation window this comes back empty.
    const body = await syncOk(cookie, { push: [field('just-walked')] });
    expect(body.fields.map((f) => f.id)).toEqual(['just-walked']);
    expect((await syncOk(cookie)).fields.map((f) => f.id)).toEqual(['just-walked']);
  });

  it('round-trips four corners, accuracies and provenance through SQLite', async () => {
    const cookie = await signIn('sync-round-trip');
    const spec: FieldSpec = {
      ...makeFieldSpec(
        'The pitch',
        {
          a1: A1,
          h1: fromLocal(A1, { e: 70, n: 0 }),
          h8: fromLocal(A1, { e: 70, n: 42 }),
          a8: fromLocal(A1, { e: 0, n: 42 }),
        },
        { id: 'pitch', accuracy: { a1: 3.2, h8: 4.1 }, now: 2000 },
      ),
      origin: { key: originKeyFor('theirs'), version: 2, via: 'game' },
    };

    const body = await syncOk(cookie, { push: [spec] });
    expect(body.fields[0]).toEqual(spec);
  });
});

describe('last write wins, on the field’s own clock', () => {
  it('keeps the later edit whichever phone reconnected first', async () => {
    const cookie = await signIn('sync-last-write');
    await syncOk(cookie, { push: [field('a', { name: 'Later', updatedAt: 9000 })] });

    // The other phone was out of signal and is only now catching up with an
    // edit the player made first. Arrival order is which phone found a bar of
    // signal; it has nothing to do with which rename was meant.
    const body = await syncOk(cookie, { push: [field('a', { name: 'Earlier', updatedAt: 5000 })] });
    expect(body.fields[0].name).toBe('Later');

    const newer = await syncOk(cookie, { push: [field('a', { name: 'Newest', updatedAt: 12000 })] });
    expect(newer.fields[0].name).toBe('Newest');
  });

  it('keeps the earliest creation stamp, because a field is created once', async () => {
    const cookie = await signIn('sync-created-at');
    await syncOk(cookie, { push: [field('a', { createdAt: 1000, updatedAt: 1000 })] });
    const body = await syncOk(cookie, { push: [field('a', { createdAt: 8000, updatedAt: 8000 })] });
    expect(body.fields[0].createdAt).toBe(1000);
  });

  it('applies a deletion after the pushes in the same batch', async () => {
    const cookie = await signIn('sync-delete-order');
    await syncOk(cookie, { push: [field('a'), field('b')] });
    // A phone that renamed a field and then deleted it in one offline stretch
    // sends both. The delete is the later act and the one the player remembers.
    const body = await syncOk(cookie, {
      push: [field('a', { name: 'Renamed', updatedAt: 5000 })],
      remove: ['a'],
    });
    expect(body.fields.map((f) => f.id)).toEqual(['b']);
  });

  it('ignores a deletion for a field it does not hold', async () => {
    const cookie = await signIn('sync-delete-unknown');
    const body = await syncOk(cookie, { remove: ['never-existed'] });
    expect(body.fields).toEqual([]);
  });
});

describe('nothing from a phone is believed', () => {
  it('drops a bad field and stores the good ones beside it', async () => {
    const cookie = await signIn('sync-partial');
    // One corrupt row on a phone must not be able to stop every other field
    // from ever reaching the account.
    const body = await syncOk(cookie, {
      push: [field('good'), { ...field('degenerate'), h8: A1 }, { id: 'no-geometry-at-all' }],
    });

    expect(body.fields.map((f) => f.id)).toEqual(['good']);
    expect(body.rejected.sort()).toEqual(['degenerate', 'no-geometry-at-all']);
  });

  it('refuses a body that is not two lists', async () => {
    const cookie = await signIn('sync-bad-body');
    expect((await sync(cookie, { push: 'everything' as unknown as unknown[] })).status).toBe(400);
    expect((await sync(cookie, { remove: 'all' as unknown as unknown[] })).status).toBe(400);
  });

  it('refuses a batch larger than an account may hold', async () => {
    const cookie = await signIn('sync-too-many');
    const push = Array.from({ length: MAX_FIELDS_PER_ACCOUNT + 1 }, (_, i) => field(`f${i}`));
    expect((await sync(cookie, { push })).status).toBe(413);
  });

  it('stops an account being used as somebody else\u2019s database', async () => {
    // Not a quota — a field is four numbers and a name, and nobody has walked
    // out two hundred boards. It is the wall that stops an authenticated client
    // filling its own Durable Object with something that is not fields.
    const cookie = await signIn('sync-account-cap');
    const batch = (from: number) =>
      Array.from({ length: MAX_FIELDS_PER_ACCOUNT }, (_, i) => field(`f${from + i}`));

    const first = await syncOk(cookie, { push: batch(0) });
    expect(first.fields).toHaveLength(MAX_FIELDS_PER_ACCOUNT);
    expect(first.rejected).toEqual([]);

    const second = await syncOk(cookie, { push: batch(MAX_FIELDS_PER_ACCOUNT) });
    expect(second.fields).toHaveLength(MAX_FIELDS_PER_ACCOUNT);
    expect(second.rejected).toHaveLength(MAX_FIELDS_PER_ACCOUNT);
    // A field already held is still updatable at the cap, which is what keeps a
    // full account from being a read-only one.
    const edit = await syncOk(cookie, { push: [field('f0', { name: 'Still mine', updatedAt: 9000 })] });
    expect(edit.rejected).toEqual([]);
    expect(edit.fields.find((f) => f.id === 'f0')?.name).toBe('Still mine');
  });

  it('answers anything but POST with 405', async () => {
    const response = await SELF.fetch(`${LOCAL}/api/fields/sync`);
    expect(response.status).toBe(405);
  });
});

describe('one account cannot see another’s ground', () => {
  it('keeps two players’ fields apart', async () => {
    // The addressing invariant with real rows behind it. A field is a precise
    // geolocation, so the quiet version of this failure is one player reading
    // where another person stands on a Sunday morning (decision 0017).
    const alice = await signIn('fields-alice');
    const bob = await signIn('fields-bob');

    await syncOk(alice, { push: [field('alice-common')] });
    const bobs = await syncOk(bob, { push: [field('bob-park')] });

    expect(bobs.fields.map((f) => f.id)).toEqual(['bob-park']);
    expect((await syncOk(alice)).fields.map((f) => f.id)).toEqual(['alice-common']);

    // And a delete names an id, so it must not reach across either.
    await syncOk(bob, { remove: ['alice-common'] });
    expect((await syncOk(alice)).fields.map((f) => f.id)).toEqual(['alice-common']);
  });

  it('has no column naming a player on a field, even now there are rows', async () => {
    const cookie = await signIn('fields-asymmetry');
    await syncOk(cookie, { push: [field('somewhere')] });

    await runInDurableObject(
      env.USER.getByName('fields-asymmetry') as unknown as DurableObjectStub<UserDO>,
      async (_instance: UserDO, state) => {
        const [row] = [
          ...state.storage.sql.exec<Record<string, SqlStorageValue>>(`SELECT * FROM fields LIMIT 1`),
        ];
        expect(row).toBeDefined();
        for (const forbidden of ['owner_sub', 'player_id', 'shared_by', 'sub']) {
          expect(Object.keys(row)).not.toContain(forbidden);
        }
      },
    );
  });
});
