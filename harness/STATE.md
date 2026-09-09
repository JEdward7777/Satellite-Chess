# Where the project is

*Rewritten every session. Short by design — the plan holds the detail, the session
files hold the history, and `reference/` holds everything that is simply true.*

**Tree state**: clean, pushed to `main`.
**Active stage**: none. **Phase 2 is most of the way through**: `2.5.2` (the dev
identity seam), `2.3.1`/`2.3.2` (the UserDO), `2.3.3.2` (fields on the account)
and now `2.3.4` (the game index) landed in four consecutive sessions.
**Next action**: `2.3.5` — the permanent record, over both of the UserDO's
tables. Metres walked is the headline, not games played (decision 0019).
**Live**: `1.9.1` done 2026-09-06 — first deploy from the operator's local clone,
at `https://satellite-chess.hootowl7777-cloud.workers.dev`.
**Last session**: `harness/sessions/2026-09-08-01.md` (the game index).
**Careful**: three browser drivers are written but **have never been run** —
`check-invite.mjs`, `check-fields.mjs`, and the other `check-*.mjs` scripts were
not audited for reach-sensitive positions. Playwright is not installed in the
container. Run them on a machine that can.

## Where the detail lives

- **`reference/gotchas.md`** — what will bite you when you touch the code. The
  affine board's two coordinate types, the clock that must never be compared
  against `Date.now()`, the privacy edges that are one careless index away from
  being undone. **Read it before changing anything you have not changed before.**
- **`reference/container.md`** — installing Node, why `wrangler deploy` cannot
  work from here, the git-credential and signing situation.
- `reference/platform-verified.md`, `budget.md`, `geometry.md` — durable facts.
- `harness/AGENTS.md` — the rules. `npm run plan` — the stage tree.

## In one paragraph

Phases 0 and 1 are done bar `1.9.2` (PWA install on a phone) and `1.9.3.6` (what
to become of the survey trace — keeping it is recommended). Phase 3 is complete
bar `3.6.2` and the standing `3.7`, **phase 4 is finished server and client**,
**phase 5 is closed**, and **phase 6 is closed**: lift, carry, place, resign, draw, terminal detection,
clock handover, the promotion picker, optimistic local application, both clocks
on screen, pause and the thirty-day claim, invites by QR and share sheet, joining
by code or link, and fields that travel in a URL. A whole game has been played
through it in two browsers against a real `wrangler dev` — nine moves to an
underpromotion. **706 tests pass.**

**Phase 2 has an account with both of its tables in use.** `UserDO` is addressed
by `getByName(sub)`; `GET /api/me` brings an account into existence on first
contact; saved fields sync through `POST /api/fields/sync` with the phone still
the primary store (decisions 0013 and 0032); and **the game index is now
populated** (decision 0033) — written by `GameDO` over the `USER` binding at
every state change, and by no client anywhere. `GET /api/games` lists it without
waking a single game.

**A seat now belongs to an account rather than to a phone** (`3.5.2`). That was
the load-bearing half of `2.3.4`: matching a player by the UUID in one browser's
`localStorage` would have made the index a list you can read and cannot enter,
because the second phone is a third player. The `playerId` in a request body is
honoured only when there is no session — which is still a real case until `2.5.1`
requires sign-in.

**Reach is the independent variable, measured in fractional squares** (decision
0031, reversing half of 0023). The field is fixed by the venue and the square is
`length / 8`, so reach is the only end that can move — and it is a create-screen
dial. The field walk found the game was *already* degenerate and fixed it,
closing **O-02**.

**The board is not forced to be square** (decision 0028): calibration walks the
perimeter — a1, h1, h8, a8 — and fits a least-squares affine map. Every field,
game and link made before it still reads as the square board it was calibrated
as.

## The field survey is walked — the news is good

The riskiest assumption in the project — that consumer GPS can resolve 8 m
squares on grass — has real data against it. The operator walked the ten-step
protocol on 2026-09-06: Android Chrome, 2008 fixes over 29 minutes.

- Static scatter while standing still: **0.2 m median**, 0.6 m worst — against a
  4 m half-square. The square does not flicker.
- Claimed accuracy (±3.7 m) was ~16x pessimistic but **100% honest** — every fix
  landed inside its own circle, so the reach rule is sound.
- **8 m squares refuse 0% of moves** and mis-highlight 0%, down to 6 m squares.
- Phantom distance while stationary: 0.1 km/h, far below the simulator's
  predicted 19–32.
- The one finding not acted on is **O-12**: the distance floor scales by claimed
  accuracy rather than by observed scatter. Relaxing the anti-drift constants was
  tried and reverted — `test/gps.test.ts` immediately produced 1525 m of phantom
  distance per hour. Distance is the currency of the game (decision 0019), so
  over-counting is much worse than losing 9% of a walk.

Full numbers in `harness/sessions/2026-09-06-03.md` and decision 0031. The live
trace `2026-09-06T23-10-47-510Z-ioop0u` is deliberately **kept** (`1.9.3.6`).
`SURVEY_SECRET` is `field-walk-2026-a7k3m9qx`.

## What to do next, concretely

**Build phase 2 bottom-up and leave the live Google round-trip until last.** Not
operator-blocked any more — the console work is done — but still the riskiest to
verify in a container.

1. **`2.3.5` — the permanent record.** ← **start here.** Over both tables, and
   the game index now has honest results in it to build on, which is decision
   0033's whole point. Metres walked leads, games played never does (decision
   0019); board crossings — distance ÷ board diagonal — sit beside it as the
   field-independent measure. `2.3.5.2` excludes sub-4 m squares as practice;
   `2.3.5.1` is the privacy statement, which is not a footnote (decision 0017).
   The distance itself is still only in `presence.travel_m` inside each GameDO —
   nothing carries it to the account yet, and that is the first thing to build.
2. **`2.5.1` — the sign-in gate.** Worth noting that both account features are
   inert until this and `2.1` exist: nothing in the client establishes a session
   except the dev seam, so `/api/fields/sync` and `/api/games` 401 in an ordinary
   browser and the phone quietly stays local-only. Designed behaviour, but it
   means neither feature is exercised by real users until phase 2 finishes.
3. **`2.1`, `2.2`** — the real OAuth exchange and sessions. Last, because this is
   the part that cannot be finished in a container. `src/worker/auth.ts` does not
   exist; the OAuth client, both credentials and the redirect paths (decision
   0030) do. Two checks the code session must not assume: that the registered
   redirect URIs match whatever `auth.ts` uses, and that every player's Google
   address is on the Testing-status consent screen's test-user list. See
   `harness/sessions/2026-09-06-01.md`.
4. **`2.4`** — KV namespace creation. Needs `wrangler` against the Cloudflare
   API, so it is the operator's from the local clone.

Loose ends that are not stages:

- **Run the browser drivers on a machine with playwright.** `check-fields.mjs`
  and `check-invite.mjs` have never been run. **Nothing drives the game list on
  the home screen either** — see O-14.
- **`1.9.2`** — PWA install and wake lock, on the next convenient phone.
