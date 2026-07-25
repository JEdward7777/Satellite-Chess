/**
 * GPS: the one place the rest of the client learns where it is.
 *
 * Two implementations sit behind {@link GpsProvider} — the browser's
 * Geolocation API, below, and a simulator in `gps-sim.ts`. The simulator is not
 * a nicety: there is no satellite in a CI container, so without it nothing
 * downstream of this file could be exercised at all.
 *
 * Nothing here talks to the network. Inbound WebSocket messages are billed as
 * requests, so a position leaves the phone only at the two instants a move is
 * committed — see `shared/protocol.ts`.
 *
 * The switch between the two providers lives with the app shell rather than
 * here (see {@link simRequested}), so that this module never has to import the
 * simulator and the two files stay in one dependency direction.
 */

import { type LatLng, distanceM, fromLocal, toLocal } from '../shared/geo.js';
import {
  DEFAULT_REACH,
  type ReachConfig,
  accuracyTooPoor,
  isPlausibleStep,
} from '../shared/reach.js';

/** A single position report. */
export interface GpsFix {
  pos: LatLng;
  /** Reported horizontal accuracy in metres — the phone's claim, not a measurement. */
  accuracyM: number;
  /** Client clock. Diagnostics and UI only; game rules are timed by the DO. */
  at: number;
}

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

export type GpsQuality = 'good' | 'fair' | 'poor' | 'unusable';

/**
 * Roughly one square on a typical field. At this accuracy the square under your
 * feet is the square the phone thinks you are on, which is the only property a
 * player actually cares about.
 */
export const GOOD_ACCURACY_M = 8;

/**
 * A coarse verdict, because a number in metres means nothing to most players
 * and the interesting boundaries are not where you would guess.
 *
 * The `fair`/`poor` boundary is the reach ceiling: past it, extra error stops
 * buying you a more forgiving circle (`effectiveReachM` clamps), so the game
 * gets harder rather than looser. The `poor`/`unusable` boundary is the same
 * threshold the move validator refuses at, so the badge and the rules agree.
 */
export function qualityOf(accuracyM: number, cfg: ReachConfig = DEFAULT_REACH): GpsQuality {
  if (accuracyTooPoor(accuracyM, cfg)) return 'unusable';
  if (accuracyM <= GOOD_ACCURACY_M) return 'good';
  if (accuracyM <= cfg.maxM) return 'fair';
  return 'poor';
}

export function qualityLabel(quality: GpsQuality): string {
  switch (quality) {
    case 'good':
      return 'Good';
    case 'fair':
      return 'Fair';
    case 'poor':
      return 'Poor';
    case 'unusable':
      return 'Too vague to play';
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type GpsErrorCode =
  | 'unsupported'
  | 'insecure'
  | 'permission_denied'
  | 'unavailable'
  | 'timeout'
  /** Fixes are arriving, but they are city-sized. See {@link COARSE_ACCURACY_M}. */
  | 'coarse';

export interface GpsError {
  code: GpsErrorCode;
  /** Actionable: what the player can do about it, where they can do it. */
  message: string;
  /** True when nothing further will arrive until the player changes something. */
  fatal: boolean;
}

export type Platform = 'ios' | 'android' | 'other';

export function detectPlatform(userAgent: string, maxTouchPoints = 0): Platform {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  // iPadOS 13+ reports a desktop Safari user agent; touch points are the tell.
  if (/Macintosh/i.test(userAgent) && maxTouchPoints > 1) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  return 'other';
}

/**
 * Every error carries the next thing to try, named where the player can find it.
 *
 * "Location unavailable" is not a message, it is a shrug. Someone standing in a
 * field with a dead board needs the actual toggle, on the actual phone they are
 * holding, which is why these are per-platform.
 */
export function describeGpsError(code: GpsErrorCode, platform: Platform = 'other'): GpsError {
  switch (code) {
    case 'unsupported':
      return {
        code,
        fatal: true,
        message:
          'This browser cannot report your location at all, so the board cannot be placed on ' +
          'the ground. Open the game in Safari on iPhone or Chrome on Android.',
      };

    case 'insecure':
      return {
        code,
        fatal: true,
        message:
          'Location only works over a secure connection. Open the game with https:// (or on ' +
          'localhost) and reload.',
      };

    case 'permission_denied':
      return {
        code,
        fatal: true,
        message:
          platform === 'ios'
            ? 'Location is blocked for this site. Tap the "AA" button in Safari\'s address bar ' +
              '→ Website Settings → Location → Allow, then reload. If it is not offered ' +
              'there, check Settings → Privacy & Security → Location Services is on.'
            : platform === 'android'
              ? 'Location is blocked for this site. Tap the padlock in the address bar → ' +
                'Permissions → Location → Allow, then reload.'
              : 'Location is blocked for this site. Allow it in your browser\'s site settings, ' +
                'then reload.',
      };

    case 'unavailable':
      return {
        code,
        fatal: false,
        message:
          'Your phone cannot get a fix right now. Step out from under trees, walls or a car ' +
          'roof — in the open it usually takes a few seconds.',
      };

    case 'timeout':
      return {
        code,
        fatal: false,
        message:
          'Still waiting for a first fix. That is normal outdoors for a few seconds. If it ' +
          'keeps failing, check Location Services are on for the whole phone, not just this site.',
      };

    case 'coarse':
      return {
        code,
        fatal: false,
        message:
          platform === 'ios'
            ? 'Your phone is only giving an approximate location — accurate to about a ' +
              'kilometre, which is a hundred boards wide. Turn on Settings → Privacy & ' +
              'Security → Location Services → Safari Websites → Precise Location. If you ' +
              'added this game to your home screen, look for Satellite Chess in that list ' +
              'instead of Safari.'
            : platform === 'android'
              ? 'Your phone is only giving an approximate location, accurate to about a ' +
                'kilometre. Turn on Settings → Location → Location Services → Google ' +
                'Location Accuracy, and allow this site precise location.'
              : 'Your phone is only giving an approximate location, accurate to about a ' +
                'kilometre. Look for a "precise location" setting for this site and turn it on.',
      };
  }
}

/**
 * Above this, a fix is not a bad fix — it is a different kind of answer.
 *
 * iOS with Precise Location off returns roughly 1-3 km; Android falling back to
 * network-only positioning returns something similar. Real GNSS, however bad,
 * does not land here. So a run of fixes this vague means a setting is off, not
 * that the player is under a tree, and the generic permission prompt will not
 * help them find it (stage 1.1.3).
 */
export const COARSE_ACCURACY_M = 500;

/** One vague fix is noise; two in a row is a setting. */
export const COARSE_FIX_STREAK = 2;

// ---------------------------------------------------------------------------
// Distance travelled
// ---------------------------------------------------------------------------

/**
 * Never credit a hop shorter than this, however good the fix claims to be.
 * A safety net for a phone that reports an accuracy it has not earned.
 */
export const MIN_ANCHOR_STEP_M = 4;

/**
 * The floor on a credited hop, as a multiple of the reported accuracy.
 *
 * Measured, not guessed. Feeding the accumulator an hour of a stationary phone
 * whose true error matches its claimed accuracy — the honest case, since a
 * reported accuracy is roughly a one-sigma radius — gives, per hour of sitting
 * on a bench:
 *
 * | factor | 3 m error | 5 m error | 1 km walk at 5 m error | 672 m of pacing |
 * |--------|-----------|-----------|------------------------|-----------------|
 * | 1      | 207 m     | 1568 m    | 1096 m                 | 378 m           |
 * | 1.5    | 14 m      | 400 m     | 1058 m                 | 378 m           |
 * | **2**  | **0 m**   | **99 m**  | **1030 m**             | **436 m**       |
 * | 2.5    | 0 m       | 24 m      | 1019 m                 | 288 m           |
 *
 * Two is where phantom distance stops mattering without the floor growing so
 * large that it starts eating real movement — note that 2.5 counts *less* of a
 * genuine 672 m walk than 2 does, because legs shorter than the floor vanish
 * entirely. The residual at 5 m error is an over-count of about 3%, which is the
 * honest cost of not being able to tell a slow walk from a bad fix.
 */
export const ANCHOR_ACCURACY_FACTOR = 2;

/**
 * How many consecutive fixes must agree that you have left the anchor.
 *
 * One is not enough. A stationary phone still throws the occasional fix past the
 * floor, and each one moves the anchor and gets paid for, which ping-pongs its
 * way into free kilometres. Requiring two in a row squares that probability away
 * while costing a real walk only one fix of lag — once you are genuinely walking
 * away from the anchor, you are still past it a second later.
 */
export const CONFIRM_FIXES = 2;

/**
 * How many fixes are averaged before the anchor test sees them.
 *
 * Noise on the gap between two fixes has root-2 times the noise of one, so an
 * unsmoothed floor sits far closer to a stationary phone's wobble than it looks
 * and gets crossed constantly. Averaging five fixes divides that wobble by
 * root-5, which is worth roughly a factor of ten in phantom distance.
 *
 * A real walk is untouched: the mean of a straight line is the same straight
 * line, two seconds late, and lag does not change a distance.
 *
 * Only the distance count sees the smoothed track. Reach, lifts and places all
 * use the raw fix, because a two-second-old position is exactly wrong at the
 * moment a player taps to pick a piece up.
 */
export const SMOOTHING_FIXES = 5;

/**
 * Cumulative distance walked, with a jitter floor.
 *
 * Summing consecutive fixes is the obvious implementation and it is wrong:
 * a phone left on a bench reports a metre or two of drift every second and
 * clocks up kilometres by lunchtime. So the raw track is smoothed, and then we
 * hold an *anchor* and only credit a hop once the player is convincingly
 * somewhere else — convincingly meaning further than both the fixed floor and
 * the accuracy of the fixes involved, for {@link CONFIRM_FIXES} fixes running.
 * Sub-threshold wandering is dropped, which slightly under-counts a dawdle and
 * hugely under-counts a bench, and that is the right trade for a number people
 * are going to compete over (decision 0019).
 *
 * This is the client's own count. It is inflatable by anyone willing to lie
 * (observation O-03); the server keeps its own lower bound from move fixes.
 */
export class DistanceAccumulator {
  private readonly window: GpsFix[] = [];
  private anchor: GpsFix | null = null;
  private beyondCount = 0;
  private total = 0;

  constructor(private readonly cfg: ReachConfig = DEFAULT_REACH) {}

  get totalM(): number {
    return this.total;
  }

  reset(): void {
    this.window.length = 0;
    this.anchor = null;
    this.beyondCount = 0;
    this.total = 0;
  }

  /** Feed a fix; returns the running total in metres. */
  add(raw: GpsFix): number {
    // A fix too vague to move a piece with is too vague to measure a walk with.
    if (accuracyTooPoor(raw.accuracyM, this.cfg)) return this.total;

    this.window.push(raw);
    if (this.window.length > SMOOTHING_FIXES) this.window.shift();
    const fix: GpsFix = { pos: meanPos(this.window), accuracyM: raw.accuracyM, at: raw.at };

    const anchor = this.anchor;
    if (!anchor) {
      this.anchor = fix;
      return this.total;
    }

    const step = distanceM(anchor.pos, fix.pos);
    const floor = Math.max(
      MIN_ANCHOR_STEP_M,
      ANCHOR_ACCURACY_FACTOR * Math.max(anchor.accuracyM, fix.accuracyM),
    );
    if (step < floor) {
      this.beyondCount = 0;
      return this.total;
    }

    if (++this.beyondCount < CONFIRM_FIXES) return this.total;
    this.beyondCount = 0;

    // A jump no human could have walked is a GPS glitch, not a sprint. Move the
    // anchor so we resume from reality, but do not pay for the teleport.
    if (isPlausibleStep(step, fix.at - anchor.at, anchor.accuracyM + fix.accuracyM)) {
      this.total += step;
    }
    this.anchor = fix;
    return this.total;
  }
}

/** Mean of a short run of fixes, projected locally so metres stay metres. */
function meanPos(fixes: GpsFix[]): LatLng {
  const origin = fixes[0].pos;
  let e = 0;
  let n = 0;
  for (const fix of fixes) {
    const v = toLocal(origin, fix.pos);
    e += v.e;
    n += v.n;
  }
  return fromLocal(origin, { e: e / fixes.length, n: n / fixes.length });
}

// ---------------------------------------------------------------------------
// The provider interface
// ---------------------------------------------------------------------------

export interface GpsState {
  status: 'idle' | 'waiting' | 'live' | 'error';
  fix: GpsFix | null;
  quality: GpsQuality;
  /** Set whenever something is wrong, including the non-fatal cases. */
  error: GpsError | null;
  /** Metres walked since {@link GpsProvider.start}. */
  distanceM: number;
  /** Fixes seen — enough to answer "is this thing even running". */
  fixCount: number;
}

export interface GpsProvider {
  readonly state: GpsState;
  start(): void;
  stop(): void;
  /** Calls back immediately with the current state, then on every change. */
  subscribe(listener: (state: GpsState) => void): () => void;
}

export function idleGpsState(): GpsState {
  return { status: 'idle', fix: null, quality: 'unusable', error: null, distanceM: 0, fixCount: 0 };
}

/**
 * The half of a provider that has nothing to do with where fixes come from:
 * quality, distance, coarse-location detection, and telling everyone about it.
 * Both the real provider and the simulator embed one, so the simulator exercises
 * the same bookkeeping the field will.
 */
export class GpsCore {
  private readonly platform: Platform;
  private readonly cfg: ReachConfig;
  private readonly distance: DistanceAccumulator;
  private readonly listeners = new Set<(state: GpsState) => void>();
  private coarseStreak = 0;
  private current: GpsState = idleGpsState();

  constructor(opts: { platform?: Platform; reach?: ReachConfig } = {}) {
    this.platform = opts.platform ?? 'other';
    this.cfg = opts.reach ?? DEFAULT_REACH;
    this.distance = new DistanceAccumulator(this.cfg);
  }

  get state(): GpsState {
    return this.current;
  }

  subscribe(listener: (state: GpsState) => void): () => void {
    listener(this.current);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  patch(next: Partial<GpsState>): void {
    this.current = { ...this.current, ...next };
    for (const listener of this.listeners) listener(this.current);
  }

  /** Called when a watch has been requested but nothing has arrived yet. */
  waiting(): void {
    this.patch({ status: 'waiting', error: null });
  }

  acceptFix(fix: GpsFix): void {
    this.coarseStreak = fix.accuracyM >= COARSE_ACCURACY_M ? this.coarseStreak + 1 : 0;
    const coarse = this.coarseStreak >= COARSE_FIX_STREAK;
    this.patch({
      status: 'live',
      fix,
      quality: qualityOf(fix.accuracyM, this.cfg),
      distanceM: this.distance.add(fix),
      fixCount: this.current.fixCount + 1,
      error: coarse ? describeGpsError('coarse', this.platform) : null,
    });
  }

  fail(code: GpsErrorCode): void {
    const error = describeGpsError(code, this.platform);
    // A transient failure does not retract the last known position: watchPosition
    // keeps trying, and a stale dot with a warning beats a blank screen.
    this.patch({
      status: error.fatal ? 'error' : this.current.status === 'live' ? 'live' : 'waiting',
      error,
    });
  }

  /** Stop, keeping the distance walked — it is a session total, not a watch total. */
  idle(): void {
    this.coarseStreak = 0;
    this.patch({ status: 'idle' });
  }
}

// ---------------------------------------------------------------------------
// The browser's Geolocation API
// ---------------------------------------------------------------------------

/** The shape we need from a position, kept minimal so tests can fake one. */
export interface PositionLike {
  coords: { latitude: number; longitude: number; accuracy: number };
  timestamp: number;
}

export interface PositionErrorLike {
  code: number;
  message?: string;
}

export interface GeolocationLike {
  watchPosition(
    onFix: (position: PositionLike) => void,
    onError?: (error: PositionErrorLike) => void,
    options?: PositionOptions,
  ): number;
  clearWatch(watchId: number): void;
}

/** `GeolocationPositionError` codes, which are numbers on the wire. */
const PERMISSION_DENIED = 1;
const POSITION_UNAVAILABLE = 2;
const TIMEOUT = 3;

export const WATCH_OPTIONS: PositionOptions = {
  // Costs battery, and is the entire point: network positioning cannot tell 8 m
  // squares apart.
  enableHighAccuracy: true,
  // A cached fix from before you walked onto the field would lift a piece from
  // the wrong square, so never accept one.
  maximumAge: 0,
  timeout: 20_000,
};

export interface GeolocationGpsOptions {
  geolocation?: GeolocationLike | null;
  platform?: Platform;
  /** Geolocation is refused outright on an insecure origin; say so specifically. */
  secureContext?: boolean;
  reach?: ReachConfig;
  watchOptions?: PositionOptions;
}

class GeolocationGps implements GpsProvider {
  private readonly core: GpsCore;
  private watchId: number | null = null;

  constructor(private readonly opts: GeolocationGpsOptions) {
    this.core = new GpsCore({ platform: opts.platform, reach: opts.reach });
  }

  get state(): GpsState {
    return this.core.state;
  }

  subscribe(listener: (state: GpsState) => void): () => void {
    return this.core.subscribe(listener);
  }

  start(): void {
    if (this.watchId !== null) return;

    if (this.opts.secureContext === false) {
      this.core.fail('insecure');
      return;
    }
    const geolocation = this.opts.geolocation;
    if (!geolocation) {
      this.core.fail('unsupported');
      return;
    }

    this.core.waiting();
    this.watchId = geolocation.watchPosition(
      (position) => {
        this.core.acceptFix({
          pos: { lat: position.coords.latitude, lng: position.coords.longitude },
          accuracyM: position.coords.accuracy,
          at: position.timestamp,
        });
      },
      (error) => {
        switch (error.code) {
          case PERMISSION_DENIED:
            this.core.fail('permission_denied');
            break;
          case TIMEOUT:
            this.core.fail('timeout');
            break;
          case POSITION_UNAVAILABLE:
          default:
            this.core.fail('unavailable');
            break;
        }
      },
      this.opts.watchOptions ?? WATCH_OPTIONS,
    );
  }

  stop(): void {
    if (this.watchId === null) return;
    this.opts.geolocation?.clearWatch(this.watchId);
    this.watchId = null;
    this.core.idle();
  }
}

/**
 * Wrap `navigator.geolocation` in a {@link GpsProvider}.
 *
 * Everything the browser supplies is injectable so this can be driven from a
 * container with no satellite and no DOM.
 */
export function createGeolocationGps(opts: GeolocationGpsOptions = {}): GpsProvider {
  return new GeolocationGps(opts);
}

/** What `createGeolocationGps` should be handed in a real browser. */
export function browserGeolocationOptions(): GeolocationGpsOptions {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    geolocation: nav?.geolocation ?? null,
    platform: detectPlatform(nav?.userAgent ?? '', nav?.maxTouchPoints ?? 0),
    secureContext: typeof isSecureContext === 'undefined' ? true : isSecureContext,
  };
}

/**
 * Is the simulator being asked for?
 *
 * The app shell reads this and constructs the simulator itself, so that this
 * module never imports `gps-sim.ts`.
 */
export function simRequested(search: string): boolean {
  return new URLSearchParams(search).get('sim') === '1';
}
