# 0018 — Bragging is push-only, and draws the walk in board space

- **Date:** 2026-07-25
- **Status:** accepted
- **Stage:** 8.5, 2.3.5
- **Builds on:** [0017](0017-play-history-belongs-to-players-not-places.md)

## Decision

The social layer is built from four rules, which together give the bragging
without the location exposure.

**1. Push, not pull.** Achievements are shared as artefacts the player emits, at a
moment they choose, to an audience they choose — through the share sheet
(decision 0015). There are no public profile pages, no player directory, and no
way to look up another player you have not played. A brag is a thing you send, not
a thing others can read.

**2. The walk is drawn in board space.** The share card renders each player's path
across the 8×8 grid, in board coordinates. This is the striking image anyway — a
traced route over a chessboard — and it contains no geolocation whatsoever. No map
tiles, no coordinates, no scale bar tied to a real place. The card may state the
board's *size* ("a 64 m board") because that is a dimension, not a position.

**3. Aggregate over time, never points in time.** Lifetime and rolling totals —
distance walked, games played, longest carry, biggest board, win streaks — are
safe: they say what you have done, not where or when you were. Per-game location
tracks stay private to the two participants. Never publish a timestamped location,
at any granularity, to anyone but the opponent who was standing there.

**4. Place names only if the player writes them.** A card may name a field, because
field names are player-authored and players self-censor ("Riverside Park", not
"outside 14 Oak Street"). **Never reverse-geocode.** Deriving a place name from
coordinates would put a real address on a card that the player never typed and
would not have chosen.

Additional safe surfaces this permits:

- **Head-to-head with an opponent.** They were physically present for every game,
  so a shared per-opponent record — results, rematch, total distance covered
  together — reveals nothing either did not witness. This is the richest social
  feature available and it is free of the hazard.
- **Global aggregate leaderboards on distance or games**, since neither carries
  location. Field-scoped leaderboards remain forbidden by decision 0017.
- **Friends as an explicit mutual graph**, if ever wanted — and even then, only
  aggregates, never location history.

## Why

The wanted thing and the dangerous thing look similar and are separable. "I walked
4.2 km playing chess today and won on move 41" is a complete brag containing no
location. What made a per-field roster dangerous (decision 0017) was
*place + identity + time*; drop any one of the three and the hazard collapses.

Push-versus-pull is the load-bearing distinction. Every location-privacy disaster
in consumer software has the same shape: data was collected for a defensible reason
and then made *queryable by someone other than the subject*. A player who posts a
card has consented to that specific disclosure to that specific audience. A profile
page consents to everyone, forever, including people who have not arrived yet.

Rendering in board space is what makes the visual payoff compatible with all of
this, and it is not a compromise — the interesting picture was never the satellite
view, it was the shape of the path. Two routes crossing an 8×8 grid, with the lifts
and places marked, is a better image than the same thing on a map, and it happens
to be unlocatable.

The opponent-scoped surface is worth calling out because it is easy to miss while
worrying about privacy: the person who already knows exactly where you were is the
one you played, and building for them costs nothing in exposure.

## Rejected

**Public profiles with opt-in privacy settings.** The conventional design.
Rejected: it makes exposure the default state and privacy a thing you must
correctly configure, and it is pull-shaped, so a later mistake in the settings model
exposes history retroactively.

**Share cards over a map view.** The obvious visual. Rejected: it is a coordinate
disclosure with a picture wrapped round it, and it would be screenshotted and
forwarded far beyond the intended audience.

**Fuzzing coordinates on the card** — jitter the map, or show only a city. Rejected
as a half-measure: fuzzed locations combine across multiple cards to recover the
true one, and board space simply has nothing to recover.

**Reverse-geocoding a place name when the player has not named the field.**
Rejected outright, per rule 4.

## Revisit if

A club or tournament wants a genuine shared, public record. That is opt-in group
membership with a stated scope, and it should be designed as such rather than by
relaxing any of the four rules above.
