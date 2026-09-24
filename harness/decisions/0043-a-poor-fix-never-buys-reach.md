# 0043 — A poor GPS fix never buys reach; a fix too vague to trust refuses the move

- **Date:** 2026-09-24
- **Status:** accepted
- **Stage:** 10.5; answers O-33
- **Supersedes:** the rest of [0023](0023-reach-absorbs-gps-error-squares-scale-with-it.md)
  (its first half, "the circle grows rather than refusing"), and the
  "reported accuracy contributes only its excess over `goodAccuracyM`" clause of
  [0031](0031-reach-is-the-independent-variable-measured-in-squares.md)
- **Keeps:** 0031's squares, floor, ceiling and handicap; 0023's hard refusal
  above `maxAccuracyM`

## Decision

1. **Reported accuracy plays no part in reach.** `effectiveReachM(squareM, cfg,
   bonus)` is `(baseSquares + handicap) × squareM`, clamped to
   `[minSquares, maxSquares]`. The accuracy parameter is removed from it and
   from `inStartZone`, so a caller that still believes accuracy buys reach fails
   to compile rather than silently agreeing.
2. **The only way accuracy enters the rule is the refusal.** A fix worse than
   `maxAccuracyM` (25 m) refuses a lift, a place, or a calibration tap, as
   before. Constants are unchanged.
3. **The circle is the same for both players** for the same dial and handicap,
   whatever their phones report. It no longer breathes.
4. **A refusal says when the dot may be the problem.** Every out-of-reach
   refusal, the back-rank one included (`outOfReachAdvice`),
   on a fix worse than `goodAccuracyM` adds "or if you are already there, your
   position is only accurate to ±N m", because without the bonus a player
   standing on the square can be placed metres off it, and "walk closer" alone
   would send them the wrong way.
5. **`goodAccuracyM` stays on `ReachConfig`** as a label: the GPS badge's Good
   threshold and the cue for 4. Every game snapshots its config, so the field
   stays.
6. **It applies to games already in progress.** The rule is code, not snapshot;
   the change can only shrink a circle that a vague fix was widening. A carry
   lifted under the old, wider rule may be refused at place; the remedy is
   Drop (the button, or tapping the origin square) and lift again, so no code
   is needed for it.

## Why

The owner's ruling after the first outdoor games (2026-09-20). A worse signal
bought a longer reach, and signal is the one input a player can degrade at will:
a phone in a pocket earned up to `maxAccuracyM − goodAccuracyM` = 20 m of extra
reach against an opponent who could not see it happening. On 8 m squares that is
2.5 squares, up to the 1.5-square ceiling — the difference between walking to a
square and lifting it from where you stand.

The compensation was also paying out against a number that is nearly always
wrong in the generous direction. The 2026-09-06 field walk (stage 1.9.3) measured
claimed accuracy at a median 3.37 m against 0.21 m of actual scatter, about 16x
pessimistic. 0023's graceful degradation was protecting players from an error
the phone mostly does not have.

**Square sizing did not depend on the bonus.** Since 0031 the square is fixed by
the ground, and no code sized squares from accuracy. Against the walk's numbers
the default 0.4 squares (3.2 m on 8 m squares) needs a displacement of 7.2 m
before a player standing on a square is refused; the worst static scatter was
0.6 m. So a good-signal game plays exactly as before. What is lost is the
cushion for a phone whose error really is as large as it claims. The owner's
answer is that such a player can stand somewhere else, in the open, and wait.

## Rejected

- **Keeping a smaller bonus, or capping it.** Any bonus that grows with the
  claimed number is an exploit of the same shape, only cheaper.
- **Shrinking reach as accuracy worsens.** It punishes bad luck, and the refusal
  already covers a fix too poor to trust.
- **Lowering `maxAccuracyM` at the same time.** Nothing measured says 25 m is
  wrong, and the walk says the claim overstates error. Changing a constant on no
  evidence would be a second change hidden in this one.
- **Removing the accuracy floor in `DistanceAccumulator` as well (O-12).** A
  different mechanism: it guards distance against phantom metres, not reach, and
  removing it credits a bench-sitting phone ~1525 m an hour. O-12 stays open.

## Revisit if

- Players on real phones are refused while standing on the square because the
  dot is off (stage 10.5.4). The fix then is better position data, not a
  bigger circle for whoever has the worse phone.
- A handset whose accuracy claims are *optimistic*, so that 25 m lets through
  fixes much worse than it says.
