/**
 * Every distance a player reads, in the units they chose (O-21, decision 0049).
 *
 * **This is the only place a meter becomes a foot.** Everything underneath the
 * view layer is metric and stays metric: GPS answers in meters, the board is
 * fitted in meters, distance walked is accumulated and stored in meters, the
 * protocol and the archive carry meters, and the PGN says meters because it is
 * one canonical file per game (decision 0041). A conversion anywhere below the
 * words a player reads would be a second source of truth about how far somebody
 * walked, and the two would drift.
 *
 * So the setting is a *display* preference, and every formatter here takes the
 * value in meters and the units to say it in. Metric output is exactly what the
 * screens said before this module existed, so a player who never touches the
 * setting sees no change.
 *
 * ## Which US unit for which distance
 *
 * - **Feet** for anything short that a player reads while standing on the
 *   board: reach, a square's size, GPS accuracy, "walk 12 ft to e4".
 * - **Yards** for a board's size. A pitch is measured in yards, and an American
 *   laying one out thinks in them (O-21's design note).
 * - **Yards, then miles** for distance walked, the way the metric headline goes
 *   from meters to kilometers: "840 yd", then "1.4 mi".
 *
 * Reach itself is counted in **squares** (decision 0031), which is why the
 * game's main dial needed no conversion at all. Only the ground distance shown
 * beside it does.
 */

/** The two ways a player may read a distance. */
export type Units = 'metric' | 'us';

/** Exact, by international definition. */
export const METERS_PER_FOOT = 0.3048;
export const METERS_PER_YARD = 0.9144;
export const METERS_PER_MILE = 1609.344;
const YARDS_PER_MILE = 1760;

/** The value as `Units`, or null for anything else — for a body off the wire or out of storage. */
export function asUnits(value: unknown): Units | null {
  return value === 'metric' || value === 'us' ? value : null;
}

/**
 * The units a browser's locale suggests, for an account that has never chosen.
 *
 * The United States is the country that walks in feet and miles; Liberia and
 * Myanmar are the other two usually named, and are included for the same
 * reason. Everything else, including a bare `en` with no region, is metric.
 */
export function unitsForLocale(locale: string | null | undefined): Units {
  const region = /^[a-z]{2,3}(?:-[a-z]{4})?-([a-z]{2})\b/i.exec(locale ?? '')?.[1]?.toUpperCase();
  return region === 'US' || region === 'LR' || region === 'MM' ? 'us' : 'metric';
}

/** A number of meters the formatters can say: a negative or non-finite one is none. */
function clean(meters: number): number {
  return Number.isFinite(meters) && meters > 0 ? meters : 0;
}

/**
 * A whole number: "1,760" in US units, "1760" in metric. Metric is left
 * ungrouped because that is what every screen said before this module, and a
 * player who never touches the setting should see no change at all.
 */
function whole(n: number, units: Units): string {
  const s = String(n);
  return units === 'us' ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : s;
}

/**
 * The bare number of a short length, without its unit: "8.0" or "26".
 *
 * For a sentence that shares one unit between two numbers ("12.1 × 6.0 m
 * squares"). `places` is the metric precision the screen asks for; left out,
 * it is one decimal under ten meters and whole meters above, which is how the
 * game screen has always written a distance to walk. US feet ignore it: a
 * tenth of a foot under ten feet, and whole feet above, because a tenth of a
 * foot is already finer than any GPS fix.
 */
export function lengthNumber(meters: number, units: Units, places?: number): string {
  const m = clean(meters);
  if (units === 'metric') return m.toFixed(places ?? (m < 10 ? 1 : 0));
  const feet = m / METERS_PER_FOOT;
  // Decided on the rounded value, so 9.96 ft reads "10 ft" and not "10.0 ft".
  return Number(feet.toFixed(1)) < 10 ? feet.toFixed(1) : whole(Math.round(feet), units);
}

/** The unit {@link lengthNumber} is in. */
export function lengthUnit(units: Units): 'm' | 'ft' {
  return units === 'metric' ? 'm' : 'ft';
}

/** A short length on the ground: "3.2 m", "12 m" — or "10.5 ft", "39 ft". */
export function lengthWords(meters: number, units: Units, places?: number): string {
  return `${lengthNumber(meters, units, places)} ${lengthUnit(units)}`;
}

/** How sure the phone is: "±5 m", "±16 ft", or "unknown" when it did not say. */
export function accuracyWords(meters: number | null, units: Units): string {
  if (meters === null || !Number.isFinite(meters)) return 'unknown';
  const m = Math.max(0, meters);
  return units === 'metric'
    ? `±${Math.round(m)} m`
    : `±${whole(Math.round(m / METERS_PER_FOOT), units)} ft`;
}

/** The number in {@link boardWords}, for "an 80 yd board" and its article. */
export function boardNumber(meters: number, units: Units): number {
  const m = clean(meters);
  return Math.round(units === 'metric' ? m : m / METERS_PER_YARD);
}

/** A board's size, whole: "64 m", or "70 yd". */
export function boardWords(meters: number, units: Units): string {
  return `${whole(boardNumber(meters, units), units)} ${units === 'metric' ? 'm' : 'yd'}`;
}

/**
 * Distance walked, as a headline says it: "840 m", "2.4 km", "126 km" — or
 * "920 yd", "1.4 mi", "126 mi".
 *
 * One decimal of the long unit, because "2.4 km" is what people repeat to their
 * friends and "2.43 km" is a reading off an instrument. The switch to the long
 * unit is decided on the *rounded* value, so 999.7 m is "1.0 km" rather than
 * "1000 m", and 99.97 km is "100 km" rather than "100.0 km".
 *
 * **Null is not zero.** A game nobody measured says so (decision 0040), and a
 * formatter that quietly turned null into "0 m" would claim somebody walked
 * nowhere.
 */
export function walkedWords(meters: number | null, units: Units): string {
  if (meters === null) return 'not measured';
  const m = clean(meters);
  const [short, shortUnit, perLong, longUnit] =
    units === 'metric'
      ? [m, 'm', 1000, 'km']
      : [m / METERS_PER_YARD, 'yd', YARDS_PER_MILE, 'mi'];
  const shortWhole = Math.round(short);
  if (shortWhole < perLong) return `${whole(shortWhole, units)} ${shortUnit}`;
  const long = short / perLong;
  const tenths = Number(long.toFixed(1));
  return tenths < 100 ? `${tenths.toFixed(1)} ${longUnit}` : `${whole(Math.round(long), units)} ${longUnit}`;
}

/**
 * A size offered to a player as advice, rounded to something worth pacing out.
 *
 * Not a conversion: "5 m or more" becomes "15 ft or more", not "16.4 ft or
 * more", because the number is a recommendation and a recommendation in a
 * foreign unit converted to a decimal is not one anybody can use (O-21's
 * design note). Each pair is chosen by hand, so the US value is near the
 * metric one rather than equal to it — 15 ft is a little under 5 m, and 80 ft
 * a little under 25 m. What matters is that each still clears the thresholds
 * the checks really use: 15 ft (4.6 m) is above the 4 m practice floor, and a
 * board 80 ft corner to corner has squares well above the 2 m error.
 */
export const ADVICE = {
  /** The narrowest square worth playing on; the floor itself is 4 m. */
  goodSquare: { metric: '5 m', us: '15 ft' },
  /** The smallest board GPS can resolve at all, corner to corner. */
  smallestBoard: { metric: '25 m', us: '80 ft' },
  /** The range of square sizes that plays well, for the first calibration step. */
  squareRange: { metric: '5 to 10 m', us: '5 to 10 yards' },
  /** The ground that range makes, a side. */
  boardRange: { metric: '40 to 80 m', us: '40 to 80 yards' },
} as const satisfies Record<string, Record<Units, string>>;
