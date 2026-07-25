# 0019 — Distance is the currency, not games; and small fields do not count

- **Date:** 2026-07-25
- **Status:** accepted
- **Stage:** 2.3.5, 8.5
- **Builds on:** [0018](0018-bragging-without-broadcasting-location.md)

## Decision

The permanent record leads with **metres walked**, not games played. Four axes,
kept separate and never compressed into a single score:

| Metric | What it means | Scales with field size |
|---|---|---|
| **Distance walked** | Physical effort. The headline number. | Yes, correctly |
| **Board crossings** — distance ÷ board diagonal | How much chess was played. | No, by design |
| **Games and moves** | Crude volume. Never a headline, never a leaderboard. | No |
| **Biggest board played** | Its own bragging axis. | It *is* the axis |

Any public leaderboard ranks on **distance** or **board crossings**, never on games
or moves.

**Minimum field size for the record:** a game counts toward the permanent record and
any leaderboard only if its squares are at least 4 m — the same threshold at which
`checkCalibration` stops warning. Below that it still plays, and still shows in your
own history, but it is marked as a practice game and is excluded from totals.

## Why

Fifty games in a back garden is not fifty games on a football pitch, and a record
that says otherwise is lying. The two are different by roughly a factor of four in
every dimension that costs the player anything.

Distance solves this without any correction, because it is already the integral of
the thing that varies. A 96 m board makes every move about four times as expensive
as a 24 m board does, so the metres accrue in proportion to the effort. No
normalisation factor, no fudge, no argument.

**The incentive argument is the one that actually forces the decision.** A metric
that does not scale with field size rewards shrinking the field. Someone chasing a
game count would calibrate the smallest board the app permits and grind short games —
and small boards are precisely where GPS ambiguity makes the game worst
(decision 0003, and the 2–4 m warning band in `checkCalibration`). So a game-count
leaderboard would push players toward the degraded version of the game. Ranking on
distance inverts that: the way to climb is to play on a bigger field, which is also
the way to have a better time.

Board crossings earns its place as the complement. It answers a genuinely different
question — "how much chess have I played?" — in a way that is fair across fields. A
player on a small field and a player on a large one who play the same number of
comparable games land in the same place, which is right, while distance correctly
says one of them walked further. Keeping both, and labelling them honestly, beats
inventing a weighted composite that nobody can interpret and everybody suspects.

The 4 m floor exists because without it the exclusion is unenforceable in the other
direction: a 2 m board would let someone accumulate board crossings absurdly cheaply,
and it is not a real game anyway — GPS cannot reliably say which square you are on.
Excluding rather than penalising keeps the rule easy to state.

## Rejected

**A single composite score**, weighting field size, games and distance. Rejected:
any weighting is arbitrary, unarguable and gameable, and it destroys the information
that the separate axes carry. Several honest numbers are better than one fake one.

**Games played as the headline.** The conventional choice, and the one that creates
the shrink-the-field incentive.

**Normalising distance by field size** to make games comparable. Rejected: that is
what board crossings already is, and applying it *to distance* would delete the
achievement of having walked a long way, which is the thing players actually want
credit for.

**Penalising small fields with a fractional multiplier** rather than excluding them.
Rejected: it invites arguing about the multiplier, and it implies a sub-4 m board is
a lesser version of the same thing when it is really a different, unreliable thing.

## Revisit if

- Field data shows the 4 m threshold is in the wrong place — it is currently a guess,
  and stage 9.2 measures it. Move the record floor with it.
- Players want to compare across wildly different field shapes, at which point board
  crossings may need to use a path-length measure rather than the diagonal.
