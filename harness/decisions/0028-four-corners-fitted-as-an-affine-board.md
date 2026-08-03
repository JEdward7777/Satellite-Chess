# 0028 — Four corners, fitted as an affine board

- **Date:** 2026-08-03
- **Status:** accepted
- **Stage:** 1.2.5
- **Amends:** [0002](0002-calibration-taps-are-square-centres.md) — the taps are
  still square *centres*; there are now four of them, and the board need not be
  square. 0002's "Rejected: three or four taps" is hereby reversed, on evidence
  it asked for.
- **Builds on:** [0003](0003-reach-to-nearest-point-of-square.md),
  [0016](0016-fields-share-as-self-contained-links.md)

## Decision

**Calibration walks the perimeter and taps four corner squares — a1, h1, h8, a8 —
and the board is fitted to them as a least-squares affine map.**

1. **Four taps, round the edge, in that order.** Not the diagonal. The copy names
   the piece that stands on each corner, because "the next corner" is ambiguous in
   a field and going round the wrong way produces a bow-tie.
2. **The board may be a rectangle or a parallelogram.** Files and ranks have their
   own spacing and need not be perpendicular, so a board can be laid into a pitch
   instead of forcing a square onto it.
3. **Least-squares, not interpolation.** The fit does not pass through the four
   taps; it averages them. Each axis step is the mean of the two edges running
   along it, and the origin is the centroid walked back to a1.
4. **Two-corner fields still mean exactly what they meant.** A spec with only
   `a1` and `h8` is read as the square board it was calibrated as, so nothing
   saved, shared or in play shifts underfoot.
5. **Board space splits in two.** `BoardPoint` stays metric — metres in a rigid
   frame, so a distance in it is a real distance on grass. `BoardIndex` is the
   affine inverse and answers *which square*. Nothing metric may be derived from
   an index.
6. **The inverse stays closed-form**, a 2x2 matrix inverse. No iteration, no
   convergence tolerance.

## Why

**Four taps are worth about three times the accuracy, and that was measured.**
Simulating 400 calibrations against 8 m squares with 3 m of error per tap, and
asking the only question that matters — standing on a square's centre, does the
model name that square?

| model | RMS error | wrong square |
|---|---|---|
| 2 taps, similarity (the old model) | 3.65 m | **22.3 %** |
| 4 taps, least-squares similarity | 2.65 m | **6.7 %** |
| 4 taps, least-squares affine (chosen) | 3.02 m | 11.9 % |
| 4 taps, bilinear interpolation | 3.19 m | 14.1 % |

Two taps were the worst of the four, and not because of the shape they assume —
because they use half the available measurements. That is the headline: the gain
comes from *having four points*, and it is large enough to matter at the square
sizes this game wants to play at.

**Least-squares rather than interpolation, because an interpolation believes the
taps.** A bilinear map passes exactly through all four corners, so several metres
of GPS error at a corner becomes several metres of permanent distortion in the
shape of the board. Least-squares lets the error fall on the floor. It came third
of four in the table above, and third again on the rectangular ground it was
meant to be better at (19.4 % against affine's 17.3 %).

**Affine rather than similarity, and this is the one place we knowingly gave up
accuracy.** Least-squares *similarity* was the most accurate model tested — but it
cannot represent a rectangle at all, and forced onto a 10 x 6 pitch it misidentifies
**three quarters of the squares** even with no noise whatsoever, because it is
describing a different shape from the one on the ground. Affine gets that case
exactly right. The 6.7 % against 11.9 % on square ground is the price of being
able to lay a board into the space that is actually available, which is what the
owner asked for, and it is still a large improvement on the 22.3 % of today.

**A closed-form inverse is worth protecting for a reason beyond speed.** The
projection runs on both phones and again on the server for every lift and place
(decision 0008 makes the server the authority). A solver would have to agree with
itself across three machines, at a square boundary, to whatever tolerance it
stopped at. A matrix inverse gives the same answer everywhere by construction.

**The extra walking is not a cost here.** The perimeter is about 170 m against the
diagonal's 80. In a game whose currency is distance walked (decision 0019), asking
someone to walk the edge of the board they are about to play on is not a tax.

## What four corners buy that is not accuracy

**A mis-tap becomes visible at all.** Two taps and four unknowns is exactly
determined: the fit passes through both points whatever they are, the residual is
identically zero, and a corner tapped in the wrong place is indistinguishable from
a correct one. Four taps leave residuals, and `checkCalibration` reports them.

**But it is a weaker check than it sounds, and the code says so.** Eight
measurements against six parameters leaves two degrees of freedom of residual —
exactly the "these corners are not a parallelogram" component. Everything else is
absorbed: two corners dragged along an axis is a *perfectly good shear* and comes
back with zero residual, correctly, because nothing in four points says that was a
mistake rather than the board someone meant. A single corner out by `d` shows up
at about `d/4`. So the warning is set low, and it catches a corner tapped in the
wrong place, not one tapped a few metres out. It was never going to.

## Rejected

**Bilinear interpolation through the four corners**, with the inverse solved by
iteration — the model this discussion started from, and a correct one. Rejected on
measurement: worse than affine on square ground *and* on rectangular ground,
because interpolating through noisy points converts tap error into board shape.
Its extra freedom over affine can only describe a quadrilateral that is not a
parallelogram — and a chessboard laid on flat ground always is one, so those two
degrees of freedom have nothing real to represent. It would also have made squares
change size across the board, which is a fairness problem: one player's squares
would be bigger than the other's.

**Least-squares similarity**, the most accurate model tested. Rejected because it
cannot express a rectangular pitch, which was the point of the change.

**Keeping two taps and averaging repeated taps at each corner instead.** Would
recover some accuracy without the walk, but nothing about the board's shape, and
it asks someone to stand still tapping rather than to walk — which is the wrong
instinct for this game.

**Making `BoardPoint` an index and rescaling on use.** Simpler-looking, and it
would silently reintroduce the squares-are-square assumption at every subtraction:
on a 12 x 4 board, one step along a file and one along a rank differ by 3x, and
`Math.hypot` over indices would be meaningless. Two types, one metric and one
combinatorial, is the thing that keeps that honest.

## Revisit if

- The walk (`1.9.3.4`) shows the real per-tap error is much smaller than 3 m, at
  which point the accuracy argument weakens and only the shape argument remains —
  which is still enough.
- Players turn out never to use a non-square board, in which case least-squares
  *similarity* is a free accuracy win over affine and the fit can be narrowed.
- Someone wants a board on genuinely uneven ground — a slope, or a wedge-shaped
  park — which is the one case bilinear would serve and affine cannot. Note it
  costs fairness: squares would no longer be the same size for both players.
