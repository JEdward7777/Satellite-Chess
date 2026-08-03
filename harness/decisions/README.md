# Decisions

One file per decision, numbered sequentially with no gaps, named
`NNNN-short-slug.md`. **Append-only: never edit a decision after writing it.** To
change course, write a new decision and add a `Superseded by NNNN` line to the
old one's Status.

Write one when a choice would be expensive to reverse, or when a future session
would otherwise waste time re-deriving it or quietly undo it. Not for routine
implementation detail — that belongs in code comments.

Keep each to roughly one screen, with these sections:

```markdown
# NNNN — Title in the imperative

- **Date:** YYYY-MM-DD
- **Status:** accepted | superseded by NNNN
- **Stage:** the plan stage this came out of

## Decision
What was decided, stated flatly.

## Why
The reasoning. Include the numbers if numbers drove it.

## Rejected
What else was considered, and what specifically killed it. This is the section
future sessions actually need — it stops them re-proposing a dead idea.

## Revisit if
The conditions under which this should be reopened.
```

## Index

| # | Decision | Status |
|---|---|---|
| [0001](0001-two-phase-carry.md) | A move is a lift, a walk, and a place | accepted |
| [0002](0002-calibration-taps-are-square-centres.md) | Calibration taps are the centres of a1 and h8 | accepted |
| [0003](0003-reach-to-nearest-point-of-square.md) | Reach is measured to a square's nearest point | accepted |
| [0004](0004-handicap-is-reach-not-clock.md) | Handicap mismatched fitness with reach, not the clock | accepted |
| [0005](0005-back-rank-resume-handshake.md) | Resume by resetting body position to the back ranks | accepted |
| [0006](0006-sqlite-do-and-hibernation.md) | SQLite Durable Objects, hibernation, one alarm multiplexed | accepted |
| [0007](0007-join-code-is-the-do-address.md) | The join code *is* the Durable Object address | accepted |
| [0008](0008-client-computes-reach-server-decides.md) | Client computes reach for free; the server decides | accepted |
| [0009](0009-suspension-cancels-a-carry.md) | Suspension puts a carried piece back | accepted |
| [0010](0010-harness-layout.md) | Harness layout and dotted stage numbering | accepted |
| [0011](0011-piece-glyphs-not-artwork.md) | Render pieces as Unicode glyphs, not artwork | accepted |
| [0012](0012-time-controls-default-long.md) | Time controls default long | accepted |
| [0013](0013-local-first-persistence-oauth-never-loses-data.md) | Persist locally first; OAuth only adds sync | partly superseded by 0014 |
| [0014](0014-accounts-are-mandatory.md) | Google sign-in is required to play | accepted |
| [0015](0015-invite-by-share-sheet.md) | Invite through the OS share sheet | accepted |
| [0016](0016-fields-share-as-self-contained-links.md) | A field shares as a self-contained link, as a copy | accepted (provenance clause amended by 0017) |
| [0017](0017-play-history-belongs-to-players-not-places.md) | Play history is indexed by player, never by place | accepted |
| [0018](0018-bragging-without-broadcasting-location.md) | Bragging is push-only, and draws the walk in board space | accepted |
| [0019](0019-distance-is-the-currency-not-games.md) | Distance is the currency, not games; small fields excluded | accepted |
| [0020](0020-distance-is-measured-by-smoothed-anchor-hops.md) | Measure distance by smoothed anchor hops, not by summing fixes | accepted |
| [0021](0021-split-tsconfigs-by-runtime.md) | One tsconfig per runtime, not one for the repo | accepted |
| [0022](0022-survey-is-a-secret-gated-debug-facility.md) | The field survey is a secret-gated debug facility, off by default | accepted |
| [0023](0023-reach-absorbs-gps-error-squares-scale-with-it.md) | Reach absorbs GPS error; squares scale with reach | accepted |
| [0024](0024-own-qr-encoder-byte-mode.md) | Ship our own QR encoder, byte mode only | accepted |
| [0025](0025-suspension-lasts-a-month-then-the-other-player-may-claim.md) | A suspended game waits a month, then the *other* player may claim | accepted |
| [0026](0026-no-qr-decoder-ships-the-camera-app-is-the-fallback.md) | Ship no QR decoder; the phone's own camera app is the iOS fallback | accepted |
| [0027](0027-a-joiner-keeps-the-field-they-played-on.md) | A joiner keeps the field they played on, unasked | accepted |
