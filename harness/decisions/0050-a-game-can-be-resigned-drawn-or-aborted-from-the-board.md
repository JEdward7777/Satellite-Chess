# 0050 — A game can be resigned, drawn or aborted from the board; an aborted game has no result

- **Date:** 2026-09-30
- **Status:** accepted
- **Stage:** 10.11 (O-50)
- **Builds on:** [0025](0025-suspension-lasts-a-month-then-the-other-player-may-claim.md), [0040](0040-the-record-is-one-line-per-finished-game-and-totals-are-derived.md), [0041](0041-a-game-leaves-as-one-pgn-in-board-space.md), [0042](0042-a-finished-game-leaves-as-an-archive-and-its-object-ceases-to-exist.md)

## Decision

1. **The board has "End game…"** in the staging, active and suspended states.
   It opens resign, offer a draw and abort. **Anything that ends the game on
   the tap is asked about first**, on a second screen whose button is dead for
   `ENDING_ARM_MS` (1 s) after it appears: resign, an abort nobody else must
   agree to, and accepting either kind of offer. An offer, and declining one,
   go at once. No browser `confirm()`.
2. **Resign** works while active or suspended, **whoever is connected**, so a
   player left alone on a broken field can end it. Not while staging: nobody
   has moved, and abort is the way out. It is a normal result: record, index,
   review, PGN, archive, as before (stage 4.4 on the server).
3. **A draw offer** stands until the opponent accepts or declines it, or
   **until the next move is placed by either side**, or the game ends. It
   survives a suspension. Offering into the opponent's open offer is agreement.
4. **Abort alone** is allowed while fewer than two plies have been played
   (`ABORT_ALONE_BEFORE_PLIES`, `shared/endings.ts`) — until each side has
   made its first move — in staging, active or suspended. That covers a
   handshake that never completed. **After that, abort needs both**: `abort`
   records an offer (`abort_offer_from`, schema 7), which lapses exactly as a
   draw offer does, and the opponent accepts or declines. `abort` into the
   opponent's open offer is agreement. Not in `waiting` (the code expires by
   itself and can already be tidied), and not once over.
5. **An aborted game has status `aborted` and no result.** The row holds
   `result_reason = 'aborted'` with no outcome, and the time in `result_at`.
   - **No record line** (0040): `pushRecord` sends only for `finished`, so
     nothing is written however often the game is re-pushed, and it does not
     count as played. A result can never follow, because nothing ends an
     aborted game again.
   - **No archive** (0042). It is **collected on an unplayed game's terms**:
     a month after anybody last looked, moves or not, both index rows
     dropped. 0025's "a game with moves and no result is never collected"
     protects a claim; an aborted game has none to protect.
   - **"Your games"** says "aborted — no result", sorts it with games that
     are over, lets it be tidied (`forgetIsRefused`), and **offers the tidy-up
     as soon as one aborted game is listed**.
   - **No review is offered.** If the server is asked for the file while the
     object lives, it is the canonical PGN (0041) with `Result "*"`,
     `Termination "abandoned"`, `SatelliteEnd "aborted"` and a closing comment
     `{Aborted by the players: no result.}`.
6. **Messages.** One new inbound type, `abort` (optionally `accept` or
   `decline`), beside the existing `resign` and `draw`. Each is one explicit
   tap; nothing is periodic. The snapshot gains `abortOfferFrom`. Nothing is
   timed: offers lapse on a stored event (a move), not a clock.

7. **A fallen flag is settled first.** Before any message that acts on a
   running game — lift, drop, place, pause, resign, draw, abort — the server
   makes the flag alarm's own check against the stored clock. If the running
   clock is out, the game ends on time and the message is refused ("time ran
   out"). A disconnect suspension that falls due after the flag ends the game
   on time too. So a late alarm cannot let a player pause a lost clock at
   zero and then abort, or agree a draw, out of a loss on time. Claim and the
   resume handshake act only on a stopped clock. `finish()` does nothing to a
   game that is already over.

## Why

The owner's first game on a field that turned out unplayable sat on the list
for good: the server had resign and draw since 4.4 but the screen had no
button for either, "Tidy up" refused the row, and the only exit was a claim
thirty days away. Resign is the honest exit for a game that was played. For a
game that never really started, a loss is wrong, so abort ends it with no
result. Letting one player abort after both have moved would make abort a
free resignation, and a losing player's best move would be to press it — the
incentive 0025 exists to remove. Two plies is lichess's line, and it is where
neither side has anything to lose.

## Rejected

- **Abort alone at any time before N moves (N > 2)**, or while the opponent
  is away: a free exit from a bad position.
- **Abort as a `finished` game with a `*` outcome**: every surface reads
  `finished` as "has a result", and collection would archive it.
- **An `aborted` record row that does not count**: a row that means nothing
  is still a row the privacy statement has to explain, and nothing needs it.
- **Offers that expire on a timer**: a timer is state the object would have
  to hold through hibernation, and a player walking across a field may take
  minutes to answer.
- **Browser `confirm()`** for resign: one tap on a dialog that pops under a
  moving thumb, and automation dismisses it silently.

## Revisit if

- Players abuse the two-ply window (a bad opening, aborted). Then a daily
  cap, as lichess has, not a shorter window.
- Players want an aborted game's walk counted. It is still in the object
  until collection; a record rule could count distance without a result.
- O-41 lands (deleting archives): an aborted game already has none.
