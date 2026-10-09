# Phase 8 — Post-game: PGN, distance, replay

The payoff for storing a position and accuracy with every move. Cheap to store,
and it is both the review feature and the only cheat forensics worth having.

- `8` active: Post-game review

- `8.1` done: PGN export
  - Decision 0041. One canonical file per game, built from stored rows by
    `GameDO.report()` → `buildPgn` (`shared/pgn.ts`); served seat-only at
    `/api/game/:code/pgn` and built again on the phone at mount.
  - `8.1.1` done: Standard PGN with proper headers
  - `8.1.2` done: Positions and carry distances as move comments, so the file
    stays valid in any chess program while carrying the satellite data
    - Positions are board space (squares from a1's centre), never lat/lng.
  - `8.1.3` done: Remember the time control a game started with (`game.initial_ms`,
    schema 5), so `TimeControl` has something true to say; `?` where it predates it
  - `8.1.4` done: Share the file — share sheet with a `File`, then text, then the
    clipboard, then a visible text and a server-answered download link. No mailto.
- `8.2` done: Distance travelled
  - The "After the game" screen (`client/views/review.ts`), reached from the board
    once there is a result. Driver: `scripts/check-review.mjs`.
  - `8.2.1` done: Per-player total, and per-move carry distances
  - `8.2.2` done: A headline summary — "you covered 2.4 km" is the thing people
    will actually repeat to their friends
  - `8.2.3` done: Client-reported and therefore client-trusted, by design. It is a
    stat, not a rule; say so in the UI rather than pretending otherwise.
    - The record's `DISTANCE_HONESTY` sentences, word for word.
- `8.3` active: Replay
  - Decision 0052. The walk is kept as squares from the relays already sent
    (`shared/track.ts`, `presence.track`, schema 8), in the report and the
    archive, never the PGN. Drawn on the review screen (`client/replay.ts`,
    `client/replay-draw.ts`). Driver: `scripts/check-replay.mjs`.
  - `8.3.1` done: Scrub the move list and watch both players' tracks over the board
  - `8.3.2` done: Show where each piece was lifted and placed
  - `8.3.3` done: Keep each player's walk, as squares, from fixes already received —
    no new message, no new row written; archived games before it draw straight carries
  - `8.3.4` todo: Real-phone look: is the replay readable in sun, do the walk lines
    (dashed, dotted, faint) read apart, does a finger on the board scroll the page at
    1x and pan it zoomed, and do the tracks look like the walk that was walked?
- `8.4` done: Archive finished games to KV as PGN plus track, then delete the DO
  storage so the object ceases to exist
  - Decision 0042. `worker/archive.ts` (the value), `worker/collection.ts` (when),
    `GameDO.retire` (the steps). Driver: the archive steps of
    `scripts/check-review.mjs`, through `POST /api/dev/game/:code/collect`.
  - `8.4.1` done: One KV value per finished game — the PGN and the report, in
    board space, with no coordinates, no account and no join code in it
  - `8.4.2` done: Everything reads the archive when the object has gone —
    `/review`, `/pgn`, a re-join (straight to the review) and `GET` — seat-only,
    checked against the player's own record or index line
  - `8.4.3` done: Delete only when it is safe: a day after the last look, no
    board open, record and index lines landed, the archive settled and read back
  - `8.4.4` done: Nothing brings a deleted object back — the schema is created
    only by `create`, every path checks for tables first, and an archived code
    is never handed out again
  - `8.4.5` done: O-34 — the field goes to anybody only while a seat is free,
    then only to the two players; an archived game shows its players nothing
    but that it is archived

- `8.5` active: The social layer — bragging without broadcasting location
  - All four rules of decision 0018 are load-bearing. Read it before building any
    of this; the failure mode is a share card that quietly discloses where someone
    lives.
  - The share card is decision 0053: carries, not walks; the field's name only
    when ticked; no date, code or names; 1080 × 1350; made on the phone
    (`client/share-card.ts`, "Share a picture of this game" on the review).
    Driver: `scripts/check-share.mjs`.
  - `8.5.1` done: Share card rendering both players' paths **in board space** — no
    map, no coordinates, no scale tied to a real place. The route across the 8×8
    grid is the striking image and it is unlocatable by construction.
    - The paths are the carries, lift to place, as the PGN holds them; never the
      walks (0053).
  - `8.5.2` done: Distance, result, move count, longest carry, board size on the
    card. Field name only if the player authored one; never reverse-geocode.
    - The sharer's own distance and longest carry; the field's name opt-in, off
      every time, never the app's "My field" or "Shared field".
  - `8.5.3` done: Emit via the share sheet. Push only — no public profile page, no
    player directory, no way to look up someone you have not played.
    - Share sheet with the PNG, then a download, then the picture on screen. No
      request, no server copy, no URL; metadata chunks stripped from the PNG.
  - `8.5.4` active: Head-to-head record with each opponent, shared between the two
    participants. They stood there; this discloses nothing new, and it is the
    richest social surface available without the hazard.
    - Decision 0054: a pair id (a hash of both accounts) and the other player's
      distance on each new record row; folded from each player's own rows, so
      both agree by construction; a nickname only the reader sees. "Against
      each opponent" on the account screen, "Your record against this player"
      on the review (`views/opponent.ts`). Driver: `scripts/check-h2h.mjs`.
    - `8.5.4.1` done: Pair id and opponent distance on the record line, written
      exactly once by the existing push; schema 4; older rows left out and counted
    - `8.5.4.2` done: The list, the per-opponent screen, nicknames, and the link
      from the review; nobody can ask about anybody else
    - `8.5.4.3` todo: Real-phone check: does "Against each opponent" read well
      and is it found; does a nickname feel private; do both players' phones
      show the same meters after a real game, in both units?
  - `8.5.5` todo: Lifetime and rolling aggregates only for anything public.
    Per-game location tracks stay private to the participants.
    If the share card ever offers both players' walks, it needs both players'
    consent: the watch link's ask-and-agree (`onWatch`, decision 0055) is the
    mechanism to reuse.
  - `8.5.6` todo: Global aggregate leaderboard on distance or games, if wanted.
    Field-scoped leaderboards are forbidden (decision 0017).
  - `8.5.7` todo: Real-phone share check: does the sheet take the PNG on Android
    and iOS (and into which apps), does the download rung save it where the sheet
    will not, does a long press on the picture save it, does the card read well
    in a chat and a feed, and does the saved file carry no location or EXIF? Does
    iOS keep both the file and the text line in one share, or drop one of them?
