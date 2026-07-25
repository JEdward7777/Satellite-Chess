# 0007 — The join code *is* the Durable Object address

- **Date:** 2026-07-25
- **Status:** accepted
- **Stage:** 3.1.3

## Decision

Derive the Durable Object id directly from the join code: `env.GAME.getByName(code)`.
There is no join-code → game-id lookup table anywhere.

Join codes are six characters of Crockford base32 (no I, L, O or U;
case-insensitive; lookalikes folded on input), giving about 1.07e9 codes.
Collisions are handled at the object: a `GameDO` that already has two players
rejects further joins, so a collision costs the loser one retry. Unclaimed codes
expire after about 30 minutes via alarm.

## Why

The obvious design — generate a code, store `code → gameId` in KV, look it up on
join — has an eventual-consistency race built into it. KV's propagation window is
around a minute, and the single most common way this game starts is one player
creating a game and the other scanning the QR code three seconds later. That is
precisely the window where the lookup fails.

Deriving the address removes the lookup, and therefore the race, and therefore a
whole class of "it said the game doesn't exist but I'm looking at the QR code"
support問題. Verified deterministic: the same name yields the same 64-character id
across calls.

Crockford base32 is chosen for the human channel rather than the machine one. The
excluded characters are exactly the ones people confuse when reading a code aloud
across a field, and folding `O`→`0`, `I`/`L`→`1` on input means a mis-heard code
still works.

## Rejected

**KV lookup table.** The race above.

**A registry Durable Object holding the mapping.** Consistent, but it is a single
object every game creation and join funnels through — a hot spot and a single point
of failure, in exchange for nothing that `getByName` does not already give.

**Longer codes for a bigger space.** 1.07e9 is ample for the collision-handling
strategy chosen, and six characters is the most a person will reliably read out.

## Revisit if

Concurrent game volume ever gets within orders of magnitude of the code space,
which for a game requiring two people in one field is not a realistic concern.
