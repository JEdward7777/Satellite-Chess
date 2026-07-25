# Phase 8 — Post-game: PGN, distance, replay

The payoff for storing a position and accuracy with every move. Cheap to store,
and it is both the review feature and the only cheat forensics worth having.

- `8` todo: Post-game review

- `8.1` todo: PGN export
  - `8.1.1` todo: Standard PGN with proper headers
  - `8.1.2` todo: Positions and carry distances as move comments, so the file
    stays valid in any chess program while carrying the satellite data
- `8.2` todo: Distance travelled
  - `8.2.1` todo: Per-player total, and per-move carry distances
  - `8.2.2` todo: A headline summary — "you covered 2.4 km" is the thing people
    will actually repeat to their friends
  - `8.2.3` todo: Client-reported and therefore client-trusted, by design. It is a
    stat, not a rule; say so in the UI rather than pretending otherwise.
- `8.3` todo: Replay
  - `8.3.1` todo: Scrub the move list and watch both players' tracks over the board
  - `8.3.2` todo: Show where each piece was lifted and placed
- `8.4` todo: Archive finished games to KV as PGN plus track, then delete the DO
  storage so the object ceases to exist

- `8.5` todo: The social layer — bragging without broadcasting location
  - All four rules of decision 0018 are load-bearing. Read it before building any
    of this; the failure mode is a share card that quietly discloses where someone
    lives.
  - `8.5.1` todo: Share card rendering both players' paths **in board space** — no
    map, no coordinates, no scale tied to a real place. The route across the 8×8
    grid is the striking image and it is unlocatable by construction.
  - `8.5.2` todo: Distance, result, move count, longest carry, board size on the
    card. Field name only if the player authored one; never reverse-geocode.
  - `8.5.3` todo: Emit via the share sheet. Push only — no public profile page, no
    player directory, no way to look up someone you have not played.
  - `8.5.4` todo: Head-to-head record with each opponent, shared between the two
    participants. They stood there; this discloses nothing new, and it is the
    richest social surface available without the hazard.
  - `8.5.5` todo: Lifetime and rolling aggregates only for anything public.
    Per-game location tracks stay private to the participants.
  - `8.5.6` todo: Global aggregate leaderboard on distance or games, if wanted.
    Field-scoped leaderboards are forbidden (decision 0017).
