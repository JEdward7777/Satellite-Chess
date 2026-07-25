# Phase 0 — Foundation

The pure, platform-independent model, plus proof that the platform actually
behaves the way the design assumes. Everything else sits on this.

- `0` done: Foundation — shared model and verified platform

- `0.1` done: Toolchain
  - `0.1.1` done: package.json, tsconfig, vitest, esbuild, wrangler
  - `0.1.2` done: chess.js v1.4 API confirmed by probe — `move()` throws on
    illegal rather than returning null, which matters for the DO's error path

- `0.2` done: Local ENU projection (`src/shared/geo.ts`)
  - `0.2.1` done: Equirectangular with cos(latitude) correction, anchored per field
  - `0.2.2` done: Verified against an independent haversine implementation —
    ~4 cm of disagreement across a 400 m diagonal. The brief claimed "well under
    a centimetre", which is overstated, but the conclusion holds: the error is
    two orders of magnitude below GPS noise, so no geodesic library.

- `0.3` done: Field model (`src/shared/field.ts`)
  - `0.3.1` done: Two-corner calibration, taps are the centres of a1 and h8
  - `0.3.2` done: Derive square size and bearing from the diagonal; store raw
    corners as the source of truth
  - `0.3.3` done: Board-space coordinates, square centres, square polygons
  - `0.3.4` done: Distance to a square measured to its nearest point, not centre
  - `0.3.5` done: Calibration sanity checks with player-facing messages
  - `0.3.6` done: Field snapshots and versioning, so a game cannot be reshaped

- `0.4` done: Reach model (`src/shared/reach.ts`)
  - `0.4.1` done: Effective reach = base + reported accuracy, clamped
  - `0.4.2` done: Per-player reach handicap
  - `0.4.3` done: Hard accuracy refusal above 25 m, with an actionable message
  - `0.4.4` done: `checkCarry` — lift near origin, place near destination
  - `0.4.5` done: Start-zone test for the handshakes
  - `0.4.6` done: Plausibility check on implied speed

- `0.5` done: Clock arithmetic (`src/shared/clock.ts`)
  - Pure functions over stored timestamps, reconstructible after hibernation.
    Includes an explicit test that a JSON round-trip changes nothing, because
    that round-trip is exactly what the DO does on every wake.

- `0.6` done: Wire protocol (`src/shared/protocol.ts`)
  - Message types, lift/drop/place, and the shared send-rate policy so both ends
    agree on the numbers that keep us inside the request budget.

- `0.7` done: Join codes (`src/shared/joincode.ts`)
  - Crockford base32, lookalike folding on input.

- `0.8` done: Platform verification against `wrangler dev`
  - Recorded in `harness/reference/platform-verified.md`. SQLite DO storage,
    `ctx.acceptWebSocket`, `setWebSocketAutoResponse`, deterministic
    `getByName`, alarms and the assets binding all confirmed working.

- `0.9` done: The harness itself
  - `0.9.1` done: AGENTS.md working agreement, CLAUDE.md and root AGENTS.md pointers
  - `0.9.2` done: Plan tree, decisions, observations, sessions, reference
  - `0.9.3` done: `scripts/plan.mjs` status rollup and integrity checker
  - `0.9.4` done: SessionStart hook
