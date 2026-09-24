/**
 * The phone's half of the back-rank handshake (decision 0005, stages 7.2.1–7.2.2).
 *
 * A game starts, and a suspended one resumes, when both players are connected and
 * both are standing in their own start zone — checked by the server, because the
 * client is untrusted. This file does the two things the server cannot:
 *
 * - **It notices, at full GPS rate, that you have arrived**, and says so once.
 *   The relay alone is not enough to carry that news. It speaks only after two
 *   meters of movement and never more than every 2.5 s, so a player who stops a
 *   meter and a half inside their zone, just after a relay sent from outside it,
 *   is standing on their back rank while the server believes they are not — and
 *   nothing will ever correct it, because standing still is silent by design.
 * - **It makes the wait legible.** "Waiting for your opponent" with no sense of
 *   how long is the complaint in O-08 seen from the other side; the opponent's
 *   relayed position is already on the phone, so the distance costs nothing.
 *
 * **Never streamed** (`harness/reference/budget.md`). `ready` goes once on
 * entering the zone, not once per fix, and not at all when the relay already
 * carried the same position or the server already agrees. Decision 0037 has the
 * whole rule.
 */

import type { FieldGeometry } from '../shared/field.js';
import type { LatLng } from '../shared/geo.js';
import type { GameSnapshot, GameStatus } from '../shared/protocol.js';
import { DEFAULT_REACH, inStartZone } from '../shared/reach.js';
import type { Color } from '../shared/squares.js';

/**
 * The fewest milliseconds between two automatic `ready`s.
 *
 * Only reached by GPS jitter across the edge of the zone — in, out, in again —
 * which would otherwise send one per crossing. The first arrival always goes
 * immediately; this only spaces out the repeats. Ten seconds bounds a player
 * dithering on the boundary for a whole minute at six requests, a quarter of
 * what the relay itself may spend in the same minute.
 */
export const AUTO_READY_MIN_INTERVAL_MS = 10_000;

/**
 * How long a relayed in-zone fix is given to be confirmed before `ready` is sent
 * anyway. A local round trip is milliseconds; a field on one bar is not, and
 * three seconds is still well inside the time anyone spends looking at the
 * screen after arriving.
 */
export const RELAY_CONFIRM_MS = 3_000;

/** Whether the handshake is what the game is waiting on. */
export function awaitingHandshake(status: GameStatus | null | undefined): boolean {
  return status === 'staging' || status === 'suspended';
}

/**
 * One run of the handshake, as far as the latch is concerned.
 *
 * A `ready` is sent at most once per episode while the player stays in their
 * zone. The episode changes whenever the server may have forgotten what it was
 * told: a new socket (the server clears the flag when the last one closes —
 * decision 0037), or a new suspension.
 */
export function handshakeEpisode(game: GameSnapshot | null, reconnects: number): string {
  return `${game?.status ?? '-'}|${reconnects}|${game?.suspension?.at ?? '-'}`;
}

export interface AutoReadyInput {
  status: GameStatus | null;
  /** The socket is open, so a send would actually leave the phone. */
  open: boolean;
  /** The server's own verdict on me, from the last snapshot. */
  serverSaysInZone: boolean;
  /** This phone's verdict on the current fix, or null with no fix at all. */
  localInZone: boolean | null;
  /** True when the relay has just sent this very fix, which may already say it. */
  relayed: boolean;
  episode: string;
  now: number;
}

/**
 * Decides when to say "I am on my back rank" without being asked.
 *
 * A latch rather than a comparison of successive fixes, because the question is
 * not "did I just cross the line" but "has the server been told since it last
 * could have forgotten" — and a snapshot, a reconnect and a fix arrive in any
 * order.
 */
export class AutoReady {
  private sentEpisode: string | null = null;
  private lastSentAt = -Infinity;
  /** When the relay last carried an in-zone fix the server has not yet confirmed. */
  private relayedAt = -Infinity;

  /** True when a `ready` should be sent now. Records that it was. */
  decide(input: AutoReadyInput): boolean {
    if (!awaitingHandshake(input.status) || !input.open) return false;

    // Leaving the zone re-arms, so walking back in is news worth sending.
    if (input.localInZone !== true) {
      this.sentEpisode = null;
      this.relayedAt = -Infinity;
      return false;
    }
    // Already believed. Nothing to add, and the latch is left alone so a later
    // forgetting — a new episode — still gets told.
    if (input.serverSaysInZone) return false;
    if (this.sentEpisode === input.episode) return false;

    if (input.relayed) {
      // The relay just carried this exact fix, and the server runs the same zone
      // check on a relay as on a `ready` — and follows a relay that puts someone
      // on their back rank with a snapshot. So give it a round trip to say so.
      //
      // Not a latch: a relay can be sent and still count for nothing. The server
      // silently drops a `pos` inside its own interval floor, which a `ready`
      // resets too, so a player refused one meter short who steps in straight
      // away sends a relay that vanishes — and, standing still, never another.
      // If no snapshot has agreed by the deadline, `ready` goes after all.
      this.relayedAt = input.now;
      return false;
    }
    if (input.now - this.relayedAt < RELAY_CONFIRM_MS) return false;
    if (input.now - this.lastSentAt < AUTO_READY_MIN_INTERVAL_MS) return false;

    this.sentEpisode = input.episode;
    this.lastSentAt = input.now;
    return true;
  }
}

/** A distance to walk, as the game screen writes every distance. */
function walk(m: number): string {
  return m < 10 ? `${m.toFixed(1)} m` : `${Math.round(m)} m`;
}

/**
 * How far a position is from being on its own back rank, in meters of walking.
 *
 * Reach extends past your feet, so this is the distance to the nearest start
 * square less the reach circle — the same arithmetic the server's zone check
 * does, with the same handicap, so a "0 m" here is a player the server will
 * accept.
 */
export function walkToBackRankM(
  geo: FieldGeometry,
  game: Pick<GameSnapshot, 'reach' | 'players'>,
  color: Color,
  pos: LatLng,
): { inZone: boolean; walkM: number } {
  const zone = inStartZone(
    geo,
    pos,
    color,
    game.reach ?? DEFAULT_REACH,
    game.players[color]?.reachBonusSquares ?? 0,
  );
  return { inZone: zone.ok, walkM: Math.max(0, zone.nearestM - zone.reachM) };
}

/** What my own side of the handshake looks like, in one line. */
export function myHandshakeLine(
  serverSaysInZone: boolean,
  mine: { inZone: boolean; walkM: number } | null,
): string {
  if (serverSaysInZone) return 'You are on your back rank.';
  if (mine === null) return 'Walk to your own back rank.';
  // The server has not agreed yet. Usually for the length of one round trip;
  // if it disagrees, its own message says by how much, and the button is there.
  if (mine.inZone) return 'On your back rank — checking with the server…';
  return `Walk to your own back rank — ${walk(mine.walkM)} to go.`;
}

/**
 * What the opponent's side of the handshake looks like, in one line.
 *
 * Built from the coarse relayed position the screen already holds, so the
 * distance is atmosphere-grade: it can lag by a relay interval, and says so by
 * being approximate. What it must never do is claim they are ready when the
 * server has not said so — that comes only from the snapshot.
 */
export function opponentHandshakeLine(
  them: { connected: boolean; inStartZone: boolean } | null,
  distance: { inZone: boolean; walkM: number } | null,
): string {
  if (them === null) return 'Waiting for an opponent to join.';
  if (!them.connected) return 'Waiting for your opponent to come back.';
  if (them.inStartZone) return 'Your opponent is on their back rank.';
  if (distance === null) return 'Waiting for your opponent to reach their back rank.';
  if (distance.inZone) return 'Your opponent is nearly on their back rank.';
  return `Waiting for your opponent to reach their back rank — about ${walk(distance.walkM)} away.`;
}
