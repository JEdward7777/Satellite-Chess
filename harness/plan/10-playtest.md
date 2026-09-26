# Phase 10 — Playtest: an actual game with an actual human

This phase exists because the failures that matter cannot be predicted from a
container, and they deserve tracked stages rather than a note at the bottom of a
file. Expect most of it to be written after the first real game.

- `10` todo: Playtest and iterate

- `10.1` todo: First full game outdoors, two phones, two people
  - `10.1.1` todo: Choose a field and a time control that give a game rather than
    a running race
  - `10.1.2` todo: Play to a finish; note every moment either player was confused,
    annoyed, or arguing with the phone
- `10.2` todo: Write up what broke, as observations
- `10.3` todo: Promote the ones worth fixing into stages, and record any rule
  changes as decisions
- `10.4` todo: Open questions only a real game can settle
  - `10.4.1` todo: Does carrying a piece across the field feel like the point of
    the game, or like an errand?
  - `10.4.2` todo: Is capturing correctly expensive, or merely annoying?
  - `10.4.3` dropped: Does the reach circle read as fair when it breathes with GPS
    quality, or does it feel arbitrary?
    - Moot since `10.5`: the circle no longer breathes (decision 0043). The
      question that replaces it is `10.5.4`.
  - `10.4.4` todo: Is the back-rank resume rule as easy to accept in practice as
    it is on paper?
  - `10.4.5` todo: What square size actually plays best?

- `10.5` active: Poor signal stops buying reach (O-33, decision 0043)
  - The owner's ruling after the 2026-09-20 games: a phone in a pocket earned a
    longer reach than the opponent had. Reported accuracy no longer enters
    reach at all; a fix worse than `maxAccuracyM` still refuses the move.
  - `10.5.1` done: Delete the accuracy term from `effectiveReachM`, and the
    accuracy argument from it and from `inStartZone`, so the server's lift,
    place and back-rank checks, the client's circle, the handshake's "walk N m"
    and the board view all get the same accuracy-free circle. Unit and DO tests
    that a ±14 m and a ±20 m fix reach no further than a ±1 m one.
  - `10.5.2` done: Say so when the dot may be what is wrong. An out-of-reach
    refusal on a fix worse than `goodAccuracyM` tells the player their
    position is vague, rather than only "walk closer".
  - `10.5.3` done: Bring the rest into line: `scripts/analyse-survey.mjs`
    modelled the rule from before 0031 and now models this one, with accuracy
    refusals counted apart; `README.md` and `reference/gotchas.md`.
  - `10.5.4` todo: Outdoors, on real phones: is anybody standing on a square
    refused because the dot is off? Decision 0043's revisit condition. Needs a
    real game, and ideally a second handset (see O-12 and `1.9.3.6`).

- `10.6` active: The host's clock "rounding up to whole minutes" (O-31, decision 0044)
  - Reported after the 2026-09-20 games. Reproduced in `wrangler dev`: during
    a predicted place, the mover's clock jumped *up* to the balance their turn
    began with, until the server answered — on a first move, exactly the time
    control. The server's arithmetic was never wrong.
  - `10.6.1` done: A predicted place banks the mover's think at the tap, on the
    server's clock (`client/optimistic.ts`, via `freeze` and
    `estimateServerNow`), instead of only nulling `startedAt`. Unit tests, and
    `check-clock.mjs` step 5 holds the server's answer for two seconds and
    asserts the clock never rises until the increment lands.
  - `10.6.2` done: The formatter always rounds down, tenths included
    (decision 0044): the screen never shows more time than the player has.
  - `10.6.3` done: A debug readout, off by default and switched by tapping a
    clock, showing the server's raw clock numbers, the timebase and the offset
    beside the displayed clock (`client/clock-debug.ts`). Reads only what
    snapshots already carry; sends nothing.
  - `10.6.4` todo: Outdoors, on real phones, with the readout on: does the
    host's clock still appear to round? Needs a real game.

- `10.7` active: Pieces anyone can read outdoors, and the last move (O-30, decision 0045)
  - The owner's 2026-09-20 games: players could not tell whose piece was
    whose, and a bishop nearly vanished on its matching square.
  - `10.7.1` done: The standard two-sided set (cburnett, BSD, `client/pieces.ts`)
    on mid-tone squares, on the board, the carry readout and the promotion
    picker. `NOTICE` and the account screen carry the license.
  - `10.7.2` done: The owner's alternative, a team-color disc with a gray ring
    under each piece, behind a per-phone switch on the account screen, the
    game screen's readout and the simulator panel (`client/piece-look.ts`, `localStorage` in try/catch).
  - `10.7.3` done: The last completed move tinted on both squares, from the
    snapshot's `lastMove`, moved at the tap by a predicted place. No new
    traffic. Coordinates and destination dots now draw over the pieces;
    coordinates are sized from the narrow way across a cell, sit in its
    corners, and carry a thin outline, so a 5:1 field keeps them off the
    pieces. The north arrow draws under the pieces.
  - `10.7.4` todo: Outdoors, in daylight, on real phones: compare the two
    looks, keep one, and change the default (or drop the switch) to match.
    Also check that the last-move tint is visible in sun. Needs a real game.

- `10.8` active: Pinch zoom on the board (decision 0046)
  - The owner asked for "a pinch zoom option". On a 5:1 field a piece is
    about 7 px tall.
  - `10.8.1` done: Pinch to zoom about the pinch, one finger to pan while
    zoomed, 1x to 6x, the board kept on the canvas, and a "Whole board"
    button while zoomed (no double-tap). Screen-space zoom over the fitted
    projection (`client/board-zoom.ts`, `views/board-gestures.ts`), on the
    game screen and the practice board. In memory only; nothing is sent.
  - `10.8.2` done: A drag is never a tap: one finger, never more than 10 px
    from where it landed, or the touch is spent. A lift never seen going down
    is never a tap, and anything that moves the view under a finger (reset,
    "Follow me", a re-fit, the board turning round) spends it. Taps map
    through the zoomed projection. Unit tests, and `scripts/check-zoom.mjs` drives it with real
    two-finger touch input.
  - `10.8.3` done: A zoomed view follows your dot, re-centring when you reach
    the outer 20% of the canvas. A one-finger pan (or a pinch that loses you)
    stops following; "Follow me" and "Whole board" restart it.
  - `10.8.4` todo: On real phones, outdoors and walking: are taps ever
    dropped by the 10 px slop, is a pan ever read as a tap, does the follow
    feel right, and do the buttons get in the way? Needs a real game.

- `10.9` done: Small fixes from the observation list
  - A batch the operator approved from `observations/open.md`, one sub-stage
    each.
  - `10.9.1` done: The board opens at the top of the page (O-48). `swap`
    scrolls to the top for a new screen; home redrawing itself after a sync
    keeps its scroll. `check-zoom` checks it and no longer works around it.
  - `10.9.2` done: Zoomed in, file letters and rank numbers move to the
    nearest cells in view along the bottom and left (O-46), in the same
    corner of the cell and at the same size, so they cover no more of a
    piece than at 1x. Unchanged at 1x.
  - `10.9.3` done: The flaky snapshot-relay test waits for the relay to be
    stored (O-45).
  - `10.9.4` done: An expired dev account says "It has ended" (O-29).
  - `10.9.5` done: A deferred automatic `ready` goes on the 1 s ticker, not
    the next GPS fix (O-25). The latch is unchanged (O-26).
  - `10.9.6` done: The relay's rate limit is measured from the last relay,
    not the last lift, place or ready (O-39, decision 0047, schema 6).
  - `10.9.7` done: What the sprint cap clips is owed and paid under later
    windows, up to 30 m, and never across a pause or after the result (O-36,
    decision 0047).

- `10.10` active: The carried piece travels with the dot (O-44, decision 0048)
  - The owner: "it would be nice if you could see the person walking their
    piece". Drawn from the snapshot's `carry` and the relayed dot; no message
    changed.
  - `10.10.1` done: My own carry, the optimistic lift included, is drawn
    beside my dot on a cream plate, and faint on its origin. Both looks,
    screen-sized under the zoom, flipped to stay on the canvas. A tap on
    either plate is ignored, and on my own it points at "Put it back".
  - `10.10.2` done: The opponent's carry is drawn beside their dot, ringed in
    their red, only while they are connected. A hollow dot or no dot leaves
    it faint on its origin. A drop, a place, a capture and a suspend all end
    it, because they clear `carry`. `scripts/check-carry.mjs` drives both
    seats.
  - `10.10.3` todo: On real phones outdoors: can both players read the piece
    in hand at arm's length in sun, does the plate hide a square the carrier
    needs, and does it read as a carry rather than a third dot?
