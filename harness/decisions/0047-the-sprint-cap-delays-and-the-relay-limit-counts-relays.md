# 0047 — The sprint cap delays rather than discards, and the relay limit counts relays

- **Date:** 2026-09-25
- **Status:** accepted
- **Stage:** 10.9.6, 10.9.7; answers O-36 and O-39
- **Amends:** [0040](0040-the-record-is-one-line-per-finished-game-and-totals-are-derived.md) rule 6 (what the cap does with the excess)

## Decision

1. **What the sprint cap clips is owed, not dropped.** `creditTravel` keeps
   the excess in `presence.travel_owed_m` (schema 6) and pays it, before
   anything new, under the ceiling of the next report's own window. The cap is
   still `MAX_PLAUSIBLE_SPEED_MPS` over a window from the later of the last
   report and the last clock start, and windows still never overlap.
2. **At most 30 m is ever owed** (`MAX_OWED_TRAVEL_M`: a sprint for one relay
   interval, `12 m/s × 2.5 s`). Anything clipped beyond that is gone, as
   before.
3. **Nothing owed crosses a pause, a start or the result.** A report made
   while the game is not `active` drops it; `startIfBothReady` zeroes it, in
   the same place it marks every leg; and a finished game writes nothing about
   distance at all (0041 rule 9). A new leg keeps it: the meters were walked in
   play.
4. **The relay's own rate limit is measured from the last accepted relay**
   (`presence.last_relay_at`, schema 6), not from `last_pos_at`. A lift, a
   place or a `ready` still moves `last_pos_at`, which is what the travel
   window runs from, but no longer throttles the next relay. No new message
   and no new request: the throttle only ever decided what to do with a
   message already received.

## Why

Every ply re-stamps `last_clock_start_at` and every lift and place moves
`last_pos_at`, so a relay landing a few hundred milliseconds after a move had
a ceiling of a few meters. The phone's counter pays in whole accumulator hops
(decision 0020), so that relay often carried a 5–10 m hop confirmed just after
the move, and the rest was lost (O-36). Rule 4 makes that case common: before
it, such a relay was dropped whole and its meters arrived with the next one,
under a full window. So rules 1 and 4 have to go together.

Both 0040 bounds still hold. Each credit is inside its own window's ceiling,
so the total is still at most a sprint for as long as the game was active; and
nothing is paid that the counter did not report. What rule 1 adds is a lag,
not a figure. Rule 2 is for a phone that is not honest, or not well: without
it one report claiming a kilometer would be paid at a sprint for the rest of
the game, where before it was spent in one message.

Rule 4 because a dropped relay left the opponent's dot a few meters stale
until the player next moved far enough to send another (O-39).

## Rejected

- **Measuring the travel window from `last_relay_at` too.** A lift, a place
  and a relay would then have overlapping windows, which is the banking that
  0041 rule 7 exists to prevent.
- **Throttling against `last_seen_at`.** Connect and disconnect move it, and
  the snapshot shows it as `lastSeenAt`, so the limit would depend on socket
  churn.
- **No cap on what is owed.** See rule 2.
- **Doing this with O-03's server-side lower bound**, as O-36 suggested. That
  one is a different question (is the reported walk plausible at all), and it
  needs real traces; this one is arithmetic.

## Revisit if

- O-38's accumulator change lands and the hops a phone pays shrink, or grow
  past 30 m at poor accuracy: the cap in rule 2 is sized from them.
- The relay interval (`POS_MIN_INTERVAL_MS`) changes: rule 2's cap is derived
  from it.
