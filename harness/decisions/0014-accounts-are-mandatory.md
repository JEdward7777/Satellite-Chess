# 0014 — Google sign-in is required to play

- **Date:** 2026-07-25
- **Status:** accepted
- **Stage:** 2
- **Supersedes:** rule 2 of [0013](0013-local-first-persistence-oauth-never-loses-data.md)

## Decision

Google sign-in is required before playing. There is no anonymous play and no
"play now, claim later" fallback. An unauthenticated launch goes to a sign-in
screen and nowhere else.

A dev-only test seam exists for local development and the simulator, so the game
remains testable without a live Google round-trip. It is never reachable in a
deployed build.

## Why

This is a product decision by the project owner, taken over the alternatives
below, and the reasoning is worth recording because it changes what the game *is*.

Every game, result and metre walked should accrue to a permanent personal record —
"you have walked 47 km playing chess" is only true if there is a durable *you* for
it to be true of. Anonymous play makes that record a property of a browser
profile, which means it silently evaporates when someone clears site data, gets a
new phone, or plays on a tablet. Under mandatory accounts the record cannot be
stranded, because there was never a moment when it belonged to a device instead of
a person.

It also removes real complexity rather than adding it: no anonymous ids, no
claim-on-link merge, no reconciling two devices' worth of unowned history, no
"which of these two anonymous players am I" edge cases. Identity is known before
any game state exists.

Requiring it up front is additionally the *safest* moment to require it. The
data-loss hazard in 0013 comes from OAuth interrupting work in progress; at launch
there is no work in progress to lose.

## The known cost, and the mitigation

The sharp edge is that a player who cannot reach Google cannot play, and the most
likely moment for that is the worst one: a friend scanning a QR code in a park on
one bar of signal, possibly on an iOS home-screen PWA whose OAuth redirect hands
off to Safari.

This was raised, considered, and accepted. Two things reduce it to a rare case
rather than eliminating it:

- **Long-lived, sliding sessions** (stage 2.2), plus a pre-flight warning on the
  home screen while there is still wifi. Sign-in then happens at home; only the
  first ever sign-in on a device needs Google reachable.
- **Invite ahead of time** via the share sheet (decision 0015). An invite sent the
  night before means your opponent authenticates on their sofa, not in a field.

The residual risk is logged in `harness/observations/open.md` so that if it does
bite during playtesting, the evidence is already framed rather than argued from
scratch.

## Rejected

**Login-first with a field fallback** ("play now, claim later" when OAuth cannot
complete). Recommended at the time, on the grounds that it preserves the permanent
record for essentially every real case while never letting a bad signal cancel a
game two people travelled to play. Rejected by the owner in favour of the simpler
model: no merge logic, no anonymous ids, and a record that is never at risk of
being stranded on a device.

**Anonymous-first, sign in to save** (the original brief). Rejected: it is the
model that makes the permanent record optional, which is the opposite of the goal.

**Login to create, anonymous to join.** Rejected: half the players — every
opponent — would have a record that goes nowhere.

## Revisit if

Playtesting shows sign-in actually blocking games in the field (stage 10.2). The
fallback above is the pre-analysed remedy; it can be added without disturbing
anything else, since the anonymous path would be additive.
