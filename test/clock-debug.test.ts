import { describe, expect, it } from 'vitest';

import type { GameSnapshot } from '../src/shared/protocol.js';
import {
  CLOCK_DEBUG_KEY,
  type FlagStorage,
  clockDebugText,
  readClockDebug,
  writeClockDebug,
} from '../src/client/clock-debug.js';

function memoryStorage(): FlagStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const throwing: FlagStorage = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
  removeItem: () => {
    throw new Error('denied');
  },
};

describe('the clock debug switch (O-31)', () => {
  it('is off by default', () => {
    expect(readClockDebug(memoryStorage())).toBe(false);
    expect(readClockDebug(null)).toBe(false);
  });

  it('remembers being switched on, and off again', () => {
    const storage = memoryStorage();
    expect(writeClockDebug(storage, true)).toBe(true);
    expect(storage.map.get(CLOCK_DEBUG_KEY)).toBe('1');
    expect(readClockDebug(storage)).toBe(true);
    expect(writeClockDebug(storage, false)).toBe(false);
    expect(storage.map.has(CLOCK_DEBUG_KEY)).toBe(false);
    expect(readClockDebug(storage)).toBe(false);
  });

  it('reads a storage that throws as off, and still toggles for the screen', () => {
    expect(readClockDebug(throwing)).toBe(false);
    expect(writeClockDebug(throwing, true)).toBe(true);
  });
});

describe('clockDebugText', () => {
  const game = {
    rev: 12,
    status: 'active',
    you: 'w',
    serverNow: 1_000_000,
    clock: { whiteMs: 1_795_000, blackMs: 1_800_000, incrementMs: 20_000, active: 'b', startedAt: 999_000 },
  } as unknown as GameSnapshot;

  it('prints the server\'s raw numbers, the timebase and what is shown', () => {
    // The phone's clock is an hour behind the server's; the snapshot is 2.5 s old.
    const text = clockDebugText(
      { game, gameAt: -2_600_000 },
      { mine: '29:55', theirs: '29:57' },
      -2_597_500,
    );
    expect(text).toContain('server w 1795000 b 1800000 inc 20000');
    expect(text).toContain('turn b · started 999000 · active');
    expect(text).toContain('serverNow 1000000 · offset +3600000 ms · age 2500 ms');
    expect(text).toContain('est. server now 1002500 · rev 12');
    expect(text).toContain('shown you(w) 29:55 · them 29:57');
  });

  it('says when the clock is stopped', () => {
    const stopped = { ...game, clock: { ...game.clock, startedAt: null } } as GameSnapshot;
    expect(clockDebugText({ game: stopped, gameAt: 0 }, { mine: '', theirs: '' }, 0)).toContain(
      'turn b · stopped',
    );
  });

  it('has nothing to say before the first snapshot', () => {
    expect(clockDebugText({ game: null, gameAt: null }, { mine: '', theirs: '' }, 0)).toBe(
      'server: no snapshot yet',
    );
  });
});
