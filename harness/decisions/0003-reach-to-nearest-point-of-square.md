# 0003 — Reach is measured to a square's nearest point, not its centre

- **Date:** 2026-07-25
- **Status:** accepted
- **Stage:** 0.3.4

## Decision

`distanceToSquareM` returns the distance from the player to the nearest point of
the square's rectangle — a point-to-rectangle distance in board space, which is a
rigid rotation of the ground plane, so metres stay metres.

## Why

Distance-to-centre would put you out of reach of the square you are standing on.
With 8 m squares and a 6 m reach, a player at the corner of a square is 5.66 m
from its centre and, at the diagonal extreme, further still — so "I am standing on
this square and the app says I cannot touch the piece" would be a routine
occurrence. Players would rightly call that broken, and it is the sort of thing
that makes a novel rule feel arbitrary rather than physical.

Nearest-point has two properties worth having:

- Standing anywhere on a square always reaches it. No exceptions, nothing to
  explain.
- The reach radius then means what it says: how far you can *stretch beyond* the
  square you are on.

## Rejected

**Distance to centre.** Simpler to compute and to describe, but broken as above.

**Distance to centre with a reach bonus of half a diagonal.** Patches the symptom
by inflating reach, but then reach no longer means anything legible, and the
inflation is wrong for every square you are not standing on.

## Revisit if

Never expected to. If the board view ever stops being axis-aligned in board space
the implementation would need revisiting, but not the rule.
