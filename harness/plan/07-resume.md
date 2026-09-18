# Phase 6 — Resume: the back-rank handshake

Body position is part of the game state and cannot be serialised. So it is not
restored, it is reset: both players return to their own back rank before the
clock restarts (decision 0005).

Audited against the code on 2026-09-17 (O-23). Most of the DO half had been built
during phases 4 and 5 and never marked; the client half and the cold start were
finished in the same session. `scripts/check-resume.mjs` drives the whole phase in
a browser.

- `7` done: Suspend and resume

- `7.1` done: The handshake in the DO
  - `7.1.1` done: On resume, require both players connected and both localised
    inside their own start zone, each verified server-side
    `startIfBothReady` in `game-do.ts` requires `allConnected()` and every
    `presence.in_start_zone = 1`; the flag is only ever set by the server's own
    `inStartZone` check on a `ready` or a relayed `pos`. Since 2026-09-17 it is
    also cleared when a player's last socket closes (decision 0037), so a phone
    cannot vouch for a back rank it has since left. Tests in
    `test/worker/carry.test.ts`: "the start handshake" (not until both, the
    wrong back rank, the middle of the board), "the start handshake is
    positional", and "a start zone lasts only as long as the connection".
  - `7.1.2` done: Set `active`, restart the clock, re-arm the flag alarm, broadcast
    `startIfBothReady` sets `status = 'active'` and `last_clock_start_at`, clears
    the suspension, calls `armFlag()` and `syncIndex()`; every caller broadcasts.
    Tested by "arms the flag deadline once the clock starts", "lets the opponent
    resume right up until the button is pressed", and the 7.3.3 resume test,
    which checks the clock runs again with nothing charged for the pause.
  - `7.1.3` done: Same handshake gates the opening of a fresh game, so there is
    one code path and one thing to explain to players
    `join()` moves a full game to `'staging'`, and `startIfBothReady` is the one
    function both a start and a resume go through (`onReady`, `onPos`).

- `7.2` done: The handshake on the client
  - `7.2.1` done: Client-side start-zone detection, sending `ready` only when it
    believes it qualifies — server still re-validates
    `AutoReady` in `client/handshake.ts`, called from `views/game.ts` on every
    fix and snapshot. Once per arrival, not per fix; skipped when the server
    already agrees, and deferred 3 s when the relay just carried the same fix
    in case that relay confirms it (decision 0037). Unit
    tests in `test/handshake.test.ts`; `check-resume.mjs` cuts white's relay so
    only `ready` can start the game, and counts exactly one.
  - `7.2.2` done: "Waiting for your opponent to reach their back rank", with their
    distance so the wait is legible
    `opponentHandshakeLine` / `myHandshakeLine` from the coarse relayed position;
    the server now follows a relay that changes `in_start_zone` with a snapshot
    so "your opponent is on their back rank" is the server's word, not a guess.
    The driver checks the distance falls as black walks.
  - `7.2.3` done: Manual ready button, for when GPS disagrees with reality
    `[data-ready]` in `views/game.ts`. The driver taps it from the wrong end and
    reads the refusal — which found a real bug: the snapshot sent after the
    refusal wiped it, so a tap did nothing visible. Fixed by sending the
    snapshot first; asserted in the carry test.

- `7.3` done: Finding your way back
  - `7.3.1` dropped: Persist `game_id` in `localStorage` on both devices so resume
    works with no login at all
    Premise gone: sign-in is mandatory (decisions 0014, 0035), and the game index
    (2.3.4) already lists the game, on every phone of the account. Decision 0038.
  - `7.3.2` done: Reconnect with backoff, and a snapshot resync on reconnect
    `BACKOFF_MS` and the `sync` sent on every `onopen` in `client/net.ts`;
    `test/net.test.ts` covers the drop, the count, the backoff and the resync.
  - `7.3.3` done: Resume from a cold start — app killed, phone rebooted
    Through the index (decision 0038). `check-resume.mjs` closes white's page,
    lets the grace expire, opens a new page at `/`, taps the game on home, and
    the game resumes with no tap on Ready — relay still cut, so by `ready`.
    The DO half is "resumes a game
    suspended by a disconnect once the returning phone is back on its rank".
