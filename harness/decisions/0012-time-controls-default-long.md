# 0012 — Time controls default long

- **Date:** 2026-07-25
- **Status:** accepted
- **Stage:** 5.1.3

## Decision

Offered time controls run from 10 min + 10 s to 60 min + 30 s, defaulting to
**30 min + 20 s**. Increment is Fischer-style, applied after the move completes.
No blitz or bullet presets are offered.

## Why

The clock has to pay for walking, which is a cost ordinary chess clocks have never
had to price. On a 64 m board — 8 m squares, which is around the smallest that
plays cleanly — a1 to h8 is 90 m of walking, and a single exchange in the corner
can mean crossing the board and coming back. A 5+3 blitz clock on that field is not
a chess game, it is a running race with a chessboard attached, and the player who
wins is the fitter one.

The increment matters more here than the base time, and for a different reason than
in over-the-board chess: it is not protection against time trouble in a long
endgame, it is compensation for the fixed cost of *travel* on every single move.
Twenty seconds a move roughly covers walking two or three squares at a normal pace,
so a player making short, local moves is close to time-neutral, while long
diagonal sweeps genuinely cost something. That is the right incentive gradient —
it makes range expensive without making it impossible.

Keeping 10+10 as the shortest offering leaves room for a small field or a quick
game, without presenting anything that will produce a bad first experience.

## Rejected

**The usual chess presets** (3+2, 5+3, 10+5). Rejected: on any real field these
select for fitness over chess, and a first game played under one would misrepresent
what the game is.

**Time per move rather than a total budget** — a fixed allowance each turn, as in
some correspondence formats. Interesting fit for the walking problem, since travel
cost is per-move. Rejected for v1 as unfamiliar; worth revisiting after playtesting
if the total-budget model turns out to punish long games oddly.

**Scaling the clock automatically from the field's measured size.** Appealing, and
probably right eventually. Rejected for now because there is no field data to
calibrate the formula against; revisit at stage 9.2.2 alongside `DEFAULT_REACH`.

## Revisit if

Playtesting shows games ending on time rather than on the board, or players
choosing a field size to game the clock rather than for the walk (stage 10.4.5).
