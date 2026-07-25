import { describe, expect, it } from 'vitest';

import { distanceM, fromLocal } from '../src/shared/geo.js';
import { DEFAULT_REACH } from '../src/shared/reach.js';
import {
  COARSE_ACCURACY_M,
  DistanceAccumulator,
  type GeolocationLike,
  type PositionErrorLike,
  type PositionLike,
  createGeolocationGps,
  describeGpsError,
  detectPlatform,
  qualityOf,
  simRequested,
} from '../src/client/gps.js';
import { GpsSimWorld } from '../src/client/gps-sim.js';

const HOME = { lat: 51.4779, lng: -0.0015 };

/** A `navigator.geolocation` that does exactly what the test tells it to. */
class FakeGeolocation implements GeolocationLike {
  options: PositionOptions | undefined;
  cleared: number[] = [];
  watches = 0;
  private onFix: ((position: PositionLike) => void) | undefined;
  private onError: ((error: PositionErrorLike) => void) | undefined;

  watchPosition(
    onFix: (position: PositionLike) => void,
    onError?: (error: PositionErrorLike) => void,
    options?: PositionOptions,
  ): number {
    this.onFix = onFix;
    this.onError = onError;
    this.options = options;
    return ++this.watches;
  }

  clearWatch(watchId: number): void {
    this.cleared.push(watchId);
  }

  fix(pos: { lat: number; lng: number }, accuracy: number, at = 1_000): void {
    this.onFix?.({
      coords: { latitude: pos.lat, longitude: pos.lng, accuracy },
      timestamp: at,
    });
  }

  fail(code: number): void {
    this.onError?.({ code });
  }
}

describe('qualityOf', () => {
  it('calls a fix good while the square under your feet is unambiguous', () => {
    expect(qualityOf(3)).toBe('good');
    expect(qualityOf(8)).toBe('good');
    expect(qualityOf(8.1)).toBe('fair');
  });

  it('turns poor where extra error stops buying extra reach', () => {
    expect(qualityOf(DEFAULT_REACH.maxM)).toBe('fair');
    expect(qualityOf(DEFAULT_REACH.maxM + 0.1)).toBe('poor');
  });

  it('agrees with the move validator about what is unplayable', () => {
    expect(qualityOf(DEFAULT_REACH.maxAccuracyM)).toBe('poor');
    expect(qualityOf(DEFAULT_REACH.maxAccuracyM + 0.1)).toBe('unusable');
    expect(qualityOf(Number.NaN)).toBe('unusable');
  });
});

describe('detectPlatform', () => {
  it('recognises an iPhone', () => {
    expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('ios');
  });

  it('recognises an iPad pretending to be a Mac', () => {
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('ios');
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe('other');
  });

  it('recognises Android', () => {
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('android');
  });
});

describe('describeGpsError', () => {
  it('names the iOS toggle that a generic permission prompt never mentions', () => {
    const error = describeGpsError('coarse', 'ios');
    expect(error.message).toContain('Precise Location');
    expect(error.message).toContain('Location Services');
    // Fixes are still arriving, so this must not shut the provider down.
    expect(error.fatal).toBe(false);
  });

  it('gives Android its own route to the same setting', () => {
    expect(describeGpsError('coarse', 'android').message).toContain('Google Location Accuracy');
  });

  it('marks the states that will never resolve on their own', () => {
    expect(describeGpsError('permission_denied').fatal).toBe(true);
    expect(describeGpsError('unsupported').fatal).toBe(true);
    expect(describeGpsError('insecure').fatal).toBe(true);
    expect(describeGpsError('unavailable').fatal).toBe(false);
    expect(describeGpsError('timeout').fatal).toBe(false);
  });

  it('always says what to do next', () => {
    const codes = ['unsupported', 'insecure', 'permission_denied', 'unavailable', 'timeout', 'coarse'] as const;
    for (const code of codes) {
      for (const platform of ['ios', 'android', 'other'] as const) {
        expect(describeGpsError(code, platform).message.length).toBeGreaterThan(40);
      }
    }
  });
});

describe('DistanceAccumulator', () => {
  it('counts a straight walk to within a few per cent', () => {
    const acc = new DistanceAccumulator();
    // 1 Hz fixes at a walking pace, 300 m in a straight line.
    let total = 0;
    for (let i = 0; i <= 214; i++) {
      const pos = fromLocal(HOME, { e: i * 1.4, n: 0 });
      total = acc.add({ pos, accuracyM: 5, at: i * 1000 });
    }
    // The shortfall is one floor's worth: the last part-hop is still pending.
    expect(total).toBeGreaterThan(285);
    expect(total).toBeLessThanOrEqual(300);
  });

  it('does not clock up distance while standing still', () => {
    // The honest case, and the one that matters: a phone whose true error is as
    // large as the accuracy it reports. An hour of it, which is a whole game.
    const acc = new DistanceAccumulator();
    const random = seeded(7);
    let total = 0;
    for (let i = 0; i < 3600; i++) {
      const pos = fromLocal(HOME, { e: gauss(random) * 5, n: gauss(random) * 5 });
      total = acc.add({ pos, accuracyM: 5, at: i * 1000 });
    }
    // Against the kilometres a naive sum would have credited.
    expect(total).toBeLessThan(300);
  });

  it('is quiet on a bench when the fix is actually good', () => {
    const acc = new DistanceAccumulator();
    const random = seeded(11);
    let total = 0;
    for (let i = 0; i < 3600; i++) {
      const pos = fromLocal(HOME, { e: gauss(random) * 3, n: gauss(random) * 3 });
      total = acc.add({ pos, accuracyM: 5, at: i * 1000 });
    }
    expect(total).toBe(0);
  });

  it('refuses to pay for a teleport', () => {
    const acc = new DistanceAccumulator();
    acc.add({ pos: HOME, accuracyM: 5, at: 0 });
    const far = fromLocal(HOME, { e: 10_000, n: 0 });
    acc.add({ pos: far, accuracyM: 5, at: 1_000 });
    const total = acc.add({ pos: far, accuracyM: 5, at: 2_000 });
    expect(total).toBe(0);
  });

  it('resumes counting from wherever the teleport landed', () => {
    const acc = new DistanceAccumulator();
    const far = fromLocal(HOME, { e: 10_000, n: 0 });
    acc.add({ pos: HOME, accuracyM: 5, at: 0 });
    // Standing at the new place long enough for the smoothing window to forget
    // the old one.
    for (let i = 1; i <= 8; i++) acc.add({ pos: far, accuracyM: 5, at: i * 1000 });
    expect(acc.totalM).toBe(0);

    let total = 0;
    for (let i = 1; i <= 30; i++) {
      total = acc.add({ pos: fromLocal(far, { e: i * 1.4, n: 0 }), accuracyM: 5, at: 8_000 + i * 1000 });
    }
    // 42 m walked, minus the smoothing lag at the near end of it.
    expect(total).toBeGreaterThan(30);
    expect(total).toBeLessThanOrEqual(42);
  });

  it('ignores fixes too vague to move a piece with', () => {
    const acc = new DistanceAccumulator();
    acc.add({ pos: HOME, accuracyM: 5, at: 0 });
    for (let i = 1; i <= 5; i++) {
      acc.add({
        pos: fromLocal(HOME, { e: i * 200, n: 0 }),
        accuracyM: DEFAULT_REACH.maxAccuracyM + 1,
        at: i * 1000,
      });
    }
    expect(acc.totalM).toBe(0);
  });
});

describe('createGeolocationGps', () => {
  it('asks for high accuracy and refuses a cached fix', () => {
    const geolocation = new FakeGeolocation();
    createGeolocationGps({ geolocation }).start();
    expect(geolocation.options?.enableHighAccuracy).toBe(true);
    expect(geolocation.options?.maximumAge).toBe(0);
  });

  it('reports position, accuracy and quality', () => {
    const geolocation = new FakeGeolocation();
    const gps = createGeolocationGps({ geolocation });
    const seen: string[] = [];
    gps.subscribe((state) => seen.push(state.status));

    expect(gps.state.status).toBe('idle');
    gps.start();
    expect(gps.state.status).toBe('waiting');

    geolocation.fix(HOME, 4, 1_000);
    expect(gps.state.status).toBe('live');
    expect(gps.state.fix).toEqual({ pos: HOME, accuracyM: 4, at: 1_000 });
    expect(gps.state.quality).toBe('good');
    expect(gps.state.fixCount).toBe(1);
    expect(seen).toEqual(['idle', 'waiting', 'live']);
  });

  it('says so specifically when there is no geolocation at all', () => {
    const gps = createGeolocationGps({ geolocation: null });
    gps.start();
    expect(gps.state.status).toBe('error');
    expect(gps.state.error?.code).toBe('unsupported');
  });

  it('distinguishes an insecure origin from a denial', () => {
    const gps = createGeolocationGps({ geolocation: new FakeGeolocation(), secureContext: false });
    gps.start();
    expect(gps.state.error?.code).toBe('insecure');
  });

  it('maps the browser error codes', () => {
    for (const [code, expected] of [
      [1, 'permission_denied'],
      [2, 'unavailable'],
      [3, 'timeout'],
    ] as const) {
      const geolocation = new FakeGeolocation();
      const gps = createGeolocationGps({ geolocation });
      gps.start();
      geolocation.fail(code);
      expect(gps.state.error?.code).toBe(expected);
    }
  });

  it('keeps the last known position through a transient failure', () => {
    const geolocation = new FakeGeolocation();
    const gps = createGeolocationGps({ geolocation });
    gps.start();
    geolocation.fix(HOME, 6, 1_000);
    geolocation.fail(2);

    expect(gps.state.status).toBe('live');
    expect(gps.state.fix?.pos).toEqual(HOME);
    expect(gps.state.error?.code).toBe('unavailable');
  });

  it('spots iOS Precise Location being off, and clears it when it comes back on', () => {
    const geolocation = new FakeGeolocation();
    const gps = createGeolocationGps({ geolocation, platform: 'ios' });
    gps.start();

    geolocation.fix(HOME, COARSE_ACCURACY_M * 3, 1_000);
    // One vague fix is noise, not a verdict.
    expect(gps.state.error).toBeNull();

    geolocation.fix(HOME, COARSE_ACCURACY_M * 3, 2_000);
    expect(gps.state.error?.code).toBe('coarse');
    expect(gps.state.quality).toBe('unusable');

    geolocation.fix(HOME, 5, 3_000);
    expect(gps.state.error).toBeNull();
    expect(gps.state.quality).toBe('good');
  });

  it('stops watching when told to', () => {
    const geolocation = new FakeGeolocation();
    const gps = createGeolocationGps({ geolocation });
    gps.start();
    gps.stop();
    expect(geolocation.cleared).toEqual([1]);
    expect(gps.state.status).toBe('idle');
  });
});

describe('simRequested', () => {
  it('is off unless explicitly asked for', () => {
    expect(simRequested('?sim=1')).toBe(true);
    expect(simRequested('?a=b&sim=1')).toBe(true);
    expect(simRequested('?sim=0')).toBe(false);
    expect(simRequested('')).toBe(false);
  });
});

describe('GpsSimWorld', () => {
  it('walks a player at a human pace, one fix a second', () => {
    const world = new GpsSimWorld();
    const player = world.add('white', { start: HOME, accuracyM: 5 });
    player.start();
    expect(player.state.status).toBe('waiting');

    // 14 m at 1.4 m/s is ten seconds of walking; the extra two are standing still.
    player.walkTo(fromLocal(HOME, { e: 14, n: 0 }));
    world.advance(12_000);

    expect(player.walking).toBe(false);
    expect(player.state.fixCount).toBe(12);
    expect(distanceM(player.truePos, HOME)).toBeCloseTo(14, 1);
    expect(player.state.fix?.accuracyM).toBe(5);
  });

  it('counts the ground it covered', () => {
    const world = new GpsSimWorld();
    const player = world.add('white', { start: HOME, accuracyM: 5 });
    player.start();
    player.walkTo(fromLocal(HOME, { e: 100, n: 0 }));
    world.advance(80_000);

    expect(player.state.distanceM).toBeGreaterThan(90);
    expect(player.state.distanceM).toBeLessThanOrEqual(100);
  });

  it('wobbles identically for a given seed, and differently for another', () => {
    const track = (seed: number) => {
      const world = new GpsSimWorld();
      const player = world.add('white', { start: HOME, accuracyM: 5, jitterM: 3, seed });
      player.start();
      const positions: number[] = [];
      player.subscribe((state) => {
        if (state.fix) positions.push(state.fix.pos.lat, state.fix.pos.lng);
      });
      world.advance(5_000);
      return positions;
    };
    expect(track(42)).toEqual(track(42));
    expect(track(42)).not.toEqual(track(43));
  });

  it('reports the accuracy it was told to, however wrong it actually is', () => {
    // A phone that lies about its own accuracy is a real failure mode, so the
    // simulator has to be able to be one.
    const world = new GpsSimWorld();
    const player = world.add('white', { start: HOME, accuracyM: 3, jitterM: 20, seed: 1 });
    player.start();
    world.advance(1_000);

    expect(player.state.fix?.accuracyM).toBe(3);
    expect(distanceM(player.state.fix!.pos, HOME)).toBeGreaterThan(3);
  });

  it('runs two players independently on one clock', () => {
    const world = new GpsSimWorld();
    const white = world.add('white', { start: HOME, accuracyM: 5 });
    const black = world.add('black', { start: fromLocal(HOME, { e: 0, n: 56 }), accuracyM: 5 });
    white.start();
    black.start();

    white.walkTo(fromLocal(HOME, { e: 14, n: 0 }));
    world.advance(10_000);

    expect(distanceM(white.truePos, HOME)).toBeCloseTo(14, 1);
    expect(distanceM(black.truePos, HOME)).toBeCloseTo(56, 1);
    expect(black.state.fixCount).toBe(10);
    expect(black.state.distanceM).toBe(0);
  });

  it('lets accuracy be dialled down until the game refuses to play', () => {
    const world = new GpsSimWorld();
    const player = world.add('white', { start: HOME, accuracyM: 5 });
    player.start();
    world.advance(1_000);
    expect(player.state.quality).toBe('good');

    player.setAccuracy(DEFAULT_REACH.maxAccuracyM + 10);
    world.advance(1_000);
    expect(player.state.quality).toBe('unusable');
  });

  it('can be halted mid-walk', () => {
    const world = new GpsSimWorld();
    const player = world.add('white', { start: HOME, accuracyM: 5 });
    player.start();
    player.walkTo(fromLocal(HOME, { e: 100, n: 0 }));
    world.advance(5_000);
    player.halt();
    const stopped = player.truePos;
    world.advance(5_000);

    expect(player.walking).toBe(false);
    expect(player.truePos).toEqual(stopped);
  });

  it('delivers no fixes until started', () => {
    const world = new GpsSimWorld();
    const player = world.add('white', { start: HOME, accuracyM: 5 });
    world.advance(10_000);
    expect(player.state.fixCount).toBe(0);
    expect(player.state.status).toBe('idle');
  });
});

/** Deterministic noise for the accumulator tests, independent of the simulator's. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(random: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}
