# Where the project is

*Rewritten every session. Short by design — the plan holds the detail, the session
files hold the history, and `reference/` holds everything that is simply true.*

**Tree state**: clean, pushed to `main`.
**Active stage**: none. **The sign-in gate is built.** `2.5.1` landed 2026-09-16
on top of the same day's `2.1`/`2.2.1`/`2.2.2`/`2.4`, so sign-in is now mandatory
in fact and not only in decision 0014.
**Next action**: `2.5.3` — honest failure messages — or `2.3.5`, the permanent
record. See "What to do next" below; the gate made both reachable.
**Live**: `https://satellite-chess.hootowl7777-cloud.workers.dev`. **Deployed
before the gate existed** — the gate is committed but *not yet deployed*, and a
deploy is the first thing the next session should do or deliberately not do.
**Last session**: `harness/sessions/2026-09-16-02.md`.
**762 tests pass** (737 before this session). Typecheck and `plan:check` clean.
**No browser driver has been run against the gate** — playwright is not installed
in this container, and eleven drivers changed.

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

1. **Deploy, and then sign in on a phone.** The gate is committed and unproven in
   a browser. The first real launch after deploying is also the first chance to
   see **O-17** (a session written to KV and read back a second later) as a player
   would: sign in successfully, arrive back signed out. It did not bite on
   2026-09-16, which is one data point and not a clearance.
2. **Run the browser drivers**, on a machine that has playwright. Eleven changed
   and none has been run; `scripts/driver-signin.mjs` is new and every driver now
   depends on it. `check-deeplink.mjs` is the one that exercises the gate's
   offline rule, because it reloads a deep link with the network cut.
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
