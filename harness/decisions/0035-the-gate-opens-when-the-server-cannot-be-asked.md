# 0035 — The gate opens when the server cannot be asked, and a seat is a `sub` or nothing

- **Date:** 2026-09-16
- **Status:** accepted
- **Stage:** 2.5.1

## Decision

Three rules, which together are the sign-in gate.

**1. A seat is a Google `sub`, or it does not exist.** `POST /api/game`,
`POST /api/game/:code` and the WebSocket upgrade all answer **401** without a
session. The `playerId` a client used to send — a UUID minted on first run — is
gone from the body, from the query string, and from the phone
(`getPlayerId` is deleted, not merely unused).

**2. An unreachable server is not a sign-out.** The client's launch check has
**three** states, not two: `signed_in`, `signed_out`, and `unknown`. Only a real
401 closes the gate. A fetch that throws, a 5xx, or a 200 that is not our JSON is
`unknown`, and **the app opens**.

**3. A completed sign-in returns where it started.** The destination travels in
the signed flow cookie, validated against `parseAppRoute` at both ends.

## Why

**Rule 1 is what closes O-15**, and it closes it by deletion rather than by
reconciliation. The bug was that a player who created a game signed out and
reopened it signed in was matched as two different people: `colorOf` compared a
`sub` against a stored UUID, missed, and handed them the *other* seat — so one
person held both and the game was unplayable with no recourse but a new code. The
alternative fix was seat adoption (take over a seat that has no account on it),
which works and leaves two kinds of key in the system for ever. One key cannot
disagree with itself.

**Rule 2 is the one that will look wrong later**, which is why it is written
down. Sign-in is mandatory (decision 0014), so the obvious shape for the launch
check is a boolean, and the obvious simplification of three states back to two is
`if (!signedIn) showGate()`. That is a bug, and an invisible one: it only fires
when the network is gone, which is never true on a developer's machine and
routinely true in the field this game is played in. The failure is a player
standing on a football pitch with a fortnight-old session being shown a sign-in
screen they cannot complete — O-01 arriving by a route decision 0014 never
considered, and arriving at the worst moment, because the opponent is already
there.

Nothing is faked by opening: the cookie is either in the jar or it is not, every
API call still carries it, and the server still refuses all of them without it
(rule 1). The phone is given the benefit of the doubt about a question only the
server can answer, in the one situation where the server cannot be asked. A phone
that never signed in also gets in, and then cannot start a game — which it could
not have done anyway, while calibrating a field still works with no account and
no network at all (decision 0013).

**Rule 3 is about the worst moment to lose something.** The commonest first-ever
sign-in is a QR code scanned in a park by somebody who has never opened this app,
and sending them back to `/` throws the invitation away after two people have
already travelled to play. The destination goes in the **cookie** rather than in
`state` so Google is never told which game anyone was invited to, and it is
checked against `parseAppRoute` — the table the Worker and client already share
(O-06) — rather than against a new list, so the allowlist cannot drift and an
off-origin destination is unexpressible rather than merely guarded against.

## Rejected

**Seat adoption instead of mandatory sign-in.** Logged in O-15 as the alternative
remedy: a signed-in request carrying a `playerId` that matches an accountless
seat takes that seat over. It is a good fix for a world where signed-out play
exists. It does not, so this keeps a second seat key alive to serve a case the
product forbids — and a second key is what O-15 *was*.

**A boolean launch check.** See rule 2. It is smaller, reads better, and is wrong
in exactly the conditions this game is played in.

**Caching the identity locally for offline launch (stage 2.2.4).** The stronger
version of rule 2, and still worth doing — a cached `sub` would let the app know
*who* it is offline rather than merely letting it open. Not done here because it
is a separate stage with its own expiry question, and because rule 2 delivers the
part that matters (the app opens) with no new storage and nothing that can go
stale. 2.2.4 remains `todo` and this is the reason it is not urgent.

**Carrying the destination in the OAuth `state` parameter.** Free, and it is what
`state` is often used for. Rejected: Google would then see the join code of every
game anyone was invited to, which is a location people repeatedly and predictably
stand in (decisions 0017, 0018). The cookie is already signed and already making
this exact round trip.

**A `?dev=1` client flag or stripping the dev button at build time.** The button
is gated on the server's own `devSeamEnabled` answer instead. A build flag would
make the button's presence depend on how someone built rather than on where it
was deployed, which is the failure decision 0030 already refused; and `sw.js`
aside, the button is not the lock — `/api/dev/session` 404s on a deployed build
however the client renders.

## Revisit if

- **Stage 2.2.4 lands.** `unknown` should then consult the cached identity before
  falling through to "open anyway", and this file's rule 2 becomes the fallback
  rather than the whole answer.
- **O-17 is ever seen in the wild.** A session written to KV and read back a
  second later is the one case where `signed_out` could be *wrong* rather than
  merely unhelpful, and the remedy there interacts with this: the callback would
  hand the session to the client rather than making it re-read.
- **Anonymous play is ever reintroduced** (the O-01 field fallback that decision
  0014 pre-analysed and rejected). Rule 1 is the thing that would have to be
  unpicked, and it should be unpicked deliberately rather than by adding a second
  seat key back beside the `sub`.
