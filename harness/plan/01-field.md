# Phase 1 — Field: calibration, board render, first deploy

Walk a field, tap two corners, see 64 squares and your own reach circle. No
network, no chess. **This is where the concept succeeds or fails**, so it gets
validated on real ground before a line of game-server code is written.

- `1` active: Field calibration and local board render

- `1.1` done: GPS abstraction (`src/client/gps.ts`)
  - One interface with two implementations, so every later stage can be tested
    without a satellite. The simulator is not a nicety; nothing in this project
    is testable in a container without it.
  - `1.1.1` done: `watchPosition` wrapper with `enableHighAccuracy`, exposing
    position, accuracy, and a coarse quality verdict
  - `1.1.2` done: Permission and error states, each with an actionable message
  - `1.1.3` done: Detect iOS "Precise Location" being off — accuracy pinned in
    the ~1000 m range with permission apparently granted. The generic permission
    prompt does not help someone find that toggle, so name it explicitly.
  - `1.1.4` done: Simulated provider behind `?sim=1` — drag to walk, accuracy
    slider, optional jitter, and a second simulated player for two-phone flows
    - Split into the provider and the on-screen half, because the provider had
      to exist before there was a board to drag on or a shell to read `?sim=1`.
    - `1.1.4.1` done: Simulated provider — walk at a pace, teleport, accuracy,
      jitter, seeded so a wobble repeats
    - `1.1.4.2` done: Two players on one explicit clock, for two-phone flows
    - `1.1.4.3` done: On-screen controls — drag to walk, accuracy and jitter
      sliders, an arrow pad for a plausible walk, and a switch between the two
      players (`src/client/views/sim-panel.ts`)
  - `1.1.5` done: Cumulative distance-travelled accumulator with a jitter floor,
    so standing still does not clock up kilometres

- `1.2` done: Calibration flow (`src/client/views/calibrate.ts`)
  - The model is pure and tested in node; the view is DOM and is driven through a
    real browser against `?sim=1`. Worth keeping that split for later views — the
    whole input to this flow is a satellite, so nothing else is testable.
  - `1.2.1` done: Walk to a1, tap; walk to h8, tap; show live accuracy at each
  - `1.2.2` done: Show derived square size and board size before committing, and
    surface `checkCalibration` errors and warnings
  - `1.2.3` done: Re-tap either corner without restarting
  - `1.2.4` done: Name and save the field locally
  - `1.2.5` done: Refuse a corner tap on a fix the move validator would refuse,
    rather than warning about it after the board is built

- `1.3` done: Board render (`src/client/render.ts`)
  - Canvas, drawn in board space so the field appears as an ordinary chessboard
    however it is rotated on the ground.
  - `1.3.1` done: 64 squares, files and ranks labelled, own side at the bottom
  - `1.3.2` done: Player dot, heading-free, with the accuracy ring
  - `1.3.3` done: Translucent reach circle — the rule and its breathing both need
    to be legible, since it grows and shrinks with GPS quality
  - `1.3.4` done: Piece glyphs (decision 0011), and a north arrow so a player can
    relate the screen to the ground
  - `1.3.5` done: Highlight the square under foot, and squares within reach
  - `1.3.6` done: Legible in sunlight — high contrast, large touch targets
    - Judged from screenshots at phone size, which is as far as a container can
      take it. Whether it survives actual sunlight is a question for `1.9.3`.

- `1.4` done: Screen Wake Lock (`src/client/wakelock.ts`)
  - Non-negotiable: the screen locking mid-sprint ends the game. Needs a
    re-acquire on visibility change, because the lock is dropped when the page is
    hidden and does not come back on its own.
  - Held for exactly as long as the board view is mounted. Whether it actually
    holds on a real phone is `1.9.2`.

- `1.5` done: App shell and PWA plumbing
  - `1.5.1` done: Manifest, icons, standalone display
    - Icons are drawn procedurally by `scripts/make-icons.mjs`, which encodes PNG
      with `node:zlib` and no dependency at all. iOS will not take an SVG for
      `apple-touch-icon`, so a vector alone was not enough.
  - `1.5.2` done: Service worker caching the shell and saved fields — a resumable
    game is worth more than a perfectly fresh asset
    - Stale-while-revalidate, so a deploy costs one launch of staleness rather
      than a network round trip before the board appears. Verified by cutting the
      network in a browser and reloading.
  - `1.5.3` done: Local storage of `player_id` and saved fields, anonymous-first.
    Fields go to IndexedDB the instant calibration is confirmed, with no login and
    no prompt — see decision 0013. Nothing in this project may leave a
    hard-won field living only in memory.
    - `src/client/store.ts`. Falls back to `localStorage` rather than to memory
      when IndexedDB is refused, since a private-mode browser is exactly where
      losing the field would hurt most. Persistence across a reload is verified
      in a browser, not asserted.

- `1.6` done: Client build (`scripts/build-client.mjs`)
  - esbuild bundle, dev watch mode, no framework
  - Built out of numeric order, before `1.2` and `1.3`. Writing two view modules
    with no way to run them, then discovering at `1.6` that the pipeline is
    wrong, is the expensive order. With `--serve` plus `?sim=1` a view can be
    driven in a real browser in the container, which is how the rest of phase 1
    gets verified.
  - `1.6.1` done: esbuild bundle to `public/app.js`, `--watch` for rebuilds
  - `1.6.2` done: `--serve` static server on :8788, because `wrangler dev` needs
    a worker that does not exist until phase 3
  - `1.6.3` done: `src/client/main.ts` — provider selection, and a GPS readout
    that the calibration flow replaces

- `1.9` todo: First deploy
  - Deliberately early. The riskiest assumption in the project is that consumer
    GPS can tell 8 m squares apart on grass; that has to be tested on a phone on
    real ground before anything is built on top of it.
  - `1.9.1` todo: `wrangler login`, confirm the account, first `wrangler deploy`
  - `1.9.2` todo: Verify the PWA installs and the wake lock holds on a real phone
  - `1.9.3` todo: Walk a real field and record what actually happened — square
    size that felt right, accuracy observed, whether the reach circle read as
    fair. Findings go to `harness/observations/open.md` and phase 9.
