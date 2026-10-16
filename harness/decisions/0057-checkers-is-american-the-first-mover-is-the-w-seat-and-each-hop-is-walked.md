# 0057 — Checkers is American; the side that moves first is the `w` seat; each hop of a jump is walked and nothing is taken until the place

- **Date:** 2026-10-15
- **Status:** accepted
- **Stage:** 11.2 (O-57)
- **Builds on:** [0001](0001-two-phase-carry.md), [0009](0009-suspension-cancels-a-carry.md), [0041](0041-a-game-leaves-as-one-pgn-in-board-space.md), [0050](0050-a-game-can-be-resigned-drawn-or-aborted-from-the-board.md), [0056](0056-each-game-sits-behind-one-interface-and-loads-its-own-pieces.md)

## Decision

The owner chose the rules on 2026-10-13 (O-57): American checkers (English
draughts), each hop of a multi-jump walked, "Jumps are required" a creation
setting that is off by default, PDN. This records how they sit in the game.

1. **The `w` seat plays the dark pieces and moves first.** Checkers' Black
   moves first; every part of the stack around the rules (the clock starts
   with `w`, move numbering, `1-0`, the abort rule, the handshake) already
   says "the first mover is `w`". So a `Color` in checkers is a seat, not a
   paint: `w` is checkers' Black, stands on rank 1 and moves up. The phone
   names and paints seats per game (stage 11.3). PDN's `1-0` is then the
   dark pieces winning, which is the convention for American checkers files.
2. **Squares are PDN's 1–32 laid on the field's own 8 × 8**, played on the
   dark squares (a1 dark, as in chess). 1–4 is the first player's back row, 4
   is a1 (the single corner on their left), 1 and 5 the double corner. The
   position string is a PDN FEN (`B:W21,…:B1,…`, PDN's `B` being the `w`
   seat).
3. **A walked jump.** At the lift, `stops` returns each first landing: a
   landing the jump can go on from is a **waypoint**; it is also a **place**
   when the move may end there. Each `waypoint` message is judged like a
   place (a hop the rules offer from where the piece now is, reach to it
   now, a possible walk since the last stop), stored in `carry.via_json`, and
   broadcast. The place ends the move on the last landing, or, with jumps
   not required, on the square the last waypoint stood on ("stop here").
   One message per hop, each a tap; nothing else is sent.
4. **"Jumps are required"** (`jumpsRequired`, `options_json`). On: no plain
   move while any jump exists, and no stopping while the jump can go on. Off:
   both allowed. It is on the snapshot, the watcher's view, the report and
   the archive (`options`), and in the PDN as `SatelliteJumpsRequired`.
5. **Nothing is taken until the place.** A waypoint changes no square. A
   jumped piece stays on the board, unjumpable a second time, until the
   place applies the whole move. So a **drop or a suspension mid-jump puts
   everything back**: the carried piece returns to its origin and every piece
   it jumped is still there (0009's "the interruption put your piece back").
   The clock keeps what was spent.
6. **A man crowned mid-jump ends its move there**: a crowning landing is
   never a waypoint.
7. **Endings.** The side to move with no legal move, or no pieces, loses
   (`no_moves`, a new result reason). A fallen flag always loses: no
   material rule. **No automatic draw**: a draw is by agreement only, and
   resign, draw offer and abort work as for chess (0050).
8. **The carry is every leg**: lift to each waypoint to the place, summed,
   and the time in hand from lift to place (`shared/geo.ts` `pathLengthM`).
9. **PDN** (`shared/pdn.ts`), as the PGN is built (0041): `GameType "21"`,
   `11-15`, `9x18x27`, each move's walk in a comment with `via` for each
   waypoint, board space only. Served as `text/plain`, named
   `satellite-checkers-<date>-<field>.pdn`. The report's moves carry `via`
   positions (in squares) only when there were waypoints; `uci` is every
   square stood on (`c3e5g7`).
10. **The type travels.** Since there is now a second game, a stored type the
    server has no rules for is sent as stored, never left out (which would
    read as chess). The record line and the game list carry `gameType`
    (UserDO schema 5, NULL is chess), for the record screen and
    head-to-head.

## Why

Making the `w` seat the dark pieces costs one sentence of documentation;
making `b` move first would touch the clock, the abort rule ("each side has
moved"), move numbering in two writers and every result string. Nothing a
player sees depends on the letter.

Taking pieces only at the place keeps every waypoint a pure claim about
where the carrier stands, which is what 0009 already knows how to cancel.
Removing pieces hop by hop would make a suspension either undo board changes
or leave half a move played.

No automatic draw: the official 40-move rule needs a claim and a move
history the server does not keep (the same gap as O-59), the clock bounds
every game, and agreement and abort already exist.

## Open question

Is PDN's `1-0` really "the dark side (the first mover) won" for American
checkers? It is the convention as remembered, not checked. Confirm it in a
real checkers program before the first `.pdn` is shared (stage 11.3).

## Rejected

- **The `b` seat moves first** (checkers' colors on the chess seats): see Why.
- **Carry the piece to its last landing in one walk.** The owner chose to
  walk each hop.
- **Remove each jumped piece at its waypoint.** See Why; and an opponent's
  piece disappearing before the move is committed is a board nobody agreed.
- **The 40-move rule, or repetition.** See Why.
- **A dependency for the rules.** A hundred-odd lines; and the walked hops
  want "where may this piece stop next?", which move-list engines do not
  answer directly.

## Revisit if

- Real games stall in king endings nobody will agree to draw: add a
  move-count rule with stored history (and fix O-59 the same way).
- Owners want other draughts (international 10 × 10, flying kings): that is a
  new lattice (0056's "Revisit if").
- Players are confused that a suspension un-jumps a half-walked capture.
