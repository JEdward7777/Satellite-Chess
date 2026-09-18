# 0038 — A cold start finds its game through the game index, not `localStorage`

- **Date:** 2026-09-17
- **Status:** accepted
- **Stage:** 7.3.1 (dropped), 7.3.3

## Decision

No `game_id` is persisted on the phone. A phone that was killed or rebooted
mid-game opens on home, where "Your games" lists the game first (live games sort
above finished ones, `byMostWanted`), and one tap re-takes the seat through the
same idempotent join a code or a link uses. Stage `7.3.1` is dropped. The app does
not jump straight into a game on launch.

## Why

`7.3.1` was written for anonymous play: "so resume works with no login at all".
Sign-in has since become mandatory (decisions 0014, 0035), so its premise is gone,
and the game index (2.3.4, decision 0033) already answers "what was I playing?" —
from any phone on the account, which `localStorage` never could. A second, local
copy of the same pointer would be a thing to keep in step with the index and
nothing to gain from it.

The one case the index cannot serve is a cold start with no signal. That case
cannot resume either way: entering a game is a request and play is a socket.

Not auto-entering: a player with a suspended game from last week who opens the app
to calibrate a field should reach home, not a board.

`scripts/check-resume.mjs` walks this: the page is closed, a new one opens at `/`,
the game is found on home, tapped, and resumes when the phone is on its back rank.

## Rejected

- **`localStorage` as the handle** — per-device, and redundant with the index.
- **Auto-resume the most recent live game on launch** — takes the home screen away
  from someone who came for something else.

## Revisit if

Signed-out play ever returns, or the phone test (1.9.2) shows that a relaunch
after an OS kill regularly lands without a session and the index cannot be read.
