# 0061 — A remote seat is a field and its board; the wire carries squares, and anything shared describes the shared board

- **Date:** 2026-10-31
- **Status:** accepted
- **Stage:** 12.1
- **Builds on:** [0060](0060-a-remote-game-has-two-fields-one-square-size-and-board-space-between-them.md), [0055](0055-a-game-can-be-watched-live-on-a-link-both-players-agreed-to.md), [0052](0052-the-replay-keeps-each-walk-as-squares-from-the-relays-already-sent.md), [0041](0041-a-game-leaves-as-one-pgn-in-board-space.md)

## Decision

How 0060 is built on the server, where 0060 left the shape open.

1. **One seam.** Every judgement of a position — lift, waypoint, place,
   the back rank, the replay's track, the squares a fix becomes for anyone
   else — asks `GameDO.boardFor(game, color)` for that seat's board, which
   takes it from `boards(game)`: that reads the fields once, derives
   `s = min(meanSquareM)` and shrinks each seat's board with `shrinkBoard`
   (`shared/remote.ts`): about index (3.5, 3.5), one factor `s / meanSquareM`,
   `meanSquareM` set to `s` exactly. Every field shown to a player comes from
   `fieldFor`, which reads `seatFields()` or `field_snapshot_json` itself and
   does not go through `boards`. `fieldFor`, `seatFields` and `boards` are the
   only readers of `field_snapshot_json` and `seat_field`.
   `playableBoard(field, squareM?)` is the same shrink for one field, the entry
   point for the phone (12.2) and the tests; with no square size it is
   `geometryFromSnapshot(field)` exactly, which is every same-field game.
   Reach, the back rank, plausibility and the track run unchanged on the board
   they are given. Elsewhere `isRemote` decides only what is said and to whom
   — the join's refusals and answer, the relay's shape, the snapshot's
   `remote` and the opponent's `spot`, the field a peek shows, the report's
   name — with one branch that writes: `join` storing the joiner's field
   through `setSeatField`.
2. **Storage.** `game.remote` (1, or NULL for the same field) and a
   `seat_field` table, one row a seat: the field, when that player accepted
   the disclosure, and when the row was written. `s` is derived from the rows
   on every call, never stored, so replacing one seat's row (stage 12.3)
   moves `s` with nothing else to update. `field_snapshot_json` still holds
   the creator's field (the column is NOT NULL) and is not read for a remote
   game. Schema 10. **Writing a seat's row re-judges the back-rank flags, and
   only ever lowers one**: a raised flag stays raised only if its stored fix is
   still on the back rank of the reshaped board. A flag is raised only by a
   `pos` or `ready` on the player's current socket, as in every game, because
   a stored fix is evidence only for as long as the connection that gave it
   (0037) and the start must be positional and fresh (0005).
3. **The wire, board space only.** A remote snapshot carries the receiver's
   own `field` and `remote: { squareM }`. The opponent's `PlayerView.pos` is
   null and `spot` is `{ spot: {file, rank} | null, acc, at }`, or null with
   no fix; the relay is
   `opp_spot` with the same shape, in place of `opp_pos`. Both are made on
   the sender's own board by `watchSpot`, the watcher's projection (hundredths
   of a square, null beyond 3 squares off). A same-field message has none of
   these keys.
4. **Create and join.** `remote: true` on create needs `disclosureAccepted:
   true`. A remote game's free seat needs the joiner's `field` and
   `disclosureAccepted: true` in the join body, refused as `bad_field` (a
   field that describes no board), `field_required` and `disclosure_required`
   (400) with nothing written. A same-field game and a seat already held
   ignore the join body whatever it says. The join answers
   with the joiner's own field and `remote: true`; a remote invitation
   (`GET`) carries no field, and a seated player's carries their own.
5. **What both players, or nobody in particular, are told describes the
   shared board.** The report, the archive and the PGN/PDN of a remote game
   have `fieldName` null (`Site "?"`) and the figures of eight shared squares
   a side (`squareM = s`, `boardM = 8s`, `diagonalM = 8s√2`). A watcher's view,
   which never has a field name, gives `boardM = 8s`. Each move's lift, waypoints and place, and each walk, are squares
   on the mover's own board.
6. **What only one player is told is theirs.** A record line names that
   seat's own field and uses its own playable board's figures; a game-index
   line names that seat's own field.

## Why

The owner asked that the work not make the code hard to maintain. A seat's
board as the one question keeps remote out of every rule: the alternative,
`if remote` at each lift, place, waypoint, ready, relay and report, is how two
games' worth of geometry would drift apart. Squares are what the watcher and
the replay already use, so a third projection was not needed.

## Rejected

- **A remote position as a union inside `RelayedPos`.** Every reader of
  `pos.lat` would have to narrow it, and an old phone would draw squares as
  degrees. A separate key and message are ignored by an old phone instead.
- **The report naming each player's field.** The report and the PGN go to
  both players; one name is the other player's place.
- **Shrunk corners stored as a new snapshot.** The taps are the truth
  (AGENTS.md section 6), and 0060 point 7 draws the calibrated outline.

## Revisit if

- Stage 12.3 needs the shared square stored (for example to tell a rescale
  happened); today it is derived.
- A board is shrunk so far that its squares are below `SMALL_SQUARE_M`
  (0060's own revisit condition).
