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
 * The same rule serves every message that carries a report — `pos`, and the
 * lift and place that begin and end each carry (decision 0041) — over the same
 * stored leg, baseline and window, so a place and the relay after it cannot
 * both be paid for the same meters.
 *
 * What all of this costs an honest phone is **a fixed amount per active period,
 * not a fraction of the walking**: the first report after the start is a
 * baseline, and whatever the phone's accumulator has not yet confirmed when the
 * final place is sent is never reported. Each is under one accumulator hop —
 * `max(4 m, 2 × claimed accuracy)` (decision 0020), so 10 m at the simulator's
 * 5 m accuracy. Measured on Fool's mate (`check-record.mjs`, `check-review.mjs`):
 * a steady 12–14 m lost of 58–72 m counted once lift and place carried the
 * counter, against 15.3–16.4 m before, when everything after the last relay
 * before the mate was lost. The
 * error is all one way: this under-counts and never over-counts, which is the
 * side to be wrong on for a number nobody can audit (O-03). The phone's own
 * counter is a further under-count of the ground walked, which is O-38's and
 * not this function's. What a player is finally shown and recorded is this
 * credit floored by their own carries (decision 0041), so on stop-and-start
 * play the figure may be the carries rather than the credit.
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

/**
 * This game's distance, or null where nobody measured it (decision 0040, rule 7).
 *
 * The pair `travel_leg IS NULL AND travel_m > 0` means "credited under the old
 * rule, never reported under the new one": a game already being played when
 * stage 2.3.5.3 arrived holds whatever the phone's page-long counter had
 * reached — the calibration walk, the walk to the park, the game before this
 * one — and that is not a distance walked *here*. It reads as **unmeasured**,
 * which is not the same as zero: a zero claims somebody walked nowhere.
 *
 * A zero with no leg is a measured zero, deliberately. It is right for a game
 * nobody moved in, and it is also what a game zeroed by the schema-4 upgrade
 * and never reported again reads as — the accepted caveat in decision 0040.
 * Either way the record and the report then floor it by the player's own
 * carries (`flooredTravelM`, decision 0041), so a zero survives only for a
 * player who carried nothing. This function answers "was it measured"; the
 * floor answers "how far, at least".
 *
 * One function rather than the predicate written out twice, because the record
 * line and the post-game report (stage 8.1) both have to call the same game
 * unmeasured or the PGN and the record will disagree about it.
 */
export function measuredTravelM(travelM: number, travelLeg: string | null): number | null {
  if (!Number.isFinite(travelM)) return 0;
  return travelLeg === null && travelM > 0 ? null : travelM;
}
