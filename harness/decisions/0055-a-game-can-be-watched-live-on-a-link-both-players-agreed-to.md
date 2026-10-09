# 0055 — A game can be watched live, on a link both players agreed to, in board space only

- **Date:** 2026-10-08
- **Status:** accepted
- **Stage:** 10.14 (O-37)
- **Builds on:** [0006](0006-sqlite-do-and-hibernation.md), [0018](0018-bragging-without-broadcasting-location.md), [0042](0042-a-finished-game-leaves-as-an-archive-and-its-object-ceases-to-exist.md), [0052](0052-the-replay-keeps-each-walk-as-squares-from-the-relays-already-sent.md)

## Decision

The owner's purpose: family indoors watch the game being played outside, live,
with both players visible.

1. **Both agree, either stops.** One new inbound message, `watch` with
   `on` or `off`, one per tap. `on` asks; `on` into the other player's open
   ask agrees, and only then is there a link. `off` from either player
   withdraws an ask, declines one, or turns watching off. Only while both
   seats are taken and the game is not over.
2. **A link with its own secret.** `/w/<object id>.<secret>`: the game's
   Durable Object id (64 hex characters) and 128 random bits, new every time
   watching is turned on. The id lets the Worker reach the game
   (`idFromString`) without a lookup table and without the join code, which
   opens a seat while one is free and is not in the link. The secret is in
   the game's `meta` (`watch_token`), compared in constant time. Holding the
   code gives no watching; holding the link gives no seat, no field, no
   code. No directory, no listing.
3. **Board space only, built apart.** A watcher is never sent a player's
   message. The game builds a separate view (`watchSnapshot`, field by field,
   never by trimming a player's snapshot) and a separate relay (`watch_pos`):
   squares from a1's centre to a hundredth, the moves, the clocks, both dots,
   the last move, the piece in hand, each player's meters walked, the board's
   size. No latitude, longitude, field, corners, name, bearing, accuracy,
   reach, join code or account. A dot more than 3 squares off the board is
   sent as no position at all.
4. **Watchers only receive.** Anything a watcher sends closes its socket
   (4004) before a row is read. The players' phones send nothing extra.
5. **The link dies** when either player turns it off (watchers closed with
   4001, "not live") and when the game ends, finished or aborted (each
   watcher is sent the final position and result, then closed with 4002). The
   secret is deleted in the same synchronous step, so the link stops working
   at once. A wrong secret, a link turned off and a game that is over get the
   same 4001. A game whose object has since been collected answers the
   upgrade with a 404 instead, so a link holder can tell a collected game
   from a live one. That is harmless: the id is 256 bits, so nobody without
   the link can find either, and the link holder already knew the game.
   An unanswered request lapses when the game is paused or suspended; a link
   already agreed to stays on.
6. **The cap: 6 watchers a game** (`WATCH_MAX_WATCHERS`). The seventh is
   accepted and closed at once with 4003, "Too many people are watching", and
   nobody already watching is moved. Its page does not retry.
7. **No coaching delay.** A watcher sees the game as the players do.
8. **Watchers are nobody to the game.** Accepted under their own tag
   (`watcher`) with an attachment that names nobody; every place that walks
   `getWebSockets()` asks the attachment. A watcher arriving or leaving
   touches no presence row, timer or revision and sends nobody anything. So
   it never counts toward `allConnected`, `absentColour`, the back-rank
   handshake, the disconnect grace or suspension, the game index, the record,
   or collection's "somebody has this board open".
9. **The page** is `/w/<link>`, mounted before the simulator, before the
   location provider and before the sign-in gate: no sign-in, never asked for
   a location. It shows the board on the replay's unit board (no north), pinch
   zoom, both dots (each side's color inside a red ring), the piece in hand on
   its carrier's dot, clocks, moves, last carry, walked distances and the
   board's size in the device's units (the locale's when signed out), both
   piece looks, and a flip. It sends nothing but the free keepalive.
10. **The players' control** is one secondary button on the board, "Let people
    watch" (then "Watching…"), opening a panel: ask, wait, agree or decline,
    and once on the link with a QR, Share and Copy, and "Turn watching off".
    The other player's ask is a banner whose Agree is dead for a second. While
    on, a line under the prompt says so, so both always know they are watched.

## Why

**Budget.** A watcher costs one request to connect and none after: it sends
nothing, and the keepalive is answered by the runtime without waking the
object. Hibernation means an idle watcher costs no duration; the object
wakes only for the players' own messages, which it would anyway. Each
broadcast is built once and sent to every watcher (outbound is free). Six
watchers reconnecting twice each is a dozen requests against the ~1,000 a
game already costs. The cap is a family's worth, and keeps a link pasted
somewhere public from turning one game into a fan-out.

**Delay.** Both players have agreed to be watched, the purpose is family, and
a watcher who wanted to coach could equally stand at the field's edge. A
hibernation-safe delay would have to keep a history of views and send each
one late, which needs either a timer per broadcast through the one alarm
(billed wakes) or a watcher that asks (billed messages). It would also make
the dots lag the players, which is the thing worth watching.

**The id in the link** rather than the code, a KV index or a new object
class: it needs no new storage, no binding and no secret, and a revocation is
strongly consistent because the secret lives in the game.

## Rejected

- **The join code as the link**, or the code inside it: a code opens a seat
  while one is free, and O-34 already keeps a code from showing the field.
- **Forwarding the players' snapshots with fields deleted.** A field added to
  the snapshot later would leak by default. Built apart, a new field is absent
  until someone adds it on purpose.
- **Positions as fuzzed coordinates.** 0018: board space has nothing to recover.
- **One player alone turning it on**, or watching that survives a revocation.
- **A watcher count on the players' screens**: it would make watchers arriving
  news to the players, the coupling rule 8 forbids.
- **Sign-in to watch**: it is a link a player sends to family.

## Revisit if

- Strangers start watching (a club, a tournament): then a delay, and a cap
  that is a setting rather than a constant.
- The share card wants "both players' walks" (0053's revisit note): the same
  both-agree mechanism could carry that consent.
- Watching shows up in the request budget (stage 9.5).
