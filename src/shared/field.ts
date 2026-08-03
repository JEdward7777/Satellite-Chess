/**
 * The field model: how tapped GPS corners become 64 squares on the ground.
 *
 * Calibration convention (important, and a decision the brief left open):
 * the taps are the **centres of corner squares** — a1, h1, h8, a8 — not the
 * outer corners of the board. "Stand where the white rook goes" is a thing two
 * people can agree on while standing in a field; "stand at the mathematical
 * corner of an imaginary square" is not (decision 0002).
 *
 * **Four taps, fitted as an affine map** (decision 0028). The board is a
 * parallelogram: files and ranks have their own spacing and need not be
 * perpendicular, so a board can be laid into a rectangular pitch. The fit is
 * least-squares rather than an interpolation through the four points, because
 * a tap carries several metres of GPS error and an interpolation would
 * reproduce that error as the shape of the board. Measured: least-squares beat
 * bilinear interpolation at every noise level tried, on square *and* on
 * rectangular ground.
 *
 * **Two-tap fields still work, and still mean what they always meant.** A spec
 * with only `a1` and `h8` is read as the square board it was calibrated as.
 * That is why the raw taps are the stored truth and the projection is derived
 * on load — the note this paragraph replaces predicted exactly this revision.
 *
 * ## Two frames, and the difference matters
 *
 * Once the board can be skewed, "position on the board" splits into two
 * questions that used to have one answer:
 *
 * - **{@link BoardPoint} is metric.** Metres in a rigid frame anchored at a1 —
 *   a pure rotation of the ground, so a distance in board space is a real
 *   distance on the grass. Reach, drawing and anything measured lives here.
 * - **{@link BoardIndex} is combinatorial.** Which square, in file/rank units,
 *   through the affine inverse. Whole numbers are square centres. Nothing
 *   metric may be computed from it, because on a skewed board one index step
 *   along a file and one along a rank are different distances.
 *
 * Collapsing these back into one type would silently reintroduce the
 * squares-are-square assumption everywhere a subtraction happens.
 */

import {
  type Enu,
  type LatLng,
  add,
  bearingOf,
  dot,
  fromLocal,
  length,
  rotateBearing,
  scale,
  sub,
  toLocal,
  unitFromBearing,
} from './geo.js';
import { type FileRank, type Square, fromSquare } from './squares.js';

/** Centre-to-centre distance from a1 to h8, in units of one square. */
const DIAGONAL_SQUARES = 7 * Math.SQRT2;

/**
 * Where a copied field came from, carried by every copy of it.
 *
 * Provenance is what makes copying survivable. Without it, joining ten games on
 * the same common leaves ten identical fields on a phone, and a friend who
 * re-calibrates and shares the link again gives you a second entry rather than a
 * better one. Decision 0016 asks for the original field's identity and version
 * for exactly this.
 *
 * It is **not** the sharer's identity — decision 0017 amends 0016 on that point.
 * A field link carries ground and a name, and nothing about people.
 */
export interface FieldLineage {
  /**
   * A stable key for the ground, inherited by every copy rather than re-derived.
   *
   * Inherited, so that A → B → C still recognises C's copy as the same field A
   * shared; re-deriving at each hop would make every copy its own lineage.
   * `fieldKey` in `fieldlink.ts` is the one place it is computed.
   */
  key: string;
  /** The lineage's version at the moment this copy was taken. */
  version: number;
}

export interface FieldOrigin extends FieldLineage {
  /** How the copy arrived. Local only — never on the wire. */
  via: 'link' | 'game';
}

/** A saved, re-calibratable field. Raw taps only — no derived geometry. */
export interface FieldSpec {
  id: string;
  name: string;
  /** Tapped centre of square a1. */
  a1: LatLng;
  /** Tapped centre of square h8. */
  h8: LatLng;
  /**
   * Tapped centres of the other two corner squares (decision 0028).
   *
   * Optional because every field calibrated before four taps existed has only
   * the diagonal, and those fields must keep working exactly as they did. When
   * these are absent the board is the square one the two taps described; when
   * they are present the fit is affine and the board may be a parallelogram.
   */
  h1?: LatLng;
  a8?: LatLng;
  /** Accuracy reported at each tap, in metres — kept for diagnostics. */
  a1Accuracy?: number;
  h8Accuracy?: number;
  h1Accuracy?: number;
  a8Accuracy?: number;
  /** Bumped on every re-calibration of the same field. */
  version: number;
  createdAt: number;
  updatedAt: number;
  /**
   * Absent on a field walked out on this phone; present on one that arrived as a
   * copy, from a shared link or from a game played on it (decisions 0016, 0027).
   *
   * A copy is owned outright — renameable, re-calibratable, deletable — so this
   * is a note about where it came from, not a claim on it by anyone.
   */
  origin?: FieldOrigin;
}

/** Everything derived from a FieldSpec. Cheap to recompute; never stored. */
export interface FieldGeometry {
  /** Tangent-plane anchor: the fitted centre of a1 (not necessarily the tap). */
  origin: LatLng;
  /**
   * Metres from one square centre to the next, along each axis.
   *
   * Equal on a square board. `fileM` is the a->h step, `rankM` the 1->8 step.
   */
  fileM: number;
  rankM: number;
  /**
   * One number for the screens that need one — the geometric mean of the two
   * steps, which is the side of a square of the same area as one real cell.
   *
   * Display and sanity-checking only. Never use it to place or measure
   * anything: on a skewed board it is a summary, not a length that exists.
   */
  meanSquareM: number;
  /** Angle between the file and rank axes, in degrees. 90 on a square board. */
  axisAngleDeg: number;
  /** Compass bearing of the a->h axis, degrees clockwise from true north. */
  bearingDeg: number;
  /** Ground step for one square along the files — carries length and direction. */
  fileStep: Enu;
  /** Ground step for one square along the ranks. */
  rankStep: Enu;
  /**
   * The rigid frame {@link BoardPoint} is measured in: `uHat` along the file
   * axis, `vHat` 90 degrees counter-clockwise of it. Orthonormal by
   * construction, which is what makes board-space distances real distances.
   */
  uHat: Enu;
  vHat: Enu;
  /** Inverse of `[fileStep rankStep]`, for {@link toBoardIndex}. */
  inv: { a: number; b: number; c: number; d: number };
}

/**
 * A place on the ground, in metres, in a rigid frame anchored at a1.
 *
 * A pure rotation of the ground plane, so `Math.hypot` between two of these is
 * a real distance a player would walk. This is the frame for reach, drawing and
 * every measurement.
 */
export interface BoardPoint {
  /** Metres along the a->h direction, from the centre of a1. */
  u: number;
  /** Metres 90 degrees counter-clockwise of it. */
  v: number;
}

/**
 * A place on the board in square units: `{ file: 4.5, rank: 0 }` is the edge
 * between e1 and f1.
 *
 * Whole numbers are square centres. **Not metric** — on a skewed board a step
 * of 1 along the files and a step of 1 along the ranks are different distances,
 * so nothing here may be fed to a distance function.
 */
export interface BoardIndex {
  file: number;
  rank: number;
}

/**
 * The taps a calibration produces. `h1`/`a8` absent means the two-tap board.
 *
 * A type of its own because the corners now travel together through
 * calibration, saving and re-calibration, and passing them as four positional
 * arguments would make a transposed pair a silent bug rather than a wrong name.
 */
export interface FieldCorners {
  a1: LatLng;
  h8: LatLng;
  h1?: LatLng;
  a8?: LatLng;
}

export function makeFieldSpec(
  name: string,
  corners: FieldCorners,
  opts: {
    id?: string;
    accuracy?: Partial<Record<CornerName, number>>;
    now?: number;
  } = {},
): FieldSpec {
  const now = opts.now ?? Date.now();
  const acc = opts.accuracy ?? {};
  return {
    id: opts.id ?? crypto.randomUUID(),
    name,
    a1: corners.a1,
    h8: corners.h8,
    h1: corners.h1,
    a8: corners.a8,
    a1Accuracy: acc.a1,
    h8Accuracy: acc.h8,
    h1Accuracy: acc.h1,
    a8Accuracy: acc.a8,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/** Corner squares, in the order calibration walks them. */
export type CornerName = 'a1' | 'h1' | 'h8' | 'a8';
export const CORNER_ORDER: readonly CornerName[] = ['a1', 'h1', 'h8', 'a8'];
/** Where each corner sits in square units — the far corner is 7 steps, not 8. */
export const CORNER_INDEX: Record<CornerName, BoardIndex> = {
  a1: { file: 0, rank: 0 },
  h1: { file: 7, rank: 0 },
  h8: { file: 7, rank: 7 },
  a8: { file: 0, rank: 7 },
};

/** True when the spec carries all four corners rather than just the diagonal. */
export function hasFourCorners(
  spec: Pick<FieldSpec, 'a1' | 'h8' | 'h1' | 'a8'>,
): spec is Pick<FieldSpec, 'a1' | 'h8'> & { h1: LatLng; a8: LatLng } {
  return spec.h1 != null && spec.a8 != null;
}

/**
 * Fit the board to the taps.
 *
 * With four corners this is the least-squares affine fit, and for corners at
 * the four points of a rectangle in index space it has a closed form worth
 * seeing plainly: **each axis step is the average of the two edges that run
 * along it**, and the origin is the centroid walked back to a1. Averaging the
 * opposite edges is the whole benefit — a tap that is 4 m out moves the fitted
 * step by half that and cannot skew the board on its own, where an
 * interpolation through the same four points would bake it into the shape.
 *
 * With two corners it is the old square board exactly: the axes sit at 45
 * degrees to the a1->h8 diagonal, which is the only assumption two points
 * support. The rank axis is 90 degrees counter-clockwise of the file axis,
 * which is what "a1 at bottom-left, seen from above" means and fixes the
 * handedness two points leave open.
 */
export function deriveGeometry(
  spec: Pick<FieldSpec, 'a1' | 'h8' | 'h1' | 'a8'>,
): FieldGeometry {
  let origin: LatLng;
  let fileStep: Enu;
  let rankStep: Enu;

  if (hasFourCorners(spec)) {
    // Everything in one tangent plane, anchored at the a1 tap so the numbers
    // stay small; the fitted origin is recovered at the end.
    const a1 = { e: 0, n: 0 };
    const h1 = toLocal(spec.a1, spec.h1);
    const h8 = toLocal(spec.a1, spec.h8);
    const a8 = toLocal(spec.a1, spec.a8);

    // The two file-running edges (a1->h1, a8->h8), averaged, over 7 steps.
    fileStep = scale(add(sub(h1, a1), sub(h8, a8)), 1 / (2 * 7));
    // The two rank-running edges (a1->a8, h1->h8).
    rankStep = scale(add(sub(a8, a1), sub(h8, h1)), 1 / (2 * 7));

    // Least-squares origin: the fit passes through the centroid, which sits at
    // index (3.5, 3.5).
    const centroid = scale(add(add(a1, h1), add(h8, a8)), 1 / 4);
    const fitted = sub(centroid, add(scale(fileStep, 3.5), scale(rankStep, 3.5)));
    origin = fromLocal(spec.a1, fitted);
  } else {
    const diagonal = toLocal(spec.a1, spec.h8);
    const diagonalM = length(diagonal);
    if (!(diagonalM > 0)) {
      throw new Error('degenerate field: the two corners are the same point');
    }
    const squareM = diagonalM / DIAGONAL_SQUARES;
    // The diagonal's bearing is the mean of the two axis bearings, which sit
    // +/-45 degrees either side of it.
    const bearingDeg = rotateBearing(bearingOf(diagonal), 45);
    origin = spec.a1;
    fileStep = scale(unitFromBearing(bearingDeg), squareM);
    rankStep = scale(unitFromBearing(rotateBearing(bearingDeg, -90)), squareM);
  }

  const fileM = length(fileStep);
  const rankM = length(rankStep);
  const det = fileStep.e * rankStep.n - fileStep.n * rankStep.e;
  if (!(fileM > 0) || !(rankM > 0) || Math.abs(det) < 1e-9) {
    throw new Error('degenerate field: the corners do not describe a board');
  }

  const bearingDeg = bearingOf(fileStep);
  const uHat = scale(fileStep, 1 / fileM);
  // 90 degrees counter-clockwise of the file axis, matching the two-tap rule.
  const vHat = unitFromBearing(rotateBearing(bearingDeg, -90));

  return {
    origin,
    fileM,
    rankM,
    meanSquareM: Math.sqrt(fileM * rankM),
    axisAngleDeg: (Math.acos(dot(uHat, scale(rankStep, 1 / rankM))) * 180) / Math.PI,
    bearingDeg,
    fileStep,
    rankStep,
    uHat,
    vHat,
    // Inverse of the 2x2 [fileStep rankStep], so a ground offset becomes an
    // index directly. Closed form: no iteration, and both ends of the wire get
    // bit-for-bit the same answer, which a solver could not promise.
    inv: {
      a: rankStep.n / det,
      b: -rankStep.e / det,
      c: -fileStep.n / det,
      d: fileStep.e / det,
    },
  };
}

/** Project a real-world coordinate into the metric board frame. */
export function toBoardPoint(geo: FieldGeometry, p: LatLng): BoardPoint {
  const local = toLocal(geo.origin, p);
  return { u: dot(local, geo.uHat), v: dot(local, geo.vHat) };
}

/** Inverse of {@link toBoardPoint}. */
export function fromBoardPoint(geo: FieldGeometry, bp: BoardPoint): LatLng {
  const local = add(scale(geo.uHat, bp.u), scale(geo.vHat, bp.v));
  return fromLocal(geo.origin, local);
}

/**
 * Where a point falls on the board, in square units — the affine inverse.
 *
 * This is the one that answers "which square am I on", and the one that has to
 * be a matrix inverse rather than a search: it runs on every GPS fix on both
 * phones and again on the server for every lift and place, and the two ends
 * have to agree exactly or they will disagree about a move at a boundary.
 */
export function toBoardIndex(geo: FieldGeometry, p: LatLng): BoardIndex {
  return boardIndexOfLocal(geo, toLocal(geo.origin, p));
}

/** {@link toBoardIndex}, for a point already in the metric board frame. */
export function boardIndexOf(geo: FieldGeometry, bp: BoardPoint): BoardIndex {
  return boardIndexOfLocal(geo, add(scale(geo.uHat, bp.u), scale(geo.vHat, bp.v)));
}

function boardIndexOfLocal(geo: FieldGeometry, local: Enu): BoardIndex {
  const { a, b, c, d } = geo.inv;
  return { file: a * local.e + b * local.n, rank: c * local.e + d * local.n };
}

/** Ground offset from a1's centre to an index, as a metric board point. */
export function boardPointOfIndex(geo: FieldGeometry, bi: BoardIndex): BoardPoint {
  const local = add(scale(geo.fileStep, bi.file), scale(geo.rankStep, bi.rank));
  return { u: dot(local, geo.uHat), v: dot(local, geo.vHat) };
}

/** Metric board-frame centre of a square. */
export function squareCentre(geo: FieldGeometry, fr: FileRank): BoardPoint {
  return boardPointOfIndex(geo, { file: fr.file, rank: fr.rank });
}

/**
 * The four corners of a square, in the metric frame, wound consistently.
 *
 * A square is a parallelogram once the board can be skewed, so this is what
 * drawing and distance both have to work from — a centre and a size no longer
 * describe it.
 */
export function squareCornersBoard(geo: FieldGeometry, fr: FileRank): BoardPoint[] {
  return [
    { file: fr.file - 0.5, rank: fr.rank - 0.5 },
    { file: fr.file + 0.5, rank: fr.rank - 0.5 },
    { file: fr.file + 0.5, rank: fr.rank + 0.5 },
    { file: fr.file - 0.5, rank: fr.rank + 0.5 },
  ].map((bi) => boardPointOfIndex(geo, bi));
}

/** Real-world centre of a square — what you walk to. */
export function squareCentreLatLng(geo: FieldGeometry, fr: FileRank): LatLng {
  return fromBoardPoint(geo, squareCentre(geo, fr));
}

/** The four real-world corners of a square, for drawing it on a map. */
export function squareCornersLatLng(geo: FieldGeometry, fr: FileRank): LatLng[] {
  return squareCornersBoard(geo, fr).map((bp) => fromBoardPoint(geo, bp));
}

/**
 * Distance in metres from a point to the nearest part of a square.
 *
 * Deliberately not distance-to-centre. With 8 m squares and a 6 m reach,
 * distance-to-centre would put you out of reach of the very square you are
 * standing on, which players would rightly call broken. Nearest-point means
 * standing anywhere on a square always reaches it, and the reach radius
 * additionally lets you stretch to nearby squares.
 */
export function distanceToSquareM(geo: FieldGeometry, p: LatLng, fr: FileRank): number {
  return distanceFromBoardPointToSquareM(geo, toBoardPoint(geo, p), fr);
}

export function distanceFromBoardPointToSquareM(
  geo: FieldGeometry,
  bp: BoardPoint,
  fr: FileRank,
): number {
  // Point-to-parallelogram, measured in the rigid frame, where metres are still
  // metres. It used to be point-to-*rectangle* on the difference of centres,
  // which is only right while every square is an axis-aligned square of one
  // fixed size — the assumption decision 0028 removed.
  const corners = squareCornersBoard(geo, fr);
  let inside = true;
  let best = Infinity;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    // The winding is consistent, so a point inside is on the same side of every
    // edge. One sign flip and it is outside.
    if ((b.u - a.u) * (bp.v - a.v) - (b.v - a.v) * (bp.u - a.u) < 0) inside = false;
    best = Math.min(best, distanceToSegment(bp, a, b));
  }
  return inside ? 0 : best;
}

function distanceToSegment(p: BoardPoint, a: BoardPoint, b: BoardPoint): number {
  const du = b.u - a.u;
  const dv = b.v - a.v;
  const lenSq = du * du + dv * dv;
  const t = lenSq === 0 ? 0 : clamp(((p.u - a.u) * du + (p.v - a.v) * dv) / lenSq, 0, 1);
  return Math.hypot(p.u - (a.u + t * du), p.v - (a.v + t * dv));
}

export function distanceToSquareNameM(geo: FieldGeometry, p: LatLng, sq: Square): number {
  return distanceToSquareM(geo, p, fromSquare(sq));
}

/** `Math.round` yields -0 just below zero, which trips deep-equality checks. */
function roundIndex(x: number): number {
  return Math.round(x) + 0 || 0;
}

/** The square a point sits on, or null if the point is off the board. */
export function squareAt(geo: FieldGeometry, p: LatLng): FileRank | null {
  const bi = toBoardIndex(geo, p);
  const file = roundIndex(bi.file);
  const rank = roundIndex(bi.rank);
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return { file, rank };
}

/** Nearest square, clamped onto the board even when the point is outside it. */
export function nearestSquare(geo: FieldGeometry, p: LatLng): FileRank {
  const bi = toBoardIndex(geo, p);
  return {
    file: clamp(roundIndex(bi.file), 0, 7),
    rank: clamp(roundIndex(bi.rank), 0, 7),
  };
}

/**
 * Bounding box of the playing surface in the metric frame, outer half-squares
 * included.
 *
 * A bounding *box* rather than the board itself, because a skewed board is not
 * one — it is the smallest upright rectangle that contains it, which is what a
 * canvas needs. Derived from the four outer corners rather than from a side
 * length, since with a parallelogram the extreme points depend on the skew.
 */
export function boardExtentM(geo: FieldGeometry): {
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
  /** The longer side of the box — what a square viewport has to cover. */
  sizeM: number;
} {
  const corners = [
    { file: -0.5, rank: -0.5 },
    { file: 7.5, rank: -0.5 },
    { file: 7.5, rank: 7.5 },
    { file: -0.5, rank: 7.5 },
  ].map((bi) => boardPointOfIndex(geo, bi));
  const us = corners.map((c) => c.u);
  const vs = corners.map((c) => c.v);
  const minU = Math.min(...us);
  const maxU = Math.max(...us);
  const minV = Math.min(...vs);
  const maxV = Math.max(...vs);
  return { minU, maxU, minV, maxV, sizeM: Math.max(maxU - minU, maxV - minV) };
}

/**
 * How far it is across the board — the longer side of its bounding box.
 *
 * Used for "how big is this field" copy and for the board-crossings measure
 * (decision 0019), both of which want one honest number rather than two.
 */
export function boardSizeM(geo: FieldGeometry): number {
  return boardExtentM(geo).sizeM;
}

/**
 * "8.0 m squares · 64 m a side", or "10.0 x 6.0 m squares · 80 m across".
 *
 * One place, because three screens said this and each would otherwise have to
 * decide for itself what to do when the two steps differ. A board whose squares
 * are not square must not describe itself with a single number — that is
 * exactly the misreport that would send someone to a field expecting one shape
 * and finding another.
 */
export function describeSquares(geo: FieldGeometry): string {
  const boardM = Math.round(boardSizeM(geo));
  return isSquareBoard(geo)
    ? `${geo.fileM.toFixed(1)} m squares · ${boardM} m a side`
    : `${geo.fileM.toFixed(1)} × ${geo.rankM.toFixed(1)} m squares · ${boardM} m across`;
}

/** Within a tenth of a metre and a degree of being the square board of old. */
export function isSquareBoard(geo: FieldGeometry): boolean {
  return Math.abs(geo.fileM - geo.rankM) < 0.1 && Math.abs(geo.axisAngleDeg - 90) < 1;
}

export interface CalibrationCheck {
  ok: boolean;
  /** Geometric mean of the two steps — one number for a sentence. */
  squareM: number;
  fileM: number;
  rankM: number;
  boardM: number;
  bearingDeg: number;
  /**
   * Worst distance, in metres, between a tapped corner and where the fitted
   * board puts that corner. Zero for a two-tap field, which cannot disagree
   * with itself.
   */
  residualM: number;
  /** Blocking problems. */
  errors: string[];
  /** Playable, but the player should know. */
  warnings: string[];
}

/**
 * How far each tap is from where the fit says that corner is.
 *
 * **This is what the third and fourth taps buy that two never could.** Two taps
 * and four unknowns is exactly determined: the fit passes through both points
 * whatever they are, the residual is identically zero, and a corner tapped in
 * the wrong place is indistinguishable from a correct one. With four taps the
 * fit is over-determined, so a mis-tap has somewhere to show up.
 *
 * **But it shows up small, and the reason matters.** Eight measurements against
 * six parameters leaves only two degrees of freedom of residual — exactly the
 * "these corners are not a parallelogram" component. An affine fit absorbs
 * everything else: a corner dragged *along* an axis is a perfectly good shear,
 * and comes back with a residual of zero. Measured against a single corner
 * displaced by d, the residual lands at about **d/4**. So this catches a corner
 * tapped in the wrong place entirely; it does not catch one tapped a few metres
 * out, and it was never going to.
 */
export function calibrationResiduals(
  spec: Pick<FieldSpec, 'a1' | 'h8' | 'h1' | 'a8'>,
  geo: FieldGeometry,
): number[] {
  if (!hasFourCorners(spec)) return [];
  return CORNER_ORDER.map((name) => {
    const tapped = toBoardPoint(geo, spec[name] as LatLng);
    const fitted = boardPointOfIndex(geo, CORNER_INDEX[name]);
    return Math.hypot(tapped.u - fitted.u, tapped.v - fitted.v);
  });
}

/**
 * Sanity-check a calibration before anyone commits to playing on it.
 *
 * The binding constraint is that one square has to be meaningfully larger than
 * the GPS error, or "which square am I on" becomes a coin flip.
 */
export function checkCalibration(
  spec: Pick<FieldSpec, 'a1' | 'h8' | 'h1' | 'a8'>,
  opts: { worstAccuracyM?: number } = {},
): CalibrationCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  let geo: FieldGeometry;
  try {
    geo = deriveGeometry(spec);
  } catch {
    return {
      ok: false,
      squareM: 0,
      fileM: 0,
      rankM: 0,
      boardM: 0,
      bearingDeg: 0,
      residualM: 0,
      errors: ['Those corners are in the same place. Walk to the next one first.'],
      warnings: [],
    };
  }

  const { fileM, rankM } = geo;
  const squareM = geo.meanSquareM;
  const boardM = boardSizeM(geo);
  const smallest = Math.min(fileM, rankM);
  const residuals = calibrationResiduals(spec, geo);
  const residualM = residuals.length === 0 ? 0 : Math.max(...residuals);

  // The *smaller* step decides identifiability: a board with 12 m files and
  // 3 m ranks is as ambiguous as a 3 m board, and the mean would hide that.
  if (smallest < 2) {
    errors.push(
      `Squares would be ${smallest.toFixed(1)} m across at the narrowest. That is smaller than ` +
        'GPS can resolve — pick a bigger field (at least 25 m corner to corner).',
    );
  } else if (smallest < 4) {
    warnings.push(
      `Squares are only ${smallest.toFixed(1)} m across at the narrowest. Expect ambiguity ` +
        'about which square you are on. 5 m or more plays much better.',
    );
  }

  if (squareM > 40) {
    errors.push(
      `Squares would be ${Math.round(squareM)} m across — a ${Math.round(boardM)} m board. ` +
        'That is almost certainly a mis-tap.',
    );
  } else if (squareM > 20) {
    warnings.push(
      `Squares are ${Math.round(squareM)} m across, so the board is ${Math.round(boardM)} m ` +
        'a side. Crossing it will take a while — consider a shorter clock or a smaller field.',
    );
  }

  // A board so long and thin that walking a rank and walking a file are
  // different games. Allowed — that is the point of fitting a real pitch — but
  // worth saying out loud before someone plays a whole game on it.
  const ratio = Math.max(fileM, rankM) / Math.max(smallest, 1e-9);
  if (ratio > 2.5) {
    warnings.push(
      `This board is ${ratio.toFixed(1)}x longer one way than the other — ` +
        `${fileM.toFixed(1)} m along the files against ${rankM.toFixed(1)} m along the ranks. ` +
        'That plays, but a move sideways costs much more than a move forward.',
    );
  }

  const acc = opts.worstAccuracyM;
  if (acc != null && smallest > 0 && acc > smallest * 0.75) {
    warnings.push(
      `Your GPS accuracy at calibration was ±${Math.round(acc)} m against ${smallest.toFixed(1)} m ` +
        'squares. The corners you tapped may be well off. Re-calibrate in the open if you can.',
    );
  }

  // Only reachable with four taps. The threshold is low because the residual
  // is itself about a quarter of the mis-tap that caused it (see
  // `calibrationResiduals`) — 0.35 of a square is roughly a corner tapped a
  // square and a half from where it should be.
  if (residualM > Math.max(2, smallest * 0.35)) {
    warnings.push(
      `Your four corners are ${residualM.toFixed(1)} m from making a straight-sided board. ` +
        'Check you tapped them in order, going round the edge rather than across it.',
    );
  }

  return {
    ok: errors.length === 0,
    squareM,
    fileM,
    rankM,
    boardM,
    bearingDeg: geo.bearingDeg,
    residualM,
    errors,
    warnings,
  };
}

/**
 * Re-calibrate an existing field in place, bumping its version.
 *
 * Games hold a snapshot, so this cannot reshape a game already in progress.
 */
export function recalibrate(
  spec: FieldSpec,
  corners: FieldCorners,
  opts: { accuracy?: Partial<Record<CornerName, number>>; now?: number } = {},
): FieldSpec {
  const acc = opts.accuracy ?? {};
  return {
    ...spec,
    a1: corners.a1,
    h8: corners.h8,
    // Explicitly re-set rather than spread, so re-calibrating a four-corner
    // field with two taps really does return it to a square board instead of
    // leaving the old corners behind to contradict the new diagonal.
    h1: corners.h1,
    a8: corners.a8,
    a1Accuracy: acc.a1,
    h8Accuracy: acc.h8,
    h1Accuracy: acc.h1,
    a8Accuracy: acc.a8,
    version: spec.version + 1,
    updatedAt: opts.now ?? Date.now(),
  };
}

/**
 * The immutable copy of a field that a game carries.
 *
 * A saved field is mutable and versioned; a game in progress must not change
 * shape underneath the players because someone re-calibrated on another phone.
 */
export interface FieldSnapshot {
  fieldId: string;
  name: string;
  version: number;
  a1: LatLng;
  h8: LatLng;
  /** Present only for a four-corner field; absent means the square board. */
  h1?: LatLng;
  a8?: LatLng;
  fileM: number;
  rankM: number;
  bearingDeg: number;
  snapshotAt: number;
}

export function snapshotField(spec: FieldSpec, now = Date.now()): FieldSnapshot {
  const geo = deriveGeometry(spec);
  return {
    fieldId: spec.id,
    name: spec.name,
    version: spec.version,
    a1: spec.a1,
    h8: spec.h8,
    ...(hasFourCorners(spec) ? { h1: spec.h1, a8: spec.a8 } : {}),
    // Derived values are included for display and for sanity-checking that a
    // reader's maths agrees with the writer's. The taps remain the truth — a
    // snapshot that carried only these could not be re-fitted.
    fileM: geo.fileM,
    rankM: geo.rankM,
    bearingDeg: geo.bearingDeg,
    snapshotAt: now,
  };
}

export function geometryFromSnapshot(
  snap: Pick<FieldSnapshot, 'a1' | 'h8' | 'h1' | 'a8'>,
): FieldGeometry {
  return deriveGeometry(snap);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export { clamp };
