# Verified platform behaviour

Everything here was tested against `wrangler dev` (wrangler 4.114.0, local mode) on
2026-07-25, not inferred from documentation. Re-verify if the compatibility date
moves substantially.

## Confirmed working

| Capability | Result |
|---|---|
| SQLite DO storage via `new_sqlite_classes` | Works. `ctx.storage.sql.exec` fine; `sql.databaseSize` reported 20480 for an empty table. |
| `ctx.acceptWebSocket(ws, tags)` | Works. Message echoed via `webSocketMessage`; `ctx.getWebSockets()` returned 1. |
| `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('p','P'))` | Works. `p` was answered with `P` **without** invoking `webSocketMessage` — free keepalive, no wake, no billed request. |
| `env.GAME.getByName(name)` | Works and is deterministic. Same name returned the same 64-hex id across separate requests. |
| `ctx.storage.setAlarm` / `getAlarm` | Works. |
| Assets binding (`env.ASSETS.fetch`) alongside a Worker | Works. |
| `blockConcurrencyWhile` | Present. |

Probe source is not kept in the tree; it was a throwaway `GameDO` that reported
`typeof` for each API and round-tripped a SQLite row, a WebSocket message and an
alarm.

## Constraints these confirm

- **`new_sqlite_classes` is mandatory.** `new_classes` is the legacy key-value
  backend and fails to deploy on the free plan with error 10097. The KV storage
  backend is unavailable on free, and as of mid-2026 new KV-backed namespaces are
  restricted even on paid accounts without an existing one.
- **Free tier: 5 GB DO storage, up to 100 DO classes, 100k requests/day.**
  Storage is not the ceiling; requests are. See [`budget.md`](budget.md).
- **Inbound WebSocket messages are billed as requests** on a hibernatable object.
  Outbound are not, which is why the server broadcasts full snapshots rather than
  maintaining a delta protocol.
- **A Durable Object has exactly one alarm.** Hence the `timers` table
  (decision 0006).
- **A Durable Object whose storage is entirely empty ceases to exist.** Useful for
  garbage collection; also means a suspended game must keep rows to survive.

## chess.js

Version 1.4.0. Confirmed by probe:

- `new Chess()`, `.fen()`, `.turn()`, `.moves({verbose:true})`, `.history()`.
- **`move()` throws on an illegal move** rather than returning null, as it did in
  0.x. The DO must catch this and map it to an `illegal_move` error, or an illegal
  input from a client would fault the object.
- Move objects carry `color, from, to, piece, captured, promotion, flags, san, lan,
  before, after`, plus predicate methods including `isCapture()`.
- Terminal detection: `isCheckmate`, `isStalemate`, `isDraw`,
  `isInsufficientMaterial`, `isThreefoldRepetition`.
- `pgn()` and `setHeader()` exist, for phase 8.
- Pure JS, runs in a Worker unmodified.

## Environment note

`wrangler dev` emits `Unable to fetch the 'Request.cf' object` warnings and a
proxy-related `Request was cancelled` trace in this container. Harmless — it falls
back to a placeholder `cf` object and the server works. Requests to it need
`--noproxy` / `NO_PROXY` set, or they are intercepted by the agent proxy.
