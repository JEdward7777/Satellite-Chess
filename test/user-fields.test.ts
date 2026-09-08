import { describe, expect, it } from 'vitest';

import { type FieldSpec, makeFieldSpec } from '../src/shared/field.js';
import { fieldKey, originKeyFor } from '../src/shared/fieldlink.js';
import { fromLocal } from '../src/shared/geo.js';
import {
  FIELD_COLUMNS,
  type FieldRow,
  MAX_FIELD_NAME_CHARS,
  asFieldSpec,
  bindValuesFor,
  specFromRow,
} from '../src/worker/user-fields.js';

/**
 * The server's end of a saved field (stage 2.3.3.2).
 *
 * Two things are worth testing and neither needs a runtime. The first is that
 * the columns and the values stay in step — twenty-one of each, positional, and
 * a pair swapped by an edit would put a latitude in a longitude column and go on
 * working right up until somebody stood on the wrong continent. The second is
 * that a field arriving from a phone is not believed: this is the one table a
 * client writes to directly.
 */

const A1 = { lat: 51.4779, lng: -0.0015 };

function square(over: Partial<FieldSpec> = {}): FieldSpec {
  return {
    ...makeFieldSpec('The common', { a1: A1, h8: fromLocal(A1, { e: 56, n: 56 }) }, {
      id: 'field-1',
      now: 1000,
    }),
    ...over,
  };
}

function fourCorners(): FieldSpec {
  return makeFieldSpec(
    'The pitch',
    {
      a1: A1,
      h1: fromLocal(A1, { e: 70, n: 0 }),
      h8: fromLocal(A1, { e: 70, n: 42 }),
      a8: fromLocal(A1, { e: 0, n: 42 }),
    },
    { id: 'field-4', accuracy: { a1: 3, h8: 4 }, now: 2000 },
  );
}

/** A row as SQLite would hand it back, built the way the DO writes it. */
function rowFor(spec: FieldSpec): FieldRow {
  const values = bindValuesFor(spec);
  return Object.fromEntries(FIELD_COLUMNS.map((name, i) => [name, values[i]])) as FieldRow;
}

describe('a field, out to a row and back', () => {
  it('round-trips a two-tap field unchanged', () => {
    const spec = square();
    expect(specFromRow(rowFor(spec))).toEqual(spec);
  });

  it('round-trips four corners, accuracies and provenance', () => {
    const spec: FieldSpec = {
      ...fourCorners(),
      origin: { key: originKeyFor('theirs'), version: 3, via: 'game' },
    };
    expect(specFromRow(rowFor(spec))).toEqual(spec);
  });

  it('writes the lineage key the server derives, never one it was handed', () => {
    // A chosen lineage key would let a field pose as a copy of somebody else's
    // and be offered to them as an update to it.
    const mine = square();
    expect(rowFor(mine).lineage_key).toBe(fieldKey(mine));

    const copy: FieldSpec = {
      ...square(),
      origin: { key: originKeyFor('theirs'), version: 1, via: 'link' },
    };
    // Inherited, never re-derived: A → B → C still recognises A's lineage.
    expect(rowFor(copy).lineage_key).toBe(originKeyFor('theirs'));
  });

  it('keeps a column for every value', () => {
    expect(bindValuesFor(square())).toHaveLength(FIELD_COLUMNS.length);
  });

  it('reads a half-present corner pair as the two-tap board it is not', () => {
    // Defensive: the DO cannot write one of these, but a hand-edited row or a
    // future migration could, and reading it as a four-corner field would drop
    // the surviving corner silently.
    const row = { ...rowFor(fourCorners()), a8_lat: null, a8_lng: null };
    const spec = specFromRow(row);
    expect(spec.h1).toBeUndefined();
    expect(spec.a8).toBeUndefined();
  });
});

describe('nothing from a phone is believed', () => {
  it('accepts what the client actually sends', () => {
    expect(asFieldSpec(JSON.parse(JSON.stringify(fourCorners())))).toEqual(fourCorners());
  });

  it('refuses a field with no usable geometry', () => {
    expect(asFieldSpec({ ...square(), a1: undefined })).toBeNull();
    expect(asFieldSpec({ ...square(), h8: { lat: 91, lng: 0 } })).toBeNull();
    expect(asFieldSpec({ ...square(), a1: { lat: '51', lng: 0 } })).toBeNull();
    // Two corners in the same place derive nothing, and would throw on the
    // first screen that tried to draw them rather than here.
    expect(asFieldSpec({ ...square(), h8: A1 })).toBeNull();
  });

  it('refuses half a four-corner board', () => {
    const spec = fourCorners();
    expect(asFieldSpec({ ...spec, a8: undefined })).toBeNull();
    expect(asFieldSpec({ ...spec, h1: undefined })).toBeNull();
  });

  it('refuses an id that could not be a key', () => {
    expect(asFieldSpec({ ...square(), id: '' })).toBeNull();
    expect(asFieldSpec({ ...square(), id: '../../etc' })).toBeNull();
    expect(asFieldSpec({ ...square(), id: 'a'.repeat(129) })).toBeNull();
  });

  it('refuses a malformed provenance rather than dropping it', () => {
    // Dropping it would turn a copy into an original, and every copy taken from
    // it afterwards would start a new lineage instead of updating the old one.
    const spec = square();
    expect(asFieldSpec({ ...spec, origin: { key: 'abc', version: 1, via: 'post' } })).toBeNull();
    expect(asFieldSpec({ ...spec, origin: { key: '', version: 1, via: 'link' } })).toBeNull();
    expect(asFieldSpec({ ...spec, origin: 'theirs' })).toBeNull();
    // Absent is not malformed — that is a field walked out on this phone.
    expect(asFieldSpec({ ...spec, origin: undefined })?.origin).toBeUndefined();
  });

  it('mends a name rather than refusing ground over a label', () => {
    expect(asFieldSpec({ ...square(), name: '   ' })?.name).toBe('Field');
    expect(asFieldSpec({ ...square(), name: 42 })?.name).toBe('Field');
    expect(asFieldSpec({ ...square(), name: 'x'.repeat(500) })?.name).toHaveLength(
      MAX_FIELD_NAME_CHARS,
    );
  });

  it('drops a nonsense accuracy, which is only ever a diagnostic', () => {
    const spec = asFieldSpec({ ...square(), a1Accuracy: -1, h8Accuracy: 'near' });
    expect(spec).not.toBeNull();
    expect(spec?.a1Accuracy).toBeUndefined();
    expect(spec?.h8Accuracy).toBeUndefined();
  });

  it('takes a clock that is wrong, because phones have wrong clocks', () => {
    const future = asFieldSpec({ ...square(), updatedAt: 4_000_000_000_000 });
    expect(future?.updatedAt).toBe(4_000_000_000_000);
    expect(asFieldSpec({ ...square(), updatedAt: -1 })).toBeNull();
    expect(asFieldSpec({ ...square(), version: 0 })).toBeNull();
  });
});
