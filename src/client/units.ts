/**
 * Which units this phone shows distances in (stage 2.3.8, decision 0049).
 *
 * **An account setting, cached on the phone.** The choice lives on the UserDO,
 * so it follows the player to their second phone, and `/api/me` hands it back
 * on every launch — the request the phone was making anyway. The phone keeps a
 * copy for a launch with no signal, exactly as it keeps who it is (decision
 * 0039): the copy is words, never a door. It decides how "12 m" is written and
 * nothing else; it is never sent anywhere except as the player's own choice.
 *
 * **Never chosen is not metric.** An account with no choice gets whatever this
 * browser's locale suggests (`unitsForLocale`), so an American reads feet
 * without looking for a setting, and nothing is written to the account until
 * the player actually picks. Once they pick, the account's answer wins on every
 * phone.
 *
 * **A choice made offline is not lost.** It is shown at once and written down
 * as `pending`; the next launch that reaches the server sends it before
 * believing the server's older answer. Without that, the account's "metric"
 * would overwrite the "US" the player chose in a field with no signal, the
 * next time they opened the app at home.
 *
 * Views read {@link displayUnits}`().get()` when they draw, and pass it to the
 * formatters in `shared/units.ts`, which are the only place a meter becomes a
 * foot.
 */

import { type Units, asUnits, unitsForLocale } from '../shared/units.js';

/** Beside the identity, under the same prefix. */
export const UNITS_KEY = 'satchess.units';

/** The slice of `Storage` this needs, so a test can hand in a map. */
export type UnitsStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** What the phone remembers: the units, and whether the account has them yet. */
export interface CachedUnits {
  units: Units;
  /** Chosen on this phone and not yet confirmed by the account. */
  pending: boolean;
}

export function readCachedUnits(storage: UnitsStorage | null): CachedUnits | null {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(UNITS_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { units?: unknown; pending?: unknown };
    const units = asUnits(parsed?.units);
    return units === null ? null : { units, pending: parsed.pending === true };
  } catch {
    return null;
  }
}

export function writeCachedUnits(storage: UnitsStorage | null, cached: CachedUnits): void {
  try {
    storage?.setItem(UNITS_KEY, JSON.stringify(cached));
  } catch {
    // A full or forbidden store costs the offline launch its units, nothing more.
  }
}

/**
 * Forget the account's units. Part of `forgetAccount`, so every route by
 * which an account stops being this phone's (decision 0039, rule 4) also
 * stops the next account inheriting a choice — or a pending push — that was
 * not theirs.
 */
export function clearCachedUnits(storage: UnitsStorage | null): void {
  try {
    storage?.removeItem(UNITS_KEY);
  } catch {
    // As above.
  }
}

/**
 * What a launch shows, and whether it owes the account a choice.
 *
 * `server` is the account's answer on a confirmed launch — `null` for "never
 * chosen" — and `undefined` when the server could not be asked. A pending
 * choice beats the server, because it is newer than anything the server has
 * seen; it is pushed only when there is a server to push to.
 */
export function launchUnits(
  server: Units | null | undefined,
  cached: CachedUnits | null,
  locale: string | null | undefined,
): { units: Units; cache: CachedUnits | null; push: boolean } {
  if (cached?.pending) return { units: cached.units, cache: cached, push: server !== undefined };
  if (server === undefined) return { units: cached?.units ?? unitsForLocale(locale), cache: cached, push: false };
  if (server === null) return { units: unitsForLocale(locale), cache: null, push: false };
  return { units: server, cache: { units: server, pending: false }, push: false };
}

/** Sends a choice to the account. True only when the account has it. */
export type UnitsPush = (units: Units) => Promise<boolean>;

export function browserUnitsPush(): UnitsPush {
  return async (units) => {
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ units }),
      });
      return response.ok;
    } catch {
      return false;
    }
  };
}

/**
 * Where the units in force came from: the account (`saved`), a choice on this
 * phone the account has not had yet (`pending`), or this browser's locale
 * because nobody has chosen (`default`).
 */
export type UnitsStatus = 'saved' | 'pending' | 'default';

export interface UnitsStore {
  get(): Units;
  status(): UnitsStatus;
  /**
   * Apply what a launch learned. `server` as for {@link launchUnits}. Reads
   * storage afresh, because an account change empties it just before.
   */
  launched(server: Units | null | undefined): void;
  /** The player picked. Shown at once; resolves true once the account has it. */
  choose(units: Units): Promise<boolean>;
  /** Called after every change, including a push landing. Returns the unsubscribe. */
  subscribe(fn: (units: Units) => void): () => void;
}

export function createUnitsStore(
  storage: UnitsStorage | null,
  push: UnitsPush,
  locale: string | null | undefined,
): UnitsStore {
  const remembered = readCachedUnits(storage);
  let current: Units = remembered?.units ?? unitsForLocale(locale);
  let status: UnitsStatus = statusOf(remembered);
  const listeners = new Set<(units: Units) => void>();
  const notify = () => {
    for (const fn of [...listeners]) fn(current);
  };

  /**
   * Pushes go one at a time, in the order they were chosen, so two quick taps
   * cannot reach the account in the wrong order and leave it holding the
   * first while this phone shows the second as saved.
   */
  let queue: Promise<unknown> = Promise.resolve();

  /** Push `units`, and mark it confirmed if it is still the choice when the answer lands. */
  const send = async (units: Units): Promise<boolean> => {
    const sent = queue.then(() => push(units));
    queue = sent.catch(() => false);
    const ok = await sent.catch(() => false);
    // A second tap may have changed it in the meantime; only the latest
    // choice may be marked as the account's.
    if (ok && current === units) {
      status = 'saved';
      writeCachedUnits(storage, { units, pending: false });
      notify();
    }
    return ok;
  };

  return {
    get: () => current,
    status: () => status,
    launched(server) {
      const result = launchUnits(server, readCachedUnits(storage), locale);
      current = result.units;
      status = statusOf(result.cache);
      if (result.cache === null) clearCachedUnits(storage);
      else writeCachedUnits(storage, result.cache);
      notify();
      if (result.push) void send(result.units);
    },
    choose(units) {
      current = units;
      status = 'pending';
      writeCachedUnits(storage, { units, pending: true });
      notify();
      return send(units);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

function statusOf(cached: CachedUnits | null): UnitsStatus {
  return cached === null ? 'default' : cached.pending ? 'pending' : 'saved';
}

/** `localStorage`, or null where touching it throws (some private modes do). */
export function browserUnitsStorage(): UnitsStorage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** The browser's first language, or null outside a browser. */
function browserLocale(): string | null {
  try {
    return navigator.languages?.[0] ?? navigator.language ?? null;
  } catch {
    return null;
  }
}

let shared: UnitsStore | null = null;

/** The page's one store. Made on first use, and told about the launch by `main.ts`. */
export function displayUnits(): UnitsStore {
  shared ??= createUnitsStore(browserUnitsStorage(), browserUnitsPush(), browserLocale());
  return shared;
}
