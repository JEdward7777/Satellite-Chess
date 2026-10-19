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
- `11.2` done: Checkers rules on the server: American checkers, walk each hop (the `waypoint` handler), "jumps are required" at creation (default off), PDN, and "no moves left" as a result (decision 0057)
  - Descriptor and codec `shared/games/checkers.ts` (PDN squares 1–32, a PDN
    FEN as the position), engine `worker/games/checkers.ts`, writer
    `shared/pdn.ts`. The `w` seat plays the dark pieces and moves first.
  - `waypoint` handler in `GameDO`: judged like a place against the last
    stop, stored in `carry.via_json`; nothing is taken until the place, so a
    drop or suspension mid-jump puts everything back. The carry sums its legs.
  - `create` takes `gameType: "checkers"` and `options: {jumpsRequired}`.
    Snapshot, watcher view (`carry.via`), report (`moves[].via`), archive,
    record line and game list carry the type; UserDO schema 5 adds
    `game_type` to `record` and `game_index`. An unknown stored type is sent
    as stored, never as chess. New result reason `no_moves`.
  - Verified: `test/checkers.test.ts` (rules, with a random-game sweep),
    `test/worker/checkers.test.ts` (a game over the socket), and
    `check-golden` against `895c93b`: identical in all 63 parts.
  - Left for 11.3 (the phone): checkers art and `LOADERS` entry (the
    registry is `Partial` until then and draws no pieces); New game's
    Chess/Checkers choice and the "Jumps are required" switch; sending
    `waypoint` on a tap of a `carry.waypoints` square and offering "stop
    here"; naming the seats (`w` is Black, the dark pieces) everywhere the
    phone says White/Black (share card "Won as Black", color picker); the
    optimistic layer for a waypoint; the replay's hops (`uci` and
    `moves[].via`); the PDN share (`text/plain`, `.pdn`); "SATELLITE CHESS"
    and "playing chess" on the share card and text; `descriptorFor` still
    draws an unknown type as chess and should say "update the app".
  - Also for 11.3, from the round-1 review:
    - A king's multi-jump can legally end on its own origin square (for
      example `11x18x9x2x11`; with jumps required it can be the only place
      offered). So after any waypoint, a tap on the origin is a real place,
      not "put it back".
    - The record and head-to-head totals (`summarizeRecord` in
      `shared/record.ts`, and `shared/head-to-head.ts`) count chess and
      checkers together; split or label them.
    - Before the first `.pdn` is shared, confirm in a real checkers program
      that PDN's `1-0` means the dark side won (decision 0057, open question; answered in decision 0058).
- `11.3` done: Checkers on the phone: Chess or Checkers at New game, pieces, and replay, the share card, head-to-head and watching (decision 0058)
  - Built: New game's Game choice (Chess, Checkers) and, for checkers, the
    "Jumps are required" switch, off by default (the draft is not
    remembered per phone: no create choice is). The board's readout says
    Jumps required/optional. Art in `client/games/checkers/` (our own, a gold
    crown for a king, both looks), `/games/checkers.js`, precached; the build
    guard also keeps both record writers out of `app.js`.
  - Carrying: a ring for a hop, a dot for a place, "Stop here / Keep
    jumping" where a landing is both, one `waypoint` per tap, the origin after
    a hop a place only when the rules offer it (a king's loop) and otherwise
    a put-back, the hops walked drawn as an orange line on both phones
    and the watcher's; the optimistic layer walks a hop. A lift refused
    because another piece must jump says so (`GameRules.whyStuck`).
  - Seats named and painted per game (`seats` on the descriptor): checkers'
    `w` is Black. Board result line, color picker, review, replay ("Black
    jumped c1 to e3 to g5"), share card ("SATELLITE CHECKERS", "Won as
    Black"), watch page, games list, record and head-to-head (results split
    by game, distance one total). PDN shared as `text/plain`. An unknown game
    type says "update the app" and is never drawn as chess. PDN's `1-0`:
    answered in decision 0058 (kept as the dark side winning).
  - Round-1 review fixes: Cancel (not "Keep carrying") on the stop/keep
    choice; the invitation and the distance-honesty sentence name the game;
    the readout says "walk 119 ft to e5" after a hop; the origin after a hop
    puts the piece back unless the rules offer it (a king's loop).
  - Verified: `test/checkers-ui.test.ts`, a worker test for the refusal,
    `scripts/check-checkers.mjs` (both settings, keep jumping and put back,
    stop early, a refused lift, a 25-move game with a crowning and no moves
    left, the review and card), `check-golden` against `23cee67` identical.
- `11.4` todo: Real-phone check of checkers (stage 11.3, which is done): are rings and dots told apart in sun, is the crown read at arm's length in both looks, is "Stop here / Keep jumping" ever hit by accident
