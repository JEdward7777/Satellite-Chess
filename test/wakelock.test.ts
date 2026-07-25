import { describe, expect, it } from 'vitest';

import {
  type VisibilitySource,
  type WakeLockLike,
  type WakeLockSentinelLike,
  createScreenLock,
} from '../src/client/wakelock.js';

class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  private listeners: (() => void)[] = [];

  addEventListener(_type: 'release', listener: () => void): void {
    this.listeners.push(listener);
  }

  async release(): Promise<void> {
    this.drop();
  }

  /** What the platform does when the page is hidden. */
  drop(): void {
    this.released = true;
    for (const listener of this.listeners) listener();
  }
}

class FakeWakeLock implements WakeLockLike {
  requests = 0;
  refuse = false;
  readonly issued: FakeSentinel[] = [];

  async request(_type: 'screen'): Promise<WakeLockSentinelLike> {
    this.requests++;
    if (this.refuse) throw new Error('refused');
    const sentinel = new FakeSentinel();
    this.issued.push(sentinel);
    return sentinel;
  }

  get latest(): FakeSentinel {
    return this.issued[this.issued.length - 1];
  }
}

class FakeVisibility implements VisibilitySource {
  visibilityState: DocumentVisibilityState = 'visible';
  private listeners = new Set<() => void>();

  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  async set(state: DocumentVisibilityState): Promise<void> {
    this.visibilityState = state;
    for (const listener of [...this.listeners]) listener();
    // Let the handler's async re-acquire settle.
    await Promise.resolve();
    await Promise.resolve();
  }
}

describe('createScreenLock', () => {
  it('takes the lock when asked', async () => {
    const wakeLock = new FakeWakeLock();
    const lock = createScreenLock({ wakeLock, visibility: new FakeVisibility() });

    expect(lock.held).toBe(false);
    await lock.acquire();
    expect(lock.held).toBe(true);
    expect(wakeLock.requests).toBe(1);
  });

  it('re-acquires after the platform drops it on hide — the whole point', async () => {
    const wakeLock = new FakeWakeLock();
    const visibility = new FakeVisibility();
    const lock = createScreenLock({ wakeLock, visibility });
    await lock.acquire();

    // Taking a call: the page hides and the lock is silently dropped.
    wakeLock.latest.drop();
    await visibility.set('hidden');
    expect(lock.held).toBe(false);

    await visibility.set('visible');
    expect(lock.held).toBe(true);
    expect(wakeLock.requests).toBe(2);
  });

  it('does not re-acquire while still hidden, since the request would be refused', async () => {
    const wakeLock = new FakeWakeLock();
    const visibility = new FakeVisibility();
    const lock = createScreenLock({ wakeLock, visibility });
    await lock.acquire();
    wakeLock.latest.drop();

    await visibility.set('hidden');
    expect(wakeLock.requests).toBe(1);
  });

  it('stays released once the caller has let it go', async () => {
    const wakeLock = new FakeWakeLock();
    const visibility = new FakeVisibility();
    const lock = createScreenLock({ wakeLock, visibility });

    await lock.acquire();
    await lock.release();
    expect(lock.held).toBe(false);

    await visibility.set('hidden');
    await visibility.set('visible');
    expect(wakeLock.requests).toBe(1);
    // And it is no longer listening at all.
    expect(visibility.listenerCount).toBe(0);
  });

  it('does not stack locks when acquired twice', async () => {
    const wakeLock = new FakeWakeLock();
    const lock = createScreenLock({ wakeLock, visibility: new FakeVisibility() });
    await lock.acquire();
    await lock.acquire();
    expect(wakeLock.requests).toBe(1);
  });

  it('survives a refusal without throwing at the caller', async () => {
    const wakeLock = new FakeWakeLock();
    wakeLock.refuse = true;
    let lost = 0;
    const lock = createScreenLock({
      wakeLock,
      visibility: new FakeVisibility(),
      onLost: () => lost++,
    });

    await expect(lock.acquire()).resolves.toBeUndefined();
    expect(lock.held).toBe(false);
    expect(lost).toBe(1);
  });

  it('reports being unsupported rather than pretending', async () => {
    const lock = createScreenLock({ wakeLock: null, visibility: new FakeVisibility() });
    expect(lock.supported).toBe(false);
    await lock.acquire();
    expect(lock.held).toBe(false);
  });
});
