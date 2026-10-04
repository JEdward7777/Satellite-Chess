# Where the project is

*Rewritten every session. Short by design — the plan holds the detail, the session
files hold the history, and `reference/` holds everything that is simply true.*

**Tree state**: clean. **Run 2 of the pipeline is under way**
(`harness/pipeline/ratchet.md`). **Phases 1–5 are done.** Phase 1 was `10.9`,
seven small fixes (`2026-09-25-02`, decision 0047). Phase 2 was `10.10`,
**O-44: the carried piece travels with the dot** (`2026-09-26-01`, decision
0048). Phase 3 was `2.3.8`, **O-21: display units** (`2026-09-30-01`,
decision 0049). Phase 4 was `10.11`, **O-50: Resign, Offer draw and Abort on
the board** (`2026-10-01-01`, decision 0050). Phase 5 was `10.12`, **O-49:
try a field alone** (`2026-10-03-01`, decision 0051). Phase 6 is `8.3`,
**the replay** (`2026-10-04-01`, decision 0052), clean after two rounds.
**Order from here**: `8.5.1`–`8.5.3` (the share card), `8.5.4` (the
head-to-head record).
**Active stages**: `8.3`, `10.5`, `10.6`, `10.7`, `10.8`, `10.10`, `10.11`
and `10.12`, each waiting only on a real-phone check (`8.3.4`, `10.5.4`,
`10.6.4`, `10.7.4`, `10.8.4`, `10.10.3`, `10.11.5`, `10.12.3`).
**Next action**: phase 7 of run 2, **`8.5.1`–`8.5.3` (the share card)**.
**Live**: `https://satellite-chess.hootowl7777-cloud.workers.dev`, version
`b3946765`, at `b09b892`: everything through `10.12`, and **not yet
`8.3`**; the coordinator deploys it next. The `ARCHIVE` KV namespace id
(`fe6b455ea33c415f983eee0921c64cdc`) is pinned in `wrangler.jsonc`. The
operator has authorized deploys during this run once a phase is reviewed clean.
**1300 tests pass** (three record tests are flaky, O-52; a rerun passes).
Typecheck and `plan:check` are clean. On 2026-10-04 `check-replay` (eight
runs), `check-review`, `check-record`, `check-endings`, `check-resume` and
`drive-game` passed; `check-games` still fails its home-height check (O-51).
**Run drivers from a new, uniquely named `--persist-to`** (O-19).
Drivers take `--base=http://127.0.0.1:<port>/?sim=1`, except `check-invite`,
`check-calibrate`, `check-field` and `check-games`, which take
`--origin=http://127.0.0.1:<port>` and default to 8799. **Drivers tap with a
`pointerdown`/`pointerup` pair** (`isPrimary: false`); a lone `pointerup` is
no longer a tap (0046). **Drivers that read metric text pin `locale:
'en-GB'`**, because headless Chromium is `en-US` and an account that never
chose its units follows the locale. `drive-game`'s `opponentDot()` colour
filter also matches the red ring of the opponent's piece-in-hand plate, so do
not read it mid-carry. **The scratchpad is shared between agents in a run**:
name helper scripts per agent, since another agent may overwrite a generic
`restart.sh`.

## Replay and the walk, in one paragraph

"After the game" now opens on a **replay** (decision 0052): the board at
every step, with Back, Next, a scrubber and a tap on any move in the list.
Each step draws the carry (orange, from a ring where the piece was picked
up to a disc where it went down), the mover's walk to it, the other player
meanwhile and earlier walks faint, and says "Picked up standing on d8 ·
Carried 41 m · Put down standing on h4". It is the project's **first stored
location history**: each player's walk, built from the relays and lift and
place fixes the server already gets (no new message, no new row written),
**stored as squares from the moment it arrives**, only while active, at
most 2,000 fixes a player (`presence.track`, schema 8, `shared/track.ts`).
It is in the seat-only report and the archive (still `v1`; older archives
read `tracks: null` and draw straight carries), and scrubbing sends
nothing. **The rule most likely to be broken**: letting the walk into the
PGN or into an outbound game message. The file travels and the snapshot
goes to the socket; the walk belongs to the two players and leaves only
through `/review`.

## Trying a field alone, in one paragraph

"Try it alone" on the field screen opens the preview board (decision 0051):
the dot, the square underfoot, Reach, **Leeway** (a square's middle to its
nearest edge, plus the reach: where the server starts refusing a move on
your own square), Signal, a reach dial in memory, and tap a square to test
it with the server's own `checkReachTo`. The verdict compares the claimed
accuracy with the leeway (playable inside it, the odd refusal up to twice
it, hard beyond, not playable above ±25 m) and is **judged on the figures
as displayed**, so its sentence cannot contradict itself. **Nothing is
sent**; it works offline. **Every refused figure rounds up**: in the game's
refusals as in the preview, a distance or accuracy that was refused reads
past its limit and never below the truth (`lengthAboveWords`,
`accuracyAboveWords` in `shared/units.ts`). **The rule most likely to be
broken**: a new refusal sentence written with `lengthWords`, which rounds
to nearest and can read "3.2 m … reach is 3.2 m".

## Ending a game early, in one paragraph

"End game…" on the board offers resign, a draw, and abort (decision 0050).
Anything that ends the game asks first, on a button dead for a second.
**Abort alone only before each side has moved**; after that it is an offer.
An aborted game has status `aborted` and no result: no record line, no
archive, removable from the list, collected like an unplayed game. **A fallen
flag is settled before any action on a running game** (lift, drop, place,
pause, resign, draw, abort) and before a disconnect suspension, so a late
alarm cannot be dodged. **The rule most likely to be broken**: asking
`status === 'finished'` for "is it over?" instead of `isOver`.

## Units, in one paragraph

What a player reads is in their **account's** units, metric or US (decision
0049). The choice is a `settings` row on the UserDO, written by `POST
/api/settings` and returned on `/api/me` in the same object call as the launch
touch. The phone caches it (words, never a door) and holds an offline choice as
pending until a launch can send it: last delivered wins. An account that never
chose follows the browser's locale. **Everything underneath is metric**,
including the protocol's numbers, the archive and the PGN. `src/shared/units.ts`
is the only formatter: feet for short things, yards for a board, yards then
miles walked. Server refusals that name a distance carry a `Refusal` of figures
beside the metric `message`, and the phone rebuilds the sentence with
`refusalWords`. **The rule most likely to be broken**: a new on-screen distance
or server sentence written in meters directly. O-22 (spelling) is still open.

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
so the carry that ends a game is counted (decision 0041). **The cap delays; it
does not discard** (decision 0047): what it clips is owed (`travel_owed_m`, at
most 30 m) and paid under later windows' ceilings. It is dropped outside active
play and at every start and resume, and never paid after the result. So the
total is still at most a sprint for the time the game was active, and never
more than the phone reported. The figure stored and
shown is **floored by the player's own carries** — the larger, never the sum —
and **frozen once the game is finished**. `travel_m` is nullable, and NULL means
*unmeasured*: the owner's 2026-09-20 games stay unmeasured however often they are
re-opened. The residue the server loses against the phone was a steady 12–14 m
before 0047. It has not been re-measured since, because `check-record`'s figure is floored by the carries. The
bigger error is the phone's counter itself, which strands up to a hop at every
stop (**O-38**).

## The handshake, in one paragraph

A game starts, and a suspended one resumes, when both players are connected and
both are on their own back rank, verified server-side (decision 0005). The phone
says `ready` by itself, once per arrival (`client/handshake.ts`). The flag
**expires with the socket**, and a relay that flips it is followed by a snapshot
(decision 0037). A killed phone finds its game again on home, through the game
index (decision 0038). The rule most likely to be broken by a simplification is
treating a sent relay as delivered. The server drops a relay inside 1.5 s of
the last *relay* (0047), so `AutoReady` waits 3 s for confirmation and then
sends `ready` anyway, from the 1 s ticker if no fix arrives.

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
built, and since `2.3.8` so are display units. Since `10.11` a game can be
resigned, drawn or aborted from the board. **`8.1`, `8.2` and `8.4` are done, and `8.3` bar its outdoor look**; what is left is the rest of phases 8–10.

**Reach is the independent variable, measured in fractional squares** (decision
0031), and **reported accuracy plays no part in it** (decision 0043): a fix worse
than ±25 m refuses the move, and anything better gets the same circle as a
perfect one. **The board is not forced to be square** (decision 0028).

## The game has now been played outdoors, twice

The owner played complete games on real ground on 2026-09-20, which is the first
evidence from outside this repository. It produced **O-30** (piece outlines took
the *opponent's* color; a bishop could vanish: now built, open until the
outdoor comparison), **O-31** (the host's clock appeared
to round up: a real bug in the predicted place, now fixed, open until an
outdoor game confirms it), **O-32** (a
parked feature idea: two players on two fields), and **O-33** (the owner's
ruling: poor signal must stop buying extra reach, now done). Read all four before planning
game-rule work.

## What to do next, concretely

1. **Deployed** `b3946765` (through `10.12`), `ARCHIVE` id pinned; `8.3` is next. Finished games
   from before 8.4, including the owner's two real games, are archived only
   once someone re-opens them.
2. **The next outdoor game**, one checklist:
   - `10.5.4`: is anybody standing on a square refused because the dot is off
     (reach with a poor fix)?
   - `10.6.4`: tap either clock to switch the readout on. Does the clock still
     look wrong?
   - `10.7.4`: compare **Standard** against **On discs** with the "Pieces"
     button in the readout, in daylight; keep one. Is the last-move tint
     visible in sun?
   - `10.8.4`: pinch zoom while walking. Are taps ever dropped, is a pan ever
     read as a tap, does follow feel right, do the buttons get in the way?
   - `10.10.3`: does the carried piece read well outdoors? Can both players
     read the piece beside the dot at arm's length in sun, does the plate
     hide a square the carrier needs, and does it read as a carry rather than
     a third dot?
   - the record, review and archived-review screens;
   - sharing a `.pgn` (Android falls to the text rung);
   - `2.3.8.5`: does the units default come up US on the owner's phone,
     do the numbers read naturally, and does a 10-yard board paced by eye
     read as "30 ft" squares on the review?
   - `10.12.3`: try a field alone ("Try it alone" on the field screen)
     before the game. Does the verdict match how play goes there? Does a
     tap in the middle of a square say yes? Does any phone's claimed
     accuracy run optimistic, so a "Looks playable" is refused in play?
   - `8.3.4`: the replay ("After the game"). Is it readable in sun? Do
     the dashed, dotted and faint walks read apart? Does a finger on the
     board scroll the page at 1x and pan it zoomed? Does the walk drawn
     look like the walk that was walked, and is anything clipped at the
     edge (O-55)?
   - `10.11.5`: End game: resign, draw, abort. Is "End game…" easy to find
     when stuck, and never hit by accident while walking? Does an offer get
     noticed?
   - sign-in and sign-out;
   - the wake lock (`1.9.2`);
   - the handshake on real GPS (O-17), and zoomed labels (O-46).
3. **The rest of run 2**: `8.5.1`–`8.5.3` (the share card; reuse
   `client/replay-draw.ts`), `8.5.4`.
4. **Next candidates after that:**
   - **O-22**, the spelling sweep; its analysis is done in `open.md`.
   - **O-38**, the distance counter, once there are real-handset traces.
     **O-12** is still open too.
   - **O-47**, `user-scalable=no` blocking accessibility zoom: the owner's call.
