# 0054 — Head-to-head is folded from each player's own rows, by a pair id; the name is the reader's own

- **Date:** 2026-10-08
- **Status:** accepted
- **Stage:** 8.5.4
- **Amends:** [0040](0040-the-record-is-one-line-per-finished-game-and-totals-are-derived.md) rule 4 ("no opponent")
- **Builds on:** [0018](0018-bragging-without-broadcasting-location.md), [0019](0019-distance-is-the-currency-not-games.md), [0035](0035-the-gate-opens-when-the-server-cannot-be-asked.md), [0042](0042-a-finished-game-leaves-as-an-archive-and-its-object-ceases-to-exist.md), [0050](0050-a-game-can-be-resigned-drawn-or-aborted-from-the-board.md)

## Decision

1. **Who the opponent was: a pair id on each new record row.** `GameDO`
   computes `SHA-256("satellite-chess/head-to-head/v1\n" + the two subs,
   sorted)`, cut to 128 bits of hex (`pairIdFor`, `worker/user-record.ts`),
   once per game, keeps it in `meta.pair_id`, and puts it in both players'
   record lines. It is the same in both rows and different for every pair.
   **No row holds the other account's `sub`, email or name.** User schema 4
   adds `record.pair_id` and `record.opponent_travel_m` (the other player's
   distance, exactly as their own line holds it) by `ALTER`.
2. **Exactly once, as before.** The pair id and the other distance are part of
   the line, so they ride the existing digest-and-upsert (0040 rule 3): no new
   write, no new timer. A game that finished before this and still has its
   object gets them when its line is next pushed (a re-join, or collection's
   "have the lines landed" step), into the same row.
3. **Both players see the same tally, by construction, not by storing it once.**
   Each account folds its own rows (`summarizeHeadToHead`,
   `shared/head-to-head.ts`) on every read, oldest first with ties by join
   code, so both add the same per-game numbers in the same order and agree to
   the bit, **once both lines for each game have landed** (until a retried
   push lands, one record can briefly hold a game the other does not yet). A game's standing between the two (`pairStandingOf`) is the
   record's rule asked of both sides: unmeasured if either distance is.
   Only counted games enter the tally; practice, unplayed and unmeasured are
   counted beside it.
4. **Meters first** (0019): the headline is meters walked between you
   (`walkedPairWords`, `shared/units.ts`), then "You … · They …", then the
   results. While the total is in the short unit it is the sum of the two
   figures shown, so the line adds up as read.
5. **The name is the reader's own.** No Google name, no email. A player may
   give an opponent a nickname (40 characters, cleaned), kept in their own
   `opponent_names` table, shown only on their own screens, and settable only
   for a pair id already in their record. Unnamed, an opponent is "Unnamed
   opponent, first played Sep 20 at Riverside Park".
6. **Nobody can ask about anybody else.** `GET /api/record` returns the list
   with the record (one request, one object call). `GET
   /api/record/opponent?id=` or `?game=` and `POST
   /api/record/opponent/name` act on the session's account only; a pair id or
   code not in that account is the same 404 as one that does not exist. No
   route takes an account.
7. **Older rows are left out, and counted.** A row with no pair id is never
   guessed at; the list says how many earlier games are not in it, and a
   review of one says it predates the feature. Aborted games write no row
   (0050), so are in neither.
8. **The way in from a game** is "Your record against this player" on the
   review, for a seat, in a game with a result.

## Why

0018 names head-to-head as the one social surface with no location hazard,
because it only tells you about someone who was standing beside you. 0040
refused an opponent column because it would be "a player→player edge by the
back door". The pair id is the narrowest edge that makes this work: it lives
only in the two accounts it describes, cannot be used to address anything,
and is pairwise, so two people comparing their lists cannot discover a third
person they both played (a per-player pseudonym would allow that).

The Google name was rejected because standing beside someone does not mean
you know their legal name, and many Google names are exactly that. A nickname
you type is something you already know.

## Rejected

- **The opponent's `sub` in the row.** Gives the other account's global Google
  identifier to anything that reads the row, and to the phone if ever sent.
- **A per-player pseudonym** (HMAC of one `sub`). Same in every opponent's
  record: comparing notes reveals shared opponents.
- **An HMAC with a server key.** A `sub` is not secret (0042), so the plain
  hash is testable by someone holding both subs; but the id is never queryable
  by anyone but its two players, and a key rotation would split every record.
- **A shared head-to-head row stored once.** A second source of truth, needs
  cross-object exactly-once delivery, and is a place one player reads the other.
- **Deriving the opponent from the game index or the archive.** The index can
  be tidied away and the archive holds no accounts, by design.
- **Showing the Google name, or the email.** See Why.

## Revisit if

- A friends graph or club (0018's "opt-in group") is wanted: that is a new,
  mutual mechanism, not a relaxing of rule 6.
- Players want to see games from before this decision with their opponent: it
  would need a re-push from archives, which hold no accounts, so it cannot be
  done honestly.
- A shared display name is ever wanted: it must be opt-in and chosen by the
  person named, never taken from Google.
