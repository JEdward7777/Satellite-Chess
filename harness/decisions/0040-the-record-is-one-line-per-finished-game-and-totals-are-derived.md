# 0040 — The record is one line per finished game, pushed by the game; totals are derived

- **Date:** 2026-09-19
- **Status:** accepted
- **Stage:** 2.3.5 (and 2.3.5.2, 2.3.5.3, 2.3.5.4)
- **Builds on:** [0019](0019-distance-is-the-currency-not-games.md), [0033](0033-the-game-writes-the-index-the-phone-only-reads-it.md)

## Decision

1. **The permanent record is a `record` table in `UserDO`: one row per finished
   game, keyed by join code, and no totals anywhere.** `summarizeRecord`
   (`shared/record.ts`) folds the rows into totals on every read of
   `GET /api/record`.
2. **Only `GameDO` writes it**, over the `USER` binding, when the game finishes
   (0033's rule, carried over). There is no route that writes a record.
3. **Delivery is idempotent at both ends and retried through the alarm.** The
   game remembers each accepted line's digest in `meta` and does not resend it;
   the account upserts by join code, so a line sent twice is one row. A failed
   push schedules the `record` timer (30 s, doubling, ten attempts), and
   re-taking a seat in a finished game tries again. Nothing is held in memory.
4. **A row is separate from the game index and outlives it.** Forgetting a game
   from the list (2.3.4.2) does not touch the record. A row carries everything
   the record will ever say — result, plies, own moves, own distance, longest
   carry, field name, lineage key, narrowest square, board size, diagonal — so it
   survives the game's DO being archived and deleted (8.4). **No coordinates and
   no opponent.**
5. **What counts is judged at read time, from stored facts:** `counted`;
   `practice` when the narrowest square is under `SMALL_SQUARE_M` (4 m, the same
   constant `checkCalibration` warns at, 2.3.5.2); `unplayed` when nobody moved;
   and `unmeasured`, checked first, when `travelM` is null. Only `counted` games
   enter totals; all four are listed in history. A claimed or resigned game with
   moves counts like any other result. Unfinished games (suspended, waiting,
   collected) are not in the record at all.
6. **`travel_m` is this game's distance, credited by difference (2.3.5.3).** The
   phone's counter runs for the life of the page, so it now reports a `leg` (one
   per page load) with its total. The game credits only what one leg adds
   between two of its own reports, only while `active`, and never faster than
   `MAX_PLAUSIBLE_SPEED_MPS` over the window since the **later** of that
   player's last accepted report and the last clock start — so silence banks no
   ceiling to spend in one message. A new leg sets a baseline and earns nothing,
   and **every leg is re-baselined at the transition into `active`** — the start
   and every resume — so the walk to the back rank and the walk back from a
   pause cannot arrive as one large first credit. Over a whole game the credit
   cannot exceed `MAX_PLAUSIBLE_SPEED_MPS` × the time the game spent active,
   which is why silence during an opponent's think is not a hole: it buys
   nothing the elapsed clock had not already allowed.
7. **`travel_m` is nullable, and null means nobody measured it.** Games already
   being played when 2.3.5.3 arrived hold the old figure — the phone's whole
   counter — and have never pushed a record line, because the record ships in
   the same deploy. `recordLine` calls a row **unmeasured** when its distance
   was credited under the old rule and never reported under the new one
   (`travel_leg IS NULL AND travel_m > 0`), so no date and no flag are needed.
   The row is written, listed, and left out of every total. A game whose
   inherited figure was dropped to zero by the schema-4 upgrade and which never
   reports again is a **measured zero**, which is the honest reading: this app
   saw no walking in it.

## Why

Totals derived from rows make double delivery harmless without exactly-once
messaging between two Durable Objects, and let stage 9.2 move the 4 m floor and
re-judge every game consistently. Rule 6 was not optional: until it, `travel_m`
was `MAX(travel_m, pageTotal)`, which credited a game with the calibration walk,
the walk to the park and the previous game in the same sitting, and lost
everything after a reload. Carrying that into a *permanent* record would have
made the headline figure wrong from the first game.

## Rejected

- **A running total incremented at game end.** Needs exactly-once delivery; a
  retried alarm double-counts.
- **Totals stored alongside rows as a cache.** Two sources of truth, and a rule
  change would leave the cache judged by the old rule.
- **Building the record on `game_index` rows.** The player may forget those.
- **Storing a `practice` flag at write time.** Freezes the threshold per game.
- **Capping the credit on time since the last report alone.** Simpler, and it
  pays a phone that said nothing for an hour a ceiling of 12 km in one message.
- **Relying on the rate cap to keep the pre-start walk out.** It caps the rate,
  it does not subtract the meters: +12 m leaked into a 57 m game, measured.
- **Re-baselining whenever `last_clock_start_at` is newer than the last report.**
  That column is re-stamped on every move, so it would zero the credit of
  whichever player had not relayed since the last ply — a per-ply under-count
  worse than the leak. The transition into `active` happens in exactly one
  place (`startIfBothReady`), and that is the one to hook.
- **Keeping a pre-schema-4 in-flight game's `travel_m`.** It is the page's whole
  counter, and that game's end would write it into a row nothing rewrites.
- **Zeroing a pre-2.3.5.3 *finished* game's distance, or leaving it out of the
  record.** A zero is a claim that they walked nowhere, and dropping the game
  loses a real result. Unmeasured says the true thing.
- **Marking those games by date, or with a migration flag.** `travel_leg IS
  NULL AND travel_m > 0` already means exactly "credited under the old rule,
  never reported under the new one", and needs nothing kept in step.
- **Per-game baseline on the client** (`distanceM - distanceAtMount`). Equivalent
  on paper, but the server would still need to tell a reload from a lie, and
  would still credit walking during staging or a suspension.
- **Naming the opponent in a row**, for head-to-head. 8.5.4 is a record shared
  by two participants, a different mechanism; adding a column here would build
  a player→player edge by the back door.

## Accepted caveat

A game *in play* at the upgrade reads as honestly measured but is short by
however much of it was walked before the deploy, because its inherited figure is
dropped rather than marked. It is a handful of games, once, and the alternative
— marking a live game unmeasured for its whole remaining life — would lose the
distance of a game mostly played after the upgrade.

## Revisit if

- O-03 gets its server-side lower bound (from stored lift/place fixes): the
  credit rule, not the record's shape, is what changes.
- The per-game figure's residue starts to matter. It is now a **pure
  under-count, and a fixed cost per active period rather than a fraction of the
  walking**: the first report after the start is a baseline, and whatever is
  walked after the last report before the result is never sent. Each of those is
  about one accumulator hop — `max(4 m, 2 × claimed accuracy)`, so ~16 m at the
  simulator's 5 m accuracy. Measured with `check-record.mjs`: 15.3 m and 15.6 m
  lost out of 58.5 m walked, and 13.0 m and 12.2 m lost out of 400.7 m and
  390.5 m walked over the same four moves — so a real game is **1–3% short**,
  one way. Earlier rules erred the other way (the rate cap alone leaked +12 m of
  a 57 m game), and under-counting is the side to be wrong on for a number
  nobody can audit.
- Ten thousand rows (`MAX_RECORD_GAMES`) is ever near.
