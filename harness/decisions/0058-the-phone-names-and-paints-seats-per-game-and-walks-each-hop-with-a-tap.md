# 0058 — The phone names and paints seats per game, walks each hop with a tap, and never draws an unknown game as chess

- **Date:** 2026-10-16
- **Status:** accepted
- **Stage:** 11.3 (O-57)
- **Builds on:** [0045](0045-pieces-are-the-standard-two-sided-set.md), [0048](0048-the-carried-piece-travels-beside-a-live-dot.md), [0053](0053-the-share-card-draws-carries-not-walks.md), [0054](0054-head-to-head-is-folded-from-each-players-own-rows-by-a-pair-id.md), [0056](0056-each-game-sits-behind-one-interface-and-loads-its-own-pieces.md), [0057](0057-checkers-is-american-the-first-mover-is-the-w-seat-and-each-hop-is-walked.md)

## Decision

1. **A seat's name and paint belong to the game.** `GameDescriptor.seats`
   gives each `Color` a `name` and whether it is `dark`: chess `w` White
   (light), checkers `w` Black (dark), `b` White. Every sentence that names
   a side asks `seatName(gameType, color)`; every ink that follows a side's
   pieces (walks, dots, the card's carries) asks `seatIsDark`. **Black and
   White** for American checkers, as PDN and the owner's rules say; not Red.
   `pieceNames` likewise ("a man", "a king") for the watcher.
2. **A tap while carrying** (`carryTap` in `views/game.ts`): the origin
   puts the piece back, before a hop and after one unless the rules offer
   it as a stop; a square that is a waypoint and a place asks **"Stop
   here" / "Keep jumping"** (its third button is "Cancel", never "Keep
   carrying", which reads too like the second); a waypoint sends one
   `waypoint` (`to`); anything else, **the origin after a hop included when
   it is offered** (a king's loop), is a place, and the server judges it. Put it back stays a button for the
   whole carry. Rings mark hops, dots mark places, an orange line through the
   squares stood on shows the hops walked, on both phones and the watcher's.
3. **The prediction walks a hop** at the tap and holds both lists empty
   ("still working it out") until the server answers; the server never
   offers nowhere after a hop, so empty-both is unambiguous.
4. **An unknown type is never drawn as chess.** `descriptorFor` returns
   null for a name this build does not know; the board, the watch page and
   the review say "close the app and open it again to update" and draw no
   pieces, and nothing is predicted.
5. **Chess reads exactly as it did.** Every new word is said only for a
   game that is not chess (`gameLabel` is null for chess): the board's
   "1-0 — checkmate.", the share text, the card's "SATELLITE CHESS" and
   `satellite-chess.png`, the games list, the record. Checkers says "Black
   won — no moves left.", "SATELLITE CHECKERS", "playing checkers".
6. **The record and head-to-head keep one distance and split results by
   game** (`tallyByGame`, `byGame`), present only once something other than
   chess was played. Walking is walking — meters are the record's currency
   whatever the game (0019) — but "3 won" across two games says less than
   it seems. Each checkers line is labeled.
7. **The card draws a walked jump through its hops**: lift, each waypoint
   fix, place. The PDN holds those fixes already (0057), so the card still
   shows nothing a shared file does not (0053's rule).
8. **The refusal says why** when jumps are required and another piece must
   jump: a rules hook, `GameRules.whyStuck`, gives the server's sentence;
   chess has none and keeps its own.
9. **Art**: our own checkers pieces (no license to carry), a gold crown
   for a king in both looks, the disc look with chess's gray ring. Its own
   file, `/games/checkers.js`, precached; the build fails if `app.js`
   bundles either game's art or either record writer.

## Why

Naming seats in each view would have spread "is this checkers?" through
twenty files; a descriptor field puts it in one place and keeps the `w`
seat moving first (0057). Saying nothing new for chess keeps every chess
driver and the golden comparison meaningful.

## Answered from 0057: what PDN's `1-0` means

Decision 0057 left open whether PDN's `1-0` is the dark side (the first
mover, our `w` seat) winning in American checkers. **Looked into on
2026-10-16: the writer stays as it is.** The original PDN proposal says the
four result codes "are given from the aspect of the 1st side to move -
Black in english draughts, White in Italian" (the spec copy in
mig0/Games-Checkers, `data/spec/pdn-format.txt`), so `1-0` is Black winning,
as written. A sample English game from the CheckerPlayer program bears it
out: Black blunders a piece (`11-15??`), White is ahead, and the file says
`0-1`. Against it: Wikipedia's PDN page glosses `1-0` as "White won", and
the PDN 3.0 standard (Wesselink, 2026) lists `1-0` as WIN1 without naming a
side. Still worth opening one of our files in a real checkers program
before the owner shares one widely.

## Rejected

- **Red and Black.** Common on boards, but PDN and the owner say Black and
  White, and Red reads as the opponent's dot color here.
- **Splitting meters by game.** Two headlines; 0019 has one.
- **Keep jumping by default on a double landing.** Stopping early is the
  setting's whole point when it is off; the player chooses.
- **A dev seam that sets a position for the driver.** The replay would not
  match the moves; `check-checkers.mjs` plays a real game found by a search
  over the server's own rules instead.

## Revisit if

- Players read Black/White as the wrong way round outdoors.
- The choice panel is hit by accident while walking (it sits over the board,
  as the promotion picker does).
