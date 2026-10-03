# 0051 — A field is tried alone, on the phone, and judged against its leeway

- **Date:** 2026-10-01
- **Status:** accepted
- **Stage:** 10.12; answers O-49
- **Builds on:** [0003](0003-reach-to-nearest-point-of-square.md),
  [0031](0031-reach-is-the-independent-variable-measured-in-squares.md),
  [0043](0043-a-poor-fix-never-buys-reach.md)

## Decision

1. **The practice board is the preview.** "Try it alone" on the field screen
   opens it (it was "Open the board"). One board for walking a field alone,
   not two.
2. **Entirely local.** The verdict and the tap test run `shared/reach.ts` on
   this phone's fix and send nothing: no socket, no request. It works offline
   on a field already on the phone.
3. **The verdict compares the phone's claimed accuracy against the leeway**:
   the distance from a square's middle to its nearest edge, plus the reach.
   That is exactly how far the dot may stray while a player stands in the
   middle of the right square before a move there is refused.
   - worse than `maxAccuracyM`: **not playable**, every move refused;
   - a claim within the leeway: **looks playable**;
   - up to twice the leeway: **playable, with the odd refusal**;
   - beyond that: **hard to play**.
   The claim is read as close to a worst case. **The three judged levels
   are decided on the figures as shown**: the claim and the leeway at one
   decimal in the player's units (`lengthFigure` in `shared/units.ts`, the
   number `lengthWords` prints). Equal figures are a yes. So the sentence
   ("Your phone says ±7.2 m … strays 7.2 m") can never show an order that
   contradicts its verdict. Judged raw, the leeway's ~1e-11 m of projection
   error made equal figures read "odd refusal", and slack to hide that made
   a larger figure read as a yes. The accepted cost: metric and US can
   disagree near a boundary by at most half a display step. "Not playable"
   stays on the raw `maxAccuracyM`, as the server judges it. Two notes ride
   beside it: squares under `SMALL_SQUARE_M` (games there count only as
   practice), and, only below "looks playable", a dot that may name a
   neighbor (accuracy above half a square). It uses the **current** fix, not
   an average.
4. **The ground is not judged.** The screen always says to walk the four
   edges, because nothing on the phone can see a fence or a pond.
5. **Tap a square to test it**: the answer is `checkReachTo`, the server's
   own lift and place check, with the same config, re-tested on every fix
   and marked like a carry's destination. Reach only: chess legality is not
   asked.
6. **A reach dial, in memory.** The verdict and the circle follow it, so a
   player can see whether a longer reach rescues a field. Nothing is saved;
   the handicap is not offered.
7. **Every refused figure rounds up**, here and in the game's own
   refusals (`lengthAboveWords`, `accuracyAboveWords` in
   `shared/units.ts`): never below the true value, always past the limit as
   shown, within one display step unless the limit's rounding forces it
   higher. Rounding to nearest put "3.2 m" beside "your reach is 3.2 m",
   and "3.1 m" at 3.49 m sent a player one step and refused them again.

## Why

Since 0043 reach is fixed in squares and accuracy never widens it, so O-49's
first idea, "does the reach at that accuracy cover most of the board", can no
longer happen: reach is at most 1.5 squares on any field. What does go wrong
is a player standing on the right square and being refused, and the leeway
is that rule's own boundary (0003 measures reach to the nearest point of the
square), not an estimate of it.

**The claim is read as close to a worst case, because that is what it was
measured to be.** The 2026-09-06 field walk (0031, 2008 fixes on one phone)
had every fix inside its claimed circle. The claim never went below 3.00 m
and its median was 3.37 m, against a real error of median 0.21 m (p95
0.43 m), and nothing standing on 6 to 12 m squares would have been refused.
Read as a typical error instead (the 68% radius phones nominally report),
the same phone would be told a default 8 m board gives "the odd refusal" and
that a 6 m board can never look playable, which the walk contradicts. So a
claim inside the leeway is a yes. Up to twice the leeway, a real error many
times smaller than the claim still mostly lands inside it: the odd refusal.
Past that, even a sixteenfold pessimist's real error starts to reach the
edge. The screen still says "your phone says" and points at the tap test,
which is the real answer for a square.

## Rejected

- **A separate preview screen** beside the practice board: two boards that
  differ only in the text under them.
- **Asking the server.** An inbound message costs a request, and the field
  where the answer matters may have no signal.
- **Observed scatter** in place of the claim. It sees jitter but not a
  steady offset, it needs the player to stand still for a window, and the
  game refuses on the claim, not the scatter (O-12 is the same question for
  distance).
- **Reading the claim as a 68% radius** (the first version: yes only under
  half the leeway). It called the owner's own phone marginal on a default
  board, against a walk with no refusals.
- **A rolling average of accuracy.** Slower to show what stepping out from
  under a tree does, and the screen says "right now".

## Revisit if

- Another handset's claims prove **optimistic**, with fixes landing outside
  their circle: then a claim inside the leeway is no longer a safe yes, and
  the thresholds tighten.
- Real fields (10.12.3) show the verdict disagreeing with play in either
  direction. Then the thresholds move, or the verdict learns observed
  scatter.
- 0043 is reversed and accuracy buys reach again: the leeway then grows with
  the claim, and the verdict needs O-49's original question back.
