import { describe, expect, it } from 'vitest';

import { distanceM, fromLocal } from '../src/shared/geo.js';
import { POS_MIN_INTERVAL_MS } from '../src/shared/protocol.js';
import { OpponentTrack } from '../src/client/opponent.js';

const HOME = { lat: 51.4779, lng: -0.0015 };

/** A relay arriving at `at`, `east` metres east of home. */
function relay(east: number, at: number, acc = 6) {
  const pos = fromLocal(HOME, { e: east, n: 0 });
  return { lat: pos.lat, lng: pos.lng, acc, at };
}

/** How far east of home the dot is drawn at `now`. */
function eastAt(track: OpponentTrack, now: number): number {
  const dot = track.at(now);
  if (dot === null) throw new Error('no dot');
  return distanceM(HOME, dot.pos);
}

describe('the first fix', () => {
  it('is nothing at all before one arrives', () => {
    expect(new OpponentTrack().at(1_000)).toBeNull();
  });

  it('appears where it is, with nothing to glide from', () => {
    const track = new OpponentTrack();
    track.push(relay(10, 1_000));
    expect(eastAt(track, 1_000)).toBeCloseTo(10, 3);
    expect(track.at(1_000)?.moving).toBe(false);
  });
});

describe('gliding between relays', () => {
  it('walks the dot across the gap instead of jumping it', () => {
    const track = new OpponentTrack();
    track.push(relay(0, 1_000));
    track.push(relay(4, 1_000 + POS_MIN_INTERVAL_MS));

    // Still at the old position the instant the new fix lands: the dot lags by
    // about one relay interval, on purpose.
    expect(eastAt(track, 1_000 + POS_MIN_INTERVAL_MS)).toBeCloseTo(0, 3);
    expect(eastAt(track, 1_000 + POS_MIN_INTERVAL_MS * 1.5)).toBeCloseTo(2, 1);
    expect(eastAt(track, 1_000 + POS_MIN_INTERVAL_MS * 2)).toBeCloseTo(4, 3);
  });

  it('reports itself moving only while it has ground to cover', () => {
    const track = new OpponentTrack();
    track.push(relay(0, 1_000));
    track.push(relay(4, 3_000));
    expect(track.at(3_500)?.moving).toBe(true);
    // The caller stops repainting on this, so it has to go false and stay false.
    expect(track.at(9_000)?.moving).toBe(false);
    expect(eastAt(track, 9_000)).toBeCloseTo(4, 3);
  });

  it('never overshoots, however late the repaint is', () => {
    const track = new OpponentTrack();
    track.push(relay(0, 1_000));
    track.push(relay(4, 3_000));
    expect(eastAt(track, 1_000_000)).toBeCloseTo(4, 3);
  });

  it('carries the latest reported accuracy rather than averaging it', () => {
    const track = new OpponentTrack();
    track.push(relay(0, 1_000, 5));
    track.push(relay(4, 3_000, 40));
    expect(track.at(3_500)?.acc).toBe(40);
  });
});

describe('the cases that would look broken', () => {
  it('takes a step after a long silence, rather than creeping for a minute', () => {
    const track = new OpponentTrack();
    track.push(relay(0, 1_000));
    // Two minutes of standing still, then two metres. Gliding over the whole
    // gap would show a dot inching along for the rest of the game.
    track.push(relay(2, 121_000));
    expect(eastAt(track, 121_000 + POS_MIN_INTERVAL_MS)).toBeCloseTo(2, 3);
    expect(track.at(121_000 + POS_MIN_INTERVAL_MS)?.moving).toBe(false);
  });

  it('snaps a fix that could not have been walked to', () => {
    const track = new OpponentTrack();
    track.push(relay(0, 1_000));
    // 300 m in three seconds is a GPS glitch, not a sprint. Animating it would
    // be a smooth lie about a walk that never happened.
    track.push(relay(300, 4_000));
    expect(eastAt(track, 4_000)).toBeCloseTo(300, 1);
    expect(track.at(4_000)?.moving).toBe(false);
  });

  it('ignores a fix it has already seen, so a snapshot cannot restart the glide', () => {
    const track = new OpponentTrack();
    track.push(relay(0, 1_000));
    const second = relay(4, 3_000);
    track.push(second);
    const midway = eastAt(track, 4_000);

    // The same position arriving again — a snapshot repeating the last relay.
    track.push(second);
    expect(eastAt(track, 4_000)).toBeCloseTo(midway, 6);
  });

  it('carries on from where the dot is when a relay arrives early', () => {
    const track = new OpponentTrack();
    track.push(relay(0, 1_000));
    track.push(relay(4, 3_000));
    // Halfway through that glide, a third fix. The dot must continue from where
    // it stands, not teleport back to the fix it was leaving.
    const midway = eastAt(track, 4_000);
    expect(midway).toBeGreaterThan(0.5);
    expect(midway).toBeLessThan(3.5);
    track.push(relay(8, 4_000));
    expect(eastAt(track, 4_000)).toBeCloseTo(midway, 3);
  });
});
