# Phase 12 — Remote play: two fields, one game

Two players on two different fields, playing over the internet (O-32,
decision 0060). Scoped with the owner on 2026-10-31 and built with the
ratchet (`harness/pipeline/ratchet.md`), as run 4.

- `12` todo: Remote play on two fields

- `12.1` todo: Remote games on the server: a field per seat, one shared square size, board-space relay, disclosure accepted (decision 0060)
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
- `12.2` todo: Remote games on the phone: the choice at creation, picking or calibrating a field on join, the disclosure, the opponent dot in squares, the calibrated outline around a shrunk board
  - The disclosure is shown and accepted on every remote create and join.
  - Show the shared square size. The opponent's dot is drawn from board
    space onto your own board.
  - Drive two browser contexts with the simulator on two different fields.
- `12.3` todo: Recalibrate your own field during a pause in a remote game; the square size crosses over again with no re-approval
  - One inbound message, accepted only while suspended, only from that
    seat. `s` is recomputed and both snapshots updated. Resume is the
    ordinary back-rank handshake.
  - The phone re-taps the outer (calibrated) corners, with the outline from
    `12.2` making clear which corners those are.
- `12.4` todo: Real-phone check: a remote game between two places
  - Does A1 feel like A1? Is the disclosure read or dismissed? Does a
    rescale after recalibrating surprise the other player?
