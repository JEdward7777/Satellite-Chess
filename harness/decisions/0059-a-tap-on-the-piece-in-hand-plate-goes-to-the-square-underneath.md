# 0059 — A tap on the piece-in-hand plate goes to the square underneath

- **Date:** 2026-10-22
- **Status:** accepted
- **Stage:** 10.10.4
- **Supersedes:** [0048](0048-the-carried-piece-travels-beside-a-live-dot.md)
  — the point "A tap on the plate is no tap at all", and nothing else.

## Decision

**The plate beside a carrier's dot only paints, and a tap on it is a tap on
the square underneath**, exactly as if the plate were not there. Mine and the
opponent's alike, at every zoom. `views/game.ts` no longer asks whether a tap
landed on a plate, and the hint "That is the piece in your hand…" is gone.
The plate is drawn where 0048 put it, at the size 0048 chose; only taps change.

## Why

- **The owner, after a real checkers game outdoors (2026-10-22):** "the bubble
  that shows what piece you are holding can't be clicked through so it makes
  something you have to avoid when trying to click where to set it down."
  Then: "Can you make the piece click transparent?" This is 0048's own
  "Revisit if": the plate stood over a destination the carrier needed.
- The plate sits up and to the right of the dot, over the squares round the
  carrier — which is where a piece is put down, because the carrier walks to
  the destination. In checkers every hop of a jump is another tap near the
  dot. Ignoring taps there made a dead patch on the squares that matter most.
- The drivers already showed it: `check-units.mjs` and `check-endings.mjs`
  each wait an extra fix before tapping, so the dot is on the centre and the
  tap clears the plate. A person cannot wait out a GPS step.

## Rejected

- **Keep ignoring taps on the plate.** The field report is the evidence
  against it; the hint explained the dead patch but did not remove it.
- **Move or shrink the plate instead** (0048's "smaller, or a leash line").
  That is about the plate *hiding* a square, which is still open for
  `10.10.3`. It would shrink the dead patch, not end it, and the owner asked
  for the taps to go through.
- **Ignore taps only on the piece glyph, not the plate's rim.** Still a dead
  patch over the square, just a smaller one, and harder to explain.
- **A translucent plate.** Changes what is seen, not where a tap goes; a
  separate question for `10.10.3`.

## Accepted risk

The one 0048 feared: a player who taps "their piece" on the plate to put it
back now taps the square under it, and if that square is a legal destination,
the piece is placed there. The remedy is the "Put it back" button, shown for
the whole of my carry, and a tap on the origin itself, which is never under
the plate while the carrier stands on it. The plate covers the origin only
when the carrier stands down and to the left of it, as 0048 already noted.

## Revisit if

- Players report pieces placed by a tap meant for the plate. Then the answer
  is moving the plate off the squares round the dot, not dead taps again.
- `10.10.3` decides the plate must move, shrink or fade; this rule stays.
