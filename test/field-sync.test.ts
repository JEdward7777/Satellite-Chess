import { describe, expect, it } from 'vitest';

import { type FieldSpec, makeFieldSpec } from '../src/shared/field.js';
import { fromLocal } from '../src/shared/geo.js';
import {
  type SyncTransport,
  createFieldSync,
  createLocalStorageJournal,
  createMemoryJournal,
  syncOnce,
} from '../src/client/field-sync.js';
import { type FieldStore, createMemoryFieldStore } from '../src/client/store.js';

/**
 * Fields following an account to a second phone (stage 2.3.3.2).
 *
 * The copying is trivial. What is not trivial is **deleting**, and it is the
 * reason this file is long: without a memory of what the server has already
 * acknowledged, the phone in your pocket pushes back the field you deleted on
 * the other phone last week, for ever. Every test here is really about telling
 * "the server has never heard of this" apart from "the server used to hold this
 * and does not now", which are indistinguishable in a single list.
 *
 * The other rule under test throughout: **a failed sync costs synchronisation
 * and never costs a field** (decision 0013). No signal, no session and a broken
 * server all leave the phone holding exactly what it held.
 */

const A1 = { lat: 51.4779, lng: -0.0015 };

function field(id: string, over: Partial<FieldSpec> = {}): FieldSpec {
  return {
    ...makeFieldSpec(id, { a1: A1, h8: fromLocal(A1, { e: 56, n: 56 }) }, { id, now: 1000 }),
    ...over,
  };
}

/**
 * A stand-in for the account, with the Durable Object's rules: pushes are
 * last-write-wins on `updatedAt`, deletions are applied after them, and the
 * whole list comes back.
 */
function fakeServer(initial: FieldSpec[] = []) {
  const held = new Map(initial.map((f) => [f.id, f]));
  const calls: { push: FieldSpec[]; remove: string[] }[] = [];
  let answer: 'ok' | 'unauthenticated' | 'offline' | 'server' = 'ok';

  const transport: SyncTransport = async ({ push, remove }) => {
    calls.push({ push: [...push], remove: [...remove] });
    if (answer !== 'ok') return { ok: false, reason: answer };
    for (const spec of push) {
      const existing = held.get(spec.id);
      if (!existing || spec.updatedAt >= existing.updatedAt) held.set(spec.id, spec);
    }
    for (const id of remove) held.delete(id);
    return { ok: true, fields: [...held.values()], rejected: [] };
  };

  return {
    transport,
    calls,
    held,
    fail(reason: 'unauthenticated' | 'offline' | 'server') {
      answer = reason;
    },
    recover() {
      answer = 'ok';
    },
  };
}

async function storeWith(...specs: FieldSpec[]): Promise<FieldStore> {
  const store = createMemoryFieldStore();
  for (const spec of specs) await store.save(spec);
  return store;
}

async function ids(store: FieldStore): Promise<string[]> {
  return (await store.list()).map((f) => f.id).sort();
}

describe('pushing what this phone has', () => {
  it('sends everything the first time and nothing the second', async () => {
    const store = await storeWith(field('a'), field('b'));
    const journal = createMemoryJournal();
    const server = fakeServer();

    await syncOnce(store, journal, server.transport);
    expect(server.calls[0].push.map((f) => f.id).sort()).toEqual(['a', 'b']);

    // Every field is now acknowledged at the exact `updatedAt` the server holds,
    // so the steady state is a request with an empty body — which is what makes
    // syncing on every write affordable at all.
    const second = await syncOnce(store, journal, server.transport);
    expect(server.calls[1].push).toEqual([]);
    expect(second).toEqual({ kind: 'synced', changed: false, rejected: [] });
  });

  it('sends only what changed', async () => {
    const store = await storeWith(field('a'), field('b'));
    const journal = createMemoryJournal();
    const server = fakeServer();
    await syncOnce(store, journal, server.transport);

    await store.save(field('b', { name: 'Renamed', updatedAt: 2000 }));
    await syncOnce(store, journal, server.transport);

    expect(server.calls[1].push.map((f) => f.id)).toEqual(['b']);
    expect(server.held.get('b')?.name).toBe('Renamed');
  });
});

describe('taking what the account has', () => {
  it('brings in a field calibrated on the other phone', async () => {
    const store = await storeWith(field('mine'));
    const server = fakeServer([field('theirs')]);

    const outcome = await syncOnce(store, createMemoryJournal(), server.transport);

    expect(await ids(store)).toEqual(['mine', 'theirs']);
    expect(outcome).toEqual({ kind: 'synced', changed: true, rejected: [] });
  });

  it('takes a newer version and leaves an older one alone', async () => {
    const store = await storeWith(field('a', { name: 'Here', updatedAt: 5000 }));
    const journal = createMemoryJournal();

    // Older than what this phone holds: the server is behind, and overwriting
    // would undo a rename the player is looking at.
    const stale = fakeServer([field('a', { name: 'Stale', updatedAt: 1000 })]);
    await syncOnce(store, journal, stale.transport);
    expect((await store.get('a'))?.name).toBe('Here');

    const fresh = fakeServer([field('a', { name: 'Newer', updatedAt: 9000 })]);
    await syncOnce(store, journal, fresh.transport);
    expect((await store.get('a'))?.name).toBe('Newer');
  });
});

describe('deleting, which is the whole reason for the journal', () => {
  it('tells the server, once', async () => {
    const store = await storeWith(field('a'), field('b'));
    const journal = createMemoryJournal();
    const server = fakeServer();
    const sync = createFieldSync({ store, journal, transport: server.transport });

    await sync.sync();
    await sync.store.remove('a');
    await sync.sync();

    expect(server.held.has('a')).toBe(false);
    // The tombstone is spent, not kept: a delete replayed for ever would fight
    // any future field that happened to reuse the id.
    expect(journal.read().removed).toEqual({});
    expect(server.calls[server.calls.length - 1].remove).toEqual([]);
  });

  it('keeps the tombstone until a server has heard it', async () => {
    const store = await storeWith(field('a'));
    const journal = createMemoryJournal();
    const server = fakeServer();
    const sync = createFieldSync({ store, journal, transport: server.transport });
    await sync.sync();

    // Deleting a field in a park with no signal is the ordinary case.
    server.fail('offline');
    await sync.store.remove('a');
    expect(await ids(store)).toEqual([]);
    expect(Object.keys(journal.read().removed)).toEqual(['a']);

    server.recover();
    await sync.sync();
    expect(server.held.has('a')).toBe(false);
  });

  it('removes locally a field deleted on another phone', async () => {
    const store = await storeWith(field('a'), field('b'));
    const journal = createMemoryJournal();
    const server = fakeServer();
    await syncOnce(store, journal, server.transport);

    // The other phone deleted it. This one is now holding a field the account
    // says is gone, and the journal is the only thing that knows the difference
    // between that and a field the server has not caught up with.
    server.held.delete('b');
    const outcome = await syncOnce(store, journal, server.transport);

    expect(await ids(store)).toEqual(['a']);
    expect(outcome).toEqual({ kind: 'synced', changed: true, rejected: [] });
  });

  it('never deletes a field the server has not acknowledged', async () => {
    // A field the server refused — or one written a moment ago — comes back
    // absent from the list, and must not be mistaken for one deleted elsewhere.
    const store = await storeWith(field('rejected'));
    const journal = createMemoryJournal();
    const transport: SyncTransport = async () => ({ ok: true, fields: [], rejected: ['rejected'] });

    const outcome = await syncOnce(store, journal, transport);

    expect(await ids(store)).toEqual(['rejected']);
    expect(outcome).toEqual({ kind: 'synced', changed: false, rejected: ['rejected'] });
  });

  it('resurrects rather than deletes when the journal is lost', async () => {
    // Losing the journal is safe in exactly one direction, and this is the test
    // that says which. A cleared browser store, a new profile, a private window:
    // nothing is acknowledged, so nothing is deleted and everything is re-pushed.
    const store = await storeWith(field('a'));
    const server = fakeServer();
    await syncOnce(store, createMemoryJournal(), server.transport);

    server.held.clear();
    const outcome = await syncOnce(store, createMemoryJournal(), server.transport);

    expect(await ids(store)).toEqual(['a']);
    expect(server.held.has('a')).toBe(true);
    expect(outcome.kind).toBe('synced');
  });
});

describe('a failed sync costs synchronisation, never a field', () => {
  it('holds everything when nobody is signed in', async () => {
    // The ordinary state until stage 2.5.1, and not an error worth a screen.
    const store = await storeWith(field('a'));
    const journal = createMemoryJournal();
    const server = fakeServer();
    server.fail('unauthenticated');

    expect(await syncOnce(store, journal, server.transport)).toEqual({
      kind: 'skipped',
      reason: 'unauthenticated',
    });
    expect(await ids(store)).toEqual(['a']);
    expect(journal.read().acked).toEqual({});
  });

  it('holds everything when the request never lands', async () => {
    const store = await storeWith(field('a'));
    const server = fakeServer([field('b')]);
    server.fail('server');

    expect((await syncOnce(store, createMemoryJournal(), server.transport)).kind).toBe('skipped');
    expect(await ids(store)).toEqual(['a']);
  });
});

describe('the store the screens use', () => {
  it('saves locally before the network is asked anything', async () => {
    const store = createMemoryFieldStore();
    const server = fakeServer();
    server.fail('offline');
    const sync = createFieldSync({ store, journal: createMemoryJournal(), transport: server.transport });

    // Decision 0013: a field is on the phone the instant it is calibrated, and
    // the account is a replica. `save` resolving is the save being safe.
    await sync.store.save(field('walked-out'));
    expect(await ids(store)).toEqual(['walked-out']);
  });

  it('does not lose an edit made while a sync was in flight', async () => {
    const store = await storeWith(field('a', { name: 'Before', updatedAt: 1000 }));
    const journal = createMemoryJournal();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport: SyncTransport = async () => {
      await held;
      return { ok: true, fields: [field('a', { name: 'Server', updatedAt: 1500 })], rejected: [] };
    };

    const running = syncOnce(store, journal, transport);
    // The player renames it while the request is out. The response predates the
    // rename, so believing the list this pass started with would undo it.
    await store.save(field('a', { name: 'After', updatedAt: 3000 }));
    release();
    await running;

    expect((await store.get('a'))?.name).toBe('After');
  });

  it('coalesces a burst of writes into one more pass', async () => {
    const store = createMemoryFieldStore();
    const server = fakeServer();
    const sync = createFieldSync({ store, journal: createMemoryJournal(), transport: server.transport });

    // Re-calibration saves, renames and the copy taken from a joined game can
    // all land within a tick. Two passes in parallel would race over the
    // journal, so a pass in flight queues exactly one successor.
    await Promise.all([
      sync.store.save(field('a')),
      sync.store.save(field('b')),
      sync.store.save(field('c')),
    ]);
    await sync.sync();

    expect([...server.held.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(server.calls.length).toBeLessThanOrEqual(3);
  });

  it('never rejects, because every caller fires it and walks away', async () => {
    // A private-mode IndexedDB refuses on first transaction. An unhandled
    // rejection would be a red console line on a phone in a park, for a
    // background task whose failure is an ordinary state.
    const broken: FieldStore = {
      list: async () => {
        throw new Error('indexedDB refused');
      },
      get: async () => undefined,
      save: async () => {},
      remove: async () => {},
    };
    const sync = createFieldSync({
      store: broken,
      journal: createMemoryJournal(),
      transport: fakeServer().transport,
    });
    await expect(sync.sync()).resolves.toEqual({ kind: 'skipped', reason: 'local' });
  });

  it('tells the home screen when a sync changed what this phone holds', async () => {
    const store = createMemoryFieldStore();
    const server = fakeServer([field('from-the-other-phone')]);
    const sync = createFieldSync({ store, journal: createMemoryJournal(), transport: server.transport });

    let changes = 0;
    sync.onChange(() => changes++);

    await sync.sync();
    expect(changes).toBe(1);
    // A steady state must not redraw the screen under the player's thumb.
    await sync.sync();
    expect(changes).toBe(1);
  });
});

describe('the journal on disk', () => {
  it('survives a round trip and shrugs off corruption', () => {
    const storage = new Map<string, string>();
    const fake = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
    } as unknown as Storage;

    const journal = createLocalStorageJournal(fake);
    journal.write({ acked: { a: 5 }, removed: { b: 6 } });
    expect(createLocalStorageJournal(fake).read()).toEqual({ acked: { a: 5 }, removed: { b: 6 } });

    // Corrupt reads as absent, which is the direction that resurrects rather
    // than deletes.
    storage.set('satchess.field_sync', '{not json');
    expect(createLocalStorageJournal(fake).read()).toEqual({ acked: {}, removed: {} });

    storage.set('satchess.field_sync', '{"acked":{"a":"soon"},"removed":null}');
    expect(createLocalStorageJournal(fake).read()).toEqual({ acked: {}, removed: {} });
  });
});
