# 0004 — Handicap mismatched fitness with reach, not the clock

- **Date:** 2026-07-25
- **Status:** accepted
- **Stage:** 0.4.2

## Decision

Reach is symmetric by default. Where players want a handicap, it is applied as
extra metres of reach per player (`ReachBonuses`), which also raises that
player's clamp ceiling. Clock handicaps are not offered.

## Why

The brief raised this as an open question and suggested a reach handicap is "more
humane than a clock handicap". It is, and for reasons worth writing down:

- It is continuous and small. One or two metres changes what you can stretch to
  without changing what the game is.
- It is visible. Both players see the circle, so the handicap is a stated fact on
  screen rather than a number in a settings menu.
- It targets the actual asymmetry. The thing an unfit or less mobile player is
  short of is metres, not seconds. Giving them time instead compensates for the
  wrong quantity, and does it by making the other player wait.
- It does not distort the chess. Extra time changes how deeply you can calculate.
  Extra reach does not.

## Rejected

**Clock handicap.** The conventional chess answer, and wrong here for the reasons
above.

**Asymmetric field geometry** — a smaller board on one player's side. Rejected as
incoherent: the board is a shared physical object.

**Piece odds.** Orthogonal, already exists in chess, and available to players
without any support from us.

## Revisit if

Playtesting shows a reach handicap large enough to matter also lets a player span
moves that should require walking. If so, cap the bonus rather than switching
quantities.
