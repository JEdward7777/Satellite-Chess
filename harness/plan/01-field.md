# Phase 1 — Field: calibration, board render, first deploy

Walk a field, tap two corners, see 64 squares and your own reach circle. No
network, no chess. **This is where the concept succeeds or fails**, so it gets
validated on real ground before a line of game-server code is written.

- `1` todo: Field calibration and local board render

- `1.1` todo: GPS abstraction (`src/client/gps.ts`)
  - One interface with two implementations, so every later stage can be tested
    without a satellite. The simulator is not a nicety; nothing in this project
    is testable in a container without it.
  - `1.1.1` todo: `watchPosition` wrapper with `enableHighAccuracy`, exposing
    position, accuracy, and a coarse quality verdict
  - `1.1.2` todo: Permission and error states, each with an actionable message
  - `1.1.3` todo: Detect iOS "Precise Location" being off — accuracy pinned in
    the ~1000 m range with permission apparently granted. The generic permission
    prompt does not help someone find that toggle, so name it explicitly.
  - `1.1.4` todo: Simulated provider behind `?sim=1` — drag to walk, accuracy
    slider, optional jitter, and a second simulated player for two-phone flows
  - `1.1.5` todo: Cumulative distance-travelled accumulator with a jitter floor,
    so standing still does not clock up kilometres

- `1.2` todo: Calibration flow (`src/client/views/calibrate.ts`)
  - `1.2.1` todo: Walk to a1, tap; walk to h8, tap; show live accuracy at each
  - `1.2.2` todo: Show derived square size and board size before committing, and
    surface `checkCalibration` errors and warnings
  - `1.2.3` todo: Re-tap either corner without restarting
  - `1.2.4` todo: Name and save the field locally

- `1.3` todo: Board render (`src/client/render.ts`)
  - Canvas, drawn in board space so the field appears as an ordinary chessboard
    however it is rotated on the ground.
  - `1.3.1` todo: 64 squares, files and ranks labelled, own side at the bottom
  - `1.3.2` todo: Player dot, heading-free, with the accuracy ring
  - `1.3.3` todo: Translucent reach circle — the rule and its breathing both need
    to be legible, since it grows and shrinks with GPS quality
  - `1.3.4` todo: Piece glyphs (decision 0011), and a north arrow so a player can
    relate the screen to the ground
  - `1.3.5` todo: Highlight the square under foot, and squares within reach
  - `1.3.6` todo: Legible in sunlight — high contrast, large touch targets

- `1.4` todo: Screen Wake Lock
  - Non-negotiable: the screen locking mid-sprint ends the game. Needs a
    re-acquire on visibility change, because the lock is dropped when the page is
    hidden and does not come back on its own.

- `1.5` todo: App shell and PWA plumbing
  - `1.5.1` todo: Manifest, icons, standalone display
  - `1.5.2` todo: Service worker caching the shell and saved fields — a resumable
    game is worth more than a perfectly fresh asset
  - `1.5.3` todo: Local storage of `player_id` and saved fields, anonymous-first.
    Fields go to IndexedDB the instant calibration is confirmed, with no login and
    no prompt — see decision 0013. Nothing in this project may leave a
    hard-won field living only in memory.

- `1.6` todo: Client build (`scripts/build-client.mjs`)
  - esbuild bundle, dev watch mode, no framework

- `1.9` todo: First deploy
  - Deliberately early. The riskiest assumption in the project is that consumer
    GPS can tell 8 m squares apart on grass; that has to be tested on a phone on
    real ground before anything is built on top of it.
  - `1.9.1` todo: `wrangler login`, confirm the account, first `wrangler deploy`
  - `1.9.2` todo: Verify the PWA installs and the wake lock holds on a real phone
  - `1.9.3` todo: Walk a real field and record what actually happened — square
    size that felt right, accuracy observed, whether the reach circle read as
    fair. Findings go to `harness/observations/open.md` and phase 9.
