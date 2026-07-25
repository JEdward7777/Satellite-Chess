# 0009 — Suspension puts a carried piece back

- **Date:** 2026-07-25
- **Status:** accepted
- **Stage:** 4.2.6, 5.3.5

## Decision

When a game is suspended — by a disconnect exceeding the grace period, or by a
requested pause — any piece currently being carried is returned to its origin and
the pending lift is cleared. The mover's clock keeps whatever it had spent; nothing
is refunded and nothing extra is charged.

## Why

A carry is a claim about where a body is: "I picked this up at e2 and I am walking
it somewhere." Suspension exists precisely because we have stopped being able to
trust that claim — the player has dropped off the network, or has asked to stop.
Preserving a half-completed carry across a suspension would mean honouring a
statement about a body whose position we no longer know.

It also interacts badly with the resume rule. Resuming requires both players to
walk back to their own back rank (decision 0005). A player who resumes while still
holding a piece would be standing on their own back rank with a queen notionally in
hand, having walked there — either they get a free repositioning of the carry, or
they have to walk back out to where they were, which is the thing the back-rank
reset was designed to avoid needing.

Returning the piece is the simplest rule that is obviously fair to both players,
and it is trivial to explain: *the interruption put your piece back.*

## Rejected

**Preserve the carry across suspension.** Feels more respectful of the player's
effort, but requires trusting a stale position and conflicts with the back-rank
reset.

**Refund the clock time spent on the abandoned carry.** Superficially generous,
and exploitable: a player in time trouble could lift a piece, walk, and drop the
connection to claw back time. Freezing the clock at suspension already prevents the
disconnect itself from costing anyone, which is the fairness that actually matters.

## Revisit if

Playtesting shows carries being lost often enough to be infuriating — which would
more likely indicate the disconnect grace period is too short than that this rule
is wrong.
