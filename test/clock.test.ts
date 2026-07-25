import { describe, expect, it } from 'vitest';

import {
  applyMove,
  flagFallAt,
  flaggedColor,
  formatClock,
  freeze,
  newClock,
  remainingMs,
  snapshot,
  start,
} from '../src/shared/clock.js';
import { generateJoinCode, normaliseJoinCode, formatJoinCode, joinUrl } from '../src/shared/joincode.js';

const T0 = 1_700_000_000_000;

describe('clock', () => {
  it('starts stopped, with no flag possible', () => {
    const c = newClock(600_000, 10_000);
    expect(c.startedAt).toBeNull();
    expect(flagFallAt(c)).toBeNull();
    expect(flaggedColor(c, T0 + 10 ** 9)).toBeNull();
    expect(remainingMs(c, 'w', T0 + 10 ** 9)).toBe(600_000);
  });

  it('only drains the active player', () => {
    const c = start(newClock(600_000, 10_000), T0);
    expect(remainingMs(c, 'w', T0 + 5_000)).toBe(595_000);
    expect(remainingMs(c, 'b', T0 + 5_000)).toBe(600_000);
  });

  it('banks elapsed time, adds the increment, and hands over', () => {
    let c = start(newClock(600_000, 10_000), T0);
    c = applyMove(c, T0 + 30_000);
    expect(c.active).toBe('b');
    expect(c.whiteMs).toBe(600_000 - 30_000 + 10_000);
    expect(c.blackMs).toBe(600_000);
    expect(c.startedAt).toBe(T0 + 30_000);
  });

  it('reconstructs identically from stored fields — nothing lives in memory', () => {
    let c = start(newClock(600_000, 10_000), T0);
    c = applyMove(c, T0 + 30_000);
    // Round-trip through JSON, as the DO does on every wake.
    const revived = JSON.parse(JSON.stringify(c));
    expect(remainingMs(revived, 'b', T0 + 45_000)).toBe(remainingMs(c, 'b', T0 + 45_000));
    expect(flagFallAt(revived)).toBe(flagFallAt(c));
  });

  it('freezes without charging anyone further', () => {
    const running = start(newClock(600_000, 10_000), T0);
    const frozen = freeze(running, T0 + 12_000);
    expect(frozen.startedAt).toBeNull();
    expect(frozen.whiteMs).toBe(588_000);
    // Time passing while frozen costs nothing.
    expect(remainingMs(frozen, 'w', T0 + 12_000 + 3_600_000)).toBe(588_000);
  });

  it('resumes from the frozen balance', () => {
    const frozen = freeze(start(newClock(600_000, 10_000), T0), T0 + 12_000);
    const resumed = start(frozen, T0 + 999_000);
    expect(remainingMs(resumed, 'w', T0 + 999_000 + 1_000)).toBe(587_000);
  });

  it('freezing twice is a no-op', () => {
    const frozen = freeze(start(newClock(600_000, 10_000), T0), T0 + 12_000);
    expect(freeze(frozen, T0 + 50_000)).toEqual(frozen);
  });

  it('predicts flag-fall to the exact millisecond', () => {
    const c = start(newClock(600_000, 10_000), T0);
    expect(flagFallAt(c)).toBe(T0 + 600_000);
    expect(flaggedColor(c, T0 + 599_999)).toBeNull();
    expect(flaggedColor(c, T0 + 600_000)).toBe('w');
  });

  it('moves the flag alarm to the new player after each move', () => {
    let c = start(newClock(600_000, 10_000), T0);
    c = applyMove(c, T0 + 30_000);
    expect(flagFallAt(c)).toBe(T0 + 30_000 + 600_000);
    expect(flaggedColor(c, T0 + 30_000 + 600_001)).toBe('b');
  });

  it('never reports a negative balance in a snapshot', () => {
    const c = start(newClock(1_000, 0), T0);
    expect(snapshot(c, T0 + 5_000)).toEqual({ w: 0, b: 1_000 });
    // The raw reading does go negative, which is how the DO detects an overrun.
    expect(remainingMs(c, 'w', T0 + 5_000)).toBe(-4_000);
  });

  it('cannot bank a negative balance when frozen past zero', () => {
    const frozen = freeze(start(newClock(1_000, 0), T0), T0 + 5_000);
    expect(frozen.whiteMs).toBe(0);
  });
});

describe('formatClock', () => {
  it('shows tenths under ten seconds', () => {
    expect(formatClock(9_400)).toBe('9.4');
    expect(formatClock(0)).toBe('0.0');
    expect(formatClock(-500)).toBe('0.0');
  });

  it('shows mm:ss in the normal range', () => {
    expect(formatClock(10_000)).toBe('0:10');
    expect(formatClock(65_000)).toBe('1:05');
    expect(formatClock(600_000)).toBe('10:00');
  });

  it('shows hours past an hour', () => {
    expect(formatClock(3_725_000)).toBe('1:02:05');
  });
});

describe('join codes', () => {
  it('generates six characters from the Crockford alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const c = generateJoinCode();
      expect(c).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
      expect(normaliseJoinCode(c)).toBe(c);
    }
  });

  it('never generates the excluded lookalikes', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) for (const ch of generateJoinCode()) seen.add(ch);
    for (const bad of ['I', 'L', 'O', 'U']) expect(seen.has(bad)).toBe(false);
  });

  it('folds lookalikes, case and separators when reading a typed code', () => {
    expect(normaliseJoinCode('abc123')).toBe('ABC123');
    expect(normaliseJoinCode('ABC 123')).toBe('ABC123');
    expect(normaliseJoinCode('abc-123')).toBe('ABC123');
    expect(normaliseJoinCode('OIL123')).toBe('011123');
    expect(normaliseJoinCode('uvwxy1')).toBe('VVWXY1');
  });

  it('rejects wrong lengths and out-of-alphabet characters', () => {
    expect(normaliseJoinCode('ABC12')).toBeNull();
    expect(normaliseJoinCode('ABC1234')).toBeNull();
    expect(normaliseJoinCode('ABC12!')).toBeNull();
    expect(normaliseJoinCode('')).toBeNull();
  });

  it('builds a join URL and a readable display form', () => {
    expect(formatJoinCode('ABC123')).toBe('ABC 123');
    expect(joinUrl('https://example.com/', 'ABC123')).toBe('https://example.com/j/ABC123');
  });
});
