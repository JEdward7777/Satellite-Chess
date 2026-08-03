# 0002 — Calibration taps are the centres of a1 and h8

- **Date:** 2026-07-25
- **Status:** accepted; two-tap calibration superseded by 0028, which keeps the
  square-centre convention and reverses the "three or four taps" rejection below
- **Stage:** 0.3.1

## Decision

The two calibration taps are the **centres of squares a1 and h8**, not the outer
corners of the board. Centre-to-centre separation is therefore 7√2 square widths,
which is what `deriveGeometry` divides by.

The rank axis is 90° counter-clockwise from the file axis, which is what "a1 at
bottom-left, seen from above" means. That resolves the handedness ambiguity two
points alone would leave open.

## Why

"Stand where the white rook goes, then walk to where the black rook goes" is an
instruction two people can agree on and repeat while standing in a field. "Stand
at the mathematical corner of an imaginary square that does not exist yet" is not
— there is nothing to aim at, and the two players would disagree by half a square.

The square-centre convention also makes the derived arithmetic fall out cleanly
and makes the calibration self-checking: the tapped points are exactly where two
specific pieces will be drawn, so a mis-tap is visible on the board render
immediately.

## Rejected

**Outer corners of the board.** Marginally more natural as "the corner of the
field", but unaimable in practice on featureless ground, and it makes the derived
separation 8√2 squares in a way that is easy to get wrong by one square.

**Three or four taps, solving for a general quadrilateral.** More accurate in
principle and it would not need the squares-are-square assumption. Rejected for
v1: it is more walking before you can play, and GPS error at each tap swamps the
extra fidelity. Worth reconsidering only if field data shows the two-tap
assumption is visibly wrong.

## Revisit if

Playtesting shows players systematically mis-tapping, or wanting to lay out a
board on a rectangular pitch whose proportions they want respected.
