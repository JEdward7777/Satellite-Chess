/**
 * Saved fields on the server side: validating one that arrives, and moving it
 * between a `FieldSpec` and a row in the account's `fields` table (stage
 * 2.3.3.2).
 *
 * Split out of `user-do.ts` because the two halves have different audiences.
 * The Durable Object is about storage and ordering; this file is about **not
 * trusting the phone**, and that is the half worth reading in node — every
 * shape here arrives as JSON from a client that may be a browser, a script, or
 * somebody with `curl` and an opinion.
 *
 * ## Why a column per corner rather than a JSON blob
 *
 * A game's field snapshot is stored as JSON because nothing ever queries inside
 * it. These rows are queried: listed by recency, fetched by id, and matched by
 * lineage when a copy arrives. Column-per-value keeps `lineage_key` indexable
 * and makes a schema change visible as a schema change rather than as a blob
 * that quietly means something new.
 *
 * ## What is deliberately not validated
 *
 * Whether the corners describe *good* ground. `checkCalibration` has opinions
 * about squares that are too small to stand on, and they belong on the phone of
 * the person walking the field — refusing to store a 3 m board would mean the
 * server deciding that someone's practice game in a car park is not allowed to
 * be saved. The only geometric rule here is that the field must derive at all,
 * because a degenerate one would throw somewhere later instead.
 */

import {
  type FieldSpec,
  type FieldOrigin,
  deriveGeometry,
} from '../shared/field.js';
import { fieldKey } from '../shared/fieldlink.js';
import type { LatLng } from '../shared/geo.js';

/**
 * How many fields one account may hold.
 *
 * A field is four numbers and a name, and a person who has walked out two
 * hundred boards is not a person, so this is not a quota — it is the bound that
 * stops an authenticated client turning its own Durable Object into a database
 * for something else. Well clear of any real use, and a wall rather than a
 * gradient so the failure is legible.
 */
export const MAX_FIELDS_PER_ACCOUNT = 200;

/**
 * The stored name's cap, in characters.
 *
 * Longer than `MAX_LINK_NAME_BYTES` on purpose: a link truncates because bytes
 * in a QR are expensive, and there is no reason to make the phone forget the
 * rest of a name it can perfectly well hold.
 */
export const MAX_FIELD_NAME_CHARS = 120;

/** One row of `fields`, exactly as the table spells it. */
export interface FieldRow {
  id: string;
  name: string;
  a1_lat: number;
  a1_lng: number;
  h8_lat: number;
  h8_lng: number;
  h1_lat: number | null;
  h1_lng: number | null;
  a8_lat: number | null;
  a8_lng: number | null;
  a1_accuracy: number | null;
  h8_accuracy: number | null;
  h1_accuracy: number | null;
  a8_accuracy: number | null;
  version: number;
  origin_key: string | null;
  origin_version: number | null;
  origin_via: string | null;
  lineage_key: string;
  created_at: number;
  updated_at: number;
  [key: string]: SqlStorageValue;
}

/** A row as the phone that wrote it would recognise it. */
export function specFromRow(row: FieldRow): FieldSpec {
  const spec: FieldSpec = {
    id: row.id,
    name: row.name,
    a1: { lat: row.a1_lat, lng: row.a1_lng },
    h8: { lat: row.h8_lat, lng: row.h8_lng },
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  // Both or neither: a half-present pair would be read by `hasFourCorners` as a
  // two-tap field and silently drop the corner that survived.
  if (row.h1_lat !== null && row.h1_lng !== null && row.a8_lat !== null && row.a8_lng !== null) {
    spec.h1 = { lat: row.h1_lat, lng: row.h1_lng };
    spec.a8 = { lat: row.a8_lat, lng: row.a8_lng };
  }
  if (row.a1_accuracy !== null) spec.a1Accuracy = row.a1_accuracy;
  if (row.h8_accuracy !== null) spec.h8Accuracy = row.h8_accuracy;
  if (row.h1_accuracy !== null) spec.h1Accuracy = row.h1_accuracy;
  if (row.a8_accuracy !== null) spec.a8Accuracy = row.a8_accuracy;
  if (row.origin_key !== null && row.origin_version !== null) {
    spec.origin = {
      key: row.origin_key,
      version: row.origin_version,
      via: row.origin_via === 'game' ? 'game' : 'link',
    };
  }
  return spec;
}

/**
 * The bind values for an upsert, in the order {@link FIELD_COLUMNS} names them.
 *
 * A list rather than an object because `SqlStorage.exec` takes positional
 * parameters, and one array built next to the column list is harder to get out
 * of step than twenty-two arguments spelled out at the call site.
 */
export const FIELD_COLUMNS = [
  'id',
  'name',
  'a1_lat',
  'a1_lng',
  'h8_lat',
  'h8_lng',
  'h1_lat',
  'h1_lng',
  'a8_lat',
  'a8_lng',
  'a1_accuracy',
  'h8_accuracy',
  'h1_accuracy',
  'a8_accuracy',
  'version',
  'origin_key',
  'origin_version',
  'origin_via',
  'lineage_key',
  'created_at',
  'updated_at',
] as const;

export function bindValuesFor(spec: FieldSpec): SqlStorageValue[] {
  return [
    spec.id,
    spec.name,
    spec.a1.lat,
    spec.a1.lng,
    spec.h8.lat,
    spec.h8.lng,
    spec.h1?.lat ?? null,
    spec.h1?.lng ?? null,
    spec.a8?.lat ?? null,
    spec.a8?.lng ?? null,
    spec.a1Accuracy ?? null,
    spec.h8Accuracy ?? null,
    spec.h1Accuracy ?? null,
    spec.a8Accuracy ?? null,
    spec.version,
    spec.origin?.key ?? null,
    spec.origin?.version ?? null,
    spec.origin?.via ?? null,
    // Materialised here rather than computed in SQL, because `fieldKey` falls
    // back to a digest of the field's own id and so cannot be an indexed
    // expression. Always the server's own answer — a client that sent a
    // lineage key of its choosing could make its field pose as a copy of
    // somebody else's and be offered as an update to it.
    fieldKey(spec),
    spec.createdAt,
    spec.updatedAt,
  ];
}

/**
 * A `FieldSpec` from whatever the client sent, or null.
 *
 * Null rather than a throw with a reason, because there is exactly one thing to
 * do about any of these — refuse the field and say so once. The phone that sent
 * it built it from `makeFieldSpec`, so anything failing here is either a bug or
 * not a phone.
 */
export function asFieldSpec(value: unknown): FieldSpec | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;

  const id = asId(raw.id);
  const a1 = asLatLng(raw.a1);
  const h8 = asLatLng(raw.h8);
  const version = asPositiveInt(raw.version);
  const createdAt = asTimestamp(raw.createdAt);
  const updatedAt = asTimestamp(raw.updatedAt);
  if (id === null || a1 === null || h8 === null) return null;
  if (version === null || createdAt === null || updatedAt === null) return null;

  // Both corners or neither. A spec carrying only `h1` reads as a two-tap
  // field everywhere downstream, so accepting it would store a board the
  // sender did not calibrate.
  const h1 = raw.h1 === undefined || raw.h1 === null ? undefined : asLatLng(raw.h1);
  const a8 = raw.a8 === undefined || raw.a8 === null ? undefined : asLatLng(raw.a8);
  if (h1 === null || a8 === null) return null;
  if ((h1 === undefined) !== (a8 === undefined)) return null;

  const spec: FieldSpec = {
    id,
    name: asName(raw.name),
    a1,
    h8,
    ...(h1 && a8 ? { h1, a8 } : {}),
    ...pickAccuracy(raw),
    version,
    createdAt,
    updatedAt,
  };

  const origin = asOrigin(raw.origin);
  if (origin === null) return null;
  if (origin !== undefined) spec.origin = origin;

  // The one geometric rule. Two corners in the same place, or four that do not
  // describe a board, would throw the first time anything tried to draw or
  // measure them — better here, where the answer is "no" rather than a 500 on
  // some later screen.
  try {
    deriveGeometry(spec);
  } catch {
    return null;
  }

  return spec;
}

function pickAccuracy(raw: Record<string, unknown>): Partial<FieldSpec> {
  const out: Partial<FieldSpec> = {};
  const a1 = asAccuracy(raw.a1Accuracy);
  const h8 = asAccuracy(raw.h8Accuracy);
  const h1 = asAccuracy(raw.h1Accuracy);
  const a8 = asAccuracy(raw.a8Accuracy);
  // Diagnostics, so a nonsense value is dropped rather than being a reason to
  // refuse a field somebody walked out.
  if (a1 !== null) out.a1Accuracy = a1;
  if (h8 !== null) out.h8Accuracy = h8;
  if (h1 !== null) out.h1Accuracy = h1;
  if (a8 !== null) out.a8Accuracy = a8;
  return out;
}

/**
 * Provenance, or `undefined` for a field walked out on the sender's own phone.
 *
 * `null` is the refusal, so a malformed origin is not quietly dropped: losing
 * it would turn a copy into an original, and every copy of it thereafter would
 * be a new lineage rather than an update to the one it came from.
 */
function asOrigin(value: unknown): FieldOrigin | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const key = asId(raw.key);
  const version = asPositiveInt(raw.version);
  if (key === null || version === null) return null;
  if (raw.via !== 'link' && raw.via !== 'game') return null;
  return { key, version, via: raw.via };
}

/** An id that is safe as a primary key and as a lineage key. */
export function asId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 128) return null;
  if (!/[A-Za-z0-9]/.test(trimmed)) return null;
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : null;
}

/**
 * A name, never a refusal.
 *
 * A field with an unusable name is still a field, and losing ground over a
 * label would be the wrong trade — the same reasoning that makes a link
 * truncate rather than refuse.
 */
function asName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().slice(0, MAX_FIELD_NAME_CHARS) : '';
  return name === '' ? 'Field' : name;
}

function asLatLng(value: unknown): LatLng | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const lat = raw.lat;
  const lng = raw.lng;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function asAccuracy(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : null;
}

/**
 * A millisecond timestamp from a clock that might be wrong.
 *
 * Not bounded to "now", deliberately: phones have bad clocks, and a field
 * stamped an hour into the future is a field, not an attack. The bound is only
 * that it is a real number of milliseconds — ordering by it is a convenience,
 * never a rule anything rests on.
 */
function asTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}
