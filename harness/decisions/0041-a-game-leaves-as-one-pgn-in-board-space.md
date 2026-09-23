# 0041 — A game leaves as one PGN, in board space, fetched at mount and shared on tap

- **Date:** 2026-09-23
- **Status:** accepted
- **Stage:** 8.1, 8.2
- **Amends:** [0040](0040-the-record-is-one-line-per-finished-game-and-totals-are-derived.md) rules 6 and 7 (rules 7 and 8 below)
- **Builds on:** [0017](0017-play-history-belongs-to-players-not-places.md), [0018](0018-bragging-without-broadcasting-location.md), [0040](0040-the-record-is-one-line-per-finished-game-and-totals-are-derived.md)

## Decision

1. **Positions in a report and a PGN are board space, never latitude and
   longitude.** `GameDO.buildReport` applies the affine inverse to each stored
   lift and place fix, and what leaves the object is squares from a1's centre
   plus claimed accuracy. The fixes stay in the game.
2. **One canonical PGN per game.** No seat, no names (`White`/`Black` are `?`),
   nothing reader-specific, so both seats get identical bytes and `8.4` can
   archive a single blob. **The join code is in neither the file nor its
   filename**, which is `satellite-chess-YYYY-MM-DD-<field-slug>.pgn` (O-34).
3. **Seat-only, and a refusal is a 404.** `/api/game/:code/review` and `/pgn`
   need a session; the Durable Object checks the account against its seats. A
   non-player gets the same 404 body as a code that names nothing.
4. **Fetch at mount, share on tap, and the phone builds the file itself.** The
   review screen reads the report once and runs `buildPgn` on it, so Share has
   nothing to await before `navigator.share`. Ladder: share sheet with a
   `File` → share sheet with text → clipboard → a visible `<textarea>` beside
   a plain `<a href="/api/game/:code/pgn">`, a *server*-initiated download with
   `Content-Disposition: attachment`. **No `mailto` rung.**
5. **The starting clock is stored** (`game.initial_ms`, schema 5), because the
   clock columns hold what is *left*. On upgrade it is backfilled from Black's
   clock only when no move has been played, and left NULL otherwise, which the
   PGN writes as the standard's `TimeControl "?"`.
6. **Unmeasured travel is left out**, not zeroed: `measuredTravelM` (0040 rule 7)
   decides for both the record and the report, and the PGN omits the
   `Satellite…WalkedM` tag.
7. **Lift and place carry the phone's counter** (`travelM`, `leg`), and are
   credited by 0040 rule 6's rule through one function (`GameDO.travelFrom`)
   over the same leg, baseline and window as `pos`. **This amends 0040 rule 6**,
   which named `pos` as the only carrier. The credit runs before the message is
   judged and whether or not it is refused — the walk was real — and moves
   `last_pos_at` on, so windows never overlap and a burst of refused places
   earns what one relay after it would. A place that mates is credited before
   the result and the record line are written.
8. **The walked figure is floored by the player's own carries**: walked =
   max(measured travel, sum of that color's `carried_m`) — the larger, never
   the sum — in one helper (`flooredTravelM`, `shared/review.ts`) applied in
   `recordLine` and `buildReport` (and again, idempotently, in `walkOf`), so
   the record row, the review screen and the PGN tags agree. Null stays null:
   an unmeasured game is not given a figure made of carries alone. **This
   amends 0040 rules 6 and 7**: a stored figure is no longer only what the
   phone reported, and 0040's "measured zero" for a game zeroed in flight is
   now its carries. No schema change. A record row is not frozen by this: the
   account upserts by join code and a re-join re-pushes a line whose digest
   changed, so an older row is rewritten to the floored figure the next time
   its game re-pushes. No production row exists yet — 2.3.5 is not deployed —
   so in practice every row is written floored.
9. **A finished game's distance is frozen at the result.** Once `status` is
   `finished`, no relay, lift or place writes anything about distance — not
   the credit, not the leg, not the baseline (`GameDO.travelFrom`). Re-opening
   a finished board still relays, and storing a leg there would turn an
   unmeasured game (0040 rule 7) into a "measured" one worth the phone's whole
   counter, which the next re-join re-pushes into the record. Staging and a
   suspension still move baselines; only `finished` is frozen.

## Why

A PGN is the file that travels — share sheet, chat, laptop, forwarded on. A
lat/lng in it would make every shared game a disclosure of a place somebody
regularly stands, which 0017 and 0018 exist to prevent; a board index has no
anchor and is unlocatable by construction. One canonical file is what makes the
archive in `8.4` one object rather than two, and what lets a test assert the
two seats agree. `navigator.share` loses its user activation on the first
`await` (`gotchas.md`), so the file must already be a string when the tap
lands. A page-initiated blob download is silently blocked in some in-app
browsers; a server response with `Content-Disposition` is not.

Rule 7 because the review screen made the gap visible: relays go out every few
seconds and only on movement, so everything walked after the last one before
the mating place was never sent. Measured on Fool's mate, Black's review read
43 m above 60 m of carrying before the change, and 46–59 m above 58–61 m over
four runs after it. Against the phone's own counter the server now loses a
steady 12–14 m (the start baseline and the last unconfirmed hop), against
16.4 m before; the run-to-run spread, and most of the gap to the carrying
figure, is the counter itself (O-38). Riding on messages already sent costs no
request.

Rule 8 because rule 7 was not enough: on a one-move game that ended on the
clock, the phone had not yet confirmed a hop and the review read "You covered
0 m" above "1. e4 carried 16 m", and the record and PGN said 0 m too. A carry is
a straight line between the lift and place fixes, so it is a lower bound on the
walk it is part of. **This is about the surfaces agreeing and the figure being
a lower bound, not about cheating**: the fixes come from the same phone, and
O-03 stands.

## Rejected

- **Coordinates in move comments**, even rounded: a handful of fixes locates a
  back garden to a few meters.
- **A per-seat PGN naming "You"/"Opponent"**, or account names: two files per
  game, and a name in a file that gets forwarded.
- **403 for a non-seat**: it confirms the code is a real game.
- **Fetching the PGN on tap**: the await in front of `navigator.share` kills it.
- **A `mailto:` rung**: a whole PGN in a mail body arrives as text nobody's chess
  program opens, and every phone with mail already has a share sheet.
- **A final relay sent just before the place**, or a new message for the
  counter: an extra billed inbound request per move, and still racing the
  place. **Crediting only an accepted place**: a refused place ends a real walk,
  and the rule is safe on refusals because the window is shared.
- **Freezing every status but `active`**: staging and the resume need their
  baselines moved — that is how the walk to the back rank is kept out.
- **Adding the carries to the counted distance**: the carries are inside the
  walk, so a sum counts them twice. **Showing max(travel, carries) on the
  screen only**: the screen would disagree with the record and the PGN.
  **Flooring an unmeasured game**: that invents a figure for a game rule 7
  says has none.
- **Backfilling `initial_ms` from White's clock**: a pause before White's first
  move banks White's elapsed time there. **Inventing it from the remaining time
  once moves exist**: a number nobody measured.

## Revisit if

- A player wants names in the file: let them type them, or add an opt-in tag
  per export — not a second stored file.
- `8.5.1`'s share card needs positions at a finer grain than a hundredth of a
  square.
- A browser we care about can share files and drops text shares, or the reverse.
  **Android Chrome's Web Share file allowlist does not include `.pgn`**, so
  `canShare({files})` is false there and Android lands on the text rung; if the
  allowlist grows, or a `text/plain` `.pgn.txt` proves better than text, look
  again.
- O-38's accumulator change lands: the residue figures in rule 7 move with it.
