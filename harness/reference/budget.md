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
  that ignores the policy. All three live in `src/shared/protocol.ts` so both ends
  agree on the numbers.
- Keepalive must go through `setWebSocketAutoResponse`. A hand-rolled ping/pong
  would wake the object and be billed, turning idle games into a cost.
- The clock is never polled. It ticks locally on each client from the snapshot,
  corrected by a server-time offset, and flag-fall arrives via one alarm.
- Broadcast full snapshots freely. Outbound is not billed, so a delta protocol
  would be complexity in exchange for nothing.

Stage 9.5 measures this against a real game rather than trusting the arithmetic.
