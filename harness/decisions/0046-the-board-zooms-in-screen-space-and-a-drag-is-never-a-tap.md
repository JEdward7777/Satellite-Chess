# 0046 — The board zooms in screen space, and a drag is never a tap

- **Date:** 2026-09-24
- **Status:** accepted
- **Stage:** 10.8

## Decision

1. **Pinch to zoom, one finger to pan while zoomed**, on the game board and
   the practice board. 1x to 6x. The zoom is a uniform scale and shift laid
   over the fitted projection (`client/board-zoom.ts`), so every tap still
   goes through the same `Projection` to a square. At 1x it is exactly the old
   view. It lives in memory, per view. Nothing is stored, nothing is sent.
2. **A press is a tap only if it was the only finger down for its whole life
   and never moved more than 10 CSS px** from where it landed, and the tap is
   aimed where it landed. A pan, a pinch, a second finger or a cancel spends
   the whole touch. The last finger off after a pinch is never a tap. **A
   `pointerup` whose `pointerdown` was not seen is never a tap.** The drivers
   send a down/up pair, marked non-primary so the simulator does not teleport.
   Anything that moves the view while a finger is down ("Whole board", "Follow
   me", or the board turning round when the first snapshot names this phone's
   side) spends the touch, and keeps the fingers on record so their lifts
   still match.
3. **No double-tap**, to zoom or to reset. Two quick taps on one square are a
   lift and a put-back. The way back is a **"Whole board" button** over the
   board's corner, shown only while zoomed.
4. **A zoomed view follows your dot.** It holds still while you are clear of
   the outer 20% of the canvas, and centres on you when you reach it. A
   one-finger pan stops following, and so does a pinch that leaves you off
   screen; a pinch that keeps you in view does not. "Follow me" (shown when
   not following) and "Whole board" turn it back on. It never moves the view
   while a finger is down.
5. **The board may not be panned off the canvas.** Where the zoomed board is
   wider than the canvas its edge may come in by the same padding the whole
   board has. Where it is narrower, as a 5:1 field is across its short way
   until about 5x, it stays centred.
6. **What scales:** everything measured in metres (squares, pieces, the reach
   circle and accuracy ring, destination dots, the last-move tint, the
   lifted-from dashes). **What stays at screen size:** the two players' dots,
   the north arrow, 1.5–2 px strokes, and the coordinate labels, which were
   already capped at 14 px. Strokes sized from a cell are capped at 6 px.
7. `touch-action: none` on the canvas and on the zoom buttons over it. The
   viewport meta is unchanged (see O-47).

## Why

On a 5:1 field a piece is about 7 px tall at 1x (session `2026-09-24-04`).
Zoom is the only fix that does not shrink something else. A mis-read tap is a
move. A tap that is ignored costs a second tap. So the rule leans hard towards
ignoring. 10 px is about the platforms' own touch slop (Android 8 dp, iOS
10 pt).

## Rejected

- **Double-tap to reset or zoom.** It fires a lift and a put-back, or it
  delays every single tap to wait for a second one.
- **Following by keeping the dot centred.** GPS wander of a metre at 5x is
  about 50 px, so the board would swim under a finger aiming a tap.
- **Following by the smallest shift that keeps the dot in frame** (the first
  version). A player walking up the screen is then held against the top edge,
  and cannot see where they are going.
- **Letting the browser's own page zoom do it.** It zooms the clocks and
  buttons too, fights `user-scalable=no`, and the canvas would be rescaled
  from a bitmap rather than redrawn.
- **Persisting the zoom.** A view you have to undo on every return is worse
  than one you have to redo.

## Revisit if

- Real phones (`10.8.4`) show taps being dropped while walking. Then raise the
  slop, rather than accepting a drag.
- Players lose track of where they are when zoomed. Then consider edge
  labels (O-46) or a small whole-board inset.
