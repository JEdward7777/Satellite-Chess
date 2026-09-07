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
  /**
   * Reach at a good fix, in squares. The parameter players actually choose.
   *
   * Squares, not metres, because the playable window is bounded by the square
   * at both ends (decision 0031). Too large and you play ordinary chess from
   * one spot; too small and you fight the lock while the clock runs. A field is
   * whatever ground people have, so the square is an input and this is the
   * variable.
   */
  baseSquares: number;
  /** Floor on effective reach, in squares — below this the game is unplayable. */
  minSquares: number;
  /**
   * Ceiling on effective reach, in squares. Absolute: a handicap does not raise
   * it (O-02). Without a ceiling, "grow the circle when the fix is poor" has no
   * endpoint and the field stops mattering.
   */
  maxSquares: number;
  /**
   * Reported accuracy at or below this costs nothing.
   *
   * Metres, because it is a number the device reports about itself rather than
   * a distance on the board. The 2026-09-06 walk found reported accuracy is
   * ~16x pessimistic — median 3.37 m claimed against 0.21 m actual, and never
   * better than 3.00 m — so treating an ordinary fix as free is closer to the
   * truth than adding it raw, which spent the whole reach budget on noise.
   */
  goodAccuracyM: number;
  /** Above this reported accuracy we refuse to accept moves at all. */
  maxAccuracyM: number;
}

export const DEFAULT_REACH: ReachConfig = {
  baseSquares: 0.4,
  minSquares: 0.25,
  maxSquares: 1.5,
  goodAccuracyM: 5,
  maxAccuracyM: 25,
};

/**
 * The range the reach dial offers, and the most a handicap may add — in squares.
 *
 * These live here rather than on the create screen because the client is
 * untrusted: `POST /api/game` re-applies exactly these bounds, so a hand-rolled
 * request cannot create a game with a reach the UI would refuse to offer. That
 * is the server half of **O-02**.
 */
export const MIN_REACH_SQUARES = 0.25;
export const MAX_REACH_SQUARES = 1.5;
export const MAX_HANDICAP_SQUARES = 0.5;
/** One notch of either dial. Fractional squares, deliberately. */
export const REACH_STEP_SQUARES = 0.05;

/** Round to the dial's step, so a float never shows up as 0.30000000000000004. */
function toStep(squares: number): number {
  // Via a fixed number of decimals: 0.3 / 0.05 * 0.05 is 0.30000000000000004 in
  // binary floating point, and that number would be shown to a player.
  return Number((Math.round(squares / REACH_STEP_SQUARES) * REACH_STEP_SQUARES).toFixed(2));
}

/** Clamp the reach dial onto the offered range, in squares. */
export function clampReachSquares(squares: unknown): number {
  if (typeof squares !== 'number' || !Number.isFinite(squares)) return DEFAULT_REACH.baseSquares;
  return toStep(Math.min(MAX_REACH_SQUARES, Math.max(MIN_REACH_SQUARES, squares)));
}

/** Clamp a handicap onto the offered range, in squares. */
export function clampHandicapSquares(squares: unknown): number {
  if (typeof squares !== 'number' || !Number.isFinite(squares)) return 0;
  return toStep(Math.min(MAX_HANDICAP_SQUARES, Math.max(0, squares)));
}

/** The reach rule for a game, from whatever the creator asked for. */
export function reachFromSquares(squares: unknown): ReachConfig {
  return { ...DEFAULT_REACH, baseSquares: clampReachSquares(squares) };
}

/**
 * Per-player reach bonus, in **squares**.
 *
 * This answers one of the open questions: reach is the right place to put a
 * handicap for mismatched fitness, because it is continuous, it is visible on
 * both screens as a bigger circle, and it does not distort the clock. A player
 * who cannot sprint gets to stretch further instead of getting free time.
 *
 * Squares rather than metres (decision 0031): a metre handicap against a
 * square-based reach is the unit mismatch O-02 was about.
 */
export type ReachBonuses = Record<Color, number>;

export const NO_BONUSES: ReachBonuses = { w: 0, b: 0 };

/**
 * Effective reach in metres, for one fix on one board.
 *
 * `squareM` is `FieldGeometry.meanSquareM` — the side of a square of the same
 * area as one real cell. It is the scale everything here is expressed against.
 *
 * Accuracy contributes only what it claims *in excess of* a good fix, so an
 * ordinary fix buys no slack and a genuinely bad one still grows the circle
 * rather than refusing the move (decision 0023's surviving half).
 */
export function effectiveReachM(
  accuracyM: number,
  squareM: number,
  cfg: ReachConfig = DEFAULT_REACH,
  bonusSquares = 0,
): number {
  const s = Math.max(0, squareM);
  const bonus = Math.max(0, bonusSquares);
  const excessM = Math.max(0, (Number.isFinite(accuracyM) ? accuracyM : 0) - cfg.goodAccuracyM);
  const raw = (cfg.baseSquares + bonus) * s + excessM;
  return clamp(raw, cfg.minSquares * s, cfg.maxSquares * s);
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

/** Machine-readable failure reasons. A subset of the protocol's `ErrorCode`. */
export type ReachFailure = 'accuracy' | 'out_of_reach' | 'implausible';

export interface ReachVerdict {
  ok: boolean;
  /** Machine-readable failure, for the client to map to a specific message. */
  code?: ReachFailure;
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
  bonusSquares = 0,
): ReachVerdict {
  const reachM = effectiveReachM(accuracyM, geo.meanSquareM, cfg, bonusSquares);
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
  bonusSquares = 0,
): CarryVerdict {
  const reachM = effectiveReachM(
    Math.max(lift.accuracyM, place.accuracyM),
    geo.meanSquareM,
    cfg,
    bonusSquares,
  );
  const carriedM = distanceM(lift.pos, place.pos);
  const carriedMs = Math.max(0, place.at - lift.at);

  const liftVerdict = checkReachTo(geo, lift.pos, lift.accuracyM, from, cfg, bonusSquares);
  if (!liftVerdict.ok) {
    return {
      ...liftVerdict,
      message: `When you picked the piece up you were not at ${from}. ${liftVerdict.message ?? ''}`.trim(),
      carriedM,
      carriedMs,
    };
  }

  const placeVerdict = checkReachTo(geo, place.pos, place.accuracyM, to, cfg, bonusSquares);
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
  bonusSquares = 0,
): { ok: boolean; nearestM: number; reachM: number } {
  const reachM = effectiveReachM(accuracyM, geo.meanSquareM, cfg, bonusSquares);
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
