# 0005 — Resume by resetting body position to the back ranks

- **Date:** 2026-07-25
- **Status:** accepted
- **Stage:** 6.1

## Decision

To resume a suspended game, both players must be connected and standing in their
own start zone — anywhere on their own back rank — verified server-side, before
the clock restarts. The same handshake gates the start of a fresh game, so there
is one code path.

## Why

Body position is part of the game state and cannot be serialised. Whose turn it
is matters less than where each player is standing, since that determines what
each of them can reach. A resume that restores the board but not the bodies hands
someone an arbitrary advantage or takes one away.

Rather than solve that at the engineering layer, resolve it at the rules layer:
reset it. Returning both players to their own back rank neutralises whatever
positional advantage the interruption created or destroyed, is trivially
explainable — "go back to your own end" — and reduces resume to a well-defined
handshake with an observable completion condition.

Reusing the same handshake for the opening means the rule is learned once, on the
first game, before it ever has to be applied under the frustration of a dropped
connection.

## Rejected

**Resume wherever the players happen to be.** Zero friction, and unfair in a way
that would be immediately obvious to whoever lost by it.

**Record positions at suspension and require players to return to them.** Fairer
in principle. Rejected: it needs an accurate fix at the exact moment of a
disconnect, which is precisely when the fix is least trustworthy, and it asks
players to find an unmarked spot in a field.

**Let the players agree informally and tap resume.** Fine between friends, no help
at all when they disagree, which is the only time a rule is needed.

## Revisit if

Playtesting finds the walk back is long enough to be resented on a large field
(stage 10.4.4). A designated smaller start zone is the fallback, not abandoning
the reset.
