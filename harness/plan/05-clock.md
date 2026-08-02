# Phase 4 — Clock: alarms, flag-fall, suspension

The arithmetic is already done and tested in `src/shared/clock.ts`. This phase is
about wiring it to alarms and to the disconnect rules.

**Most of this phase was built during phase 4 and never marked, which cost a
session.** A move cannot be applied without banking time, handing over and
re-arming the flag, so `5.1` and `5.2` went in alongside the carry and `5.3` went
in alongside decision 0009's put-the-piece-back rule. Nobody updated the statuses,
so `STATE.md` spent five sessions recommending "phase 5, the DO half is not
written" at a DO half that was written, tested and playing whole games. Audited
against the code and the suite on 2026-08-02; the evidence is named per stage
below.

- `5` active: Clock, flag-fall and suspension

- `5.1` done: Clock in the DO
  - `5.1.1` done: Persist `ClockState`; recompute on every wake, never in memory
    The four columns are in `schema.ts` (`white_ms_remaining`, `black_ms_remaining`,
    `increment_ms`, `last_clock_start_at`) and `GameDO.clockOf` rebuilds the state
    from them on every read. Nothing is cached across a request.
  - `5.1.2` done: Apply on each accepted place: bank elapsed, add increment, flip
    `GameDO.onPlace` calls `applyMove` and writes the result. Covered by "charges
    the mover and hands the clock over with an increment" in `test/worker/carry.test.ts`,
    and visible end to end in `scripts/check-clock.mjs` step 4 — after white's move
    their clock reads 30:16, being 30:00 less the walk plus the 20 s increment.
  - `5.1.3` done: Time controls at creation, defaulting long (decision 0012)
    `TIME_CONTROLS` in `shared/clock.ts`, offered by `client/views/create.ts`,
    carried in `createGameBody` and applied by `GameDO.create` via `newClock`.

- `5.2` done: Flag-fall by alarm
  - `5.2.1` done: Schedule `flag` at the exact expiry instant via the scheduler
    `GameDO.armFlag` → `flagFallAt` → `Timers.schedule('flag', …)`. Never
    `setAlarm` directly, per decision 0006.
  - `5.2.2` done: Re-schedule on every move; cancel when the clock stops
    Re-armed at the end of `onPlace`; cancelled in `finish` and in
    `suspendForDisconnect`. Both directions are tested.
  - `5.2.3` done: Insufficient-material-on-timeout is a draw, not a loss
    `hasMatingMaterial` in `game-do.ts`, deliberately the simple test rather than
    an exhaustive one.
  - `5.2.4` done: Handle an alarm that fires against a stale or suspended state
    `onFlagFall` returns on a non-active game and re-arms rather than ending one
    that still has time. Covered by "does not end a game that still has time on
    the clock".

- `5.3` active: Suspension
  - `5.3.1` done: On disconnect, schedule a 20 s grace timer
  - `5.3.2` done: On expiry, freeze both clocks and set status `suspended`. A
    dropped connection is a network or GPS failure, not a decision, so it must not
    cost anyone time.
  - `5.3.3` done: Cancel the grace timer on reconnect inside the window
    `openWebSocket` cancels `disconnect` once `allConnected()`.
  - `5.3.4` todo: Player-requested pause, same freeze path
    **The one part of `5.3` that genuinely does not exist.** `handle` answers
    `pause` with an explicit "not implemented yet" rather than silence, which is
    the right shape but is not the feature. Worth settling alongside O-04 (nothing
    decides what happens to a game whose opponent never returns), since a
    deliberate pause and an abandonment resolve to the same frozen state and want
    one rule between them.
  - `5.3.5` done: Cancel any carry on suspension (decision 0009)

- `5.4` done: Clock on the client
  - `5.4.1` done: Tick locally from the snapshot, corrected by server-time offset,
    so a running clock costs zero messages
    `src/client/clock.ts`. The correction is the whole point: `game.serverNow` is
    on the server's clock and the phone's has never been synchronised with it, so
    elapsed time is measured locally and added, and nothing is ever compared
    against `Date.now()` directly. Drawn by `paintClock` in `views/game.ts` on its
    own 100 ms timer, because under ten seconds the display counts in tenths and a
    once-a-second repaint renders that as a slideshow.
  - `5.4.2` done: Low-time warning that works in a pocket — sound and vibration,
    since the phone will not be in front of your face
    Thresholds at 60 s and 15 s, both longer than a chess clock's usual panic
    because the remedy here involves *walking*. Fires on worsening only, and
    re-arms when the increment hands time back.

- `5.5` active: Tests for flag-fall, freeze/resume, and alarm-after-hibernation
  Flag-fall, the freeze, and an alarm fired against stored state are all covered in
  `test/worker/carry.test.ts`; the carry surviving hibernation has its own
  describe block. **Resume from `suspended` back to `active` is the gap** — the
  positional handshake is tested from `staging` only, and `startIfBothReady`
  treats the two identically, so the untested half is the one nobody has run.
  Waiting on `5.3.4` so pause and resume can be tested through one path.
