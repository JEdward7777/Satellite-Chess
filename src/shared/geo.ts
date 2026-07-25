/**
 * Local ENU (East/North/Up) tangent-plane projection.
 *
 * We deliberately do not use a geodesic library. Over the few hundred metres a
 * playing field spans, an equirectangular projection with a cos(latitude)
 * correction on longitude has an error far below the ~3-10 m that consumer GPS
 * gives us, so anything fancier is measuring the thickness of the paint.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** A vector on the local tangent plane, in metres. */
export interface Enu {
  e: number;
  n: number;
}

/** WGS84 semi-major axis. */
const EARTH_RADIUS_M = 6378137;

const DEG = Math.PI / 180;

/** Metres per degree of latitude (constant enough at our scale). */
const M_PER_DEG_LAT = (EARTH_RADIUS_M * Math.PI) / 180;

/** Metres per degree of longitude at a given latitude. */
export function metresPerDegLng(lat: number): number {
  return M_PER_DEG_LAT * Math.cos(lat * DEG);
}

/** Project `p` onto the tangent plane anchored at `origin`. */
export function toLocal(origin: LatLng, p: LatLng): Enu {
  return {
    e: (p.lng - origin.lng) * metresPerDegLng(origin.lat),
    n: (p.lat - origin.lat) * M_PER_DEG_LAT,
  };
}

/** Inverse of {@link toLocal}. */
export function fromLocal(origin: LatLng, v: Enu): LatLng {
  return {
    lat: origin.lat + v.n / M_PER_DEG_LAT,
    lng: origin.lng + v.e / metresPerDegLng(origin.lat),
  };
}

export function add(a: Enu, b: Enu): Enu {
  return { e: a.e + b.e, n: a.n + b.n };
}

export function sub(a: Enu, b: Enu): Enu {
  return { e: a.e - b.e, n: a.n - b.n };
}

export function scale(a: Enu, k: number): Enu {
  return { e: a.e * k, n: a.n * k };
}

export function dot(a: Enu, b: Enu): number {
  return a.e * b.e + a.n * b.n;
}

export function length(a: Enu): number {
  return Math.hypot(a.e, a.n);
}

export function normalise(a: Enu): Enu {
  const l = length(a);
  if (l === 0) return { e: 0, n: 0 };
  return { e: a.e / l, n: a.n / l };
}

/**
 * Straight-line distance in metres between two coordinates.
 *
 * Anchored at `a`, so accuracy degrades with separation the same way the rest
 * of the projection does. Fine for field-scale work and for accumulating a
 * walked track one GPS fix at a time.
 */
export function distanceM(a: LatLng, b: LatLng): number {
  return length(toLocal(a, b));
}

/** Compass bearing of the vector, in degrees clockwise from true north. */
export function bearingOf(v: Enu): number {
  const deg = Math.atan2(v.e, v.n) / DEG;
  return (deg + 360) % 360;
}

/** Unit vector pointing along the given compass bearing. */
export function unitFromBearing(bearingDeg: number): Enu {
  const r = bearingDeg * DEG;
  return { e: Math.sin(r), n: Math.cos(r) };
}

/** Rotate a bearing and wrap into [0, 360). */
export function rotateBearing(bearingDeg: number, byDeg: number): number {
  return ((bearingDeg + byDeg) % 360 + 360) % 360;
}
