# Where the project is

*Rewritten every session. Short by design — the plan holds the detail, the session
files hold the history, and `reference/` holds everything that is simply true.*

**Tree state**: clean, pushed to `main`.
**Active stage**: none. **The sign-in gate is built.** `2.5.1` landed 2026-09-16
on top of the same day's `2.1`/`2.2.1`/`2.2.2`/`2.4`, so sign-in is now mandatory
in fact and not only in decision 0014.
**Next action**: `2.5.3` — honest failure messages — or `2.3.5`, the permanent
record. See "What to do next" below; the gate made both reachable.
**Live**: `https://satellite-chess.hootowl7777-cloud.workers.dev`, **with the gate
on it** — deployed 2026-09-16, version `1fea90ff`, after all eleven drivers
passed. Sign-in is now mandatory in fact, on the real origin, and the O-15 window
that was open there all day is shut.
**Last session**: `harness/sessions/2026-09-16-02.md`.
**763 tests pass** (737 before this session). Typecheck and `plan:check` clean.
**All eleven browser drivers pass at `cfc9f87`**, run by a peer session with a
browser — including the gate's own two new sections, and the rendered gate was
inspected in a screenshot rather than trusted from assertions. **Run them from an
empty `.wrangler` or they lie to you** (O-19).

## The gate, in one paragraph

An unauthenticated launch reaches a sign-in screen and nothing else. The server
half is what makes it real: creating a game, joining one, and opening the socket
all 401 without a session, and **`playerId` is gone** — from the request body,
from the WebSocket URL, and from `localStorage`. That is what closed **O-15**: a
seat is a Google `sub` or it does not exist, so a player cannot be mistaken for
two people and handed both seats. A completed sign-in returns to wherever it
started, carried in the signed flow cookie, so a QR scanned in a park survives
the trip to Google. All three rules, and the reasoning that will look wrong later,
are **decision 0035**.

**The rule most likely to be broken by a well-meaning simplification**: the launch
check has *three* states, not two. Only a real 401 closes the gate; an unreachable
server opens the app. Collapsing that to a boolean is invisible on a developer's
machine and shows a sign-in screen to a player standing in a field.

## Where the detail lives

- **`reference/gotchas.md`** — what will bite you when you touch the code. Read it
  before changing anything you have not changed before.
- **`reference/container.md`** — **check which machine you are on first.** The
  "wrangler cannot reach Cloudflare" rule is about the ephemeral container only;
  on the operator's WSL machine deploys, secrets and KV all work.
- `reference/platform-verified.md`, `budget.md`, `geometry.md` — durable facts.
- `harness/AGENTS.md` — the rules. `npm run plan` — the stage tree.

## In one paragraph

Phases 0 and 1 are done bar `1.9.2` (PWA install on a phone) and `1.9.3.6`. Phase
3 is complete bar `3.6.2` and the standing `3.7`; **phases 4, 5 and 6 are
closed**. **Phase 2 now has identity end to end**: Google OAuth, opaque sessions
in KV with throttled sliding renewal, the UserDO, field sync, the game index —
and, as of this session, the gate in front of all of it. A real Google sign-in was
completed from a phone on 2026-09-16, against the deployed origin.

**Reach is the independent variable, measured in fractional squares** (decision
0031). **The board is not forced to be square** (decision 0028). Every field, game
and link made before either still reads as it was calibrated.

## The field survey is walked — the news is good

The riskiest assumption in the project — that consumer GPS can resolve 8 m squares
on grass — has real data against it. The operator walked the ten-step protocol on
2026-09-06: Android Chrome, 2008 fixes over 29 minutes. Static scatter while
standing still was **0.2 m median** against a 4 m half-square, claimed accuracy
was ~16x pessimistic but **100% honest**, and **8 m squares refuse 0% of moves**.
The one finding not acted on is **O-12**. Full numbers in
`harness/sessions/2026-09-06-03.md` and decision 0031. The live trace
`2026-09-06T23-10-47-510Z-ioop0u` is deliberately **kept** (`1.9.3.6`).
`SURVEY_SECRET` is `field-walk-2026-a7k3m9qx`.

## What to do next, concretely

1. **Sign in on a phone, through the deployed gate.** ← **start here.** The gate
   is live (version `1fea90ff`) and verified server-side from here: `/` serves,
   `/api/me` 401s with `devSeam:false`, `/auth/google/login` 302s to Google with
   every parameter right, and `POST /api/dev/session` **404s**, so the seam truly
   does not exist in production. What no request from this machine can prove is a
   human completing a Google consent screen and landing back *through the gate*
   (decision 0034).
   That first launch is also the first honest chance to see **O-17** as a player
   would: sign in successfully, arrive back signed out, because the session was
   written to KV and read a second later from a different colo. It did not bite on
   2026-09-16 — one data point, not a clearance. If it appears, the cheapest fix
   is in the observation.
2. **The drivers are green and need nothing** — all eleven pass at `cfc9f87`,
   run twice by a peer session with a browser. Two things to carry forward rather
   than rediscover:
   - **Wipe `.wrangler` before any run** (O-19). A second run against unchanged
     source gives three deterministic failures in drivers nobody touched, which
     reads exactly like a regression and is not one.
   - **The gate's only browser coverage is section 1 of `check-fields` and
     `check-games`.** Every other driver signs in through `context.request`
     before its first navigation, so nothing else ever renders the sign-in
     screen. If that screen changes, those two sections are what catch it.
   Delegating a run again? **A peer may share this working tree** — read the
   warning at the head of `reference/container.md` before sending any command.
3. **`2.5.3` — honest failure messages.** The natural companion to the gate and
   now the only unfinished part of `2.5`. `auth.ts` already redirects to
   `…?signin=failed&reason=…`; the screen renders the code but not yet a sentence
   naming the likely cause (no signal, a Safari handoff from a home-screen PWA).
4. **`2.3.5` — the permanent record.** Metres walked leads, games played never
   does (decision 0019). The distance is still only in `presence.travel_m` inside
   each GameDO; carrying it to the account is the first thing to build. **O-03**
   and **O-12** both deserve a sentence in the record's own UI.
5. **`2.2.3`–`2.2.5`** — expiry pre-flight, offline session caching, sign-out.
   `2.2.4` is the stronger version of decision 0035's rule 2 and would let the app
   know *who* it is offline rather than merely letting it open. `destroySession`
   already exists for sign-out.
6. **O-16 — the home screen's ordering.** Two unbounded lists sit above the
   controls a player came to tap.
7. **`1.9.2`** — PWA install and wake lock, on the next convenient phone.
