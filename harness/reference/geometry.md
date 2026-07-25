# Field geometry

Implementation is `src/shared/geo.ts` and `src/shared/field.ts`, both fully unit
tested. This file records the facts and the numbers, not the code.

## Projection

Local ENU tangent plane anchored at the field's a1 corner: equirectangular with a
`cos(latitude)` correction on longitude.

Measured against an independent haversine implementation: **~4 cm of disagreement
across a 400 m diagonal**, which is larger than the brief's claim of "well under a
centimetre" but two orders of magnitude below consumer GPS error. No geodesic
library.

## Calibration

Two taps, at the **centres of a1 and h8** (decision 0002). From the diagonal:

```
diagonal length L = |a1 -> h8|
square size   s = L / (7 * sqrt(2))
file axis bearing = bearing(diagonal) + 45 degrees
rank axis bearing = file axis - 90 degrees      (counter-clockwise, seen from above)
```

The rank axis being counter-clockwise from the file axis is what "a1 at
bottom-left, viewed from above" means, and it resolves the handedness that two
points alone leave ambiguous.

Raw corners are stored as the source of truth; `squareM` and `bearingDeg` are
derived on load and included in snapshots only for display and cross-checking.

## Board space

`toBoardPoint` gives `(u, v)` in metres along the file and rank axes from a1's
centre. The axes are orthonormal, so board space is a rigid rotation of the ground
plane and metres stay metres. Square `(f, r)` occupies
`u ∈ [f·s − s/2, f·s + s/2]`, likewise `v`.

This is also why the client can render the field as an ordinary axis-aligned
chessboard however the board is rotated on the ground.

## Reach

`R_effective = clamp(base + reported_accuracy + handicap, min, max + handicap)`,
defaults `base 5 m`, `min 4 m`, `max 15 m`. Moves are refused outright above
**25 m** reported accuracy.

Distance to a square is measured to the **nearest point of its rectangle**, not its
centre (decision 0003), so standing anywhere on a square always reaches it.

## The numbers that killed the single-instant rule

Edge-to-edge gap between the two squares of a move, and the reach a single standing
position would need to span both:

| Move | Squares apart | Gap (8 m squares) | Reach needed | Under a 15 m ceiling |
|---|---|---|---|---|
| e2–e4 | 2 | 8 m | 4 m | possible |
| e2–e5 | 3 | 16 m | 8 m | possible |
| a1–a4 | 3 | 16 m | 8 m | possible |
| a1–a8 | 7 | 48 m | 24 m | **impossible** |
| a1–h8 | 7 diagonal | 71 m | 36 m | **impossible** |

Shrinking squares does not rescue it — at 4 m squares, a1–h8 still needs 17.8 m.
Hence decision 0001: a move is a lift, a walk, and a place.

A useful consequence of the same arithmetic: a two-square move requires standing
*between* the endpoints. From e2's centre, e4's near edge is 12 m away, outside a
6 m reach — you have to walk out onto e3 to play e2–e4. Reach is not "stand
anywhere and play anything nearby"; it genuinely puts you on the board.

## Field size guidance

`checkCalibration` enforces this, with player-facing messages:

| Square size | Verdict |
|---|---|
| < 2 m | Rejected — smaller than GPS can resolve |
| 2–4 m | Warned — expect ambiguity about which square you are on |
| 4–20 m | Fine. 5–10 m is the sweet spot as currently understood |
| 20–40 m | Warned — crossing the board takes a while; consider the clock |
| > 40 m | Rejected — almost certainly a mis-tap |

These thresholds are guesses pending field data. Stage 9.2 measures them.
