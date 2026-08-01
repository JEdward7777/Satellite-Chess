# 0023 — Reach absorbs GPS error, and squares scale with reach

- **Date:** 2026-08-01
- **Status:** accepted
- **Stage:** 1.9.3, 9.2
- **Constrains:** [0003](0003-reach-to-nearest-point-of-square.md),
  [0022](0022-survey-is-a-secret-gated-debug-facility.md)

## Decision

**The reach circle is the safety net for GPS imprecision.** If the fix is not
precise enough to resolve a square, the circle gets bigger — it does not get a
better sensor, a filter, or a refusal. This is already how
`effectiveReachM` works: reach is `base + reported accuracy + handicap`.

Two things follow.

1. **The field survey (`1.9.3.4`) is not a gate.** It never was a question of
   *whether* the game works on consumer GPS. It is a question of *what square
   size* the game wants. Nothing downstream waits on the walk.
2. **Square size scales with reach, not against it.** The playability
   constraint is the ratio, not either number alone. A circle that grows past
   the square it is trying to select stops requiring a walk, and the walk is the
   game. When accuracy turns out worse than assumed, the answer is bigger
   squares — and therefore a bigger field — not a tighter circle.

## Why

The alternative safety net is refusal: demand a good fix, and tell the player to
wait when you cannot get one. That fails in exactly the situation the game is
for — two people who have already travelled to a field, under trees, on one bar,
wanting to play now. A circle that breathes with the error budget degrades
gracefully; a threshold that refuses does not degrade at all, it just stops.

It also keeps the rule honest on screen. The circle is drawn from the same
number the DO validates against (decision 0008), so a player watching it swell
in poor conditions is seeing the actual rule relax, not a cosmetic ring around a
hidden threshold.

The failure mode this creates is not a rejected move — it is a game that accepts
everything. That is why the second half is load-bearing and stated here rather
than left implicit: without it, "just make the circle bigger" has no stopping
point, and the endpoint is chess on a phone in a field, with the field doing
nothing.

## What would make me revisit

- A field where the ratio cannot be held: accuracy so poor that the square size
  it implies makes the board larger than any ground people actually have. That
  is the point at which the game has a hard floor on venue size, and the honest
  answer is to say so rather than to shrink the circle.
- `maxM` is currently a flat 15 m (`DEFAULT_REACH`), which contradicts the
  scaling above once square size moves off 8 m. Expressing the ceiling as a
  multiple of square size is the natural implementation, deferred until
  `1.9.3.5` supplies a real square size to scale from. See **O-02**, whose
  handicap-raises-the-ceiling problem has the same root and the same fix.
