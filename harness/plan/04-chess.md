# Phase 3 — Chess: server-authoritative rules and carry validation

chess.js runs in both places: the client for instant highlighting, the Durable
Object for the only answer that counts.

- `4` active: Server-authoritative chess with carry validation

- `4.1` done: Rules in the DO
  - `4.1.1` done: Load FEN, validate legality, apply, persist new FEN
  - `4.1.2` done: chess.js `move()` throws on illegal input — catch it and map to
    an `illegal_move` error rather than letting it fault the object
  - `4.1.3` done: Terminal detection: checkmate, stalemate, insufficient
    material, threefold repetition, fifty-move rule
  - `4.1.4` done: Persist every move to `moves` with both position fixes

- `4.2` done: The carry, server side (decision 0001)
  - Server half complete. Legality is checked **before** the carry
    verdict: it does not depend on where anyone stands, so it is both cheaper
    and clearer — the other order told a player who moved illegally that their
    GPS had jumped.
  - `4.2.1` done: `lift` — validate turn, ownership, reach to origin, and that the
    piece has at least one legal move; store the pending lift
  - `4.2.2` done: Relay the carry to the opponent, including piece type. Seeing
    what is being carried across the field is most of the tension in the game.
  - `4.2.3` done: `place` — validate reach to destination, plausibility of the
    walk, and legality of from→to; then apply
  - `4.2.4` done: Pending lift persisted in SQLite, so it survives hibernation
  - `4.2.5` done: `drop` — put the piece back, free, costing only clock time
  - `4.2.6` done: Suspension cancels a carry (decision 0009)
    - `suspendForDisconnect` now clears the carry row along with the flag timer.
      Body position cannot be serialised, so whoever resumes is standing
      somewhere else — a pending lift would be unfinishable. The clock keeps what
      it spent; nothing is refunded.
  - `4.2.7` done: Promotion resolved at place time, no travel involved

- `4.3` active: The carry, client side
  - `src/client/views/game.ts`. Destinations come from the server with the carry,
    so the client needs no rules engine — a solid dot is legal *and* in reach, a
    faint one is legal but needs walking, which is the decision the game is made
    of. Verified by playing a real move between two browsers against
    `wrangler dev`: calibrate, create, join by code, both walk to their back
    ranks, lift on e2, walk to e3, place on e4, opponent sees it.
  - `4.3.1` done: Tap a reachable own piece to lift it
  - `4.3.2` done: Show legal destinations, and which are currently in reach
  - `4.3.3` todo: Carried piece in the HUD, with a distance-to-nearest-legal-
    destination readout so a player knows where to walk
  - `4.3.4` done: Tap to place when in reach; clear feedback when not
  - `4.3.5` todo: Promotion picker
  - `4.3.6` todo: Optimistic local application, reconciled against the DO snapshot

- `4.4` done: Resign and draw agreement
  - Resigning is allowed on the opponent's turn too: "I am beaten" is not a move,
    and making someone wait for the clock to come back before conceding would be
    a strange thing to require.
  - The draw offer lives in the game row, not in memory — the object hibernates
    between messages, and an offer that evaporated on a wake would be genuinely
    confusing from opposite ends of a field.
  - Offering into an open offer counts as agreement, since both players tapping
    at once means the same thing under any reading.

- `4.5` done: Tests
  - `4.5.1` done: A full game played through the DO in a test
    - Scholar's mate, seven moves, each a real lift-walk-place. Confirms the move
      list, the terminal detection and that both position fixes are stored for
      every move — which is what the distance record and the replay are built on.
  - `4.5.2` done: Castling reaches king squares only; en passant ignores the
    victim's square; a capture costs no more walking than a quiet move
  - `4.5.4` done: Captures — ordinary capture, recapture, cost parity with a quiet
    move, and the capture offered among the destinations at lift time
    - Added because captures were only ever covered incidentally: `Qxf7#` (which
      is also the mating move) and `exf6` (en passant, the special case). No test
      had ever taken an ordinary piece mid-game. They work, and material really
      leaves the board — asserted by counting pawns, not by trusting the 'x' in
      the SAN.
  - `4.5.3` done: Rejections — wrong turn, out of reach at each end, implausible
    carry, illegal move, place without a lift
