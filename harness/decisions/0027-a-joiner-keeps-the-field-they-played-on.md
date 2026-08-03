# 0027 — A joiner keeps the field they played on

- **Date:** 2026-08-03
- **Status:** accepted
- **Stage:** 6.4

## Decision

Taking a seat in a game saves a copy of that game's field to the joiner's phone,
without asking. It arrives through the same machinery as a shared link (decision
0016) — a copy with provenance, owned outright — and is labelled on the home
screen as *kept from a game* rather than presented as ground the player walked.

De-duplicated by lineage, so a weekly fixture on the same common leaves one field
and not fifty-two, and a later re-calibration by the creator arrives as an
improvement to that one field rather than as a second entry beside it.

A **shared link is always asked about**; a game's field never is. That asymmetry
is the decision, not an inconsistency in it.

## Why

Stage 6.3 deliberately left this open: the field travelled with the seat so the
joiner had a board to draw, and nothing was saved. That left the commonest thing
anyone does after a game — play there again — needing the person who invited you
to send you the ground you had both just stood on for an hour.

The two paths differ in consent, and that is what makes one silent and one not:

- **A link is a message.** It can be opened out of curiosity, forwarded three
  times, or tapped by someone who is nowhere near the place. Writing to their
  phone because they looked is wrong, so they are asked.
- **A seat is an act.** Joining is deliberate, idempotent, recorded at the far
  end, and immediately followed by walking around the field in question. There is
  no meaningful reading of "I joined a game here" that does not include "I know
  where here is".

Silence is also the only version that works. The moment to ask is the moment the
player is standing in a park having just tapped an invitation, and a dialogue
between the tap and the board is a dialogue that gets dismissed unread — decision
0013's argument for saving a calibration unconditionally, one screen later.

What makes it safe rather than merely convenient is that the copy is inert and
disposable. It carries geometry and a name, nothing about the sender (decision
0017). It never syncs. And stage 6.4 made a field deletable, renameable and
re-calibratable from a screen of its own — a field that arrives with no way to be
rid of it is not a gift, and until that screen existed this decision could not
have been taken.

## Rejected

**Keep nothing, as 6.3 left it.** Rejected: it makes the second game on a field
harder than the first, for no gain. The joiner has already been handed the
geometry — refusing to write it down protects nothing.

**Ask on the way in.** A prompt between the invite and the board. Rejected: it is
the worst possible moment, it costs a tap on every join to benefit the rare one,
and an unread dialogue is a worse answer than either yes or no.

**Ask on the way out**, once the game ends. Rejected as the runner-up rather than
as a bad idea: it asks at a calm moment, but it only fires for games that finish
cleanly on the phone that is still looking, which is not most of them — and a
game that is suspended for a month (decision 0025) would never reach it.

**Save it silently but hide it**, in some "recently played" list separate from the
field list. Rejected: two lists of fields is a worse answer to "which of these is
mine?" than one list with a label on it.

**Key the copy by geometry**, merging fields that sit on the same grass. Rejected:
two people who calibrate the same park produce genuinely different boards, with
different corners and different square sizes. Merging by proximity would silently
move somebody's game. Only deliberate copies of one field are de-duplicated.

## Revisit if

- Fields become an account-level thing that syncs (they are local today,
  decision 0013), at which point silently adding one has a second-device
  consequence this reasoning did not consider.
- Anyone reports the field list filling with places they do not recognise, which
  would mean the label is not carrying the explanation the silence relies on.
