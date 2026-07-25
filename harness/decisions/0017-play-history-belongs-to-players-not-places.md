# 0017 — Play history is indexed by player, never by place

- **Date:** 2026-07-25
- **Status:** accepted
- **Stage:** 2.3.5, 2.3.7
- **Amends:** the provenance clause of [0016](0016-fields-share-as-self-contained-links.md)

## Decision

A field stores **no roster of who has played on it**. Play history is stored
against the player and only against the player.

Permitted:

- **"I have played 7 games at Riverside Park."** Stored in the player's own
  `UserDO`, visible only to them. This is where the permanent record
  (decision 0014) lives, and it is unaffected by this decision.
- **Opponents you played there.** You already know who you played.
- **Coarse aggregate counts on a field**, and only behind a k-anonymity floor:
  show nothing unless at least five distinct players have played there, and report
  last-played at month granularity, never a timestamp.

Forbidden:

- Any list of player identities attached to a field.
- Any per-field leaderboard, "regulars", or visit log readable by another player.
- Any history travelling with a shared field link. **Field links carry geometry and
  a name. Nothing else.**

Amending 0016: shared-field provenance keeps the original field id and version, for
offering "this is a newer version of a field you have". It does **not** carry the
sharer's identity, which was the original wording. A display name may be attached
only if that player explicitly opts in when publishing a field to "fields near me".

## Why

A field is a precise geolocation. A player identity attached to a field is
therefore a record of where a named person physically was, and roughly when — which
is a materially different and more sensitive thing than a chess result.

The combination with two features already planned is what makes it dangerous rather
than merely awkward:

- **Fields share freely** (decision 0016), so a field definition, and anything
  attached to it, propagates to people the original players never met.
- **"Fields near me"** (stage 2.3.6) makes fields *discoverable by location*. Anyone
  could calibrate a field over a park, a school or a house, publish it, and read off
  who plays there and when.

That is a stalking and safety problem, not a privacy technicality, and it is worst
for exactly the people most likely to play chess in a park after school. It is also
the kind of feature that is easy to add and effectively impossible to withdraw,
because the data will already have propagated inside shared field definitions.

The saving grace is that the feature people actually want — a sense that a field is
a place with personal history, and an achievement record — is the *same join,
indexed the other way*. `player -> fields played` gives every bit of the
satisfaction. `field -> players` gives the satisfaction plus the hazard. There is no
reason to store the second one.

The k-anonymity floor on aggregates exists because small numbers identify: "1 game
played here" on a field you shared with one friend is a statement about that friend.

## Rejected

**Per-field leaderboards and rosters.** The obviously fun version. Rejected for the
reasons above. If it is ever revisited it must be opt-in per player *per field*, and
must not propagate through a shared link — at which point it is mostly empty and
not worth the machinery.

**Storing the roster but access-controlling it.** Rejected: it requires an access
model on an object designed to be copied freely, which is a contradiction. The
correct control for data that must not spread is not to collect it.

**Anonymised counts with no floor.** Rejected: small-N deanonymises, and the
interesting fields are the ones with small N.

## Consequences

- `UserDO.game_index` gains a field reference; the `field` record gains no player
  reference. That asymmetry is the whole decision and is worth a comment in the
  schema.
- Archived games (stage 8.4) keep positions and identities together, but they are
  private to the two participants. Do not build a public index over them by field.
- The privacy posture should be stated plainly in the app, since players are
  handing us their location: what is stored, what is visible to an opponent, and
  what never leaves their account.

## Revisit if

A genuine community feature is wanted — a club playing regularly on one pitch, say.
That is opt-in group membership, which is a different mechanism from a field
remembering everyone who has ever stood on it.
