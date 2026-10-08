# 0053 — The share card draws carries, not walks, and names the field only when ticked

- **Date:** 2026-10-07
- **Status:** accepted
- **Stage:** 8.5.1, 8.5.2, 8.5.3
- **Builds on:** [0017](0017-play-history-belongs-to-players-not-places.md), [0018](0018-bragging-without-broadcasting-location.md), [0041](0041-a-game-leaves-as-one-pgn-in-board-space.md), [0052](0052-the-replay-keeps-each-walk-as-squares-from-the-relays-already-sent.md)

## Decision

1. **The card draws each carry as a straight line from the lift fix to the
   place fix**, both players', in each player's own ink, a ring where the
   piece was picked up and a disc where it went down, over the final position
   on the replay's unit board (no north, no map, no scale). **No walk is
   drawn**: not the walk to a piece, not the other player meanwhile, and not
   the fixes sent while a piece was in hand. The card never reads
   `report.tracks`. The last four carries are drawn bold. Earlier ones are
   fainter and smaller, and every line thins as the game gets longer, so a
   long game still shows its final position. Lines are clipped to the board and the
   renderer's padding round it (about 0.55 of a square), so a fix just off
   the board keeps its marker.
2. **The figures**: the sharer's own distance walked and longest carry, and
   the game's result (in the sharer's voice, "Won as Black — checkmate"),
   move count (the last move's number, so Fool's mate is 2) and board size,
   all in the sharer's units through `shared/units.ts`. Each is the review
   screen's own figure. The opponent's distance is not on it.
3. **No date or time, no join code, no names.** The file is
   `satellite-chess.png`.
4. **The field's name is opt-in, off every time the card is opened**, and
   offered only when a player wrote it: never for a field with no name or
   with the app's own "My field" or "Shared field". It is never in the line
   of text that rides beside the picture. Never reverse-geocoded.
5. **1080 × 1350 (4:5 portrait).** The board takes the full width, with the
   words above it and the figures below.
6. **Made on the phone, sent by push, kept nowhere.** The card is drawn when
   the player opens "Share a picture of this game" on the review (live or
   archived, offline once loaded, and only for a reader with a seat in a game
   that ended with a result) and turned into a PNG then, so the Share tap
   reaches `navigator.share` with nothing awaited. The ladder is the share
   sheet with the file, then a page download, then the picture on screen,
   which can be pressed and held to save. No request, no server copy, no URL.
7. **The PNG is rebuilt keeping only `IHDR`, `PLTE`, `tRNS`, `gAMA`,
   `sRGB`, `IDAT` and `IEND`**, whatever the browser's encoder wrote, so no
   text, `eXIf`, `tIME`, `iCCP` or unknown chunk can leave. (Chromium writes
   only `IHDR`, `IDAT` and `IEND` today, so there the cleaner removes
   nothing.)

## Why

The walk is the hazard 0018 rule 3 names: a per-game track, the shape of
where somebody went, and 0052 keeps it for the two players alone. A card is
a picture made to be posted, and posted pictures go to people who have
stood on that field. Drawn on a grid, a walk still shows which corner
someone came from and left by and where they waited. Even "only my own
walk" was rejected for that reason. The lift and place fixes are a
different case, because they are already in the PGN either player may
share (0041). So the card discloses nothing a shared game file does not,
and it keeps the picture 0018 wanted: the moves as routes across a grid.

A posted card is already a point in time, because it is posted just after
the game. Naming the field on it would add the place. That combination
(place, person and time) is the one 0017 exists to prevent, so the name is
off unless the player puts it on, every time. A field called "Grandma's
backyard" is exactly the name a player would type for themselves and not
mean to broadcast.

The opponent's figures are left out because a card is one player's brag,
and the opponent never agreed to it. The carries are both players', as
8.5.1 asks, because both are in the file already.

At 4:5 the square board fills the width. At 1200 × 630 it would be less than
half the card's width. 4:5 is the tallest shape the common feeds show
uncropped, and it shows whole in chats.

## Rejected

- **Full walks**, or the walk inside a carry: the per-game track 0018 rule 3
  and 0052 keep private.
- **The sharer's own walk only**: still a track of where somebody stood,
  posted outward, even if it is the poster's.
- **A coarsened or smoothed walk**: 0018 rejects fuzzing for coordinates, and
  the same goes here. A walk coarsened to whole squares is still a route.
- **The field's name by default, or remembering the tick**: a remembered tick
  would quietly name every later field.
- **A date on the card**, or in the file name.
- **A link to the card, or storing it**: 0018 rule 1. Push only.
- **A text-only share rung**: a picture sent as words is not a picture.
- **The opponent's distance**: theirs to brag about.

## Revisit if

- Players ask for their own walk on it. If that happens, make it a per-card
  opt-in, off by default, never the opponent's, and see O-55 for how a walk
  is clipped at the board's edge.
- A browser's share sheet starts dropping PNG files, or a platform adds
  metadata after the page hands it the file. That is out of our hands, but
  the real-phone check (`8.5.7`) should look at it.
- A head-to-head card (8.5.4) wants the opponent's figures. Both players
  agreeing is what would make that allowed.
