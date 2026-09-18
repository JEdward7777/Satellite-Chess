# Where the project is

*Rewritten every session. Short by design — the plan holds the detail, the session
files hold the history, and `reference/` holds everything that is simply true.*

**Tree state**: clean, pushed to `main`.
**Active stage**: none. **Phase 7 is closed** (2026-09-18). The O-23 audit marked
what was already built, and the rest was built: an automatic `ready`, the
waiting distances, and resume from a cold start. `7.3.1` was dropped (decision 0038).
**Next action**: `2.2.3`–`2.2.5`, the session lifecycle. See "What to do next".
**Live**: `https://satellite-chess.hootowl7777-cloud.workers.dev`, deployed
2026-09-16, version `1fea90ff`. **Neither `2.5.3` nor phase 7 is deployed.**
Phase 7 changes the Worker, so the next `npm run deploy` carries both.
**793 tests pass**. Typecheck and `plan:check` are clean. `check-resume`,
`drive-game` and `check-clock` passed on 2026-09-18. **Run drivers from an empty
`.wrangler`** (O-19), and not with `--base=…?sim=1` on anything but
`check-resume` (O-24).

## The handshake, in one paragraph

A game starts, and a suspended one resumes, when both players are connected and
both are on their own back rank, verified server-side (decision 0005). The phone
says `ready` by itself, once per arrival (`client/handshake.ts`). The flag
**expires with the socket**, and a relay that flips it is followed by a snapshot
(decision 0037). A killed phone finds its game again on home, through the game
index (decision 0038). The rule most likely to be broken by a simplification is
treating a sent relay as delivered. The server drops relays inside its interval
floor, so `AutoReady` waits 3 s for confirmation and then sends `ready` anyway.

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
Phase 3 is complete bar `3.6.2` and the standing `3.7`. **Phase 2 has identity
end to end and its gate is shut. Phase 7 is closed** (78% overall, and now an
honest number). What is left is session lifecycle polish (`2.2.3`–`2.2.5`), the
*record* (`2.3.5`), and then phases 8–10.

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

1. **`2.2.3`–`2.2.5`**: expiry pre-flight, offline session caching, sign-out.
   `2.2.4` is the stronger form of decision 0035's rule 2. It would let the app
   know *who* it is while offline, not merely let it open.
2. **`2.3.5`, the permanent record.** The reason accounts are mandatory at all
   (decision 0019): meters walked is the headline figure, and games played never
   is. Distance lives only in `presence.travel_m` inside each GameDO, and carrying
   it to the account is the first thing to build. **O-03** and **O-12** each
   deserve a sentence in the record's own UI.
3. **Deploy.** `2.5.3` and phase 7 are both waiting.
4. **A phone test**: sign-in through the gate, the wake lock (`1.9.2`), and the
   back-rank handshake on real GPS (watch for **O-25**). iOS is the case that
   bites: a home-screen app handing OAuth to Safari. Watch for **O-17** too.
5. **O-24**: a one-line argument-parsing fix in ten drivers.
6. **O-16**: two unbounded lists sit above the home screen's primary actions.
