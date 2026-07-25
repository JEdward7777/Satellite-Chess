# Phase 2 — Transport: GameDO, hibernating WebSockets, presence

Two clients connect to one authoritative object and see each other move around
the field. No chess yet — proving the plumbing in isolation.

- `3` active: GameDO and the WebSocket transport

- `3.0` done: Test harness for Durable Objects
  - Numbered `3.0` and done first, out of order, for the same reason phase 1 built
    `1.6` before its views: writing a hibernating, SQLite-backed, alarm-driven
    object with no way to run it is the expensive order. `3.7` remains the stage
    for the substantial integration tests.
  - `3.0.1` done: Two vitest projects — `model` in node for pure logic, `worker`
    in the real `workerd` runtime via `@cloudflare/vitest-pool-workers`. The
    runtime behaviours this phase depends on (hibernation, SQLite, alarms) are
    exactly the ones a mock would get wrong.
  - `3.0.2` done: `Env` generated from `wrangler.jsonc` by
    `wrangler types --include-runtime=false` into `src/worker/worker-env.d.ts`,
    548 bytes rather than the 550 KB the default emits. `npm run check` runs
    `--check` first, so a binding added to `wrangler.jsonc` without regenerating
    fails the build instead of drifting. Scoped to the worker and tools tsconfig
    projects, never the client — the full runtime types are what caused O-05.
  - `3.0.3` done: Smoke tests proving the wiring: health, the `/api` namespace
    returning honest 501s rather than the shell, both DO namespaces present,
    `idFromName` deterministic (decision 0007), and both stubs constructible

- `3.1` done: GameDO skeleton (`src/worker/game-do.ts`)
  - `3.1.1` done: SQLite schema — `game`, `moves`, `presence`, `timers`
  - `3.1.2` done: Schema creation guarded so it is idempotent across wakes
  - `3.1.3` done: `getByName(joinCode)` addressing, no lookup table (decision 0007)
  - `3.1.4` done: Create, join, and reject a third player

- `3.2` done: Hibernatable WebSockets
  - `3.2.1` done: `ctx.acceptWebSocket` with per-socket `serializeAttachment`
    carrying player id and colour, since nothing survives in memory
  - `3.2.2` done: `setWebSocketAutoResponse` for ping/pong — keepalive that costs
    no request and does not wake the object
  - `3.2.3` done: `webSocketMessage` dispatch with strict message validation
  - `3.2.4` done: `webSocketClose`/`webSocketError` marking presence
  - `3.2.5` done: Broadcast a full snapshot on change. Outbound messages are not
    billed, so a delta protocol would be complexity for nothing.

- `3.3` done: The multiplexed alarm scheduler
  - A Durable Object has exactly one alarm, but we need three deadlines
    (flag-fall, disconnect grace, garbage collection). All feature code schedules
    through a `timers` table and the alarm is always set to the earliest due row.
  - `3.3.1` done: `schedule(kind, dueAt)` / `cancel(kind)` / `syncAlarm()`
  - `3.3.2` done: `alarm()` runs every due row, then reschedules
  - `3.3.3` done: Tests for overlapping and re-scheduled timers

- `3.4` active: Coarse position relay
  - `3.4.1` todo: Client sends only on >2 m movement, at most every 2.5 s
  - `3.4.2` done: Server-side rate limit as a backstop against a bad client
  - `3.4.3` todo: Relay to the opponent; interpolate on receipt
  - `3.4.4` done: Persist last known position in `presence` for reconnect

- `3.5` active: HTTP routes (`src/worker/index.ts`)
  - `3.5.1` done: `POST /api/game` create, `GET /api/game/:code` peek,
    `GET /api/game/:code/ws` upgrade
  - `3.5.2` todo: Player identity. The route takes a `playerId` and trusts it,
    which is fine while nothing is deployed publicly and is exactly what stage
    2.5 closes. Decision 0014 makes this the authenticated Google `sub`; the
    original "anonymous, no login" wording is superseded.
  - `3.5.3` done: Static assets for everything else, SPA fallback

- `3.6` active: Garbage collection
  - `3.6.1` done: Unclaimed join codes expire after ~30 min
  - `3.6.2` todo: Finished and abandoned games deleted on an alarm. A DO with
    entirely empty storage ceases to exist, which is the goal.

- `3.7` active: DO integration tests with `@cloudflare/vitest-pool-workers`
  - 64 tests against the real runtime across `test/worker/game-do.test.ts` and
    `test/worker/carry.test.ts`: create/join, hibernation, alarms, the start
    handshake, the whole carry, flag-fall and checkmate. What is still missing is
    the end-to-end shape — a full game played move by move (`4.5.1`) and the
    special moves (`4.5.2`).
