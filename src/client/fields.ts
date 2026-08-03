/**
 * Taking a copy of somebody else's field.
 *
 * Two things arrive here and they are the same thing wearing different clothes:
 * a shared link (`/f/<blob>`, decision 0016) and the field a game brought with it
 * (decision 0027). Both are a copy of ground, taken so that a re-calibration
 * somewhere else cannot reshape what you are standing on, and both are owned
 * outright by whoever receives them — rename it, re-calibrate it, delete it, and
 * none of that reaches back to the sender.
 *
 * The interesting work is not the copying, it is deciding **whether to copy at
 * all**. A player who joins six games on the same common must end up with one
 * field, not six; a friend who re-calibrates and shares again should improve the
 * field you have rather than add a second one beside it. That is what the
 * lineage key in `FieldOrigin` is for, and `offerFor` is the whole of the policy.
 *
 * Model only — nothing here draws anything, so the awkward cases (a copy of a
 * copy, an older version arriving after a newer one) are tested in node.
 */

import { type FieldSnapshot, type FieldSpec, makeFieldSpec } from '../shared/field.js';
import { type FieldLink, fieldKey, fieldLinkFromSnapshot } from '../shared/fieldlink.js';
import type { FieldStore } from './store.js';

/** What a phone should do with a field that has just arrived. */
export type FieldOffer =
  /** Nothing like it here. Add it. */
  | { kind: 'new'; incoming: FieldLink }
  /** A newer calibration of a field already held. Improve it in place. */
  | { kind: 'update'; incoming: FieldLink; existing: FieldSpec }
  /** Already held, at this version or a better one. Do nothing. */
  | { kind: 'have'; incoming: FieldLink; existing: FieldSpec };

/**
 * Which of the three this is, given everything the phone already has.
 *
 * Matching is by lineage rather than by geometry: two fields on the same grass
 * tapped by two people are genuinely different fields — different corners,
 * different square sizes, different games — and merging them because they are
 * fifteen metres apart would silently move somebody's board. Deliberate copies
 * of one field are the only thing worth de-duplicating.
 */
export function offerFor(incoming: FieldLink, fields: FieldSpec[]): FieldOffer {
  const existing = fields.find((f) => fieldKey(f) === incoming.origin.key);
  if (!existing) return { kind: 'new', incoming };
  // A field walked out on this phone has no `origin.version` of its own, so its
  // own `version` is the lineage's — they are the same counter until a copy is
  // taken, and the copy carries it forward.
  const held = existing.origin?.version ?? existing.version;
  return incoming.origin.version > held
    ? { kind: 'update', incoming, existing }
    : { kind: 'have', incoming, existing };
}

/**
 * Write the copy, and return the field as it now stands on this phone.
 *
 * `via` records how it arrived, so the home screen can say "shared with you"
 * rather than presenting ground the player has never walked as though they had.
 * A `have` offer writes nothing at all — the point of recognising it.
 */
export async function adoptField(
  store: FieldStore,
  offer: FieldOffer,
  via: 'link' | 'game',
  now = Date.now(),
): Promise<FieldSpec> {
  const { incoming } = offer;
  const origin = { key: incoming.origin.key, version: incoming.origin.version, via };

  if (offer.kind === 'have') return offer.existing;

  if (offer.kind === 'update') {
    // In place, keeping the local id: anything already pointing at this field —
    // a game the player is mid-way through, the screen they are looking at —
    // goes on pointing at it. The version is the sender's, not one more than
    // ours, because the counter belongs to the lineage rather than to a phone.
    const updated: FieldSpec = {
      ...offer.existing,
      name: incoming.name || offer.existing.name,
      a1: incoming.a1,
      h8: incoming.h8,
      // The sender's accuracy readings are not in the link, and keeping ours
      // would attach the old corners' diagnostics to new corners.
      a1Accuracy: undefined,
      h8Accuracy: undefined,
      version: incoming.origin.version,
      updatedAt: now,
      origin,
    };
    await store.save(updated);
    return updated;
  }

  // A fresh local id, not the sender's: this copy is the recipient's own field
  // from here on, and two phones sharing an id would collide the moment either
  // of them shared it onwards.
  const spec: FieldSpec = {
    ...makeFieldSpec(
      incoming.name || 'Shared field',
      { a1: incoming.a1, h8: incoming.h8, h1: incoming.h1, a8: incoming.a8 },
      { now },
    ),
    version: incoming.origin.version,
    origin,
  };
  await store.save(spec);
  return spec;
}

/**
 * Keep the field a game was played on (decision 0027).
 *
 * Not asked about, unlike a shared link, and the difference is the whole of the
 * reasoning: taking a seat in a game *is* the consent. The player is about to
 * spend an hour walking this ground, and the single commonest thing anyone does
 * after playing on a field is play there again — at which point, without this,
 * they would have to ask the person who invited them for a link to the place
 * they both just stood in.
 *
 * Returns the field as saved, or `null` when there was nothing to do.
 */
export async function keepGameField(
  store: FieldStore,
  snap: FieldSnapshot,
  now = Date.now(),
): Promise<FieldSpec | null> {
  const offer = offerFor(fieldLinkFromSnapshot(snap), await store.list());
  if (offer.kind === 'have') return null;
  return adoptField(store, offer, 'game', now);
}

/**
 * Everything the phone holds that came from somewhere else.
 *
 * Only used to word a screen; kept here so the definition of "not mine" lives
 * next to the code that creates them.
 */
export function isCopy(spec: FieldSpec): boolean {
  return spec.origin !== undefined;
}
