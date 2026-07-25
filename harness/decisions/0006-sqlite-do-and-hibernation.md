# 0006 — SQLite Durable Objects, mandatory hibernation, one alarm multiplexed

- **Date:** 2026-07-25
- **Status:** accepted
- **Stage:** 0.8, 3.1, 3.3

## Decision

Three platform constraints, adopted as project rules. All three were verified
against `wrangler dev` — see `harness/reference/platform-verified.md`.

1. **`new_sqlite_classes` in the Wrangler migration.** The free plan requires the
   SQLite storage backend; `new_classes` is the legacy key-value backend and fails
   to deploy with error 10097.
2. **`ctx.acceptWebSocket()`, never `server.accept()`.** Hibernation is mandatory,
   so an idle game — players walking, thinking, resting — is not billed for
   duration. **Consequence: no timing state in memory, ever.** No `setTimeout`.
   Everything must be reconstructible from stored timestamps on wake.
3. **One alarm, multiplexed through a `timers` table.** A Durable Object has
   exactly one alarm, but the design needs at least three deadlines: flag-fall,
   disconnect grace, and garbage collection. Feature code schedules through the
   table; the alarm is always set to the earliest due row.

## Why

The first is not a preference; the deployment fails without it. The KV storage
backend is unavailable on free, and as of mid-2026 new KV-backed namespaces are
restricted even on paid accounts without an existing one.

The second is what makes the free tier viable at all. A game lasts thirty to sixty
minutes of mostly walking; being billed for wall-clock duration would be absurd.
The consequence is the part that catches people out — it is why
`src/shared/clock.ts` is pure functions over stored timestamps rather than a
ticking timer, and why that file has a test asserting a JSON round-trip changes
nothing. That round-trip is exactly what happens on every wake.

The third is a direct consequence of the second. Three deadlines and one alarm
means a scheduler, and the scheduler must live in storage. Calling `setAlarm`
directly from feature code would silently cancel whichever other deadline was
pending — a bug that would appear as "the clock sometimes doesn't flag", weeks
later, and be very hard to trace.

## Rejected

**A polling loop or a long-lived timer for the clock.** Impossible under
hibernation, and it would be billed for duration if it were not.

**Separate Durable Objects per deadline, to get more alarms.** Solves the wrong
problem at the cost of coordination, extra requests, and more objects to garbage
collect.

## Revisit if

Cloudflare gives Durable Objects multiple named alarms, at which point the
`timers` table becomes a thin adapter rather than a necessity.
