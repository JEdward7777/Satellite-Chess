# 0045 — Pieces are the standard two-sided set, on mid-tone squares

- **Date:** 2026-09-24
- **Status:** accepted
- **Stage:** 10.7
- **Supersedes:** [0011](0011-piece-glyphs-not-artwork.md)

## Decision

1. **Pieces are Colin M. L. Burnett's "cburnett" set**, the one lichess and
   Wikipedia use. White pieces are white with black line work; black pieces are
   black with white interior lines. The twelve SVGs are transcribed into
   `client/pieces.ts` as path data and drawn with `Path2D`, bundled into
   `app.js`, never fetched. Used under the **BSD license** (the set is offered
   under GFDL, BSD and GPL; we rely on BSD only). The notice is in `NOTICE`, in
   a `/*!` comment that survives minification, and on the account screen.
2. **Squares are mid-tones**: light `#e6dcbc`, dark `#769656`. Each side
   stands off each square: a black piece is 6.3:1 against the dark square (it
   was 4.2:1), a white piece 3.4:1. A white piece on the light square is 1.4:1
   and is separated by its black outline, which is what the outline is for.
3. **The outline separates a piece from the square under it. It is never the
   opponent's color.** In the old scheme it was, and that is what O-30 reported.
4. **The owner's alternative, a team disc, is behind a per-phone switch**
   (account screen, the game screen's readout and the simulator panel,
   `localStorage`, default standard). A
   disc of the team's color under each piece, with a **gray ring** (`#8a8a8a`)
   so that a white disc shows on a light square. On its black disc a black
   piece's outline is the same gray, because black on black would hide it.
5. **Every surface draws the same art**: the board, the carry readout and the
   promotion picker (`pieceSvg` builds the HTML version from the same layers).
6. **The last move is tinted** on both squares, translucent yellow, under the
   reach tint and the pieces, from the snapshot's `lastMove`. A predicted place
   moves it at the tap.

## Why

The owner, after the first outdoor games: "people not knowing which piece is
theirs… isn't showing a chess board something that has been done for years?"
It has. Every board app uses a two-sided set on mid-tone squares, and players
already read it. 0011 rejected artwork for bytes and licensing. The bytes are
13.5 kB on `app.js` (137 → 151 kB), 5.5 kB gzipped (47 → 52 kB), license
text included. The license was checked on 2026-09-24
against each Commons file page (`{{self|GFDL|migration=relicense|BSD|GPL}}`),
and BSD is MIT-compatible with attribution.

Path data rather than images: synchronous (no load-then-redraw), crisp at any
size, and it lets the disc look change one ink. Lines never go below 1 CSS
pixel, so small squares on a long field keep an outline.

## Rejected

- **Keeping glyphs and recoloring the outline by square color** (O-30's first
  suggestion): still a home-made convention, and glyph shapes vary by platform
  font.
- **Rendering SVG files through `<img>`**: asynchronous, needs a repaint hook,
  and cannot swap the outline gray for the disc look.
- **Discs as the default**: nobody has compared them outdoors yet. The
  standard set is the one players already know. `10.7.x` decides.
- **The last move over the reach tint**: yellow over blue hid "you can reach
  this", which is the rule. Blue over yellow still reads as "moved".

## Revisit if

- The outdoor comparison (`10.7`) favors discs. Then change the default in
  `readPieceLook` and consider removing the switch.
- Players still misread sides in daylight with either look. Then look at a
  thicker outline or a larger piece box before a new set.
