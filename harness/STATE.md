# Where the project is

*Rewritten every session. Short by design — the plan holds the detail, the session
files hold the history, and `reference/` holds everything that is simply true.*

**Tree state**: clean. **O-31 is fixed** (`10.6.1`–`10.6.3`, decision 0044):
while a place waited for the server, the mover's clock jumped *up* to the
balance their turn began with, which on a first move is exactly the time
control. A predicted place now stops the clock at the tap. Reviewed clean in one
round, committed and pushed (`2026-09-24-03`). This is phase 2 of a four-phase
run: O-33 (done), O-31 (done), O-30 (piece look plus a last-move highlight),
pinch zoom.
**Active stages**: `10.5`, waiting only on `10.5.4`, and `10.6`, waiting only on
`10.6.4` (both real-phone checks).
**Next action**: phase 3 of this run, **O-30**. The deploy is still the
operator's.
**Ask the owner**, on the next outdoor game, to switch the clock readout on:
tap either clock. It shows the server's raw clock numbers beside the screen and
stays on until tapped again. A screenshot when the clock looks wrong settles
`10.6.4`.
**Live**: `https://satellite-chess.hootowl7777-cloud.workers.dev`, deployed
2026-09-16, version `1fea90ff`. **Nothing since `2.5.3` is deployed**: `2.5.3`,
phase 7, `2.2.3`–`2.2.5`, `2.3.5`, `8.1`/`8.2`, `8.4`/`3.6.2`, `10.5` and `10.6`
all ship on the next `npm run deploy`. That deploy **creates the `ARCHIVE` KV
namespace** (no `id` in `wrangler.jsonc`). Pin its id there afterwards
(`reference/budget.md`).
**1035 tests pass**. Typecheck and `plan:check` are clean. On 2026-09-24
`check-clock`, `check-resume` and `drive-game` passed after this phase, and
`check-review`, `check-record`, `check-games` and `check-invite` passed before
it. **Run drivers from a new, uniquely named `--persist-to`** (O-19). Every
driver now takes `--base=http://127.0.0.1:<port>/?sim=1` (O-24 is fixed).

## A finished game, a day later, in one paragraph

A day after anybody last looked at a finished game, it is **archived to KV and
its Durable Object deleted** (decision 0042, `worker/collection.ts`,
`GameDO.retire`).
- **The archive** holds the PGN byte for byte and the review report, in board
  space. It has no coordinates, no field, no accounts, and no join code in the
  value.
- **After the object has gone**, the review, the file, "Your games" and a deep
  link all read the archive. The seat check asks the player's own account.
- **Deletion waits** for the record and index lines to land, then for a
  settled, read-back archive, and never happens under an open board.
- **Unplayed games** (two seats, no move, not a claimable pause) go after 30
  days. **A game with moves and no result is never deleted** (0025).
- **The field** goes to anybody only while a seat is free (O-34, resolved).

**The rule most likely to be broken by a well-meaning simplification**: creating
the schema on wake. Storage is existence, and that one line made every request
to any code a permanent object and every deleted game come back.

## After the game, in one paragraph

The board offers **After the game** once there is a result (`client/views/review.ts`):
"You covered 2.4 km", each player's walk, every carry, the honesty sentences, and
the game as a PGN (decision 0041). The PGN is **one canonical file per game**, in
**board space — never lat/lng**, with no names and no join code in it or its
filename; the phone builds it at mount so Share has nothing to await, and the
ladder ends in a visible text and a server-answered `/api/game/:code/pgn` link.
Both routes are **seat-only and answer a stranger 404**. `game.initial_ms`
(schema 5) holds the starting clock; older games write `TimeControl "?"`.

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

A phone's counter runs for the life of the *page*, so every report carries its
`leg` and the game credits only what that leg adds between two of its own
reports, while `active`, capped at a sprint over a window that cannot be banked
— and every leg is re-baselined at the transition into `active`. **Relays, lifts
and places all carry the counter**, through one function (`GameDO.travelFrom`),
so the carry that ends a game is counted (decision 0041). The figure stored and
shown is **floored by the player's own carries** — the larger, never the sum —
and **frozen once the game is finished**. `travel_m` is nullable, and NULL means
*unmeasured*: the owner's 2026-09-20 games stay unmeasured however often they are
re-opened. The server now loses a steady 12–14 m of what a phone counts; the
bigger error is the phone's counter itself, which strands up to a hop at every
stop (**O-38**).

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
is complete bar the standing `3.7`. **Phase 2 is closed apart from
`2.3.6`** ("fields near me"): identity, sessions and now the record are all
built. **`8.1`, `8.2` and `8.4` are done**; what is left is the rest of phases 8–10.

**Reach is the independent variable, measured in fractional squares** (decision
0031), and **reported accuracy plays no part in it** (decision 0043): a fix worse
than ±25 m refuses the move, and anything better gets the same circle as a
perfect one. **The board is not forced to be square** (decision 0028).

## The game has now been played outdoors, twice

The owner played complete games on real ground on 2026-09-20, which is the first
evidence from outside this repository. It produced **O-30** (piece outlines take
the *opponent's* color; a bishop can vanish), **O-31** (the host's clock appeared
to round up: a real bug in the predicted place, now fixed, open until an
outdoor game confirms it), **O-32** (a
parked feature idea: two players on two fields), and **O-33** (the owner's
ruling: poor signal must stop buying extra reach, now done). Read all four before planning
game-rule work.

## What to do next, concretely

1. **O-30**, piece outlines and the vanishing bishop, plus a last-move
   highlight. Phase 3.
2. **Pinch zoom** on the board. Phase 4.
3. **Deploy** (the operator's). Afterwards, pin the `ARCHIVE` namespace id in
   `wrangler.jsonc`. Finished games from before 8.4, including the owner's two
   real games, are archived only once someone re-opens them.
4. **O-38**, the distance accumulator, once there are real-handset traces.
   **O-12** is still open too: 0043 did not close it.
5. **A phone test** covering:
   - the record, review and archived-review screens;
   - sharing a `.pgn` (Android falls to the text rung);
   - sign-in and sign-out;
   - the wake lock (`1.9.2`);
   - the handshake on real GPS (O-25, O-17);
   - `10.5.4`: is anybody standing on a square refused because the dot is off?
   - `10.6.4`: with the clock readout on, does the clock still look wrong?
