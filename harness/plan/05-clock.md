# Phase 4 — Clock: alarms, flag-fall, suspension

The arithmetic is already done and tested in `src/shared/clock.ts`. This phase is
about wiring it to alarms and to the disconnect rules.

- `5` todo: Clock, flag-fall and suspension

- `5.1` todo: Clock in the DO
  - `5.1.1` todo: Persist `ClockState`; recompute on every wake, never in memory
  - `5.1.2` todo: Apply on each accepted place: bank elapsed, add increment, flip
  - `5.1.3` todo: Time controls at creation, defaulting long (decision 0012)

- `5.2` todo: Flag-fall by alarm
  - `5.2.1` todo: Schedule `flag` at the exact expiry instant via the scheduler
  - `5.2.2` todo: Re-schedule on every move; cancel when the clock stops
  - `5.2.3` todo: Insufficient-material-on-timeout is a draw, not a loss
  - `5.2.4` todo: Handle an alarm that fires against a stale or suspended state

- `5.3` todo: Suspension
  - `5.3.1` todo: On disconnect, schedule a 20 s grace timer
  - `5.3.2` todo: On expiry, freeze both clocks and set status `suspended`. A
    dropped connection is a network or GPS failure, not a decision, so it must not
    cost anyone time.
  - `5.3.3` todo: Cancel the grace timer on reconnect inside the window
  - `5.3.4` todo: Player-requested pause, same freeze path
  - `5.3.5` todo: Cancel any carry on suspension (decision 0009)

- `5.4` todo: Clock on the client
  - `5.4.1` todo: Tick locally from the snapshot, corrected by server-time offset,
    so a running clock costs zero messages
  - `5.4.2` todo: Low-time warning that works in a pocket — sound and vibration,
    since the phone will not be in front of your face

- `5.5` todo: Tests for flag-fall, freeze/resume, and alarm-after-hibernation
