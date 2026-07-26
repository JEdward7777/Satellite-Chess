# 0022 — The field survey is a secret-gated debug facility, off by default

- **Date:** 2026-07-25
- **Status:** accepted
- **Stage:** 1.9.3
- **Constrained by:** [0017](0017-play-history-belongs-to-players-not-places.md),
  [0018](0018-bragging-without-broadcasting-location.md)

## Decision

The app can upload a raw GPS trace for offline analysis, under these rules:

1. **Off unless `SURVEY_SECRET` is set.** With no secret configured, every
   `/api/survey/*` route returns **404** — not 401 — so an unconfigured
   deployment is indistinguishable from one where the feature does not exist.
2. **Opt-in per session, per link.** The recorder only runs at
   `/?survey=<secret>`. It is never reachable from the game's own screens, and
   it replaces the whole app rather than sitting inside it.
3. **Traces expire after 14 days**, measured by *server* receipt time.
4. **Deletable in one commit.** `survey-do.ts`, `survey.ts`,
   `views/survey.ts` and `scripts/analyse-survey.mjs` have no callers in the
   game, so when 1.9.3 is settled the whole facility can go.

## Why

Everything in this project has been verified against a GPS simulator I wrote,
which encodes my assumptions about noise. A green test suite proves the code
matches the model; it says nothing about whether the model matches the sky. The
riskiest assumption — that consumer GPS can resolve 8 m squares on grass — can
only be answered by a real phone on real ground, and the operator is the only
one who can hold that phone.

The awkward part is that a GPS trace is *precisely* the data decisions 0017 and
0018 are careful with: a minute-by-minute record of where a person stood. Those
decisions keep play history indexed by player and never by place, and keep
bragging in board space with no map. A telemetry endpoint is the natural enemy
of both, so the constraints above exist to keep it from quietly becoming one.

**404 rather than 401 is the load-bearing detail.** A 401 advertises that a
location recorder exists here and invites someone to look for the key. A 404
says there is nothing to find, which is also true of every deployment that has
not deliberately turned it on.

**Expiry is measured on the server clock**, and this was a real bug before it was
a rule: pruning by the client's `startedAt` meant a phone with a wrong clock had
its trace deleted the instant it uploaded — precisely the device whose data is
most worth having. Client timestamps are stored and never trusted, which is the
same rule the game already applies to move timing.

## Rejected

**Telemetry always on, anonymised.** The obvious product instinct, and wrong
here. There is no anonymising a field: the coordinates *are* the identity, and
decision 0017 exists because of exactly that.

**Ask the operator to email me a file.** Simpler, and it was the fallback. The
round trip is the problem — a phone in a field discovers a gap in the protocol
long after the walk is over, and each iteration costs another trip outdoors.

**A general `/api/debug/*` namespace.** Tempting to build once and reuse.
Rejected: a general debug endpoint acquires callers and stops being deletable,
which is the property that makes this acceptable at all.

**Passive recording — just log everything and analyse it later.** Rejected after
thinking about what the analysis needs. "Walk around for ten minutes" produces a
squiggle with no ground truth to compare against, so scatter cannot be separated
from real movement. The guided protocol exists so that every number in the report
has a known truth behind it.

## Revisit if

- The survey answers 1.9.3 and phase 9 needs no further field data — then delete
  the facility rather than leaving it dormant.
- A second kind of field measurement is wanted (battery drain, wake-lock
  behaviour). Extend the protocol, not the API surface.
- The project ever gains users other than the owner, at which point "the operator
  consented to recording their own location" stops being the whole story.
