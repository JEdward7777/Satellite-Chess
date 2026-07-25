# 0011 — Render pieces as Unicode glyphs, not bitmap or SVG artwork

- **Date:** 2026-07-25
- **Status:** accepted
- **Stage:** 1.3

## Decision

Draw pieces on the canvas using the **solid** Unicode chess glyphs
(`♚♛♜♝♞♟`, U+265A–U+265F) for both colours, distinguishing white from black by
fill and stroke rather than by glyph. Ship no piece image assets.

## Why

The board here is a top-down map of a field, not a chess diagram. Pieces are
small markers at square centres, frequently drawn over grass-coloured squares and
a translucent reach circle, and they are never the focus of attention the way
they are in a board app.

- Zero bytes and zero licensing. This is a PWA whose service worker must cache
  the whole shell for a field with no signal; every asset avoided is a resume
  that works.
- Scales cleanly at any square size, which varies with the field.
- No external requests, no image decode, no sprite sheet to keep in sync.

Using only the solid glyphs, rather than the natural `♔`-for-white and
`♚`-for-black pairing, is deliberate: the outline glyphs render inconsistently
across platforms and some systems substitute a colour emoji for them, which would
look like a font-fallback bug. Filling the solid glyph white with a dark stroke
is consistent everywhere and reads as an intentional style.

Guard against emoji presentation by appending the text-presentation variation
selector (U+FE0E) and specifying a concrete serif font stack.

## Rejected

**Wikipedia / Wikimedia Commons piece artwork (the Cburnett SVG set).** Suggested
in the original brief's lineage as "free for usage", which is imprecise. The set
is not public domain: it appears to be triple-licensed under GFDL, CC BY-SA 3.0
and BSD, all of which require attribution, and the share-alike terms of the first
two would reach into this project if that were the option relied on. The BSD
option would be workable with an attribution notice — but this needs checking
against the current Commons file page rather than trusted from memory, and it
buys nothing the glyphs do not already give us.

**A custom sprite sheet.** More bytes, more work, same outcome at 20 px.

## Revisit if

- Playtesting shows players genuinely cannot tell pieces apart at a glance on a
  sunlit phone screen. Piece identity matters most for the piece being *carried*,
  which is drawn large in the HUD and could take real artwork on its own.
- The board view grows into something closer to a conventional diagram, e.g. for
  the post-game replay on a desktop screen.
- If artwork is adopted: inline the SVGs into the bundle, do not fetch them, and
  put the attribution notice in the about screen and in `NOTICE`.
