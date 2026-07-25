# 0020 — Measure distance walked by smoothed anchor hops, not by summing fixes

- **Date:** 2026-07-25
- **Status:** accepted
- **Stage:** 1.1.5
- **Builds on:** [0019](0019-distance-is-the-currency-not-games.md)

## Decision

`DistanceAccumulator` (`src/client/gps.ts`) counts metres walked in three steps,
and none of them is optional:

1. **Smooth.** Average the last `SMOOTHING_FIXES` (5) raw fixes. Only the
   distance count sees the smoothed track — reach, lifts and places all use the
   raw fix.
2. **Anchor.** Hold a fixed point and credit a hop only when the smoothed
   position is further from it than `max(4 m, 2 × reported accuracy)`, then move
   the anchor there. `ANCHOR_ACCURACY_FACTOR` is **2**.
3. **Confirm.** Require `CONFIRM_FIXES` (2) consecutive fixes past that floor
   before paying, and never pay for a hop `isPlausibleStep` calls a teleport.

Fixes above `maxAccuracyM` are dropped entirely: too vague to move a piece with
is too vague to measure a walk with.

## Why

Decision 0019 made distance the currency of the permanent record. A currency
that inflates while the phone sits on a bench is worthless, and summing
consecutive fixes — the obvious implementation — inflates enormously.

The numbers, from an hour of a *stationary* phone whose true error matches its
reported accuracy (the honest case: a reported accuracy is roughly a one-sigma
radius). Phantom metres per hour, against a 1 km walk and against 672 m of
pacing back and forth over two squares:

| floor factor | 3 m error | 5 m error | 1 km walk @5 m | 672 m pacing |
|---|---|---|---|---|
| naive sum | 19.0 km | 31.6 km | — | — |
| 1 | 207 m | 1568 m | 1096 m | 378 m |
| 1.5 | 14 m | 400 m | 1058 m | 378 m |
| **2** | **0 m** | **99 m** | **1030 m** | **436 m** |
| 2.5 | 0 m | 24 m | 1019 m | 288 m |

Three things fall out of that table.

**Smoothing is worth about a factor of ten**, and it is nearly free. Noise on the
gap between two fixes is root-2 times the noise on one, so an unsmoothed floor
sits far closer to a stationary phone's wobble than it looks. Averaging five
fixes divides the wobble by root-5 while leaving a real walk alone: the mean of a
straight line is the same straight line, two seconds late, and lag does not
change a distance.

**One fix past the floor is not evidence.** Whatever the floor, a stationary
phone eventually throws a fix past it, and because that outlier then *becomes*
the anchor, the next fix back at the true position is also past the floor. It
ping-pongs, and every bounce gets paid for. Confirmation kills it and costs a
real walk one fix of lag.

**Factor 2 is a real optimum, not a midpoint.** 2.5 counts *less* of a genuine
672 m walk than 2 does (288 m against 436 m), because legs shorter than the floor
vanish entirely — pushing the floor up eventually starts eating the thing being
measured. 2 is where phantom distance stops mattering and the floor is still
smaller than a chess move.

The residual ~3% over-count on a long walk with a poor fix is accepted. At 5 m of
genuine error you cannot distinguish a slow walk from a bad fix, and erring
slightly high there is better than erring low on every real walk.

## Rejected

**Summing consecutive fixes.** 19 km an hour of standing still at ±3 m, 32 km at
±5 m. Not a tuning problem — the sum of `n` noise samples grows with `n`, so it
gets worse the longer the game.

**A fixed floor in metres, ignoring reported accuracy.** The floor has to track
the noise, and the noise is what accuracy reports. A 5 m floor is generous at
±3 m and useless at ±10 m.

**A speed gate — drop fixes implying less than some m/s.** Rejected: it throws
away genuinely slow movement, which in this game is most of it. Someone edging
along a rank to get a rook in reach is walking, and should be paid for it.

**A Kalman filter.** Correct, and far more machinery than a bragging stat needs.
The measured numbers say a five-fix mean already puts phantom distance below the
noise floor of what anyone would notice.

**Trusting the client less by computing distance only from move fixes.** That is
the server's job and it already does it (observation O-03); it is a lower bound,
not a measurement, because it misses every metre walked that did not end in a
move. Both numbers are wanted.

## Revisit if

- Real GPS traces from stage 1.9.3 show the noise is not Gaussian enough for
  these numbers to hold — in particular if fixes come in correlated bursts, which
  would defeat the five-fix mean.
- Reported accuracy turns out not to track real error on the phones people
  actually bring, which would undermine the whole scaling argument.
- Fix rate turns out not to be ~1 Hz, since both window lengths are counted in
  fixes rather than seconds.
