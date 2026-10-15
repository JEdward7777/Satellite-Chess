# Phase 11 — Other games

The same field, the same walking, another game (O-57). Everything around the
rules — calibration, the carry, the clock, the handshake, the record, the
archive, the replay, the zoom, watching — is shared; each game's rules sit
behind one interface (decision 0056). Checkers first, as the owner decided
on 2026-10-13: American rules, each hop of a multi-jump walked, "jumps are
required" a creation setting that is off by default, and PDN.

- `11` active: Other games on the same field

- `11.1` done: The multi-game architecture, with chess moved behind it and no behavior change (decision 0056)
  - Descriptor (both runtimes, with the position codec), server rules
    (chess.js behind `GameRules`), and phone art fetched on demand as
    `/games/chess.js`. `game_type` and `options_json` on the game (schema 9),
    absent is chess everywhere. A carry is a lift, waypoints, a place; the
    `waypoint` message and `via_json` storage are defined, unused by chess.
  - Verified by `scripts/check-golden.mjs`: the same games against the old
    and new server leave the same PGN, report, archive and watcher frames.
- `11.2` todo: Checkers rules on the server: American checkers, walk each hop (the `waypoint` handler), "jumps are required" at creation (default off), PDN, and "no moves left" as a result
- `11.3` todo: Checkers on the phone: Chess or Checkers at New game, pieces, and replay, the share card, head-to-head and watching
