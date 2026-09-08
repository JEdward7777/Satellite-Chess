/**
 * Saved fields, on the account as well as on the phone (stage 2.3.3.2).
 *
 * ## The phone is still where a field is saved
 *
 * Decision 0013 has not moved: calibrating a field writes it to this phone,
 * immediately and unconditionally, with no account and no network. What follows
 * is a **replica**, and everything here is arranged so that the replica can fail
 * — no signal, no session, a 500 — without ever costing ground somebody spent
 * five minutes walking out. Nothing in this file is ever awaited before a screen
 * is shown, and nothing in it can delete a field the server has never seen.
 *
 * ## Why there is a journal rather than just a list
 *
 * Two phones and a delete is what makes this more than "push everything". If the
 * phone in your pocket pushes whatever it holds, then a field you deleted on the
 * other phone last week comes straight back, for ever. Something has to
 * distinguish *"I have this and the server has never heard of it"* from *"I have
 * this and the server used to as well"*, and that is the whole content of the
 * journal:
 *
 * - `acked` — the `updatedAt` the server last confirmed for each field. A field
 *   whose local `updatedAt` differs is a local edit waiting to go out; a field
 *   that is acked but absent from the server's list was deleted elsewhere, and
 *   is the only case in which this code removes anything locally.
 * - `removed` — fields deleted here, kept until the server says it has heard.
 *   Deleting while out of signal is the ordinary case, not the exotic one.
 *
 * The journal is a cache of a conversation, so **losing it is safe in one
 * direction on purpose**. An empty journal means nothing is acked, so nothing is
 * ever deleted locally and everything is re-pushed: a lost journal resurrects a
 * deleted field at worst, and never loses a live one.
 *
 * ## Conflicts
 *
 * Last write wins, on `updatedAt`, both here and in the Durable Object. There is
 * no real conflict to resolve — both phones belong to the same person, so the
 * question is only which of their own two edits was later, and a merge dialogue
 * about a field's name would be worse than the problem.
 */

import type { FieldSpec } from '../shared/field.js';
import type { FieldStore } from './store.js';

/** What the phone remembers about its conversation with the account. */
export interface SyncJournalState {
  /** Field id → the `updatedAt` the server has confirmed holding. */
  acked: Record<string, number>;
  /** Field id → when it was deleted here, until the server has been told. */
  removed: Record<string, number>;
}

export interface SyncJournal {
  read(): SyncJournalState;
  write(state: SyncJournalState): void;
}

/** Where the journal lives. Small — a few numbers per saved field. */
const JOURNAL_KEY = 'satchess.field_sync';

export function emptyJournalState(): SyncJournalState {
  return { acked: {}, removed: {} };
}

export function createLocalStorageJournal(storage: Storage = localStorage): SyncJournal {
  return {
    read() {
      try {
        const raw = storage.getItem(JOURNAL_KEY);
        if (!raw) return emptyJournalState();
        const parsed = JSON.parse(raw) as Partial<SyncJournalState>;
        return {
          acked: asNumberMap(parsed.acked),
          removed: asNumberMap(parsed.removed),
        };
      } catch {
        // Corrupt is the same as absent, and absent is the safe direction.
        return emptyJournalState();
      }
    },
    write(state) {
      try {
        storage.setItem(JOURNAL_KEY, JSON.stringify(state));
      } catch {
        // A full or refused localStorage costs synchronisation, not fields.
      }
    },
  };
}

/** For tests, and for a browser that has no storage at all. */
export function createMemoryJournal(initial = emptyJournalState()): SyncJournal {
  let state = initial;
  return {
    read: () => state,
    write: (next) => {
      state = next;
    },
  };
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

export interface SyncRequest {
  push: FieldSpec[];
  remove: string[];
}

export type TransportResult =
  | { ok: true; fields: FieldSpec[]; rejected: string[] }
  /** Nobody is signed in. Ordinary, and not an error worth showing. */
  | { ok: false; reason: 'unauthenticated' }
  /** The request never reached a server. Also ordinary — this is a field. */
  | { ok: false; reason: 'offline' }
  | { ok: false; reason: 'server' };

export type SyncTransport = (request: SyncRequest) => Promise<TransportResult>;

/** The real one: `POST /api/fields/sync`, one round trip for the whole job. */
export function browserSyncTransport(fetcher: typeof fetch = fetch): SyncTransport {
  return async (request) => {
    let response: Response;
    try {
      response = await fetcher('/api/fields/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
    } catch {
      return { ok: false, reason: 'offline' };
    }
    if (response.status === 401) return { ok: false, reason: 'unauthenticated' };
    if (!response.ok) return { ok: false, reason: 'server' };
    try {
      const body = (await response.json()) as { fields?: unknown; rejected?: unknown };
      if (!Array.isArray(body.fields)) return { ok: false, reason: 'server' };
      return {
        ok: true,
        fields: body.fields as FieldSpec[],
        rejected: Array.isArray(body.rejected) ? (body.rejected as string[]) : [],
      };
    } catch {
      return { ok: false, reason: 'server' };
    }
  };
}

// ---------------------------------------------------------------------------
// The synchronisation itself
// ---------------------------------------------------------------------------

export type SyncOutcome =
  | { kind: 'synced'; changed: boolean; rejected: string[] }
  /**
   * Nothing happened, and nothing was lost.
   *
   * `local` is this phone's own store refusing to answer — a private-mode
   * IndexedDB, a full disk. It is listed beside the network reasons because the
   * response to all four is identical: leave everything where it is and try
   * again later.
   */
  | { kind: 'skipped'; reason: 'unauthenticated' | 'offline' | 'server' | 'local' };

/**
 * One pass: push what changed, name what was deleted, take the answer as truth.
 *
 * Exported for the tests, which are where the interesting cases are — a delete
 * on the other phone, an edit made while the request was in flight, a journal
 * that was thrown away. None of those is visible in a screenshot.
 */
export async function syncOnce(
  store: FieldStore,
  journal: SyncJournal,
  transport: SyncTransport,
): Promise<SyncOutcome> {
  const before = journal.read();
  const held = await store.list();

  const push = held.filter((field) => before.acked[field.id] !== field.updatedAt);
  const remove = Object.keys(before.removed);

  const result = await transport({ push, remove });
  if (!result.ok) return { kind: 'skipped', reason: result.reason };

  const server = new Map(result.fields.map((field) => [field.id, field]));
  // Re-read rather than reusing `held`: the player may have renamed or deleted
  // something while the request was in flight, and the phone's copy of a field
  // it has just edited must not lose to a server copy that predates the edit.
  const current = await store.list();
  const mine = new Map(current.map((field) => [field.id, field]));
  let changed = false;

  for (const [id, incoming] of server) {
    const local = mine.get(id);
    if (local === undefined || incoming.updatedAt > local.updatedAt) {
      await store.save(incoming);
      changed = true;
    }
  }

  for (const local of current) {
    if (server.has(local.id)) continue;
    // The only deletion this code ever performs, and the condition is the whole
    // reason the journal exists: the server has held this field before and does
    // not now, so it was deleted on another phone. A field the server has never
    // acknowledged is simply one it has not caught up with — most often because
    // it was just rejected, or written a moment ago.
    if (before.acked[local.id] !== undefined) {
      await store.remove(local.id);
      changed = true;
    }
  }

  // Tombstones raised while the request was in flight survive; the ones just
  // sent are done with.
  const after = journal.read();
  const removed: Record<string, number> = {};
  const sent = new Set(remove);
  for (const [id, at] of Object.entries(after.removed)) {
    if (!sent.has(id)) removed[id] = at;
  }
  journal.write({
    acked: Object.fromEntries([...server].map(([id, field]) => [id, field.updatedAt])),
    removed,
  });

  return { kind: 'synced', changed, rejected: result.rejected };
}

// ---------------------------------------------------------------------------
// What the app uses
// ---------------------------------------------------------------------------

export interface FieldSync {
  /**
   * The store the rest of the app talks to.
   *
   * Writes land locally first and always — the sync is what happens afterwards,
   * in the background, and its failure is invisible to the caller. Every screen
   * that saves, renames, re-calibrates or deletes a field therefore syncs it
   * without knowing that synchronisation exists.
   */
  store: FieldStore;
  /** Run now, awaiting the answer. Coalesces with a pass already running. */
  sync(): Promise<SyncOutcome>;
  /** Run soon, ignoring the answer. What a write triggers. */
  schedule(): void;
  /** Called when a sync changed what this phone holds. Returns an unsubscribe. */
  onChange(listener: () => void): () => void;
}

export function createFieldSync(opts: {
  store: FieldStore;
  journal: SyncJournal;
  transport: SyncTransport;
}): FieldSync {
  const { store: local, journal, transport } = opts;
  const listeners = new Set<() => void>();

  let running: Promise<SyncOutcome> | null = null;
  let rerun = false;

  const sync = async (): Promise<SyncOutcome> => {
    // A pass already under way has not seen the write that prompted this one, so
    // queue exactly one more rather than starting a second in parallel — two
    // concurrent passes would race over the journal.
    if (running !== null) {
      rerun = true;
      return running;
    }
    // Never rejects, because every caller fires this and walks away — an
    // unhandled rejection here would be a red console line on a phone in a
    // park, for a background task whose failure is already an ordinary state.
    running = syncOnce(local, journal, transport).catch(
      (): SyncOutcome => ({ kind: 'skipped', reason: 'local' }),
    );
    let outcome: SyncOutcome;
    try {
      outcome = await running;
    } finally {
      running = null;
    }
    if (outcome.kind === 'synced' && outcome.changed) {
      for (const listener of listeners) listener();
    }
    if (rerun) {
      rerun = false;
      return sync();
    }
    return outcome;
  };

  /**
   * The store the app sees.
   *
   * Only `remove` needs the journal: a save is recognised as pending by its
   * `updatedAt` not matching what the server acknowledged, but a delete leaves
   * nothing behind to notice, so it has to leave a note.
   */
  const store: FieldStore = {
    list: () => local.list(),
    get: (id) => local.get(id),
    async save(spec) {
      await local.save(spec);
      void sync();
    },
    async remove(id) {
      const state = journal.read();
      journal.write({ ...state, removed: { ...state.removed, [id]: Date.now() } });
      await local.remove(id);
      void sync();
    },
  };

  return {
    store,
    sync,
    schedule: () => void sync(),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function asNumberMap(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
}
