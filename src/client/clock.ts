/**
 * The clock as the player sees it.
 *
 * The server owns the clock and is the only authority on it (`shared/clock.ts`
 * does the arithmetic, `GameDO` stores it and fires the flag alarm). This module
 * exists so that watching it tick costs **nothing**: a running clock redrawn ten
 * times a second from a snapshot the phone already has spends no requests, where
 * asking the server what time it is would spend one per tick and empty the
 * account's budget in a single game.
 *
 * The whole difficulty is that the snapshot's timestamps are on the *server's*
 * clock and the phone's has never been synchronised with it. Two phones in the
 * same field can disagree by minutes; one of them will be wrong about whether
 * you have flagged. So nothing here ever compares a stored timestamp against
 * `Date.now()` directly — it measures elapsed time locally and adds it to the
 * server's own reading of the moment the snapshot left. See
 * {@link estimateServerNow}.
 */

import { type ClockState, formatClock, snapshot as clockSnapshot } from '../shared/clock.js';
import type { GameSnapshot } from '../shared/protocol.js';
import type { Color } from '../shared/squares.js';

/**
 * What the server's clock reads right now, as well as this phone can tell.
 *
 * `game.serverNow` is the server's reading at the instant it built the snapshot;
 * `localNow - receivedAt` is how long ago that arrived, measured entirely in
 * local time so the two clocks' disagreement cancels out. Only the *rate* has to
 * match, and two quartz oscillators drift by milliseconds over a game.
 *
 * The estimate is short by the one-way network latency, since the snapshot was
 * already in flight when it was stamped. That is tens of milliseconds and it
 * errs in the player's favour — the screen shows very slightly more time than
 * they have, so it never announces a flag the server has not yet called.
 *
 * `Math.max(0, …)` because a phone's clock can step backwards under NTP
 * correction, and time running backwards on screen mid-game reads as a bug in
 * the game rather than in the handset.
 */
export function estimateServerNow(
  game: Pick<GameSnapshot, 'serverNow'>,
  receivedAt: number,
  localNow: number,
): number {
  return game.serverNow + Math.max(0, localNow - receivedAt);
}

/** Both clocks, already resolved into "mine" and "theirs" and formatted. */
export interface ClockReadout {
  mineMs: number;
  theirsMs: number;
  /** `formatClock` of the above — mm:ss, or tenths under ten seconds. */
  mine: string;
  theirs: string;
  /** Whether a clock is ticking at all. False while staging or suspended. */
  running: boolean;
  /** Whose clock is going down. */
  yourTurn: boolean;
}

/**
 * Read both clocks off a snapshot.
 *
 * "Mine" and "theirs" rather than white and black: the player knows which side
 * they are, and a clock labelled with a colour is one more thing to translate
 * while walking. `game.you` is the server's word for which seat this phone holds.
 */
export function clockReadout(
  game: Pick<GameSnapshot, 'clock' | 'serverNow' | 'you'>,
  receivedAt: number,
  localNow: number,
): ClockReadout {
  const at = estimateServerNow(game, receivedAt, localNow);
  const both = clockSnapshot(game.clock as ClockState, at);
  const them: Color = game.you === 'w' ? 'b' : 'w';
  return {
    mineMs: both[game.you],
    theirsMs: both[them],
    mine: formatClock(both[game.you]),
    theirs: formatClock(both[them]),
    running: game.clock.startedAt !== null,
    yourTurn: game.clock.active === game.you,
  };
}

// ---------------------------------------------------------------------------
// Running out of time, announced to a phone that is not being looked at
// ---------------------------------------------------------------------------

/**
 * Thresholds for the low-time warning.
 *
 * Both are longer than a chess clock's usual "under a minute" panic, because the
 * remedy here involves *walking*. Being told you have thirty seconds is useless
 * if the piece you have to place is forty metres away — you needed to know while
 * there was still time to get there. A minute is roughly a diagonal of a 64 m
 * board at a brisk walk (decision 0012 prices a move's travel at about twenty
 * seconds), so it is the last moment a warning can still change the outcome.
 */
export const LOW_TIME_MS = 60_000;
export const CRITICAL_TIME_MS = 15_000;

export type AlertLevel = 'none' | 'low' | 'critical';

const RANK: Record<AlertLevel, number> = { none: 0, low: 1, critical: 2 };

export function alertLevel(remainingMs: number): AlertLevel {
  if (remainingMs <= CRITICAL_TIME_MS) return 'critical';
  if (remainingMs <= LOW_TIME_MS) return 'low';
  return 'none';
}

/**
 * Whether crossing from `previous` to `current` is worth interrupting someone
 * for, and what to remember for next time.
 *
 * Fires only when the level gets *worse*, so a clock sitting at fifty seconds
 * announces itself once rather than ten times a second. Improving re-arms it,
 * which matters because the increment genuinely hands time back: a player who
 * climbs above a minute by moving quickly should be warned again if they fall
 * back under it.
 */
export function nextAlert(
  previous: AlertLevel,
  current: AlertLevel,
): { level: AlertLevel; fire: boolean } {
  return { level: current, fire: RANK[current] > RANK[previous] };
}

/**
 * Announce a low clock to a phone that is in a pocket or a swinging hand.
 *
 * Sound *and* vibration, because neither is reliable on its own outdoors: a
 * phone on silent has no sound, and a phone held flat in a hand while walking
 * has a vibration nobody feels. Between them one usually lands.
 */
export interface ClockAlerts {
  /**
   * Permit sound later, from inside a user gesture.
   *
   * Mobile browsers refuse to start audio except in a gesture handler, and the
   * refusal is silent. The game screen calls this on the first tap on the board,
   * which every player makes long before their clock is low.
   */
  arm(): void;
  fire(level: Exclude<AlertLevel, 'none'>): void;
  dispose(): void;
}

/** The slice of WebAudio this needs, so a test need not have one. */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  state: string;
  resume(): Promise<void>;
  close(): Promise<void>;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
}

export interface OscillatorLike {
  type: string;
  frequency: { value: number };
  connect(destination: unknown): void;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface GainLike {
  gain: { value: number; setValueAtTime(value: number, when: number): void;
    exponentialRampToValueAtTime(value: number, when: number): void };
  connect(destination: unknown): void;
}

export interface ClockAlertOptions {
  /** `navigator.vibrate`, already bound, or null where there is none. */
  vibrate?: ((pattern: number | number[]) => boolean) | null;
  /** Deferred, because constructing an AudioContext outside a gesture is wasted. */
  createAudio?: (() => AudioContextLike) | null;
}

/** Two short pulses for low, an urgent burst for critical. */
const VIBRATE: Record<Exclude<AlertLevel, 'none'>, number[]> = {
  low: [120, 80, 120],
  critical: [200, 90, 200, 90, 400],
};

/** A higher, more insistent note as it gets worse. */
const TONE_HZ: Record<Exclude<AlertLevel, 'none'>, number> = { low: 660, critical: 990 };

class BrowserClockAlerts implements ClockAlerts {
  private audio: AudioContextLike | null = null;

  constructor(private readonly opts: ClockAlertOptions) {}

  arm(): void {
    if (this.audio !== null || !this.opts.createAudio) return;
    try {
      this.audio = this.opts.createAudio();
      // Created inside a gesture but possibly still suspended — Safari starts it
      // that way and only a `resume()` from the same gesture unsticks it.
      if (this.audio.state === 'suspended') void this.audio.resume();
    } catch {
      // No audio on this browser, or blocked. Vibration still works.
      this.audio = null;
    }
  }

  fire(level: Exclude<AlertLevel, 'none'>): void {
    try {
      this.opts.vibrate?.(VIBRATE[level]);
    } catch {
      // Some browsers throw rather than returning false outside a gesture.
    }
    this.beep(level);
  }

  private beep(level: Exclude<AlertLevel, 'none'>): void {
    const audio = this.audio;
    if (audio === null) return;
    try {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = TONE_HZ[level];
      // Ramped down rather than stopped flat: an oscillator cut mid-cycle clicks,
      // and a click is exactly the sound a phone makes when something breaks.
      const now = audio.currentTime;
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
      osc.connect(gain as unknown as object);
      gain.connect(audio.destination);
      osc.start(now);
      osc.stop(now + 0.4);
    } catch {
      // A dead audio context must never take the game screen down with it.
    }
  }

  dispose(): void {
    const audio = this.audio;
    this.audio = null;
    if (audio) void audio.close().catch(() => {});
  }
}

export function createClockAlerts(opts: ClockAlertOptions = {}): ClockAlerts {
  return new BrowserClockAlerts(opts);
}

/** What `createClockAlerts` should be handed in a real browser. */
export function browserClockAlertOptions(): ClockAlertOptions {
  const AudioCtor =
    typeof globalThis === 'undefined'
      ? undefined
      : ((globalThis as Record<string, unknown>).AudioContext ??
        (globalThis as Record<string, unknown>).webkitAudioContext);
  return {
    vibrate:
      typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function'
        ? null
        : (pattern) => navigator.vibrate(pattern),
    createAudio:
      typeof AudioCtor === 'function'
        ? () => new (AudioCtor as new () => AudioContextLike)()
        : null,
  };
}
