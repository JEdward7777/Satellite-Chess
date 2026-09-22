/**
 * Distance walked in one game, credited on the server from what a phone
 * reports (stage 2.3.5.3, decision 0040).
 *
 * Split out of `game-do.ts` so that the rule is a pure function a node test can
 * read, rather than a paragraph inside a socket handler.
 */

import { MAX_PLAUSIBLE_SPEED_MPS } from '../shared/reach.js';

/** A phone's distance-counter id is a label, not data; long ones are cut. */
export const MAX_TRAVEL_LEG_CHARS = 64;

/**
 * How much of a reported distance this game should be credited with (stage
 * 2.3.5.3, decision 0040). Pure, so the rule can be read — and tested — apart
 * from the socket that feeds it.
 *
 * The phone reports the running total of a counter that lives as long as its
 * page does (`GpsCore`), tagged with that counter's `leg`. So:
 *
 * - **A leg this game has not seen** — a reload, or a second game in the same
 *   sitting — sets the baseline and earns nothing. Its total so far was walked
 *   somewhere else: calibrating, crossing town, an earlier game.
 * - **The same leg** earns what it has added since its last report, and never
 *   less than nothing: a stale or reordered report cannot take distance away.
 * - **Only an active game earns.** Walking to the back rank before the start,
 *   wandering off during a suspension, and leaving the field after the result
 *   are not chess. The baseline still moves, so they are not credited later
 *   either.
 * - **No faster than a sprint, over a window that cannot be banked.** A credit
 *   is capped at {@link MAX_PLAUSIBLE_SPEED_MPS} over `budgetMs`, which the
 *   caller measures from the **later** of this player's last accepted report and
 *   the moment the clock last started — so a phone that says nothing through
 *   staging or a suspension cannot save up a ceiling there and spend it in one
 *   message. The property that holds over a whole game is the one worth stating:
 *   **total credit is at most `MAX_PLAUSIBLE_SPEED_MPS` × the time the game
 *   spent active**, because every window is inside that time and the windows do
 *   not overlap. Silence during the opponent's think is therefore not a hole to
 *   close: it buys nothing the elapsed clock had not already allowed. None of
 *   this makes the number honest (O-03: a phone can still claim a steady jog
 *   while standing still); it bounds what may be claimed.
 *
 * `GameDO` also re-baselines every leg at the transition into `active` — the
 * start, and every resume — by marking the stored leg, so the walk to the back
 * rank and the walk back from a pause cannot arrive as one large first credit.
 * The rate cap could not do that by itself: it caps the rate, it does not
 * subtract the meters, and the gap before that first report is long enough that
 * the ceiling never binds.
 *
 * What all of this costs an honest phone is **a fixed amount per active period,
 * not a fraction of the walking**: the first report after the start is a
 * baseline, and whatever is walked after the last report before the result is
 * never sent. Each is about one accumulator hop — `max(4 m, 2 × claimed
 * accuracy)` (decision 0020), so ~16 m at the simulator's 5 m accuracy.
 * Measured with `check-record.mjs`: 15.3 m and 15.6 m lost out of 58.5 m
 * walked, and 13.0 m and 12.2 m lost out of 400.7 m and 390.5 m walked over the
 * same four moves — a real game is 1–3% short. The error is all one way: this
 * under-counts and never over-counts, which is the side to be wrong on for a
 * number nobody can audit (O-03).
 */
export function creditTravel(input: {
  leg: string;
  reportedM: unknown;
  storedLeg: string | null;
  seenM: number;
  active: boolean;
  /**
   * Milliseconds of walking this credit may be paid for: `now` minus the later
   * of the last accepted report and the last clock start. Null when there is no
   * such instant yet, which earns nothing.
   */
  budgetMs: number | null;
}): { creditM: number; leg: string | null; seenM: number } {
  const reported = input.reportedM;
  // A relay with no distance on it (an older client, or none measured yet)
  // moves the dot and changes nothing about distance.
  if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 0) {
    return { creditM: 0, leg: input.storedLeg, seenM: input.seenM };
  }
  if (input.leg !== input.storedLeg) {
    return { creditM: 0, leg: input.leg, seenM: reported };
  }
  const added = Math.max(0, reported - input.seenM);
  const ceiling =
    input.budgetMs === null ? 0 : (Math.max(0, input.budgetMs) / 1000) * MAX_PLAUSIBLE_SPEED_MPS;
  return {
    creditM: input.active ? Math.min(added, ceiling) : 0,
    leg: input.leg,
    seenM: Math.max(input.seenM, reported),
  };
}
