import { describe, expect, it } from 'vitest';

import { forgetAccount } from '../src/client/account.js';
import {
  UNITS_KEY,
  type UnitsStorage,
  createUnitsStore,
  launchUnits,
  readCachedUnits,
  writeCachedUnits,
} from '../src/client/units.js';
import type { Units } from '../src/shared/units.js';

/**
 * The phone's half of the display-units setting (stage 2.3.8, decision 0049).
 *
 * The account holds the choice; the phone caches it for a launch with no
 * signal, and holds a choice made offline until the account has it. The
 * cache is words, never a door (decision 0039): nothing here opens or closes
 * anything, and the worst a wrong cache can do is write "ft" for "m".
 */

function memoryStorage(initial: Record<string, string> = {}): UnitsStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

/** A push that records what it was sent, and answers as told. */
function pushRecorder(answer: boolean | (() => Promise<boolean>) = true) {
  const sent: Units[] = [];
  const push = async (units: Units) => {
    sent.push(units);
    return typeof answer === 'function' ? answer() : answer;
  };
  return { sent, push };
}

const flush = () => new Promise((settle) => setTimeout(settle, 0));

describe('the cache', () => {
  it('round-trips, and reads anything malformed as nothing', () => {
    const storage = memoryStorage();
    writeCachedUnits(storage, { units: 'us', pending: true });
    expect(readCachedUnits(storage)).toEqual({ units: 'us', pending: true });
    for (const raw of ['nope', '{"units":"imperial"}', '[]', 'null', '{"pending":true}']) {
      expect(readCachedUnits(memoryStorage({ [UNITS_KEY]: raw }))).toBeNull();
    }
    expect(readCachedUnits(null)).toBeNull();
  });

  it('survives a storage that throws', () => {
    const throwing: UnitsStorage = {
      getItem: () => {
        throw new Error('private mode');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('no');
      },
    };
    expect(readCachedUnits(throwing)).toBeNull();
    expect(() => writeCachedUnits(throwing, { units: 'us', pending: false })).not.toThrow();
  });

  it('is emptied with the account (decision 0039, rule 4)', () => {
    const storage = memoryStorage();
    writeCachedUnits(storage, { units: 'us', pending: true });
    forgetAccount(storage, { write: () => undefined });
    expect(storage.data.has(UNITS_KEY)).toBe(false);
  });
});

describe('launchUnits', () => {
  it('takes the account’s answer on a confirmed launch, and remembers it', () => {
    expect(launchUnits('us', null, 'en-GB')).toEqual({
      units: 'us',
      cache: { units: 'us', pending: false },
      push: false,
    });
    expect(launchUnits('metric', { units: 'us', pending: false }, 'en-US').units).toBe('metric');
  });

  it('asks the locale when the account has never chosen, and remembers nothing', () => {
    expect(launchUnits(null, null, 'en-US')).toEqual({ units: 'us', cache: null, push: false });
    expect(launchUnits(null, null, 'en-GB')).toEqual({ units: 'metric', cache: null, push: false });
  });

  it('reads the memory when the server could not be asked, and the locale without one', () => {
    expect(launchUnits(undefined, { units: 'metric', pending: false }, 'en-US').units).toBe('metric');
    expect(launchUnits(undefined, null, 'en-US').units).toBe('us');
  });

  it('keeps a choice made offline over the account’s older answer, and sends it', () => {
    const pending = { units: 'us' as const, pending: true };
    expect(launchUnits('metric', pending, 'en-GB')).toEqual({ units: 'us', cache: pending, push: true });
    expect(launchUnits(null, pending, 'en-GB')).toEqual({ units: 'us', cache: pending, push: true });
    // Offline, it is kept and not sent: there is nobody to send it to.
    expect(launchUnits(undefined, pending, 'en-GB')).toEqual({ units: 'us', cache: pending, push: false });
  });
});

describe('the store', () => {
  it('starts from the memory, else the locale, before the launch has answered', () => {
    const remembered = memoryStorage();
    writeCachedUnits(remembered, { units: 'metric', pending: false });
    expect(createUnitsStore(remembered, pushRecorder().push, 'en-US').get()).toBe('metric');
    const fresh = createUnitsStore(memoryStorage(), pushRecorder().push, 'en-US');
    expect(fresh.get()).toBe('us');
    expect(fresh.status()).toBe('default');
  });

  it('shows a choice at once, then marks it saved when the account has it', async () => {
    const storage = memoryStorage();
    const { sent, push } = pushRecorder(true);
    const store = createUnitsStore(storage, push, 'en-GB');
    const heard: Units[] = [];
    store.subscribe((units) => heard.push(units));

    const done = store.choose('us');
    expect(store.get()).toBe('us');
    expect(store.status()).toBe('pending');
    expect(readCachedUnits(storage)).toEqual({ units: 'us', pending: true });

    expect(await done).toBe(true);
    expect(sent).toEqual(['us']);
    expect(store.status()).toBe('saved');
    expect(readCachedUnits(storage)).toEqual({ units: 'us', pending: false });
    expect(heard).toEqual(['us', 'us']);
  });

  it('keeps an offline choice pending, and sends it on the next confirmed launch', async () => {
    const storage = memoryStorage();
    const offline = pushRecorder(false);
    const first = createUnitsStore(storage, offline.push, 'en-GB');
    expect(await first.choose('us')).toBe(false);
    expect(first.status()).toBe('pending');

    // The next launch, with signal: the account still says metric.
    const online = pushRecorder(true);
    const next = createUnitsStore(storage, online.push, 'en-GB');
    next.launched('metric');
    expect(next.get()).toBe('us');
    await flush();
    expect(online.sent).toEqual(['us']);
    expect(next.status()).toBe('saved');
  });

  it('forgets a pending choice the account has changed underneath (a switched account)', () => {
    const storage = memoryStorage();
    writeCachedUnits(storage, { units: 'us', pending: true });
    const { sent, push } = pushRecorder(true);
    const store = createUnitsStore(storage, push, 'en-GB');
    // main.ts empties the cache through forgetAccount before telling the store.
    forgetAccount(storage, { write: () => undefined });
    store.launched(null);
    expect(store.get()).toBe('metric');
    expect(store.status()).toBe('default');
    expect(sent).toEqual([]);
  });

  it('sends two quick choices in order, and only marks the last one saved', async () => {
    const storage = memoryStorage();
    let release: (() => void) | null = null;
    const sent: Units[] = [];
    const push = async (units: Units) => {
      sent.push(units);
      if (units === 'us') await new Promise<void>((settle) => (release = settle));
      return true;
    };
    const store = createUnitsStore(storage, push, 'en-GB');
    const first = store.choose('us');
    const second = store.choose('metric');
    await flush();
    // The second waits for the first to be answered.
    expect(sent).toEqual(['us']);
    (release as unknown as () => void)();
    await first;
    await second;
    expect(sent).toEqual(['us', 'metric']);
    expect(store.get()).toBe('metric');
    expect(store.status()).toBe('saved');
    expect(readCachedUnits(storage)).toEqual({ units: 'metric', pending: false });
  });

  it('carries on after a push that throws', async () => {
    const storage = memoryStorage();
    let calls = 0;
    const push = async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return true;
    };
    const store = createUnitsStore(storage, push, 'en-GB');
    expect(await store.choose('us')).toBe(false);
    expect(await store.choose('us')).toBe(true);
    expect(store.status()).toBe('saved');
  });
});
