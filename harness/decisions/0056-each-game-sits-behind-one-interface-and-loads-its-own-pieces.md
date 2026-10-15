# 0056 — Each game sits behind one interface; the phone fetches only that game's pieces

- **Date:** 2026-10-14
- **Status:** accepted
- **Stage:** 11.1 (O-57)
- **Builds on:** [0001](0001-two-phase-carry.md), [0005](0005-back-rank-resume-handshake.md), [0008](0008-client-computes-reach-server-decides.md), [0041](0041-a-game-leaves-as-one-pgn-in-board-space.md), [0042](0042-a-finished-game-leaves-as-an-archive-and-its-object-ceases-to-exist.md), [0045](0045-pieces-are-the-standard-two-sided-set.md)

## Decision

The owner's constraints (O-57): one system, not over-integrated; a phone
must not download many engines; a field is never re-calibrated to play a
different game. Chess moved behind this with no change a player or a file
can see; checkers (American rules, each hop walked, "jumps are required" a
creation setting, PDN) is the next two stages.

1. **Three doors per game, by runtime and weight** (`shared/games/types.ts`).
   - **`GameDescriptor`**, in `shared/games/<game>.ts`, statically in both
     the Worker and `app.js`: name, lattice, start zones, waypoints yes/no,
     creation options, record format (PGN/PDN), piece letters, place choices
     (promotion), and the **position codec** — `initialState`, `pieceAt`,
     `piecesOf`, and `applyKnown`, which moves a piece the server has already
     called legal, for the prediction and the replay. No legality.
   - **`GameRules`**, in `worker/games/`, the descriptor plus the authority:
     `stops` (where a carried piece may stop next), `play`, `ending`,
     `timeout` (chess: no mating material draws), `normaliseOptions`, and
     the record file. Chess's is chess.js, moved out of `GameDO` unchanged.
     Only the server holds it.
   - **`GameArt`**, in `client/games/`, fetched by the phone when that game
     is first shown: the pieces as drawn and the record writer. Its own file
     (`/games/chess.js`), built apart from `app.js` and imported dynamically
     as `/games/chess.js?v=<content hash>`. Views draw synchronously with the
     art or without pieces, and repaint when it lands; the review waits for it
     before building the file. The build fails if `app.js` ever bundles a
     game's art or any client file bundles chess.js.
2. **A carry is a lift, zero or more waypoints, then a place** (generalising
   0001). A `waypoint` message (`{t, to, pos, travelM?, leg?}`) means "I am
   standing on the square this piece hops through"; each stop is judged for
   reach where it is made, and the walk between consecutive stops for
   plausibility. `stops(state, {from, via})` answers both `places` (end the
   move) and `waypoints` (go on from). Stored as `carry.via_json` and
   `moves.via_json` (schema 9), `[{sq, lat, lng, acc, at}]`, NULL for none.
   `onPlace` already judges the last leg from the last stop. **Chess never
   has a waypoint:** its `stops` returns none, and the server has no
   `waypoint` handler yet, so one in a chess game is answered as an unknown
   type, exactly as today. Stage 11.2 adds the handler.
3. **Storage: `game.game_type` and `game.options_json`** (schema 9). A new
   game writes its type; **NULL is chess**. Nothing is backfilled. The report,
   the archive, the snapshot, the watcher's view and the join answer carry
   `gameType` and `options` **only when not chess with no options**, so every
   chess message, file and archive is byte for byte what it was, and **absent
   is chess** everywhere. The archive stays `v1` (an optional field, as 0052).
   A create with a type the server has no rules for is a 400; a stored type
   it does not know refuses moves rather than playing them as chess.
4. **Fields do not change.** The calibrated rectangle is the field; a game
   lays its `lattice` on it. Chess and checkers are 8 × 8, the field's own
   geometry, so nothing moves now; checkers' `playable` is the dark squares.
5. **The service worker precaches `/games/chess.js`**, answers a versioned
   request only with that version while the network can be reached, and
   falls back to the latest held copy offline.

## Why

The pieces' art (9 kB of `app.js`) and the PGN writer (3 kB) are most of
what is chess-specific on the phone; the engine was never there. Measured:
`app.js` 225,428 → 214,815 bytes (76,922 → 72,429 gzipped), and
`games/chess.js` 13,921 bytes (5,230 gzipped), fetched once. The codec
stays in `app.js` because the prediction (`optimistic.ts`) and the replay
need it synchronously, it is a few hundred bytes a game, and it decides
nothing.

Two bundles rather than esbuild's code splitting: splitting names shared
chunks by hash and `app.js` imports them statically, which a static service
worker cannot precache.

"Absent is chess" rather than writing `'chess'` into every message keeps
the golden comparison (`scripts/check-golden.mjs`) byte-identical, and gives
one rule for old rows, old archives and old phones.

## Rejected

- **One interface holding art and rules together.** The phone would bundle
  chess.js or the server the art; neither runtime wants the other's half.
- **The codec in the lazy file too.** The prediction and the replay would
  have to wait on a fetch; prediction exists to remove a wait.
- **A per-game Durable Object class.** The clock, carry, handshake, record,
  archive and watching are the same code; one class with a rules field is
  the "not over-integrated" the owner asked for.
- **Renaming `fen`, `san` and the archive's `pgn`.** Wire and archive names;
  each now means "the game's own" (a PDN position is also called a FEN).
- **Backfilling `game_type = 'chess'`.** A write to every object on wake.

## Revisit if

- A game needs a lattice that is not 8 × 8 (backgammon's 24 points). The
  field geometry (`shared/field.ts`) and `Square` names assume eight a side;
  that game's descriptor will need its own square naming and a geometry laid
  over the field's outer rectangle.
- A second game ships: `descriptorFor` must stop drawing an unknown type as
  chess and tell a phone left on old code to update; the record line may
  want a type; head-to-head may want to split by game; and the share card's
  "SATELLITE CHESS" and the share text's "playing chess" are chess's words.
- The lazy file grows past a few tens of kilobytes, or a game wants to play
  offline on first launch without being in the precache list.
