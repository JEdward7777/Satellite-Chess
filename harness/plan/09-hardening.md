# Phase 9 — Hardening: bad GPS, tree cover, small fields

Problems we can anticipate. The ones that actually matter will come out of phase
10; this is the predictable subset.

- `9` todo: Hardening against real-world conditions

- `9.1` todo: Degraded GPS
  - `9.1.1` todo: Accuracy trend display, so a player can tell "wait a moment"
    from "this is as good as it gets"
  - `9.1.2` todo: Behaviour when accuracy crosses the refusal threshold mid-carry
  - `9.1.3` todo: Recovery from a total loss of fix without losing the game
- `9.2` todo: Small fields and tight squares
  - `9.2.1` todo: What actually happens on 4 m squares — is it playable or a coin
    flip? Decide from measurement, then set the warning thresholds from that.
  - `9.2.2` todo: Reconsider `DEFAULT_REACH` once there is field data
- `9.3` todo: Network
  - `9.3.1` todo: Play through a dead spot and reconnect cleanly
  - `9.3.2` todo: Confirm the UI keeps working offline — reach is computed locally
    precisely so that it can
- `9.4` todo: Battery
  - High-accuracy GPS plus a wake lock plus a live canvas is the worst case for
    battery. Measure a 30-minute game and reduce the render rate if needed.
- `9.5` todo: Request budget measured against a real game, not estimated
