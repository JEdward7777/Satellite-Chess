# Where the project is

*Rewritten every session. Short by design — the plan holds the detail, the session
files hold the history, and `reference/` holds everything that is simply true.*

**Tree state**: clean, pushed to `main`.
**Active stage**: none. **`2.3.5` is closed** (2026-09-22): the permanent record,
its privacy statement and the per-game distance rule (decision 0040).
**Next action**: phase 8 — `8.1` PGN export and `8.2` distance summaries. See
"What to do next".
**Live**: `https://satellite-chess.hootowl7777-cloud.workers.dev`, deployed
2026-09-16, version `1fea90ff`. **Nothing since `2.5.3` is deployed**: `2.5.3`,
phase 7, `2.2.3`–`2.2.5` and `2.3.5` all ship on the next `npm run deploy`.
**895 tests pass**. Typecheck and `plan:check` are clean. On 2026-09-22 every
driver passed, including the new `check-record`. **Run drivers from an empty
`--persist-to`** (O-19), and not with `--base=…?sim=1` on anything but
`check-resume`, `check-account` and `check-record` (O-24).

## The record, in one paragraph

Meters walked is the headline and games played never is (decision 0019). The
account holds **one row per finished game** and **no totals**: they are folded
out of the rows on every read, which is what makes a game whose end is reported
twice count once (decision 0040). Only `GameDO` writes a row, when the game
finishes, retried on the `record` timer through the one alarm; `GET /api/record`
is a read and there is no route that writes. Rows outlive the game index — a game
forgotten from the list keeps its row — and hold no coordinates and no opponent.
The screen is on the account screen, with the privacy statement (`2.3.5.1`)
beside it and the O-03 / O-12 sentences under the numbers.

**The rule most likely to be broken by a well-meaning simplification**: a running
total. It would need exactly-once delivery between two Durable Objects, and the
retry is designed to deliver more than once.

## Distance, in one paragraph

A phone's counter runs for the life of the *page*, so a relay carries its `leg`
and the game credits only what that leg adds between two of its own reports,
while `active`, capped at a sprint over a window that cannot be banked — and
every leg is re-baselined at the transition into `active`, which is the start and
every resume. The residue is a **pure under-count of about one accumulator hop at
each end of an active period**: 1–3% of a real game, measured. `travel_m` is
nullable, and NULL means *unmeasured* — the games played before this shipped are
listed and never counted.

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

An unauthenticated launch reaches a sign-in screen and nothing else. Creating a
game, joining one and opening the socket all 401 without a session, and
**`playerId` is gone** — that is what closed **O-15**: a seat is a Google `sub`
or it does not exist (decision 0035). A completed sign-in returns where it
started. A confirmed launch caches *who* the phone is, for an offline home
screen, and that cache is words and never a door (decision 0039) — and whenever
the account changes, the field journal is emptied.

**The rule most likely to be broken by a well-meaning simplification**: the launch
check has *three* states, not two. Only a real 401 closes the gate; an unreachable
server opens the app.

## Where the detail lives

- **`reference/gotchas.md`** — what will bite you when you touch the code.
- **`reference/container.md`** — **check which machine you are on first**, and read
  the warning at its head before delegating anything: a peer session may share
  this working tree.
- `reference/platform-verified.md`, `budget.md`, `geometry.md` — durable facts.
- `harness/AGENTS.md` — the rules. `npm run plan` — the stage tree.

## In one paragraph

Phases 0 and 1 are done bar `1.9.2` (PWA install and wake lock on a phone) and
`1.9.3.6`. **Phases 4, 5, 6 and 7 are closed** — server-authoritative chess with
carry validation, the clock, the join flow and the back-rank handshake. Phase 3
is complete bar `3.6.2` and the standing `3.7`. **Phase 2 is closed apart from
`2.3.6`** ("fields near me"): identity, sessions and now the record are all
built. What is left is phases 8–10.

**Reach is the independent variable, measured in fractional squares** (decision
0031) — but see **O-33**, which removes half of it. **The board is not forced to
be square** (decision 0028).

## The game has now been played outdoors, twice

The owner played complete games on real ground on 2026-09-20, which is the first
evidence from outside this repository. It produced **O-30** (piece outlines take
the *opponent's* color; a bishop can vanish), **O-31** (the host's clock appeared
to round up — unreproduced, and the best candidate for a real bug), **O-32** (a
parked feature idea: two players on two fields), and **O-33** (the owner's
ruling: poor signal must stop buying extra reach). Read all four before planning
game-rule work.

## What to do next, concretely

1. **`8.1` and `8.2`** — PGN export, and the per-game distance summary that says
   "you covered 2.4 km" at the end of a game. Both are the record's data seen
   from inside one game, and `8.2.3`'s honesty sentences already exist in
   `client/record.ts`.
2. **Deploy.** Four sessions of work are waiting, and the deploy is what turns
   the record on for the owner's real games — which will read as *unmeasured*,
   by design.
3. **O-33: drop the accuracy-based reach bonus.** The owner's ruling, it changes
   a game rule, so it wants its own stage under phase 10 and a decision
   recording the reversal of decision 0023's generous half. It also closes
   **O-12** by removal.
4. **O-31**, the clock rounding, with the raw snapshot numbers beside the screen.
5. **A phone test**: the record screen, sign-in and sign-out, the wake lock
   (`1.9.2`), and the handshake on real GPS (O-25, O-17).
6. **`8.4`** (archive a finished game to KV) and **`3.6.2`**. `8.4` is also where
   **O-34** should be answered.
