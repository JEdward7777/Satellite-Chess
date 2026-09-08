# 0032 — Sync fields against a journal of what the account has acknowledged

- **Date:** 2026-09-07
- **Status:** accepted
- **Stage:** 2.3.3.2

## Decision

Saved fields synchronise through **one endpoint and one client-side journal**.

1. **`POST /api/fields/sync`** is the whole API. It carries the fields that have
   changed on this phone and the ids of the fields deleted on it, and it returns
   **the account's entire list**. There is no `GET /api/fields`, no
   `PUT /api/fields/:id`, and no diff or cursor.
2. **The phone keeps a journal** in `localStorage`: `acked`, mapping each field
   id to the `updatedAt` the server last confirmed holding, and `removed`,
   the fields deleted here that the server has not yet been told about.
3. **The journal is the only licence to delete locally.** A field this phone
   holds, that is absent from the returned list, is removed **only if it appears
   in `acked`**. A field the account has never acknowledged is never deleted.
4. **Last write wins on `updatedAt`**, in the Durable Object and on the phone.
   There is no conflict UI and no vector clock.
5. **The phone remains the primary store** (decision 0013, unchanged). Nothing
   in the sync path is awaited before a screen is shown, and every failure —
   no session, no signal, a 500, a refused IndexedDB — leaves the phone holding
   exactly what it held.

## Why

**Rule 3 is the decision.** Everything else is arrangement; this is the part
that is easy to delete and expensive to have deleted.

Two phones and a delete is what makes this harder than "push what you have". If
a phone pushes whatever it holds, then a field deleted last week on the other
phone comes straight back on the next sync, and back again after that, for ever
— a delete that never sticks and a list that grows. Something has to tell *"I
have this and the server has never heard of it"* apart from *"I have this and
the server used to hold it"*. A single list cannot: both look identical.

The journal answers exactly that one question and nothing else, which is why it
is two maps of numbers rather than a replication log.

**It is deliberately lossy in the safe direction.** An empty journal — cleared
site data, a new browser profile, a private window — means nothing is
acknowledged, so nothing is deleted and everything is re-pushed. Losing it
resurrects a deleted field at worst and can never lose a live one. That
asymmetry is what makes it acceptable to keep in `localStorage` at all.

**One endpoint, because of the budget.** The phone doing the calling is outdoors
on one bar, and every request is billed against 100k/day
(`harness/reference/budget.md`). A REST resource per field costs one request per
changed field plus one to list; this costs one request, whether nothing changed
or everything did. The steady state — the commonest case by far — is a request
with two empty arrays.

**Last write wins is not a compromise here.** Both phones belong to the same
person. The only question a conflict can ask is "which of my own two edits was
later", and a merge dialogue about a field's name would be worse than the
problem it solved.

## Rejected

**Server-side tombstones.** A `deleted_fields` table in the UserDO, so a delete
is a fact the server holds rather than a thing each phone must remember.
Genuinely simpler on the client. Rejected because the rows are immortal by
construction: nothing may ever prune them without reintroducing the
resurrection, so the account accumulates a permanent record of every field its
owner ever deleted — a list of places a named person used to go (decision 0017).
The journal keeps that on the phone that already knows it.

**No delete detection at all** — treat the union of local and remote as the
truth. Rejected: it makes "delete" mean "hide until the next sync", and the
field a player deleted is quite often the one they mis-tapped and do not want to
see again.

**Per-field REST routes.** Conventional, and each request is independently
retriable. Rejected on request cost and on atomicity: a first sync from a phone
with five fields is five requests, and a batch half-applied is a state neither
end can describe.

**A diff with a cursor.** Cheaper on a large account. Rejected as a false
economy at this size — an account holds perhaps five fields — and dangerous at
any size: a cursor that skips deletes somebody's fields, and the whole-list
answer is what keeps the client's merge simple enough to reason about.

**Sync before the first screen.** Rejected outright by decision 0013: it puts
the network in front of a home screen, and the phone is in a park.

## Revisit if

- Fields become numerous or large enough that the whole list is a real payload.
  A field is four numbers and a name, so this needs a use we do not have.
- Something other than one person's phones starts writing these rows — a shared
  club account, say. Last-write-wins is a statement about one owner, and it
  stops being true the moment two people can edit the same field.
- Sessions become long-lived enough that a push could be attributed to a phone
  the player has since lost. Nothing today distinguishes phones, on purpose.
