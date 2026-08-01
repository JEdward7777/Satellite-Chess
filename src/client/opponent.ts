/**
 * The opponent's dot, and what to draw in the gaps between the messages.
 *
 * Their position arrives at most every 2.5 seconds and only once they have moved
 * a couple of metres (`POS_MIN_DELTA_M`, `POS_MIN_INTERVAL_MS`), because inbound
 * messages are billed and streaming GPS would eat the day's budget on one game.
 * Drawn raw, that is a dot that sits still for two and a half seconds and then
 * jumps three or four metres — which reads as a broken connection rather than as
 * someone walking.
 *
 * So the dot is **interpolated between the last two fixes**, and deliberately
 * lags by about one relay interval: at any moment it is showing where they were
 * a couple of seconds ago, on its way to where they now are. Extrapolating along
 * their last heading instead would put the dot ahead of them and then snatch it
 * back the instant they turned, and this is atmosphere — a smooth lie about two
 * seconds ago beats a jittery guess about now.
 *
 * Everything here runs on the *local* clock. Server time only appears in the
 * snapshot, and `net.ts` converts it before anything gets this far, because the
 * two phones' clocks have never been synchronised with each other.
 */

import { type LatLng, distanceM, fromLocal, toLocal } from '../shared/geo.js';
import { POS_MIN_INTERVAL_MS } from '../shared/protocol.js';

/** A relayed position, stamped with the moment this phone received it. */
export interface OpponentFix {
  lat: number;
  lng: number;
  acc: number;
  at: number;
}

export interface OpponentDot {
  pos: LatLng;
  /** Their reported accuracy. Carried for the caller; the dot itself is a point. */
  acc: number;
  /**
   * True while the dot still has ground to cover.
   *
   * The caller repaints on this: a canvas redrawn ten times a second all game
   * would be a real battery cost outdoors, and there is nothing to animate for
   * most of it, since a player standing still relays once and then goes quiet.
   */
  moving: boolean;
}

/** Sub-pixel steps at a walking pace, and a tenth of the cost of an rAF loop. */
export const OPPONENT_FRAME_MS = 100;

/**
 * Faster than this was not a walk, so do not animate it as one.
 *
 * A phone in an urban canyon can throw a fix a hundred metres sideways. Gliding
 * smoothly across that is a lie about a walk that never happened; snapping shows
 * it for the glitch it is.
 */
const SPRINT_MPS = 10;

/**
 * The last two positions, and where between them the dot currently is.
 *
 * Deliberately not a general track: nothing wants the opponent's history, and
 * keeping one would be a location log of another person on this phone.
 */
export class OpponentTrack {
  /** Where the glide starts, already in local coordinates. Null means "snap". */
  private from: LatLng | null = null;
  private to: OpponentFix | null = null;
  private startedAt = 0;
  private durationMs = 0;

  push(fix: OpponentFix): void {
    const previous = this.to;
    if (previous === null) {
      // Nothing to glide from — the first fix of the game, or the first after a
      // reconnect. It appears where it is.
      this.to = fix;
      this.from = null;
      this.durationMs = 0;
      this.startedAt = fix.at;
      return;
    }
    // The same fix twice — a snapshot repeating what a relay already said — must
    // not restart the glide, or the dot would stutter every time the opponent
    // offered a draw.
    if (fix.at <= previous.at) return;

    const gapMs = fix.at - previous.at;
    // From where the dot *is*, not from the last fix: if a glide was cut short
    // the dot must carry on from where it was left, never teleport back.
    const from = this.at(fix.at)?.pos ?? { lat: previous.lat, lng: previous.lng };
    const jumped = distanceM(from, { lat: fix.lat, lng: fix.lng }) > (gapMs / 1000) * SPRINT_MPS;

    this.to = fix;
    this.from = jumped ? null : from;
    // Capped at the relay interval so a long silence is not replayed in slow
    // motion: someone who stood still for two minutes and then took a step
    // should take a step, not creep across the field for two minutes.
    this.durationMs = jumped ? 0 : Math.min(gapMs, POS_MIN_INTERVAL_MS);
    this.startedAt = fix.at;
  }

  /** Where to draw them at `now`, or null if they have never been heard from. */
  at(now: number): OpponentDot | null {
    const to = this.to;
    if (to === null) return null;

    const target = { lat: to.lat, lng: to.lng };
    const from = this.from;
    if (from === null || this.durationMs <= 0) {
      return { pos: target, acc: to.acc, moving: false };
    }

    const t = (now - this.startedAt) / this.durationMs;
    if (t >= 1) return { pos: target, acc: to.acc, moving: false };
    if (t <= 0) return { pos: from, acc: to.acc, moving: true };

    const step = toLocal(from, target);
    return {
      pos: fromLocal(from, { e: step.e * t, n: step.n * t }),
      acc: to.acc,
      moving: true,
    };
  }
}
