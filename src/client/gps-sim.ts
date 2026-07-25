/**
 * A GPS you can walk around by hand.
 *
 * There is no satellite in a container, so this is the only way anything that
 * depends on position — calibration, reach, the whole carry rule — gets
 * exercised before someone stands in a field. It implements the same
 * {@link GpsProvider} interface as the real thing and reuses {@link GpsCore},
 * so the quality verdict, the distance accumulator and the coarse-location
 * detector are the same code in the simulator as on the phone.
 *
 * Time is explicit. `advance(ms)` steps the world and emits whatever fixes fall
 * inside that interval, which makes a test a straight line of code rather than a
 * pile of timers, and lets a thirty-minute game run in a millisecond. The
 * browser drives the same method from a real interval (see {@link runSimClock}).
 */

import {
  type LatLng,
  fromLocal,
  length,
  normalise,
  scale,
  toLocal,
} from '../shared/geo.js';
import type { ReachConfig } from '../shared/reach.js';
import { GpsCore, type GpsProvider, type GpsState, type Platform } from './gps.js';

/** Roughly what a phone gives you: one fix a second. */
export const DEFAULT_FIX_INTERVAL_MS = 1000;

/** A comfortable walking pace. */
export const DEFAULT_WALK_SPEED_MPS = 1.4;

/** World granularity. Fine enough that a walk is smooth, coarse enough to be quick. */
export const DEFAULT_TICK_MS = 100;

export interface SimPlayerOptions {
  /** Where this player is standing when the world starts. */
  start: LatLng;
  /** Accuracy the phone *claims*, in metres. */
  accuracyM?: number;
  /**
   * How wrong the phone actually is, as a standard deviation in metres.
   *
   * Deliberately separate from `accuracyM`, and zero by default: a fix that
   * lies about its own accuracy is a real failure mode worth being able to
   * reproduce, and a test that wants a repeatable path should not have to
   * fight noise it did not ask for.
   */
  jitterM?: number;
  /** Seeds the jitter, so a run with the same seed walks the same wobble twice. */
  seed?: number;
  fixIntervalMs?: number;
  platform?: Platform;
  reach?: ReachConfig;
}

/** The knobs the simulator adds on top of a plain provider. */
export interface SimGpsControls {
  /** Where the player really is, before jitter. */
  readonly truePos: LatLng;
  /** Teleport. For setting up a scenario — a walk this fast is not plausible. */
  moveTo(pos: LatLng): void;
  /** Walk in a straight line, at a human pace, emitting fixes on the way. */
  walkTo(target: LatLng, opts?: { speedMps?: number }): void;
  /** Stop mid-walk, standing where you got to. */
  halt(): void;
  /** True while a walk is still in progress. */
  readonly walking: boolean;
  setAccuracy(accuracyM: number): void;
  setJitter(jitterM: number): void;
}

export type SimGps = GpsProvider & SimGpsControls;

class SimGpsPlayer implements GpsProvider, SimGpsControls {
  private readonly core: GpsCore;
  private readonly fixIntervalMs: number;
  private readonly random: () => number;
  private pos: LatLng;
  private accuracyM: number;
  private jitterM: number;
  private target: LatLng | null = null;
  private speedMps = DEFAULT_WALK_SPEED_MPS;
  private sinceFixMs = 0;
  private running = false;

  constructor(opts: SimPlayerOptions) {
    this.core = new GpsCore({ platform: opts.platform, reach: opts.reach });
    this.pos = opts.start;
    this.accuracyM = opts.accuracyM ?? 5;
    this.jitterM = opts.jitterM ?? 0;
    this.fixIntervalMs = opts.fixIntervalMs ?? DEFAULT_FIX_INTERVAL_MS;
    this.random = mulberry32(opts.seed ?? 1);
  }

  get state(): GpsState {
    return this.core.state;
  }

  subscribe(listener: (state: GpsState) => void): () => void {
    return this.core.subscribe(listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Real hardware makes you wait for the first fix; so does this.
    this.core.waiting();
    this.sinceFixMs = 0;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.core.idle();
  }

  get truePos(): LatLng {
    return this.pos;
  }

  get walking(): boolean {
    return this.target !== null;
  }

  moveTo(pos: LatLng): void {
    this.pos = pos;
    this.target = null;
  }

  walkTo(target: LatLng, opts: { speedMps?: number } = {}): void {
    this.target = target;
    this.speedMps = opts.speedMps ?? DEFAULT_WALK_SPEED_MPS;
  }

  halt(): void {
    this.target = null;
  }

  setAccuracy(accuracyM: number): void {
    this.accuracyM = accuracyM;
  }

  setJitter(jitterM: number): void {
    this.jitterM = jitterM;
  }

  /** Advance this player by `dtMs` of simulated time, ending at clock `nowMs`. */
  tick(dtMs: number, nowMs: number): void {
    this.walkStep(dtMs);

    if (!this.running) return;
    this.sinceFixMs += dtMs;
    while (this.sinceFixMs >= this.fixIntervalMs) {
      this.sinceFixMs -= this.fixIntervalMs;
      this.emitFix(nowMs - this.sinceFixMs);
    }
  }

  private walkStep(dtMs: number): void {
    const target = this.target;
    if (!target) return;

    const toTarget = toLocal(this.pos, target);
    const remainingM = length(toTarget);
    const stepM = (this.speedMps * dtMs) / 1000;
    if (stepM >= remainingM) {
      this.pos = target;
      this.target = null;
      return;
    }
    this.pos = fromLocal(this.pos, scale(normalise(toTarget), stepM));
  }

  private emitFix(at: number): void {
    const reported =
      this.jitterM > 0
        ? fromLocal(this.pos, {
            e: gaussian(this.random) * this.jitterM,
            n: gaussian(this.random) * this.jitterM,
          })
        : this.pos;
    this.core.acceptFix({ pos: reported, accuracyM: this.accuracyM, at });
  }
}

/**
 * A set of simulated players sharing one clock.
 *
 * Two of them is the interesting case: the whole game is two phones on one
 * field, and half the failure modes only appear when both are moving.
 */
export class GpsSimWorld {
  private readonly players = new Map<string, SimGpsPlayer>();
  private readonly tickMs: number;
  private clock: number;

  constructor(opts: { startTime?: number; tickMs?: number } = {}) {
    // A fixed default epoch, so a test that prints a timestamp prints the same
    // one tomorrow.
    this.clock = opts.startTime ?? Date.UTC(2026, 0, 1, 12, 0, 0);
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  }

  get nowMs(): number {
    return this.clock;
  }

  add(id: string, opts: SimPlayerOptions): SimGps {
    const player = new SimGpsPlayer(opts);
    this.players.set(id, player);
    return player;
  }

  get(id: string): SimGps | undefined {
    return this.players.get(id);
  }

  /** Step every player forward by `ms` of simulated time. */
  advance(ms: number): void {
    let remaining = Math.max(0, ms);
    while (remaining > 0) {
      const dt = Math.min(this.tickMs, remaining);
      this.clock += dt;
      for (const player of this.players.values()) player.tick(dt, this.clock);
      remaining -= dt;
    }
  }
}

/**
 * Drive a world from wall-clock time, for use in a browser.
 *
 * Returns the stop function. Elapsed time is measured rather than assumed,
 * because a phone with the screen off will not give us the interval we asked
 * for — and the wake lock (stage 1.4) is exactly the thing this has to keep
 * working without.
 */
export function runSimClock(
  world: GpsSimWorld,
  opts: { intervalMs?: number; now?: () => number } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_TICK_MS;
  const now = opts.now ?? (() => Date.now());
  let last = now();
  const handle = setInterval(() => {
    const t = now();
    world.advance(t - last);
    last = t;
  }, intervalMs);
  return () => clearInterval(handle);
}

/** Small, fast, seedable PRNG. Determinism is the only requirement here. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller: GPS error is much more nearly Gaussian than it is uniform. */
function gaussian(random: () => number): number {
  const u = 1 - random();
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
