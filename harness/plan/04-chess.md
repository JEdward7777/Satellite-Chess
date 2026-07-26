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

- `4.3` todo: The carry, client side
  - `4.3.1` todo: Tap a reachable own piece to lift it
  - `4.3.2` todo: Show legal destinations, and which are currently in reach
  - `4.3.3` todo: Carried piece in the HUD, with a distance-to-nearest-legal-
    destination readout so a player knows where to walk
  - `4.3.4` todo: Tap to place when in reach; clear feedback when not
  - `4.3.5` todo: Promotion picker
  - `4.3.6` todo: Optimistic local application, reconciled against the DO snapshot

- `4.4` todo: Resign and draw agreement

- `4.5` active: Tests
  - `4.5.1` todo: A full game played through the DO in a test
  - `4.5.2` todo: Castling reaches king squares only; en passant ignores the
    victim's square; a capture costs no more walking than a quiet move
  - `4.5.3` done: Rejections — wrong turn, out of reach at each end, implausible
    carry, illegal move, place without a lift
