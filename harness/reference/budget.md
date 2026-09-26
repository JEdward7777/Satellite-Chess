# Request budget

The single most important architectural driver. Free-tier Workers allow **100,000
requests per day**, and on a hibernatable Durable Object **every inbound WebSocket
message is billed as a request**. Outbound messages are not.

## What the naive design costs

Streaming position fixes at 1 Hz from two players across a thirty-minute game:

```
2 players x 1 msg/s x 1800 s = 3,600 requests for ONE game
100,000 / 3,600 = 27 games per day, account-wide
```

That is the entire daily budget spent on 27 games, before counting HTTP requests
for the PWA shell, joins, or anything else.

## What the chosen design costs

Reach for the UI is computed client-side at full GPS rate, for free, because the
client already holds the field snapshot and the board state. The server needs a
position only at the two moments that matter (decision 0008).

| Source | Per game, per player | Notes |
|---|---|---|
| Position relay | ~250–450 typical, **599 ceiling** | Only on >2 m movement, at most 1 per 2.5 s |
| `lift` + `place` | ~80 | Two per move, ~40 moves |
| `ready` / `sync` / control | ~10 | Handshakes, reconnects, resign, draw |
| Keepalive | **0** | `setWebSocketAutoResponse` never wakes the object |
| **Total** | **~350–550** | |

Roughly **700–1,100 requests per game**, against 3,600 — call it 90–140 games a
day, and that is a limit no two-player-in-one-field game will reach.

**The relay ceiling is measured, not estimated** (`test/net.test.ts`, and
`offerPosition` in `src/client/net.ts`). Feeding the real rate limiter 1 Hz fixes
for thirty continuous minutes sends **599** messages, and that figure is identical
at 0.7, 1.4 and 3 m/s — the 2.5 s interval floor binds long before the 2 m delta
does, so *speed does not matter, only elapsed time*. A 1 Hz offer stream can only
clear a 2,500 ms floor every third tick, which is why it is 599 and not 720.

That makes the worst case **~1,290 requests per game** rather than 1,100, or about
**77 games a day** — still far beyond reach, but the honest number. The 250–450
estimate above stands as the *typical* case, because a real game is not a
continuous walk: players stand still to think, and a stationary player sends
exactly **one** relay message for the whole game, no matter how long they stand
there. The truth for any given game is somewhere between 1 and 599.

## Rules that keep it there

- Never stream GPS to the server. The client computes its own reach.
- Position relay: `POS_MIN_DELTA_M = 2`, `POS_MIN_INTERVAL_MS = 2500`, with
  `POS_SERVER_MIN_INTERVAL_MS = 1500` as a server-side backstop against a client
  that ignores the policy, measured from the last accepted relay (decision
  0047), not from a lift, place or `ready`. All three live in
  `src/shared/protocol.ts` so both ends agree on the numbers.
- Keepalive must go through `setWebSocketAutoResponse`. A hand-rolled ping/pong
  would wake the object and be billed, turning idle games into a cost.
- The clock is never polled. It ticks locally on each client from the snapshot,
  corrected by a server-time offset, and flag-fall arrives via one alarm.
- Broadcast full snapshots freely. Outbound is not billed, so a delta protocol
  would be complexity in exchange for nothing.

Stage 9.5 measures this against a real game rather than trusting the arithmetic.

## Workers KV (stage 8.4, decision 0042)

Free tier: **1,000 writes, 100,000 reads, 1,000 lists and 1,000 deletes a day**,
values up to 25 MiB, 1 GB stored. Two namespaces share the write allowance, which
is account-wide rather than per namespace.

| Namespace | Writes | Reads |
|---|---|---|
| `SESSIONS` | a sign-in, and a throttled sliding renewal (`sessions.ts`) | every authenticated request that carries a Google session |
| `ARCHIVE` | **1 per finished game**, written once a day after it ends. A rewrite happens only if the read-back disagrees | 1 per game created (to check the code was never archived); 1 at the object's last step (read-back); 1 per archived review, file or re-join |

- **The namespace id is pinned.** The first deploy (2026-09-25) created
  `satellite-chess-archive`, id `fe6b455ea33c415f983eee0921c64cdc`, and it is
  now in `wrangler.jsonc` beside SESSIONS', so a fresh checkout or a renamed
  Worker cannot quietly get a second, empty namespace.
- **Key:** `game/v1/<CODE>`. **No TTL.** A finished game's history is kept, as
  decision 0025 promised. **No list operation** is ever made: every read is by
  a known code, so the 1,000/day list allowance is untouched.
- **Size:** about 30 KB for a 40-move game (the PGN, plus a report of ~250 bytes
  a ply). 1 GB holds about 33,000 games. That is the limit to watch, well
  before writes are.
- **Retries:** a failed write, or a read-back that disagrees, is retried on a
  doubling ladder of twelve attempts (about 34 hours), so a day's write cap
  resets before it gives up. Then the game is kept alive, not written again.
- **Writes:** even at 100 finished games a day (far beyond two-people-on-a-field
  play), the archive takes a tenth of the day's 1,000. It cannot starve sign-in.
- **Requests** (the 100k/day budget above): a finished game's `gc` alarm fires
  about three times (the grace check, the write, the settle and delete). Each
  archived read adds one `UserDO` request for the seat check. Both are noise
  next to the ~1,000 WebSocket messages a game costs.
