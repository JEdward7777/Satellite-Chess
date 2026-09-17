# Where the project is

*Rewritten every session. Short by design — the plan holds the detail, the session
files hold the history, and `reference/` holds everything that is simply true.*

**Tree state**: clean, pushed to `main`.
**Active stage**: none. **Phase 2's gate is finished** — `2.5.3` landed 2026-09-17
and closed `2.5`, on top of the same week's `2.1`/`2.2.1`/`2.2.2`/`2.4`/`2.5.1`.
**Next action**: `2.3.5` — the permanent record — or the phase 7 audit O-23 asks
for. See "What to do next" below.
**Live**: `https://satellite-chess.hootowl7777-cloud.workers.dev`, with the gate on
it — deployed 2026-09-16, version `1fea90ff`. **`2.5.3` is not deployed yet**;
it is client-only and ships with the next `npm run deploy`.
**768 tests pass** (763 before this session). Typecheck and `plan:check` clean.
**All eleven browser drivers pass at `cfc9f87`** — but **run them from an empty
`.wrangler` or they lie to you** (O-19).

## The gate, in one paragraph

An unauthenticated launch reaches a sign-in screen and nothing else. The server
half is what makes it real: creating a game, joining one, and opening the socket
all 401 without a session, and **`playerId` is gone** — from the request body,
from the WebSocket URL, and from `localStorage`. That is what closed **O-15**: a
seat is a Google `sub` or it does not exist. A completed sign-in returns to
wherever it started, carried in the signed flow cookie. All three rules are
**decision 0035**. As of `2.5.3` a failed sign-in explains itself: a hedged
sentence naming the likely cause, with the exact code kept underneath.

**The rule most likely to be broken by a well-meaning simplification**: the launch
check has *three* states, not two. Only a real 401 closes the gate; an unreachable
server opens the app. Collapsing that to a boolean is invisible on a developer's
machine and shows a sign-in screen to a player standing in a field.

**The second rule, new with `2.5.3`**: the failure sentences hedge on purpose, and
a test enforces it. `bad_token` is six checks collapsed into one code; `expired`
covers two unrelated failures. Tightening "usually means" into an assertion sends
somebody to fix the wrong thing.

## Where the detail lives

- **`reference/gotchas.md`** — what will bite you when you touch the code.
- **`reference/container.md`** — **check which machine you are on first**, and read
  the warning at its head before delegating anything: a peer session may share
  this working tree.
- `reference/platform-verified.md`, `budget.md`, `geometry.md` — durable facts.
- `harness/AGENTS.md` — the rules. `npm run plan` — the stage tree.

## In one paragraph

Phases 0 and 1 are done bar `1.9.2` (PWA install and wake lock on a phone) and
`1.9.3.6`. **Phases 4, 5 and 6 are closed** — server-authoritative chess with carry
validation, the clock with flag-fall and suspension, and the whole join flow.
Phase 3 is complete bar `3.6.2` and the standing `3.7`. **Phase 2 now has identity
end to end and its gate is shut.** What is left is the *record* (`2.3.5`), session
lifecycle polish (`2.2.3`–`2.2.5`), and then phases 7–10.

**Read O-23 before trusting the 73%.** Phase 7 is recorded as entirely `todo` and
is substantially built — the handshake, `'staging'`, `t: 'ready'`, the Ready button
and reconnect backoff all exist and are tested. Roughly fourteen stages are counted
outstanding that are largely done.

**Reach is the independent variable, measured in fractional squares** (decision
0031). **The board is not forced to be square** (decision 0028).

## The field survey is walked — the news is good

Static scatter while standing still was **0.2 m median** against a 4 m half-square,
claimed accuracy was ~16x pessimistic but **100% honest**, and **8 m squares refuse
0% of moves**. The operator walked the ten-step protocol on 2026-09-06: Android
Chrome, 2008 fixes over 29 minutes. The one finding not acted on is **O-12**. Full
numbers in `harness/sessions/2026-09-06-03.md` and decision 0031. The live trace
`2026-09-06T23-10-47-510Z-ioop0u` is deliberately **kept** (`1.9.3.6`).
`SURVEY_SECRET` is `field-walk-2026-a7k3m9qx`.

## What to do next, concretely

1. **`2.3.5` — the permanent record.** The largest remaining piece of phase 2, and
   the reason accounts are mandatory at all (decision 0019): meters walked leads,
   games played never does. Distance is still only in `presence.travel_m` inside
   each GameDO; carrying it to the account is the first thing to build. **O-03**
   and **O-12** both deserve a sentence in the record's own UI.
2. **The phase 7 audit (O-23).** Read phase 7 against the code stage by stage and
   mark what is actually done. Settle whether the game index (2.3.4) makes `7.3.1`
   obsolete rather than outstanding. Small, and it makes the plan trustworthy.
3. **`2.2.3`–`2.2.5`** — expiry pre-flight, offline session caching, sign-out.
   `2.2.4` is the stronger form of decision 0035's rule 2 and would let the app
   know *who* it is offline rather than merely letting it open.
4. **A phone sign-in through the gate, plus the wake lock** — closes `1.9.2` and
   the last unproven part of the gate together. The PWA installed fine on Android
   on 2026-09-17; the wake lock was not tested and it is unclear whether that
   install signed in *through* the gate. iOS is the case that actually bites:
   a home-screen app handing OAuth to Safari and returning in another context.
   Watch for **O-17** — signing in successfully and arriving back signed out.
5. **O-16** — two unbounded lists sit above the home screen's primary actions.
6. **`2.5.3` has no browser coverage.** No driver asserts on the failure block;
   provoking a real failure needs a deliberately broken callback. Worth a section
   in `check-fields` or `check-games` if the sign-in screen changes again.
