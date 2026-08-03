/**
 * The field model: how two tapped GPS corners become 64 squares on the ground.
 *
 * Calibration convention (important, and a decision the brief left open):
 * the two taps are the **centres of squares a1 and h8**, not the outer corners
 * of the board. "Stand where the white rook goes, then walk to where the black
 * rook goes" is a thing two people can agree on while standing in a field;
 * "stand at the mathematical corner of an imaginary square" is not.
 *
 * From those two points we assume the squares are square and the board's axes
 * sit at 45 degrees to the a1->h8 diagonal. That is the only assumption
 * available from two points, and it is the right one.
 *
 * We store the raw tapped coordinates as the source of truth and re-derive the
 * projection on load, so the maths here can be revised later without
 * invalidating fields people have already saved.
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
  /** Accuracy reported at each tap, in metres — kept for diagnostics. */
  a1Accuracy?: number;
  h8Accuracy?: number;
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
  /** Tangent-plane anchor: the centre of a1. */
  origin: LatLng;
  /** Edge length of one square, in metres. */
  squareM: number;
  /** Compass bearing of the a->h axis, degrees clockwise from true north. */
  bearingDeg: number;
  /** Unit vector along the a->h axis. */
  uFile: Enu;
  /** Unit vector along the 1->8 axis. */
  uRank: Enu;
}

/** Position expressed in board space: metres along the file and rank axes. */
export interface BoardPoint {
  /** Metres along the a->h axis, measured from the centre of a1. */
  u: number;
  /** Metres along the 1->8 axis, measured from the centre of a1. */
  v: number;
}

export function makeFieldSpec(
  name: string,
  a1: LatLng,
  h8: LatLng,
  opts: { id?: string; a1Accuracy?: number; h8Accuracy?: number; now?: number } = {},
): FieldSpec {
  const now = opts.now ?? Date.now();
  return {
    id: opts.id ?? crypto.randomUUID(),
    name,
    a1,
    h8,
    a1Accuracy: opts.a1Accuracy,
    h8Accuracy: opts.h8Accuracy,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Derive square size and board orientation from the two tapped corners.
 *
 * The rank axis is 90 degrees counter-clockwise from the file axis, which is
 * what "a1 at bottom-left, viewed from above" means. That fixes the handedness
 * the two taps alone would leave ambiguous.
 */
export function deriveGeometry(spec: Pick<FieldSpec, 'a1' | 'h8'>): FieldGeometry {
  const diagonal = toLocal(spec.a1, spec.h8);
  const diagonalM = length(diagonal);
  if (!(diagonalM > 0)) {
    throw new Error('degenerate field: the two corners are the same point');
  }
  const squareM = diagonalM / DIAGONAL_SQUARES;

  // Diagonal bearing is the mean of the two axis bearings, which sit +/-45
  // degrees either side of it.
  const diagonalBearing = bearingOf(diagonal);
  const bearingDeg = rotateBearing(diagonalBearing, 45);

  return {
    origin: spec.a1,
    squareM,
    bearingDeg,
    uFile: unitFromBearing(bearingDeg),
    uRank: unitFromBearing(rotateBearing(bearingDeg, -90)),
  };
}

/** Project a real-world coordinate into board space. */
export function toBoardPoint(geo: FieldGeometry, p: LatLng): BoardPoint {
  const local = toLocal(geo.origin, p);
  return { u: dot(local, geo.uFile), v: dot(local, geo.uRank) };
}

/** Inverse of {@link toBoardPoint}. */
export function fromBoardPoint(geo: FieldGeometry, bp: BoardPoint): LatLng {
  const local = add(scale(geo.uFile, bp.u), scale(geo.uRank, bp.v));
  return fromLocal(geo.origin, local);
}

/** Board-space centre of a square. */
export function squareCentre(geo: FieldGeometry, fr: FileRank): BoardPoint {
  return { u: fr.file * geo.squareM, v: fr.rank * geo.squareM };
}

/** Real-world centre of a square — what you walk to. */
export function squareCentreLatLng(geo: FieldGeometry, fr: FileRank): LatLng {
  return fromBoardPoint(geo, squareCentre(geo, fr));
}

/** The four real-world corners of a square, for drawing it on a map. */
export function squareCornersLatLng(geo: FieldGeometry, fr: FileRank): LatLng[] {
  const c = squareCentre(geo, fr);
  const h = geo.squareM / 2;
  return [
    { u: c.u - h, v: c.v - h },
    { u: c.u + h, v: c.v - h },
    { u: c.u + h, v: c.v + h },
    { u: c.u - h, v: c.v + h },
  ].map((bp) => fromBoardPoint(geo, bp));
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
  const c = squareCentre(geo, fr);
  const h = geo.squareM / 2;
  // Point-to-rectangle distance. The axes are orthonormal, so board space is a
  // rigid rotation of the ground plane and metres are still metres.
  const du = Math.max(0, Math.abs(bp.u - c.u) - h);
  const dv = Math.max(0, Math.abs(bp.v - c.v) - h);
  return Math.hypot(du, dv);
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
  const bp = toBoardPoint(geo, p);
  const file = roundIndex(bp.u / geo.squareM);
  const rank = roundIndex(bp.v / geo.squareM);
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return { file, rank };
}

/** Nearest square, clamped onto the board even when the point is outside it. */
export function nearestSquare(geo: FieldGeometry, p: LatLng): FileRank {
  const bp = toBoardPoint(geo, p);
  return {
    file: clamp(roundIndex(bp.u / geo.squareM), 0, 7),
    rank: clamp(roundIndex(bp.v / geo.squareM), 0, 7),
  };
}

/** Board-space extent of the playing surface, including the outer half-squares. */
export function boardExtentM(geo: FieldGeometry): {
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
  sizeM: number;
} {
  const h = geo.squareM / 2;
  return {
    minU: -h,
    maxU: 7 * geo.squareM + h,
    minV: -h,
    maxV: 7 * geo.squareM + h,
    sizeM: 8 * geo.squareM,
  };
}

/** Total side length of the board, in metres. */
export function boardSizeM(geo: FieldGeometry): number {
  return 8 * geo.squareM;
}

export interface CalibrationCheck {
  ok: boolean;
  squareM: number;
  boardM: number;
  bearingDeg: number;
  /** Blocking problems. */
  errors: string[];
  /** Playable, but the player should know. */
  warnings: string[];
}

/**
 * Sanity-check a calibration before anyone commits to playing on it.
 *
 * The binding constraint is that one square has to be meaningfully larger than
 * the GPS error, or "which square am I on" becomes a coin flip.
 */
export function checkCalibration(
  spec: Pick<FieldSpec, 'a1' | 'h8'>,
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
      boardM: 0,
      bearingDeg: 0,
      errors: ['The two corners are in the same place. Walk to the opposite corner first.'],
      warnings: [],
    };
  }

  const squareM = geo.squareM;
  const boardM = boardSizeM(geo);

  if (squareM < 2) {
    errors.push(
      `Squares would be ${squareM.toFixed(1)} m across. That is smaller than GPS can resolve — ` +
        'pick a bigger field (at least 25 m corner to corner).',
    );
  } else if (squareM < 4) {
    warnings.push(
      `Squares are only ${squareM.toFixed(1)} m across. Expect ambiguity about which square ` +
        'you are on. 5 m or more plays much better.',
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

  const acc = opts.worstAccuracyM;
  if (acc != null && squareM > 0 && acc > squareM * 0.75) {
    warnings.push(
      `Your GPS accuracy at calibration was ±${Math.round(acc)} m against ${squareM.toFixed(1)} m ` +
        'squares. The corners you tapped may be well off. Re-calibrate in the open if you can.',
    );
  }

  return { ok: errors.length === 0, squareM, boardM, bearingDeg: geo.bearingDeg, errors, warnings };
}

/**
 * Re-calibrate an existing field in place, bumping its version.
 *
 * Games hold a snapshot, so this cannot reshape a game already in progress.
 */
export function recalibrate(
  spec: FieldSpec,
  a1: LatLng,
  h8: LatLng,
  opts: { a1Accuracy?: number; h8Accuracy?: number; now?: number } = {},
): FieldSpec {
  return {
    ...spec,
    a1,
    h8,
    a1Accuracy: opts.a1Accuracy,
    h8Accuracy: opts.h8Accuracy,
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
  squareM: number;
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
    // Derived values are included for display and for sanity-checking that a
    // reader's maths agrees with the writer's. `a1`/`h8` remain the truth.
    squareM: geo.squareM,
    bearingDeg: geo.bearingDeg,
    snapshotAt: now,
  };
}

export function geometryFromSnapshot(snap: Pick<FieldSnapshot, 'a1' | 'h8'>): FieldGeometry {
  return deriveGeometry(snap);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export { clamp };
