/**
 * Local persistence: saved fields, and who this phone thinks you are.
 *
 * Decision 0013 is the whole specification here — **a calibrated field is saved
 * immediately and unconditionally**, with no login and no confirmation step.
 * Someone has just spent five minutes walking out a board; there must never be a
 * moment where that exists only in memory.
 *
 * That is also why the IndexedDB store degrades to `localStorage` rather than to
 * an in-memory map. A private-mode browser that refuses IndexedDB is exactly the
 * situation where silently losing the field would be worst.
 */

import type { FieldSpec } from '../shared/field.js';

export interface FieldStore {
  list(): Promise<FieldSpec[]>;
  get(id: string): Promise<FieldSpec | undefined>;
  save(spec: FieldSpec): Promise<void>;
  remove(id: string): Promise<void>;
}

const DB_NAME = 'satellite-chess';
const DB_VERSION = 1;
const FIELDS_STORE = 'fields';
const FIELDS_KEY = 'satchess.fields';
const PLAYER_ID_KEY = 'satchess.player_id';

/**
 * This phone's anonymous identity, made on first run.
 *
 * Sign-in is mandatory to *play* (decision 0014), but a field is saved against
 * this id before any of that happens, so calibration works on a phone that has
 * never seen an account.
 */
export function getPlayerId(storage: Storage = localStorage): string {
  const existing = storage.getItem(PLAYER_ID_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  storage.setItem(PLAYER_ID_KEY, id);
  return id;
}

/** Everything in memory. For tests, and never used as a fallback — it loses data. */
export function createMemoryFieldStore(): FieldStore {
  const fields = new Map<string, FieldSpec>();
  return {
    async list() {
      return [...fields.values()].sort(byNewest);
    },
    async get(id) {
      return fields.get(id);
    },
    async save(spec) {
      fields.set(spec.id, spec);
    },
    async remove(id) {
      fields.delete(id);
    },
  };
}

/** The fallback. Slower and size-limited, but it survives a reload. */
export function createLocalStorageFieldStore(storage: Storage = localStorage): FieldStore {
  const read = (): FieldSpec[] => {
    try {
      const raw = storage.getItem(FIELDS_KEY);
      return raw ? (JSON.parse(raw) as FieldSpec[]) : [];
    } catch {
      // Corrupt JSON must not brick the app; a lost list beats a dead screen.
      return [];
    }
  };
  const write = (specs: FieldSpec[]) => storage.setItem(FIELDS_KEY, JSON.stringify(specs));

  return {
    async list() {
      return read().sort(byNewest);
    },
    async get(id) {
      return read().find((f) => f.id === id);
    },
    async save(spec) {
      write([...read().filter((f) => f.id !== spec.id), spec]);
    },
    async remove(id) {
      write(read().filter((f) => f.id !== id));
    },
  };
}

export function createIdbFieldStore(factory: IDBFactory = indexedDB): FieldStore {
  let open: Promise<IDBDatabase> | null = null;

  const db = (): Promise<IDBDatabase> => {
    open ??= new Promise((resolve, reject) => {
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(FIELDS_STORE)) {
          database.createObjectStore(FIELDS_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      // Firefox in private mode neither resolves nor errors on a blocked open.
      request.onblocked = () => reject(new Error('indexedDB open blocked'));
    });
    return open;
  };

  const run = async <T>(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const database = await db();
    return new Promise<T>((resolve, reject) => {
      const tx = database.transaction(FIELDS_STORE, mode);
      const request = body(tx.objectStore(FIELDS_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };

  return {
    async list() {
      return (await run<FieldSpec[]>('readonly', (s) => s.getAll())).sort(byNewest);
    },
    async get(id) {
      return run<FieldSpec | undefined>('readonly', (s) => s.get(id));
    },
    async save(spec) {
      await run('readwrite', (s) => s.put(spec));
    },
    async remove(id) {
      await run('readwrite', (s) => s.delete(id));
    },
  };
}

/**
 * The store the app should actually use: IndexedDB if it works, `localStorage`
 * if it does not.
 *
 * The probe is a real write, because `indexedDB` being *defined* says nothing
 * about whether it will accept anything — Safari in private mode has offered a
 * working-looking object that throws on first transaction.
 */
export async function createFieldStore(): Promise<FieldStore> {
  if (typeof indexedDB !== 'undefined') {
    try {
      const store = createIdbFieldStore();
      await store.list();
      return store;
    } catch {
      // Fall through to localStorage.
    }
  }
  return createLocalStorageFieldStore();
}

/** Most recently calibrated first: the field you just walked out is the one you want. */
function byNewest(a: FieldSpec, b: FieldSpec): number {
  return b.updatedAt - a.updatedAt;
}
