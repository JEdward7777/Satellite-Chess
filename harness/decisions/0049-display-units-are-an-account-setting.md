# 0049 — Display units are an account setting; everything underneath stays metric

- **Date:** 2026-09-30
- **Status:** accepted
- **Stage:** 2.3.8 (O-21)
- **Supersedes:** rule 2 of [0036](0036-american-spelling-in-anything-a-player-reads.md) ("units stay metric"), for what a player *reads* only

## Decision

1. **A player chooses Metric or US** (feet, yards, miles) on the account
   screen. The choice is stored on the **account** (`UserDO`, a `settings`
   table, schema 3), so it follows the player to their second phone. It is
   written by `POST /api/settings` (same-origin, like signing out) and read
   back on `/api/me`, the launch check the phone makes anyway, through one
   `UserDO.launch` call. **No WebSocket message was added or changed inbound.**
2. **Never chosen is not metric.** An account with no choice gets its
   browser's locale: a region of `US` (or `LR`, `MM`) is US, anything else,
   including a bare `en`, is metric (`unitsForLocale`). Nothing is written to
   the account until the player picks.
3. **The phone caches the account's answer** (`satchess.units`) for a launch
   with no signal, as it caches who it is (0039): words, never a door. A choice
   made offline is shown at once, kept as `pending`, and sent by the next
   launch that reaches the server, *before* the account's older answer is
   believed. `forgetAccount` empties it, so a switched account never inherits
   a choice or a pending push. **Last delivered wins:** a phone that chose
   offline and comes back online later overwrites a newer choice made on
   another phone in the meantime. Accepted: it is one person's own
   preference, and the remedy is one tap.
4. **Everything underneath stays metric**: GPS, geometry, storage, the
   rules, the protocol's numbers, the archive, and **the PGN**, which is one
   canonical file per game (0041). The only place a meter becomes a foot is
   `src/shared/units.ts`. Metric output is byte-for-byte what the screens said
   before, except that "999.6 m" now reads "1.0 km" rather than "1000 m".
5. **Which US unit:** feet for short things read on the board (reach, a
   square, GPS accuracy, a walk to a square); yards for a board's size; yards
   then miles for distance walked, switching at a mile the way metric switches
   at a kilometer. Feet get a tenth only under ten feet.
6. **Sizes offered as advice are round in the player's units, not
   converted**: "15 ft or more" (not 16.4), "at least 80 ft corner to corner",
   and a new hint before the first calibration tap: squares of "5 to 10
   yards", ground "40 to 80 yards a side". The board is still fitted in
   meters from wherever the corners are tapped.
7. **Server refusals travel as figures beside the words.** The four that
   carry a distance (accuracy, out of reach, back rank, implausible carry)
   send `refusal` on the `error` message next to the metric `message`. The
   phone rebuilds the sentence with the same shared function (`refusalWords`)
   in its player's units, and falls back to `message` for anything it does
   not recognize.

## Why

- **The owner is American**, approved this batch, and reads his own game in a
  foreign unit. 0036 closed this as "not now"; this reopens only the display.
- **Account, not device**, because fields already follow the player between
  phones and a unit that changed when you picked up the other phone would be
  a bug report. Riding on `/api/me` costs no extra request per launch.
- **Locale default**: the owner's phone would otherwise show meters until he
  found a setting. Deciding it on the phone rather than storing a guess means
  an account that never chose stays "never chose", and a later locale-aware
  change is not undoing stored data.
- **Figures, not units passed in, for server strings.** The server would have
  to know each player's units: a read of the UserDO on every socket open (a
  billed request), or a query parameter on the upgrade that goes stale if the
  setting changes mid-game. Outbound messages are free, the client already
  holds the setting, and sharing `refusalWords` keeps one wording in one
  place. Older phones still read `message`.

## Rejected

- **A device setting in `localStorage` only** (like the piece look, 0045).
  Does not follow the player; O-21 named the account.
- **Converting below the view** (storing feet, fitting in yards). Two sources
  of truth for one walk; the PGN would change unit with the author.
- **Units in the PGN.** It is a canonical file (0041); a viewer's preference
  must not change its bytes.
- **Yards for everything short.** "3.5 yd of reach" is not how anyone talks;
  "10 ft" is.
- **Rewriting server strings on the client with a regex.** Fragile, and it
  would silently miss the next sentence someone adds.

## Revisit if

- The game is localized (0036's own revisit): the formatters become part of
  the message catalogue.
- Replay (8.3), the share card (8.5) or head-to-head (8.5.4) need a distance:
  use `shared/units.ts` and the account's setting, not a new formatter.
- A new server refusal names a distance: add a `Refusal` kind rather than a
  metric sentence the phone cannot convert.
