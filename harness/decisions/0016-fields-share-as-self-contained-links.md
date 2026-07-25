# 0016 — A field shares as a self-contained link, and arrives as a copy

- **Date:** 2026-07-25
- **Status:** accepted
- **Stage:** 2.3.7, 6.1.5

## Decision

A field can be shared with anyone, independently of any game, as a self-contained
link: `https://<host>/f/<blob>`. The blob encodes everything a field is — the two
calibrated corners and the name — so resolving it requires no server lookup and no
relationship between the two accounts.

Opening the link offers *"Add 'Riverside Park' to your fields?"*. Accepting writes
**a copy** into the recipient's own `UserDO`. They own it outright: they can rename
it, re-calibrate it, or delete it, and none of that touches the sender's field.

Shared through the same share sheet as game invites (decision 0015), and
renderable as a QR code with the same encoder.

Encoding: `a1` at full precision (lat and lng as integers scaled by 1e7, four
bytes each), `h8` as a decimetre offset from `a1` (two bytes each — a field is at
most a few hundred metres across), then the name. Twelve bytes of geometry becomes
sixteen base64url characters, which keeps the QR sparse enough to scan from a
phone screen in sunlight.

Provenance travels with the copy: original field id and version, so a later share
can be recognised as a newer version of a field already held. **Not** the sharer's
identity — see decision 0017, which amends this clause. A field link carries
geometry and a name, and nothing about people.

## Why

The realisation that makes this easy is that a field is four numbers. There is no
reason to build a sharing *service* for four numbers — no upload, no ownership
records, no access-control list, no "who can see my fields" settings screen, no
sync protocol, and nothing that breaks when the sender deletes their account.

Copy rather than reference is the same principle already applied to games, which
snapshot their field precisely so that an in-progress game cannot change shape
because someone re-calibrated on another phone. A live reference would reintroduce
exactly that: your saved field silently moving because a friend re-tapped a corner.
A copy is inert, predictable, and locally owned.

The cost of copying is staleness — if the sender later improves their calibration,
the recipient keeps the old geometry. That is acceptable and self-healing: sharing
again produces a new link, and the recipient can be offered "this is a newer
version of a field you already have" by matching the provenance id.

Because the link carries the field rather than pointing at it, it also works in
places a server-backed share would not: printed on a sign at the park, in a
group chat that outlives the sender's account, or scanned once and used forever.

## Relationship to the other two field paths

Three distinct mechanisms, deliberately kept separate:

- **Playing on someone's field** — the game snapshots it. Automatic; the joiner
  needs no field of their own and keeps nothing afterwards (stage 6.3).
- **Sharing a field** — this decision. Explicit, permanent, no game required.
- **"Fields near me"** — discovery of fields others have published, read-cached in
  KV (stage 2.3.6). Public and searchable, rather than sent to one person.

## Rejected

**Server-side field sharing with recipient lists.** A `POST /api/fields/:id/share`
with an invitee. Rejected: it needs an access model, an inbox, a notification path
and a story for revocation, all to move twelve bytes.

**Live references with sync.** The recipient sees the sender's field, updated when
it changes. Rejected: it contradicts the snapshot principle, makes a saved field
non-deterministic, and creates a dependency on another account's continued
existence.

**Sharing only via an active game.** The status quo of the original brief. Rejected
because the owner specifically wanted a field to be sendable without a shared
game, and the link makes that nearly free.

## Revisit if

- Field definitions grow beyond two corners — a three or four tap calibration
  (rejected in decision 0002) would enlarge the blob, though probably still to
  well under a QR's comfortable capacity.
- "Fields near me" makes explicit sharing redundant in practice, in which case this
  becomes the private path for fields people do not want published.
