# 0052 — The replay keeps each walk as squares, from the relays already sent

- **Date:** 2026-10-03
- **Status:** accepted
- **Stage:** 8.3
- **Amends:** [0042](0042-a-finished-game-leaves-as-an-archive-and-its-object-ceases-to-exist.md) rule 3 (the "track")
- **Builds on:** [0008](0008-client-computes-reach-server-decides.md), [0018](0018-bragging-without-broadcasting-location.md), [0041](0041-a-game-leaves-as-one-pgn-in-board-space.md)

## Decision

1. **A game keeps each player's walk during play** (`presence.track`,
   schema 8), built only from fixes the server already receives: every
   accepted `pos` relay and the fix on every `lift` and `place`. **No new
   message is sent**, and the phone's relay policy is unchanged.
2. **As squares, from the moment it arrives.** Each fix is turned into
   squares from a1's centre (`toBoardIndex`) and rounded to a hundredth of a
   square before it is stored. The game never holds a trail of latitudes.
3. **Appended inside the `UPDATE` that already stores the fix**, so it costs
   no row written and no request. `track_n` counts the fixes, so the cap is
   checked without parsing.
4. **Only while the game is `active`**, as distance is: not the walk to the
   back rank, a pause, or a re-opened finished board.
5. **Each fix is `[tag, file, rank]`**: `tag >> 1` is the number of moves
   completed when it arrived, `tag & 1` is whether that player had a piece in
   hand. A lift's fix is 0 (it arrives before its carry exists), a place's
   is 1. So the replay can split each move into the walk to the piece, the
   carry, and the other player meanwhile (`shared/track.ts`).
6. **At most 2,000 fixes a player** (about 90 minutes of continuous walking at
   the relay ceiling). Past that nothing more is kept, and later carries are
   drawn straight from lift to place, which the moves hold anyway. Fixes more
   than 100 squares from a1 are dropped.
7. **In the report and the archive, never in the PGN.** `GameReport.tracks`
   is seat-only like the rest of the report. The archive keeps it (named, and
   rebuilt fix by fix by `sanitizeTracks`), at the same version, `v1`, because
   the field is optional. The PGN is the file that is forwarded, and per-game
   walks stay with the two players (8.5.5).
8. **The replay is drawn from the report alone**, on the review screen, so a
   live game and an archived one replay the same, and scrubbing sends
   nothing. The board is a unit board of squares with no north
   (`replay-draw.ts`), drawn by the game's own renderer: both piece looks and
   the pinch zoom. Positions come from applying the report's moves without a
   rules engine (`applyMoveToFen`), so chess.js stays out of the bundle.

## Games from before this

- **Archived before it**: no `tracks` key; it reads back as `null`. The replay
  works, draws each carry as a straight line from lift to place, and says
  walks were not kept for this game.
- **Finished but not archived**: the upgrade adds empty tracks; the same.
- **In play at the deploy**: the walk is kept from the deploy on. Earlier
  moves are drawn straight. Nothing earlier can be reconstructed, because
  nothing earlier was stored (the presence row held only the last fix).

## Why

Before this the server held one position per player (overwritten on every
relay) plus the lift and place fixes, so the only replay possible was a
straight line per carry. The relays that would make a walk already arrive and
are already written, one row each. Keeping them as text on that row costs
nothing against the request budget or the SQLite row-write allowance (100,000
rows written a day on the free plan), and about 16 bytes a fix in KV: a
typical game adds 5–10 KB per player to its ~30 KB archive, and up to ~78 KB
a game at the cap. 1 GB still holds about 9,000 games at the worst case.

## Rejected

- **(a) Lift and place only.** Free, but "watch both players' tracks" would
  be two dots per move, and the share card (8.5.1) wants the route.
- **A track table, one row per fix**: an extra row written per relay, which
  halves the games a day the row allowance would bear, for nothing a column
  does not do.
- **Storing latitude and longitude and converting on read**: a trail of where
  somebody stood, held in the object until deletion. Squares at arrival mean
  it never exists.
- **Putting the walk in the PGN**: the file travels; the walk is the players'.
- **A new archive version (`v2`)**: every key would move, and `isArchived`
  checks the `v1` key to keep a code from being re-used. An optional field
  needs no version.
- **Caching the report on the phone for an offline re-open**: a seat-only
  walk left in browser storage on a phone that may change hands. The replay
  works offline once the review is loaded, which is when a player is on the
  field.

## Revisit if

- The share card wants a finer grain than a hundredth of a square.
- Games regularly hit the 2,000-fix cap: thin the track rather than stop it.
- The archive namespace nears 1 GB.
- A player asks to delete their walk: today forgetting a game removes the
  pointer, not the archive (as 0042).
