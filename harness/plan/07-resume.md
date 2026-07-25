# Phase 6 — Resume: the back-rank handshake

Body position is part of the game state and cannot be serialised. So it is not
restored, it is reset: both players return to their own back rank before the
clock restarts (decision 0005).

- `7` todo: Suspend and resume

- `7.1` todo: The handshake in the DO
  - `7.1.1` todo: On resume, require both players connected and both localised
    inside their own start zone, each verified server-side
  - `7.1.2` todo: Set `active`, restart the clock, re-arm the flag alarm, broadcast
  - `7.1.3` todo: Same handshake gates the opening of a fresh game, so there is
    one code path and one thing to explain to players

- `7.2` todo: The handshake on the client
  - `7.2.1` todo: Client-side start-zone detection, sending `ready` only when it
    believes it qualifies — server still re-validates
  - `7.2.2` todo: "Waiting for your opponent to reach their back rank", with their
    distance so the wait is legible
  - `7.2.3` todo: Manual ready button, for when GPS disagrees with reality

- `7.3` todo: Finding your way back
  - `7.3.1` todo: Persist `game_id` in `localStorage` on both devices so resume
    works with no login at all
  - `7.3.2` todo: Reconnect with backoff, and a snapshot resync on reconnect
  - `7.3.3` todo: Resume from a cold start — app killed, phone rebooted
