# 0031 — Reach is the independent variable, and it is measured in squares

- **Date:** 2026-09-07
- **Status:** accepted
- **Stage:** 1.9.3.5
- **Supersedes:** the second half of
  [0023](0023-reach-absorbs-gps-error-squares-scale-with-it.md)
- **Constrains:** [0003](0003-reach-to-nearest-point-of-square.md),
  [0004](0004-handicap-is-reach-not-clock.md)
- **Closes:** O-02

## Decision

**Square size is an input, not a knob.** A field is whatever ground people have.
The board is eight squares along it, so `squareM = fieldLength / 8` falls out of
the venue and cannot be chosen. You cannot answer a GPS problem by asking for a
bigger field; the players end up in the bushes.

**Reach is the independent variable, and it is expressed in fractional squares.**
`ReachConfig` carries no absolute metre values for distance any more:

```ts
baseSquares   0.4   // reach at a good fix
minSquares    0.25  // floor: below this you fight the GPS lock
maxSquares    1.5   // ceiling: above this the field stops mattering
goodAccuracyM 5     // reported accuracy at or below this costs nothing
maxAccuracyM  25    // above this, refuse the move outright
```

Metres are derived at the point of use, from `FieldGeometry.meanSquareM`.

**Reported accuracy contributes only its excess over `goodAccuracyM`**, rather
than being added raw.

**The ceiling is absolute — a handicap no longer raises it.** That is O-02's
bug, and it is fixed by making `maxSquares` bound the total.

**`baseSquares` is exposed on the create screen**, in fractional squares, so
players decide for themselves how degenerate they want the game.

## Why

Reach has two failure modes and they pull in opposite directions. Too large and
you stand in the middle of the field playing ordinary chess — the walk is the
game, so this deletes the game. Too small and you spend the move fighting for a
lock while your clock runs. The playable window is bounded by the square, which
is why the unit is the square and not the metre.

The field walk of 2026-09-06 (trace `2026-09-06T23-10-47-510Z-ioop0u`, 2008
fixes) says the current rule sits on the wrong side of that window **today**:

- `effectiveReachM` was `baseM 5 + reportedAccuracy`. The device never reported
  better than **3.00 m** and its median was **3.37 m**, so effective reach was
  **8.4 m — 1.05 squares on an 8 m board**, with no handicap at all. With the
  4 m handicap the create screen allows, 12.4 m, or 1.55 squares.
- Reported accuracy is not a measurement of error at that scale. Actual error
  over the three-minute static hold was **median 0.21 m, p95 0.43 m** — the
  device overstates by roughly **16x**, and 3.00 m looks like a reporting floor
  rather than anything observed. Adding it raw spent the entire reach budget on
  a number that carries almost no information.

Hence the excess-over-`goodAccuracyM` model: below a fix that is merely
*ordinary*, accuracy buys nothing, because the trace shows ordinary fixes are
already sub-metre. Past it the number starts to mean something and 0023's
graceful-degradation argument takes over unchanged — the circle grows instead of
the game refusing. `maxSquares` is what stops that from having no endpoint,
which is the load-bearing half of 0023 and is kept.

`minSquares` is the other end, and it is set from the same trace: worst-case
static scatter was 0.6 m, so 0.25 squares (2 m on an 8 m board) clears the
measured error with a wide margin.

## What was rejected

- **Averaging several fixes per corner at calibration**, which session
  `2026-09-06-03` proposed to fix its 5.8 m repeatability finding. Measured
  against the trace, averaging does essentially nothing: the gap between the two
  readings of point A is 5.76 m from a single fix, 5.73 m averaged over 10 s and
  5.42 m over 30 s, because within-window scatter is already 0.02–0.15 m. There
  is nothing left to average away. Averaging attacks scatter; scatter was never
  the problem.
- **Attributing that 5.8 m to receiver drift.** Two checks say otherwise: the
  same spot re-measured with no walk in between (`settle`→`static`, 154 s apart)
  moved only **0.48 m**, and the legs from A out to B and C agree across both A
  readings to 0.15 m and 0.01 m, where a genuine 5.8 m frame shift predicts
  1.39 m and 0.57 m. The likeliest reading is that the operator restood ~5.8 m
  from the original spot — a *human* calibration error, not a GPS one.
  Caveat: B and C were only 8° apart in bearing and both ~80° off the shift
  direction, which blunts that test. Tapping one corner twice from a physical
  mark would settle it.
- **Keeping the handicap in metres.** A metre handicap against a square-based
  reach reintroduces exactly the unit mismatch O-02 is about.

## What would make me revisit

- A second device whose reported accuracy floor is much lower than 3 m, which
  would mean `goodAccuracyM = 5` is tuned to one phone's firmware rather than to
  GPS. This is the most likely thing to be wrong here: **it is one walk, one
  device, one day.**
- Players reporting they cannot get a lock at `baseSquares 0.4` on a small
  field, where 0.4 squares is a short absolute distance.
- A field so small that `minSquares` and `maxSquares` cross in practice — the
  hard floor on venue size 0023 anticipated, now expressible as a real number.
