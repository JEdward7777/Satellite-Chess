# 0063 — A remote field is recalibrated in a pause by walking it again with the board's socket closed, and the walk is saved to the player's own field

- **Date:** 2026-11-22
- **Status:** accepted
- **Stage:** 12.3
- **Builds on:** [0060](0060-a-remote-game-has-two-fields-one-square-size-and-board-space-between-them.md) (point 6), [0061](0061-a-remote-seat-is-a-field-and-its-board-and-board-space-is-squares.md), [0062](0062-the-phone-takes-its-board-from-one-seam-and-fits-a-shrunk-board-with-its-field.md), [0005](0005-back-rank-resume-handshake.md), [0037](0037-the-phone-says-ready-once-and-the-evidence-ends-with-the-socket.md)

## Decision

How 0060 point 6 is built.

1. **One inbound message, `recalibrate`, carrying the saved field** (raw taps,
   as a join body does, snapshotted by the same `gameFieldOf`). Taken only in a
   remote game, only while it is `suspended` (a pause or a disconnect, one
   state since 0025), and only for the sender's seat, which the socket names.
   Refused as `not_active` when not suspended and `bad_field` for a field that
   describes no board. **A same-field game answers it as a type it does not
   take**, byte for byte what it answered before 12.3.
2. **The write goes through `setSeatField`**, which re-judges both back ranks
   and only ever lowers a flag; the sender's own flag is then cleared
   outright. Nothing in the handler raises a flag, so nothing in it resumes
   the game. The seat keeps its `disclosure_at` (null passed to
   `setSeatField` means "keep"). Broadcast after the re-judge, then the
   seat's game-index line.
3. **The phone walks the field with the ordinary calibration screen**, in a
   recalibration's words (`recalibratePurpose`: on a shrunk board, "just
   inside the dashed line … not the smaller board inside it"), and **closes
   the board's socket meanwhile**, as the invite screen does. The server
   forgets a back rank with its socket (0037) and resumes only with both
   connected, so the game cannot resume while the player is off walking
   corners; the opponent reads "Waiting for your opponent to come back." On
   save the phone re-opens the board and sends `recalibrate` once that
   socket's first snapshot shows the game still suspended and on the old
   field, **and again on every socket that opens** until a snapshot shows
   this seat on the field it sent (id, version, corners), the server refuses
   it with `bad_field` or `not_active` (whose sentence the board shows), or
   the game is no longer suspended (`client/recalibration.ts`). Never on a
   timer: at most one per socket. A duplicate is the same field written
   twice. **Until then the board claims no back rank** — no `ready`, no
   relay, the button disabled — because the server would judge it on the old
   board and an opponent waiting on theirs would resume the game on the old
   field (found in review, round 2). Any of the three endings frees it, so a
   refused recalibration cannot strand a game. The board says "Sending your
   recalibrated field…" meanwhile, and does not offer a second recalibration.
   **The unconfirmed field is written to the phone's `localStorage`** when it
   is saved (`satchess.recalibrations`, keyed by join code, with the account's
   `sub`), read back by every board for that game, and forgotten at any of
   the three endings — so a reload, a discarded tab or Home and back resumes
   the same gate (review, round 3). Only the account that saved it sends it:
   the server applies a `recalibrate` to whichever seat the sending socket
   holds, so another account on the phone must never find it. A storage that
   throws costs only that surviving copy.
4. **The walk is saved to the player's own saved fields**: the field this
   phone holds under the game field's id is re-calibrated in place (a new
   version, synced to the account as any re-calibration is); if this phone
   does not hold it, a new field is saved under the game's name for it.
   Games snapshot their field, so no other game changes shape.
5. **A rescale is said, not asked.** Both phones show who recalibrated and the
   new square ("Your opponent recalibrated their field. The squares are now
   8.0 m on both fields.") until play resumes. `handshakeEpisode` includes the
   shared square and the receiver's own field's `snapshotAt` in a remote game,
   so `AutoReady` re-arms after a rescale (O-26); a same-field episode is the
   string it was.
6. **A still opponent is re-placed.** When a recalibration reshapes a board,
   the server re-projects that seat's stored fix onto it with the same time.
   `net.ts` takes a snapshot spot with the same server time and different
   squares as news, timed now, so the dot goes where the opponent's own phone
   says they are without waiting for them to move.
7. **Moves already played stay on their squares.** A move's fixes are stored
   as coordinates and turned into squares on the mover's board when the
   report is built (0041). On every reshaped board (the recalibrating seat's,
   and the other seat's when `s` moves), the handler moves each played fix to
   the place on the new board with the same squares it had on the old one
   (`keepMovesOnTheirSquares`), so the replay still says "picked up standing
   on f2". The walk is stored as squares already. What does not follow the
   squares: the report gives the **final** shared square for the whole game
   (`squareM`, `boardM`), accuracy rings are stored in meters so their size in
   squares changes, and an earlier move's `carried_m` is the meters walked on
   the old board, which no longer match the squares drawn between its lift
   and place.
8. **A field is checked for shape before it is snapshotted**, in
   `gameFieldOf`, so create, join and recalibration refuse by one rule: the
   parts a snapshot keeps, by the account's own validators (a string id,
   numbers for coordinates, both extra corners or neither, a whole version, a
   board that fits). A name that is not a string becomes "Field". Not the
   whole of `asFieldSpec`, whose refusal of a malformed `origin` or timestamp
   would refuse fields a same-field create has always taken.

## Why

Saving: the field was recalibrated because it was wrong, and it is wrong in
the saved list too; the next game would bring the mistake back. Re-using the
calibration screen (saved first, decision 0013) meant no second flow to keep
in step. Closing the socket: one extra inbound message ("I am recalibrating")
would be the alternative way to stop a resume mid-walk; the socket close costs
nothing and uses rules already in place.

## Rejected

- **Game-only recalibration** (not saved): simpler on paper, but leaves the
  bad field in the list, and the calibration screen would need a mode that
  does not save.
- **Keeping the socket open while walking**: a player who paused on their back
  rank keeps their flag (0037), and the opponent arriving on theirs would
  resume the game with the recalibrating player at a corner.
- **Requiring the new field to keep the old id**: the server has no reason to
  care which saved field a seat's taps came from.
- **Re-approval by the other player**: 0060 rejected it.
- **Keeping old fields to project old moves** (a history of seat fields, the
  report picking the board in force at each move): a new table and a
  time-indexed lookup, for the same squares the rewrite keeps. Squares stored
  per move would be cleaner still, but is a schema change to every game.

## Revisit if

- 12.4 finds a rescale surprises the other player despite the line, or that
  "Waiting for your opponent to come back" reads as a dropped connection.
  A "recalibrating" state would need a message or a column.
- Players want a temporary fix for today's GPS drift without changing the
  saved field.
