/**
 * Reach: the rule that makes this chess instead of a chess app.
 *
 * You may only play a move if you are physically close enough to both ends of
 * it. Everything about which squares that means lives in this file.
 */

import { type LatLng, distanceM } from './geo.js';
import { type FieldGeometry, clamp, distanceToSquareM } from './field.js';
import { type Color, type Square, fromSquare, startZoneSquares } from './squares.js';

export interface ReachConfig {
  /** Reach at perfect accuracy, before the GPS-error allowance. */
  baseM: number;
  /** Floor on effective reach — below this the game is unplayable. */
  minM: number;
  /** Ceiling on effective reach, so a bad fix can't let you play the whole board. */
  maxM: number;
  /** Above this reported accuracy we refuse to accept moves at all. */
  maxAccuracyM: number;
}

export const DEFAULT_REACH: ReachConfig = {
  baseM: 5,
  minM: 4,
  maxM: 15,
  maxAccuracyM: 25,
};

/**
 * Per-player reach bonus, in metres.
 *
 * This answers one of the open questions: reach is the right place to put a
 * handicap for mismatched fitness, because it is continuous, it is visible on
 * both screens as a bigger circle, and it does not distort the clock. A player
 * who cannot sprint gets to stretch further instead of getting free time.
 */
export type ReachBonuses = Record<Color, number>;

export const NO_BONUSES: ReachBonuses = { w: 0, b: 0 };

/** Accuracy is added to reach, so a vaguer fix means a more forgiving circle. */
export function effectiveReachM(
  accuracyM: number,
  cfg: ReachConfig = DEFAULT_REACH,
  bonusM = 0,
): number {
  const raw = cfg.baseM + Math.max(0, accuracyM) + Math.max(0, bonusM);
  return clamp(raw, cfg.minM, cfg.maxM + Math.max(0, bonusM));
}

export function accuracyTooPoor(accuracyM: number, cfg: ReachConfig = DEFAULT_REACH): boolean {
  return !Number.isFinite(accuracyM) || accuracyM > cfg.maxAccuracyM;
}

/**
 * The squares a move requires you to be able to reach.
 *
 * Both ends, always — but at two different *moments*. See {@link checkCarry}:
 * you must reach the origin when you lift the piece and the destination when
 * you put it down, with a walk in between. Requiring both at one instant would
 * make every long move physically impossible (Ra1-a8 on 8 m squares needs 24 m
 * of reach against a 15 m ceiling), which would delete the rook, bishop and
 * queen from the game.
 *
 * Given that, the rule is simply origin-then-destination:
 *
 * - Captures need the victim's square, which is the destination, so they are
 *   already covered. A capture costs exactly as much walking as the same
 *   quiet move, which is the right answer to "does capturing become annoying".
 * - Castling requires the king's origin and destination only. The rook is
 *   ignored: the king is the piece you are actually carrying, chess.js already
 *   encodes castling as an e1->g1 king move, and requiring a third square would
 *   make castling a sprint for no thematic gain.
 * - En passant requires the capturing pawn's origin and destination. The
 *   captured pawn's square is ignored, for the same reason — and it is adjacent
 *   to the destination anyway, so it is nearly always in reach.
 * - Promotion involves no travel at all; the piece you choose is a pure UI
 *   decision made from wherever you are standing.
 */
export function requiredSquares(from: Square, to: Square): Square[] {
  return [from, to];
}

export interface SquareReach {
  square: Square;
  distanceM: number;
  reachable: boolean;
}

export interface ReachVerdict {
  ok: boolean;
  /** Machine-readable failure, for the client to map to a specific message. */
  code?: 'accuracy' | 'out_of_reach';
  message?: string;
  reachM: number;
  squares: SquareReach[];
}

export function checkSquareReach(
  geo: FieldGeometry,
  pos: LatLng,
  square: Square,
  reachM: number,
): SquareReach {
  const distanceM = distanceToSquareM(geo, pos, fromSquare(square));
  return { square, distanceM, reachable: distanceM <= reachM };
}

function accuracyVerdict(accuracyM: number, cfg: ReachConfig, reachM: number): ReachVerdict | null {
  if (!accuracyTooPoor(accuracyM, cfg)) return null;
  const shown = Number.isFinite(accuracyM) ? `±${Math.round(accuracyM)} m` : 'unknown';
  return {
    ok: false,
    code: 'accuracy',
    message:
      `Your position is only accurate to ${shown}, and moves need ±${cfg.maxAccuracyM} m or ` +
      'better. Step into the open and wait for the fix to tighten.',
    reachM,
    squares: [],
  };
}

/**
 * Can this player reach one specific square right now?
 *
 * This is the primitive behind both halves of a move: `checkReachTo(from)` at
 * lift time and `checkReachTo(to)` at place time.
 */
export function checkReachTo(
  geo: FieldGeometry,
  pos: LatLng,
  accuracyM: number,
  square: Square,
  cfg: ReachConfig = DEFAULT_REACH,
  bonusM = 0,
): ReachVerdict {
  const reachM = effectiveReachM(accuracyM, cfg, bonusM);
  const bad = accuracyVerdict(accuracyM, cfg, reachM);
  if (bad) return bad;

  const sr = checkSquareReach(geo, pos, square, reachM);
  if (!sr.reachable) {
    return {
      ok: false,
      code: 'out_of_reach',
      message:
        `You are ${sr.distanceM.toFixed(1)} m from ${square} and your reach is ` +
        `${reachM.toFixed(1)} m. Walk closer.`,
      reachM,
      squares: [sr],
    };
  }
  return { ok: true, reachM, squares: [sr] };
}

/** A timestamped position fix, as captured at a lift or a place. */
export interface ReachFix {
  pos: LatLng;
  accuracyM: number;
  /** Server time. Client timestamps are stored but never used for rules. */
  at: number;
}

export interface CarryVerdict extends ReachVerdict {
  /** Ground distance between where you lifted and where you placed. */
  carriedM: number;
  carriedMs: number;
}

/**
 * Validate a completed move: lifted near the origin, placed near the
 * destination, with a physically possible walk between the two.
 *
 * This is the authoritative check, run in the Durable Object. The client runs
 * the same code so it can grey out what you cannot yet do, but the client is
 * untrusted and only the DO's answer counts.
 */
export function checkCarry(
  geo: FieldGeometry,
  lift: ReachFix,
  place: ReachFix,
  from: Square,
  to: Square,
  cfg: ReachConfig = DEFAULT_REACH,
  bonusM = 0,
): CarryVerdict {
  const reachM = effectiveReachM(Math.max(lift.accuracyM, place.accuracyM), cfg, bonusM);
  const carriedM = distanceM(lift.pos, place.pos);
  const carriedMs = Math.max(0, place.at - lift.at);

  const liftVerdict = checkReachTo(geo, lift.pos, lift.accuracyM, from, cfg, bonusM);
  if (!liftVerdict.ok) {
    return {
      ...liftVerdict,
      message: `When you picked the piece up you were not at ${from}. ${liftVerdict.message ?? ''}`.trim(),
      carriedM,
      carriedMs,
    };
  }

  const placeVerdict = checkReachTo(geo, place.pos, place.accuracyM, to, cfg, bonusM);
  if (!placeVerdict.ok) {
    return { ...placeVerdict, carriedM, carriedMs };
  }

  if (!isPlausibleStep(carriedM, carriedMs, lift.accuracyM + place.accuracyM)) {
    return {
      ok: false,
      code: 'implausible',
      message:
        `That is ${Math.round(carriedM)} m in ${(carriedMs / 1000).toFixed(1)} s. ` +
        'Either your GPS jumped or something is wrong.',
      reachM,
      squares: [...liftVerdict.squares, ...placeVerdict.squares],
      carriedM,
      carriedMs,
    };
  }

  return {
    ok: true,
    reachM,
    squares: [...liftVerdict.squares, ...placeVerdict.squares],
    carriedM,
    carriedMs,
  };
}

/**
 * Is a player standing in their own start zone (their back rank)?
 *
 * Used both for the opening handshake and for resuming a suspended game. Body
 * position is part of the game state and cannot be serialised, so instead of
 * trying to restore it we reset it: both players return to their own back rank,
 * which neutralises whatever positional advantage the interruption created.
 */
export function inStartZone(
  geo: FieldGeometry,
  pos: LatLng,
  accuracyM: number,
  color: Color,
  cfg: ReachConfig = DEFAULT_REACH,
  bonusM = 0,
): { ok: boolean; nearestM: number; reachM: number } {
  const reachM = effectiveReachM(accuracyM, cfg, bonusM);
  let nearestM = Infinity;
  for (const sq of startZoneSquares(color)) {
    const d = distanceToSquareM(geo, pos, fromSquare(sq));
    if (d < nearestM) nearestM = d;
  }
  return { ok: nearestM <= reachM, nearestM, reachM };
}

/**
 * Plausibility check on consecutive fixes — the only anti-cheat v1 attempts.
 *
 * Both players are standing in the same field watching each other, so social
 * enforcement does the real work. This just catches a teleport obvious enough
 * to be worth logging.
 */
export const MAX_PLAUSIBLE_SPEED_MPS = 12; // a very fast sprint, with slack

export function impliedSpeedMps(
  distanceM: number,
  elapsedMs: number,
): number {
  if (elapsedMs <= 0) return Infinity;
  return distanceM / (elapsedMs / 1000);
}

export function isPlausibleStep(
  distanceM: number,
  elapsedMs: number,
  accuracySumM: number,
): boolean {
  // GPS jitter alone can look like motion, so forgive movement within the
  // combined error budget before asking about speed.
  if (distanceM <= accuracySumM) return true;
  return impliedSpeedMps(distanceM - accuracySumM, elapsedMs) <= MAX_PLAUSIBLE_SPEED_MPS;
}
