# 0008 — The client computes reach for free; the server decides

- **Date:** 2026-07-25
- **Status:** accepted
- **Stage:** 0.4, 4.2, 4.3

## Decision

Split reach into two jobs with different owners:

- **The client** computes reach continuously, at full GPS rate, for its own UI —
  the reach circle, which pieces are liftable, which destinations are placeable.
  Zero network cost, zero latency.
- **The server** validates reach only at the two moments that matter: the `lift`
  and the `place`. Those messages carry the position fix. The Durable Object
  re-checks against its own copy of the field snapshot and its answer is the only
  one that counts.

Opponent position is relayed coarsely — only on movement greater than 2 m, at most
every 2.5 s, with a server-side backstop — and interpolated on receipt.

Both ends run the same code from `src/shared/reach.ts`.

## Why

Request budget, which is the binding constraint on this whole architecture. On a
hibernatable Durable Object every inbound WebSocket message is billed as a
request, and the free plan allows 100k a day. Streaming 1 Hz GPS from two players
across a thirty-minute game is about 3,600 requests for a single game. The split
above costs roughly 300–600 messages per player per game.

The split has two benefits beyond cost:

- **The UI keeps working through a network blip.** Reach is computed from data the
  client already holds — the field snapshot and the board state — so walking
  through a dead spot degrades the opponent's dot, not your own ability to see what
  you can reach.
- **Latency disappears from the interaction that happens most.** The reach circle
  must track your feet, not your connection.

The client is untrusted *and* does all the per-frame work. Those are compatible
because nothing the client computes is ever load-bearing: it renders hints, and the
server decides.

## Rejected

**Stream every fix to the server and let it drive the UI.** Simplest mental model,
authoritative everywhere, and roughly ten times over budget while being worse to
use.

**Trust the client's reach verdict entirely.** Would work fine between friends —
social enforcement is genuinely the main defence here — but it would make the
stored position log meaningless, and the log is what post-game review and the
distance stat are built on.

## Revisit if

The relay rate turns out to feel bad in practice — an opponent's dot lagging 2.5 s
behind on a large field may be more disorienting than the budget saving is worth
(stage 9.5 measures the real numbers).
