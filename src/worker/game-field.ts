/**
 * A field as a game holds it, from what a phone sent.
 *
 * Split out of `index.ts` for stage 12.3, when a recalibration in a remote
 * game started arriving over the game's socket as well as in a create or join
 * body (decision 0063): create, join and recalibration all check and snapshot
 * it by the same rule, so a field one would refuse is refused by all three.
 */

import { type FieldSnapshot, type FieldSpec, snapshotField } from '../shared/field.js';
import { fieldKey } from '../shared/fieldlink.js';
import { asId, asLatLng, asName, asPositiveInt } from './user-fields.js';

/**
 * A field from a create or join body, or from a remote game's recalibration,
 * snapshotted for a game, or null for one that describes no board. The lineage key rides along so the permanent record
 * can count "fields played on" by ground rather than by copy (stage 2.3.5).
 */
export function gameFieldOf(value: unknown): FieldSnapshot | null {
  const spec = snapshotSpecOf(value);
  if (spec === null) return null;
  try {
    const field = snapshotField(spec);
    const lineageKey = lineageKeyOf(value);
    return lineageKey !== null ? { ...field, lineageKey } : field;
  } catch {
    return null;
  }
}

/**
 * What a snapshot is made of, checked for shape by the rules a field synced
 * to an account is (`user-fields.ts`): a string id, numbers for coordinates,
 * both extra corners or neither, a whole version, and a name that is a
 * string ("Field" if it is not). Null for anything else.
 *
 * Without it a coordinate sent as a string was snapshotted as it came, and in
 * a remote game's recalibration went on into arithmetic that wrote nonsense
 * into the moves already played (found in review, stage 12.3). Only the parts
 * a snapshot keeps are checked, not the whole of `asFieldSpec`: its refusal
 * of a malformed `origin` or timestamp would refuse fields a create has
 * always taken, and a same-field game must be what it was. The lineage key is
 * judged on its own, as before (`lineageKeyOf`).
 */
function snapshotSpecOf(value: unknown): FieldSpec | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const id = asId(raw.id);
  const a1 = asLatLng(raw.a1);
  const h8 = asLatLng(raw.h8);
  const version = asPositiveInt(raw.version);
  if (id === null || a1 === null || h8 === null || version === null) return null;
  const h1 = raw.h1 === undefined || raw.h1 === null ? undefined : asLatLng(raw.h1);
  const a8 = raw.a8 === undefined || raw.a8 === null ? undefined : asLatLng(raw.a8);
  if (h1 === null || a8 === null || (h1 === undefined) !== (a8 === undefined)) return null;
  return {
    ...(raw as unknown as FieldSpec),
    id,
    name: asName(raw.name),
    a1,
    h8,
    h1,
    a8,
    version,
  };
}

/**
 * A field's lineage key, or null for one that is not shaped like ours.
 *
 * The phone's own claim about where its field came from, and harmless as one:
 * it can only decide which of the player's *own* fields a game is filed under
 * in their record. Checked for shape so that a hand-rolled request cannot park
 * an arbitrary string inside every game's snapshot.
 */
function lineageKeyOf(spec: unknown): string | null {
  try {
    const key = fieldKey(spec as FieldSpec);
    return typeof key === 'string' && /^[0-9a-f]{16}$/.test(key) ? key : null;
  } catch {
    return null;
  }
}
