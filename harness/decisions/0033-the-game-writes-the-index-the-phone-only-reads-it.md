# 0033 — The game writes the index; the phone only ever reads it

- **Date:** 2026-09-08
- **Status:** accepted
- **Stage:** 2.3.4 (and 3.5.2, which it needs)

## Decision

The game index — the list of games an account has a seat in — is written by
**`GameDO`, over the `USER` binding, and by nothing else**.

1. **No endpoint lets a client write a row.** The API is `GET /api/games` and
   `POST /api/games/forget`. There is no create, no update, and no "report my
   result".
2. **`GameDO.syncIndex` pushes a line to each seated account** when the game
   changes state: created, joined, started, suspended, resumed, finished, and
   collected. **Not on a move.** A push is a request against 100k/day and a game
   is forty moves long, so `lastMoveAt` rides along with the next transition
   rather than earning a push of its own.
3. **A push is skipped when the line has not changed.** The line is built
   entirely from stored columns, so it is deterministic, and its digest is kept
   in the game's `meta`. Re-taking a seat is the one thing that pushes anyway.
4. **Only a seat with an account gets a line.** `white_account` / `black_account`
   are new columns; a seat held by a phone that never signed in has none, and
   that game appears in nobody's list.
5. **The seat key is the Google `sub` when the request carried a session**
   (stage 3.5.2, superseding the anonymous `playerId` for signed-in play). The
   `playerId` in the body is honoured only when there is no session.
6. **Nothing server-side ever removes a played game's row.** `POST
   /api/games/forget` is the only path, it is the player's own act, and it
   refuses any game that is not `finished` or `waiting`.

## Why

**Rule 1 is the decision, and rule 5 is what makes rule 1 usable.**

*Why the game writes it.* Stage 2.3.5 — the permanent record — is built on these
rows, and decision 0014 makes that record the reason accounts are mandatory at
all. A result the player could POST to themselves is not a record; it is a note
of what they felt like claiming. Distance walked is already client-reported and
knowingly so (decision 0019, observation O-03), and that is tolerable precisely
because it is one soft number in a record whose hard facts — who played, which
colour, what the result was — come from the only thing entitled to state them.
Closing that door now costs nothing; opening it later would be a migration
through every row ever written.

*Why the seat had to stop being a phone.* The stage is called "a cross-device
resumable game list", and without rule 5 it is a cross-device **readable** list:
the second phone can see the game and cannot sit down, because `join` matches on
a UUID that lives in one browser's `localStorage` and answers `game_full` to
anybody else. A list of games you can look at and not enter is worse than no
list, because it looks like a bug in the game rather than a missing feature.

*Why not on every move.* Denormalising the line is what lets a list of ten games
render without waking ten Durable Objects. Refreshing it per move would hand
that saving straight back — and the thing it would buy, an accurate "last moved"
on a game you are in the middle of playing, is information for finding a game
you have lost, which by definition you have not.

*Why a suspended game can never be tidied away.* A join code is the only handle
on a game (decision 0007). Deleting the row of a game that is merely suspended
destroys the only route either player has back to it, and decision 0025 says
that game may still be resumed for a month and claimed for ever after. It reads
as harsh — a row can be stuck there indefinitely if an opponent never returns —
but the exit already exists and is the one 0025 designed: claim the win once the
month is up, or resign. Tidying is for games that are over.

## Rejected

**The phone pushes its own index, as `field-sync.ts` does for fields.** The
obvious symmetry, and the pattern was already built and tested one session ago.
Rejected on rule 1's reasoning: a field genuinely is the phone's — it is walked
out with no account and no signal, and decision 0013 makes the phone its origin —
and a game genuinely is not. The apparatus that file needs (a journal, an acked
map, delete-versus-never-had-it) exists because the phone is the origin of a
field; none of it is needed here, and its absence is the tell that the direction
is right.

**Server-side tombstones for forgotten games**, so a tidy-up on one phone
propagates. Not needed: the row is server-side already, so forgetting *is* the
propagation. Noted only because 0032 rejected tombstones for fields and the two
answers look contradictory until you notice which end holds the truth.

**A `games` table shared across accounts, keyed by sub.** One table, one index,
trivially joinable both ways. Rejected for decision 0017's reason: it builds a
player→player edge through games, and the whole shape of this system is that
those edges are not constructible.

**Matching a returning player by account while leaving `player_id` as the phone's
UUID.** Keeps the two identifiers separate, which is tidier on paper. Rejected
because it needs the presence row to migrate between phones, the WebSocket
handshake to carry the account as well as the id, and `colorOf` to answer two
questions — a lot of machinery to avoid substituting one string for another at
the boundary.

**Indexing anonymous seats under their `playerId`.** Would give a signed-out
player a list too. Rejected: `getByName(<uuid>)` addresses a `UserDO` that does
not exist, so this would invent an account for every phone, and stage 2.5.1
removes the case anyway by requiring sign-in to play.

## Revisit if

- Two people share one account (a club, a school). Rule 5 makes them one player
  in one seat, which is right for two phones and wrong for two people.
- A game becomes long-lived enough that "last moved" matters while it is being
  played — a correspondence mode, say. Rule 2's arithmetic changes.
- Anything other than `GameDO` acquires a legitimate reason to write a row. It
  would be the first, and rule 1 is the thing to defend rather than the thing to
  amend.
