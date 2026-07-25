/**
 * Keep the screen awake while a game is on.
 *
 * Not a nicety. The phone is in a hand, in a field, and the player is looking at
 * it every few seconds while walking — but not *touching* it, because both hands
 * are busy walking. A screen that locks mid-sprint ends the game.
 *
 * The awkward part is that the lock is dropped whenever the page is hidden, and
 * **does not come back on its own**. Locking the phone deliberately, taking a
 * call, or switching apps to read a message all silently disarm it, so the only
 * correct implementation re-acquires on every return to visibility. That is the
 * whole reason this is a module rather than one line at start-up.
 */

export interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

export interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

/** The bits of `document` this needs, so it can be driven from a test. */
export interface VisibilitySource {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface ScreenLock {
  /** Ask for the lock, and keep asking after every interruption. */
  acquire(): Promise<void>;
  /** Give it up and stop re-acquiring. */
  release(): Promise<void>;
  /** Whether the lock is held right now. */
  readonly held: boolean;
  /** False on a browser with no Wake Lock API — Safari before 16.4, say. */
  readonly supported: boolean;
}

export interface ScreenLockOptions {
  wakeLock?: WakeLockLike | null;
  visibility?: VisibilitySource;
  /** Called when a re-acquire fails, so a view can say the screen may sleep. */
  onLost?(): void;
}

class WakeLockScreenLock implements ScreenLock {
  private sentinel: WakeLockSentinelLike | null = null;
  /** What the caller asked for, as opposed to what the browser is doing. */
  private wanted = false;
  private readonly onVisibilityChange: () => void;

  constructor(private readonly opts: ScreenLockOptions) {
    this.onVisibilityChange = () => {
      if (this.wanted && this.opts.visibility?.visibilityState === 'visible') {
        void this.request();
      }
    };
    this.opts.visibility?.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  get supported(): boolean {
    return Boolean(this.opts.wakeLock);
  }

  get held(): boolean {
    return this.sentinel !== null && !this.sentinel.released;
  }

  async acquire(): Promise<void> {
    this.wanted = true;
    await this.request();
  }

  async release(): Promise<void> {
    this.wanted = false;
    const sentinel = this.sentinel;
    this.sentinel = null;
    this.opts.visibility?.removeEventListener('visibilitychange', this.onVisibilityChange);
    if (sentinel && !sentinel.released) await sentinel.release();
  }

  private async request(): Promise<void> {
    if (!this.opts.wakeLock || this.held) return;
    try {
      const sentinel = await this.opts.wakeLock.request('screen');
      // A lock dropped while hidden fires this; the visibility handler is what
      // actually gets it back, since a request while hidden is rejected.
      sentinel.addEventListener('release', () => {
        if (this.sentinel === sentinel) this.sentinel = null;
      });
      this.sentinel = sentinel;
    } catch {
      // Rejected when the document is hidden, or on a low-power-mode phone.
      // Not fatal and not worth a dialogue — the screen simply may sleep.
      this.sentinel = null;
      this.opts.onLost?.();
    }
  }
}

export function createScreenLock(opts: ScreenLockOptions = {}): ScreenLock {
  return new WakeLockScreenLock(opts);
}

/** What `createScreenLock` should be handed in a real browser. */
export function browserScreenLockOptions(): ScreenLockOptions {
  return {
    wakeLock: typeof navigator === 'undefined' ? null : (navigator.wakeLock ?? null),
    visibility: typeof document === 'undefined' ? undefined : document,
  };
}
