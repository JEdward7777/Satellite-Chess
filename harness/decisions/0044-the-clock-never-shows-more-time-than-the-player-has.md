# 0044 — The clock never shows more time than the player has

- **Date:** 2026-09-24
- **Status:** accepted
- **Stage:** 10.6; answers O-31

## Decision

What is on screen is never above the player's true balance, apart from the
few tens of milliseconds of one-way latency `estimateServerNow` already
accepts. Concretely:

1. **`formatClock` rounds down everywhere**, tenths included. 30:00 is shown
   only while exactly thirty minutes remain, and reads 29:59 a moment after the
   clock starts. Under ten seconds the tenths are truncated, never rounded.
2. **A predicted place stops the mover's clock at the tap**, at the tap's
   estimated server time (`freeze` in `shared/clock.ts`, the server's own
   banking arithmetic). It is not merely marked stopped. The increment is not
   predicted: it is the server's to grant, and it lands with the server's
   answer as the one allowed rise. While the place is in flight, the frozen
   display sits above the server's truth by the one-way latency, because the
   server keeps charging until the move arrives. That is accepted: the server
   stays the authority, and the display never runs back up.
3. Before the first move and during a pause, both clocks show their banked
   balance, not running. On a new game that is the time control, a whole
   number of minutes, and that is correct.

## Why

O-31: after the owner's first outdoor games, the host said their clock "kept
rounding up to a whole number of minutes". Reproduced in `wrangler dev`, the
cause was rule 2's absence. The prediction nulled `startedAt` and left the
balances alone. The server banks think time only when a move lands, so the
mover was shown the balance their turn *began* with, for as long as the answer
took. On one bar that is seconds. On a first move that balance is exactly the
time control (29:55 → 30:00 → 30:15 in `check-clock.mjs`).

A chess clock is trusted only if it never gives time back that it has not
granted. Rounding down is the one rule that can never show a player more than
they have. Their mistakes all go the safe way: they hurry a little early, and
they are never told they have time they do not.

## Rejected

- **Round up (ceil)**, as many countdown timers do so that 0:00 means expired.
  Every whole minute would be held on screen for a second, which is the O-31
  symptom by design, and the last second would read 0:01 while the flag is
  falling. The tenths under ten seconds already make the end legible.
- **Keep the mover's clock running until the server answers.** The turn has
  visibly passed. A clock still ticking after the piece is down reads as
  charging for time after the move.
- **Predict the increment too.** It would show time the server has not
  granted, and a place that is then refused would take it back. The rise is
  honest only when it comes from the server.
- **Hide the clocks during a prediction.** A blank clock at the moment of
  every move is a worse flicker than the one it would hide.

## Revisit if

- An outdoor game with the debug readout on (`10.6.4`) shows the displayed
  clock above the server's raw balance by more than latency. That would be a
  different cause from the one fixed here.
- A time control is ever added with increments large enough that the rise when
  the server answers reads as a bug in its own right.
