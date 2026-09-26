# 0048 — The carried piece travels beside a live dot, and nowhere else

- **Date:** 2026-09-26
- **Status:** accepted
- **Stage:** 10.10

## Decision

1. **While a piece is lifted, the 2D board draws it beside the carrier's dot**
   and draws it faint (35%) on its origin, under the dashed "lifted from"
   outline that was already there. Both phones, both seats, both piece looks.
2. **It comes from the snapshot the client already has.** `GameSnapshot.carry`
   has always named the colour, origin and piece and gone to both players.
   The opponent's dot is the relayed one. **No message changed, inbound or
   outbound.** The server's position keeps the piece on its origin until the
   place, so the faint origin is the FEN; the piece in hand is `carry.piece`,
   which is why a promoting pawn shows as a pawn until it is put down.
3. **Mine goes with my own fix**, including the optimistic lift (4.3.6). **The
   opponent's goes with their dot only while they are connected.** A hollow
   dot, or no dot at all, leaves the piece faint on its origin with the dashed
   outline, and the HUD still says "d7 · theirs". Silence alone is never
   staleness: a connected player who has not relayed lately is standing still
   (gotchas, "silence on the relay").
4. **Beside the dot, up and to the right, on a plate.** The plate is the light
   square's cream (`#f4efdc`), ringed dark for mine and in the opponent's red
   for theirs. The piece is 0.85 of a board piece, held between 22 and 44 px,
   so it stays screen-sized under the pinch zoom like the dots do. It flips
   below or left rather than leave the canvas. It is drawn last, over the reach
   circle.

## Why

- The owner asked to "see the person walking their piece". Everything needed
  was already sent, so this costs nothing against the request budget.
- **Privacy:** the dot is already relayed. Naming the piece in their hand says
  nothing new about where they are, and the HUD already said which piece.
- **Hollow dot:** it is the last place a phone that has since gone quiet was
  seen. Drawing their piece there would claim they are standing there holding
  it. The origin is the one thing that is still true.
- **Placement:** on the dot it covered the square under foot, the likeliest
  place to put it down. Straight above covered the next square up, which for
  a pawn walked forward is the destination the carrier is looking for (seen in
  the first screenshot). On the diagonal, at this size, on a phone board at 1x,
  it clears the centre of every square round the carrier **only while the
  carrier stands mid-square** (`test/render.test.ts`). Walking up and to the
  right, it covers the destination ahead until the dot arrives on it; that is
  a known case, accepted.
- **A tap on the plate is no tap at all.** The plate only paints, so a tap
  there would go to the square underneath, and for a player tapping "their
  piece" to put it back that square can be a legal destination: a move nobody
  meant. `views/game.ts` ignores a tap inside either plate, read through the
  same zoomed projection as every tap (`inHandPlate`, `hitsPlate`), and for my
  own plate says "That is the piece in your hand…" for three seconds. That is
  also what makes the up-right case above harmless: a tap on the plate never
  places. At 1x the plate can sit over the centre of the origin itself, when
  the carrier stands down and to the left of it; the remedy there is the
  "Put it back" button, which is shown for the whole of my carry, not the
  corners of the square left uncovered.

## Rejected

- **Centred on the dot.** Hides the dot and the square under foot.
- **Straight above.** Hides the square ahead; see above.
- **Board-piece size under the zoom.** At 6x a board piece is a few hundred
  pixels, and one that big beside the dot hides where the carrier is going.
- **Showing it on a hollow dot, faded.** Still a claim about where they are.
- **Sending the lift position or an "in hand" flag.** Nothing was missing.

## Revisit if

- On real phones (10.10.3) the plate hides a destination the carrier needs, or
  reads as a second player. Smaller, or a leash line, before anything bigger.
- The opponent's dot ever gains an age-out. Then a stale dot should drop the
  piece too, by the same rule as a hollow one.
- A 3D view (O-43) is built. It will want its own rule; this one is 2D only.
