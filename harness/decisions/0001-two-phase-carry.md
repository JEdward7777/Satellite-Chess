# 0001 — A move is a lift, a walk, and a place

- **Date:** 2026-07-25
- **Status:** accepted
- **Stage:** 0.4.4, 3.2

## Decision

A move is two acts separated by a walk. You must be within reach of the origin
when you **lift** the piece; you then **carry** it while you walk; you must be
within reach of the destination when you **place** it. The server validates both
ends, each against the position reported at that moment, plus the plausibility of
the walk between them.

## Why

The original brief said "you may only touch a piece when you're physically within
reach of its square, and you must also be within reach of the destination
square", which reads as one instant. Measured, that makes the game unplayable:

| Move | Edge-to-edge gap (8 m squares) | Reach needed | Brief's ceiling |
|---|---|---|---|
| e2–e4 | 8 m | 4 m | 15 m ✓ |
| a1–a4 | 16 m | 8 m | 15 m ✓ |
| a1–a8 | 48 m | 24 m | 15 m ✗ |
| a1–h8 | 71 m | 36 m | 15 m ✗ |

Under a single-instant reading, the rook, bishop and queen cannot move at all on
any field with squares big enough for GPS to resolve. Shrinking squares does not
save it — a1–h8 stays impossible even at 4 m squares.

The two-phase reading is also simply the better game:

- It is the honest physical metaphor. You pick the piece up and you carry it.
- It makes the clock cost something real, which is what a chess clock is for.
- It is the only reading under which "you covered 2.4 km" — named in the brief as
  a headline feature — is even a coherent statistic.
- It gives the opponent something to watch. Seeing a queen being carried across
  the field towards your king is most of the tension the game has to offer.

## Rejected

**Single-instant both ends, with a house rule capping move length.** Would
preserve the literal brief by forbidding moves longer than about three squares.
Rejected: that is no longer chess, and it deletes the pieces whose whole character
is range.

**Reach required only at the lift.** Pick a piece up near its square, then place
it anywhere. Rejected: it removes the walking, which removes the point. The clock
and the distance stat both go slack.

## Consequences

- The protocol needs `lift`, `drop` and `place` rather than a single `move`
  (`src/shared/protocol.ts`), and a pending lift is game state that must be
  persisted — it has to survive Durable Object hibernation.
- Two position fixes are stored per move, not one. Still one billable inbound
  message per phase, so the request budget is unaffected.
- Cancelling a lift is free and costs only clock time; the piece never moved.
- Interacts with suspension — see decision 0009.

## Revisit if

Playtesting shows the carry feels like an errand rather than the point of the
game (stage 10.4.1). The lever to reach for then is field size and time control,
not the rule.
