# 0042 — A finished game leaves as an archive, and its object ceases to exist

- **Date:** 2026-09-23
- **Status:** accepted
- **Stage:** 8.4, 3.6.2; answers O-34
- **Amends:** [0025](0025-suspension-lasts-a-month-then-the-other-player-may-claim.md) rule 6
- **Builds on:** [0017](0017-play-history-belongs-to-players-not-places.md), [0038](0038-a-cold-start-finds-its-game-through-the-index.md), [0040](0040-the-record-is-one-line-per-finished-game-and-totals-are-derived.md), [0041](0041-a-game-leaves-as-one-pgn-in-board-space.md)

## Decision

1. **A finished game is archived to Workers KV and its Durable Object deleted**,
   a day (`FINISHED_GAME_GRACE_MS`) after the later of its result, its last
   change, and a player last re-taking a seat. An open socket puts it off
   another day. This amends 0025 rule 6 ("games are never deleted on a timer"):
   the *object* goes; the game does not.
2. **What survives, and where.** The review, the PGN and the record survive,
   all without the object. The **archive** is one value in the `ARCHIVE`
   namespace at `game/v1/<CODE>`: the canonical PGN (0041), byte for byte, and
   the review's report — board space only, built by a whitelist of named fields
   (`worker/archive.ts`). **No latitude, longitude or field snapshot. No account.
   No join code in the value.** No expiry. The **record** line (0040) and both
   **game-index** rows stay in the players' accounts. The index rows now point
   at the archive.
3. **The "track" is the lift and place fixes, as squares.** The server never
   held any other positions (0008 keeps GPS off the wire), and 0041 already
   turns them into squares.
4. **Seat checks against an archive ask the player's own account.** The route
   reads the archive, then asks `UserDO.seatIn(code)` for the session's `sub`:
   its record line, or else its index row. A stranger, a signed-in non-player
   and a code with no archive all get the same 404. A missing session gets 401.
   `/review`, `/pgn`, `POST /api/game/:code` (re-join) and `GET` all read it.
   A re-join of an archived game answers `200 {archived: true, color}` with no
   field, and the phone opens the review.
5. **Deletion waits until everything owed has landed.** In order, one `gc`
   firing per step: (a) the record and index lines for both seats match what
   the accounts accepted, retried a day at a time for a week, then kept alive
   until a re-join; (b) the archive is written; (c) `ARCHIVE_SETTLE_MS` (10 min)
   passes for KV to propagate, and the archive reads back as the same PGN;
   (d) the deadline and the open sockets are checked once more, with nothing
   awaited since, then `deleteAll()`. Failed writes and disagreeing read-backs
   share one 12-attempt doubling ladder (~34 h, longer than a UTC day so a
   daily KV cap can reset). After that the game is kept until a re-join.
6. **A code that has been archived is never handed out again.** `create` reads
   the archive key first, because the archive, the record lines and the index
   rows are all filed under that code.
7. **Nothing may resurrect a deleted object.** The schema is created only by
   `create`, and on the wake of an object that already has tables. Every read
   checks `hasGameTables` first. The alarm, socket and close handlers return on
   an empty object. Collection no longer re-creates the empty schema after
   `deleteAll`, which is what kept collected codes alive before.
8. **Unplayed games are collected (3.6.2).** Both seats taken, no move ever
   played, and nothing for 30 days (`UNPLAYED_GAME_TTL_MS`): deleted, with both
   index rows dropped. No archive, because there is no game to review. **A game
   with moves and no result is never collected**, per 0025. **Nor is a game
   paused before any move with somebody recorded as stopping it**: its claim
   opens on day 30, and "Your games" and the board both promise it. Only a
   suspension nobody can claim (both players vanished at once) counts as
   unplayed. Unclaimed codes still go at 30 minutes. Both deletes re-check
   synchronously after dropping the index rows: a join, re-join or start in
   that await keeps the game.
9. **O-34: the field goes to anyone only while it is an invitation.** A
   `waiting` game with a free seat shows its field to anybody. Once both seats
   are taken, only the two players' sessions get it. An archived game reads as
   `{exists, status: 'finished', archived: true}` to its players and as
   `{exists: false}` to anyone else.
10. **One alarm, as always.** It is all the `gc` timer, re-derived from stored
    columns by the pure `collectionDue` (`worker/collection.ts`) every time it
    fires. A local-only `POST /api/dev/game/:code/collect` sets every duration
    for one game. It sits behind the dev seam's two locks (0029), so drivers can
    watch this in seconds.

## Why

The stage said to delete the object, and 0025 said nothing may be deleted. The
two conflict only if the object *is* the game. It is not. What a player keeps
is the result (the record), the list entry (the index) and the review and file
(the archive). All three live somewhere cheaper, so the object can go.
Unplayed games are outside 0025's promise ("once two people have *played*").

The seat check asks the account because an archive with accounts in it is a
list of who played whom, readable by anybody with namespace access. A salted
hash of the `sub` in the archive was the alternative. It avoids one Durable
Object request per archived review, but a `sub` is not secret, so the hash is
testable. The record line is permanent (0040) and was delivered before deletion
(rule 5), so it is a seat check that already exists.

## Rejected

- **Keep every object for ever (0025 as written).** It is free on storage, but
  O-34 stays open for ever and every stray code becomes a live object.
- **A TTL on the archive.** It would delete a game's history on a timer, which
  0025 exists to prevent. At about 30 KB a game, 1 GB is ~33,000 games.
- **Archiving suspended games with moves after N days**, or collecting a
  zero-move suspension somebody could claim. Either takes the claim button away
  (0025). The second is deleted on the very day the claim opens.
- **Leaving a board open on a deleted game to reconnect for ever.** Instead,
  after three refused upgrades in a row the phone asks `GET /api/game/:code`:
  `archived` opens the review, `exists:false` says the game is gone, and both
  stop retrying. That is one HTTP request, and no socket traffic.
- **Seat hashes, or accounts, in the archive.** See Why.
- **Rebuilding the PGN from the archived report on read.** A later change to
  `buildPgn` would silently rewrite old files. The report is kept too, for the
  screen.
- **Writing the archive at the result.** Nothing reads it while the object
  lives. Writing late lets it be checked against the object just before the
  delete, and one step then covers the retry, the settle and the read-back.
- **A dev-only `GRACE` environment variable.** One mis-set var on a deployed
  Worker would archive games in seconds. The route needs the loopback lock too.

## Revisit if

- The archive namespace nears 1 GB, or KV writes (1 per finished game) start to
  matter against sessions' share of the 1,000/day (`reference/budget.md`).
- Players want to delete a game's archive themselves. Forgetting a game
  (2.3.4.2) removes the pointer, not the archive.
- The replay (8.3) needs more than lift/place fixes. That is a change to what
  the server records, not to this.
