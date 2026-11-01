# Phase 12 — Remote play: two fields, one game

Two players on two different fields, playing over the internet (O-32,
decision 0060). Scoped with the owner on 2026-10-31 and built with the
ratchet (`harness/pipeline/ratchet.md`), as run 4.

- `12` active: Remote play on two fields

- `12.1` done: Remote games on the server: a field per seat, one shared square size, board-space relay, disclosure accepted (decision 0060)
  - `create` takes a remote flag. `join` on a remote game carries the joiner's
    own field and the disclosure acceptance, and both are refused without it.
  - Store a field per seat, and derive each seat's playable board: shrunk
    uniformly about its center so its `meanSquareM` equals
    `s = min(meanSquareM)`. Lift, place, waypoint and the back-rank handshake
    are judged against the mover's own board; reach in meters comes from `s`.
  - The position relay goes out in board space (fractional file and rank)
    in a remote game. The snapshot sends each player only their own field.
    Check the archive, the report, the watcher frames and the record for any
    path that hands one player the other's geometry or lat/lon. 0027's kept
    field does not apply.
  - A same-field game is byte for byte unchanged: `check-golden`.
  - DO integration tests: unequal fields, a move judged on each board, relay
    projection, and both refusals.
  - Built (decision 0061, `2026-11-01-01`): `shared/remote.ts`
    (`shrinkBoard`, `playableBoard`, `sharedSquareM`); schema 10 (`game.remote`,
    `seat_field`); `GameDO.boardFor`/`boards`/`fieldFor` as the one seam;
    `opp_spot` and `PlayerView.spot`; join refusals `bad_field`,
    `field_required`, `disclosure_required`; a seat-field write re-judges
    back-rank flags and only ever lowers one. Tests in
    `test/remote.test.ts` and `test/worker/remote.test.ts`. `check-golden`
    against HEAD `4e0b42e`: identical in all 63 parts. Four review rounds.
- `12.2` todo: Remote games on the phone: the choice at creation, picking or calibrating a field on join, the disclosure, the opponent dot in squares, the calibrated outline around a shrunk board
  - The disclosure is shown and accepted on every remote create and join.
  - Show the shared square size. The opponent's dot is drawn from board
    space onto your own board.
  - Drive two browser contexts with the simulator on two different fields.
  - Notes from 12.1:
    - Draw and judge on `playableBoard(field, remote.squareM)`: the game
      view's `geometry()`, `walkToBackRankM`, and reach.
    - Read `opp_spot` and `PlayerView.spot`. Handle both nulls: a `spot`
      that is null (no fix) and an inner `spot.spot` that is null (more than
      3 squares off the board).
    - The join screen picks or calibrates a field and shows the disclosure,
      and skips the kept-field copy (`keepGameField`) when the join answers
      `remote: true`.
    - Add a `waiting` branch to `prompt()` in `src/client/views/game.ts`: a
      creator waiting alone is told "Your move". Already true on HEAD, and
      it affects same-field games too.
    - The Invite button in a remote game.
    - **No new floor on the shared square (the owner, 2026-11-01):** "the
      process of creating a board already has a min sized imposed"
      (`checkCalibration`: refused under 2 m at the narrowest, warned under
      `SMALL_SQUARE_M` = 4 m). One edge to handle without a new rule: the
      shrink matches *mean* squares, so a long, thin larger field can come
      out narrower than 2 m on its short step. Show the existing
      small-square warning on the shared board in that case.
    - `remote` and `disclosureAccepted` must be the boolean `true`.
- `12.3` todo: Recalibrate your own field during a pause in a remote game; the square size crosses over again with no re-approval
  - One inbound message, accepted only while suspended, only from that
    seat. `s` is recomputed and both snapshots updated. Resume is the
    ordinary back-rank handshake.
  - The phone re-taps the outer (calibrated) corners, with the outline from
    `12.2` making clear which corners those are.
  - Notes from 12.1:
    - Every field write goes through `GameDO.setSeatField`, which re-judges
      the back-rank flags (lower-only).
    - Clear the recalibrating seat's flag outright: their last fix is a
      corner.
    - Put `remote.squareM` or a field revision into `handshakeEpisode`, so
      `AutoReady` re-arms after a rescale (O-26).
    - Broadcast after the re-judge.
- `12.4` todo: Real-phone check: a remote game between two places
  - Does A1 feel like A1? Is the disclosure read or dismissed? Does a
    rescale after recalibrating surprise the other player?
