import { describe, expect, it } from 'vitest';

import {
  type FieldSpec,
  deriveGeometry,
  makeFieldSpec,
  snapshotField,
} from '../src/shared/field.js';
import {
  MAX_LINK_NAME_BYTES,
  decodeFieldLink,
  encodeFieldLink,
  fieldKey,
  fieldLinkFromSnapshot,
  fieldUrl,
  originKeyFor,
} from '../src/shared/fieldlink.js';
import { distanceM, fromLocal } from '../src/shared/geo.js';
import { encodeQr } from '../src/shared/qr.js';
import { parseAppRoute } from '../src/shared/routes.js';
import { codeFromScan } from '../src/client/scan.js';

/**
 * The wire format for a shared field (decision 0016, stage 6.4).
 *
 * The claim being tested is stronger than "it round-trips": a link printed on a
 * sign has to survive being read by an app several versions newer, decoded by a
 * phone that has never heard of the sender, and refused cleanly when it is not
 * one of ours at all. Every one of those is a case below.
 */

const A1 = { lat: 51.4779, lng: -0.0015 };
const SQUARE_M = 8;

function field(name = 'The common', square = SQUARE_M): FieldSpec {
  return makeFieldSpec(name, { a1: A1, h8: fromLocal(A1, { e: 7 * square, n: 7 * square }) }, {
    id: 'field-under-test',
    now: 1_700_000_000_000,
  });
}

describe('a field survives the round trip', () => {
  it('brings back the corners within a decimetre', () => {
    const spec = field();
    const back = decodeFieldLink(encodeFieldLink(spec));
    expect(back).not.toBeNull();
    // a1 is stored at full precision — about 1.1 cm — and h8 is quantised to a
    // decimetre of east and north, which is the whole error budget of the format.
    expect(distanceM(spec.a1, back!.a1)).toBeLessThan(0.02);
    expect(distanceM(spec.h8, back!.h8)).toBeLessThan(0.15);
  });

  it('reproduces the square size to a centimetre, which is what plays', () => {
    // The corners matter only through the geometry they derive. A decimetre on
    // the diagonal is about a centimetre on a square edge — a hundredth of the
    // GPS error the game is built to absorb (decision 0023).
    const spec = field();
    const back = decodeFieldLink(encodeFieldLink(spec))!;
    const mine = deriveGeometry(spec);
    const theirs = deriveGeometry(back);
    expect(Math.abs(theirs.fileM - mine.fileM)).toBeLessThan(0.02);
    expect(Math.abs(theirs.bearingDeg - mine.bearingDeg)).toBeLessThan(0.2);
  });

  it('carries the name', () => {
    expect(decodeFieldLink(encodeFieldLink(field('Hackney Marshes')))!.name).toBe(
      'Hackney Marshes',
    );
  });

  it('works the world over, including negative coordinates', () => {
    for (const a1 of [
      { lat: -33.8688, lng: 151.2093 },
      { lat: 64.1466, lng: -21.9426 },
      { lat: -0.0001, lng: -0.0001 },
      { lat: 78.2232, lng: 15.6267 },
    ]) {
      const spec = makeFieldSpec('x', { a1: a1, h8: fromLocal(a1, { e: 56, n: -56 }) });
      const back = decodeFieldLink(encodeFieldLink(spec))!;
      expect(distanceM(spec.a1, back.a1)).toBeLessThan(0.02);
      expect(distanceM(spec.h8, back.h8)).toBeLessThan(0.2);
    }
  });

  it('handles a board laid out in any direction', () => {
    // The offset is signed in both axes, so a board running south-west is as
    // encodable as one running north-east. Getting a sign wrong here would put
    // the recipient's board on the far side of the origin.
    for (const offset of [
      { e: 56, n: 56 },
      { e: -56, n: 56 },
      { e: -56, n: -56 },
      { e: 56, n: -56 },
      { e: 0, n: 79 },
    ]) {
      const spec = makeFieldSpec('x', { a1: A1, h8: fromLocal(A1, offset) });
      const back = decodeFieldLink(encodeFieldLink(spec))!;
      expect(distanceM(spec.h8, back.h8)).toBeLessThan(0.2);
    }
  });
});

describe('the name is a label, not the field', () => {
  it('cuts an over-long name to the byte budget rather than growing the QR', () => {
    const long = 'Wandsworth Common, by the bandstand, near the big oak '.repeat(3);
    const back = decodeFieldLink(encodeFieldLink(field(long)))!;
    expect(back.name.length).toBeLessThan(long.length);
    expect(new TextEncoder().encode(back.name).length).toBeLessThanOrEqual(MAX_LINK_NAME_BYTES);
    expect(long.startsWith(back.name)).toBe(true);
  });

  it('cuts on a character boundary, not a byte one', () => {
    // Half a UTF-8 sequence is not decodable, so a naive byte slice would turn a
    // long name in Greek into a link that fails to open at all.
    const back = decodeFieldLink(encodeFieldLink(field('Πεδίο '.repeat(20))))!;
    expect(back.name.startsWith('Πεδίο')).toBe(true);
    expect(back.name).not.toContain('�');
  });

  it('keeps a name made entirely of astral characters intact per character', () => {
    const back = decodeFieldLink(encodeFieldLink(field('🏞️'.repeat(20))))!;
    expect(back.name).not.toContain('�');
    expect([...back.name].length).toBeGreaterThan(0);
  });

  it('accepts a field with no name at all', () => {
    const back = decodeFieldLink(encodeFieldLink(field('')))!;
    expect(back.name).toBe('');
  });
});

describe('provenance', () => {
  it('derives a key from the field id when the field was walked out here', () => {
    expect(fieldKey(field())).toBe(originKeyFor('field-under-test'));
  });

  it('inherits the key through a copy, so a copy of a copy still matches', () => {
    // A → B → C. If each hop re-derived the key from its own new id, C would
    // look like a stranger to A and the de-duplication would silently stop
    // working after one forward.
    const a = field();
    const b: FieldSpec = { ...field(), id: 'b', origin: { key: fieldKey(a), version: 1, via: 'link' } };
    const c = decodeFieldLink(encodeFieldLink(b))!;
    expect(c.origin.key).toBe(fieldKey(a));
  });

  it('carries the version, which is what makes an update recognisable', () => {
    const spec = { ...field(), version: 7 };
    expect(decodeFieldLink(encodeFieldLink(spec))!.origin.version).toBe(7);
  });

  it('reads the same field out of a game snapshot as out of a link', () => {
    // The two paths a field can arrive by have to agree, or a joiner who keeps
    // the field they played on (decision 0027) would not recognise the link for
    // the same ground when it arrives later.
    const spec = field();
    const fromGame = fieldLinkFromSnapshot(snapshotField(spec));
    const fromLink = decodeFieldLink(encodeFieldLink(spec))!;
    expect(fromGame.origin.key).toBe(fromLink.origin.key);
    expect(fromGame.origin.version).toBe(fromLink.origin.version);
  });

  it('gives different fields different keys', () => {
    expect(originKeyFor('a')).not.toBe(originKeyFor('b'));
    expect(originKeyFor('')).toHaveLength(16);
  });
});

describe('a blob that is not ours', () => {
  it('refuses an empty or truncated one', () => {
    const good = encodeFieldLink(field());
    expect(decodeFieldLink('')).toBeNull();
    expect(decodeFieldLink(good.slice(0, 8))).toBeNull();
    // A single trailing character encodes six bits of nothing: the string was cut.
    expect(decodeFieldLink(good.slice(0, 5))).toBeNull();
  });

  it('refuses characters outside base64url', () => {
    expect(decodeFieldLink('not+base64url/at=all')).toBeNull();
  });

  it('refuses a format tag it does not know', () => {
    // The one byte the whole scheme spends on the future. A decoder that guessed
    // from the length would read a version 2 layout as a version 1 field and put
    // somebody's board in the wrong place rather than saying it could not.
    const bytes = [...atob(toStdBase64(encodeFieldLink(field())))].map((c) => c.charCodeAt(0));
    // 1 and 2 are both real layouts now (two-corner and four-corner).
    bytes[0] = 3;
    expect(decodeFieldLink(fromBytes(bytes))).toBeNull();
  });

  it('refuses two corners in the same place', () => {
    // `deriveGeometry` throws on a degenerate field, and every screen downstream
    // assumes it does not have to.
    const bytes = [...atob(toStdBase64(encodeFieldLink(field())))].map((c) => c.charCodeAt(0));
    bytes[9] = bytes[10] = bytes[11] = bytes[12] = 0;
    expect(decodeFieldLink(fromBytes(bytes))).toBeNull();
  });

  it('refuses a name that is not UTF-8', () => {
    const bytes = [...atob(toStdBase64(encodeFieldLink(field('name'))))].map((c) =>
      c.charCodeAt(0),
    );
    bytes[bytes.length - 1] = 0xff;
    expect(decodeFieldLink(fromBytes(bytes))).toBeNull();
  });

  it('refuses a field too large to be one', () => {
    // A board over three kilometres across cannot be expressed in the offset,
    // and silently wrapping it would produce a plausible-looking wrong field.
    const huge = makeFieldSpec('vast', { a1: A1, h8: fromLocal(A1, { e: 9000, n: 9000 }) });
    expect(() => encodeFieldLink(huge)).toThrow();
  });
});

describe('the link the blob goes into', () => {
  it('is a route the app already knows how to serve', () => {
    // The Worker decides whether to answer a path with the shell from this same
    // parser (O-06). A blob it rejects is a link that 404s at the edge, and the
    // client never sees it to explain.
    const blob = encodeFieldLink(field('Wandsworth Common by the bandstand'));
    expect(parseAppRoute(`/f/${blob}`)).toEqual({ kind: 'field', blob });
  });

  it('stays inside the route parser\'s length cap even at the longest name', () => {
    const blob = encodeFieldLink(field('x'.repeat(60)));
    expect(parseAppRoute(`/f/${blob}`)).not.toBeNull();
  });

  it('is not mistaken for a game invite by the scanner', () => {
    // A camera swept across a park sees both kinds of link, and a field blob
    // *does* parse as an app route — joining a game whose code was a field is
    // the exact failure `codeFromScan` is a filter against.
    const url = fieldUrl('https://sat.example', encodeFieldLink(field()));
    expect(codeFromScan(url)).toBeNull();
  });

  it('strips a trailing slash from the origin, like joinUrl', () => {
    expect(fieldUrl('https://sat.example/', 'abc')).toBe('https://sat.example/f/abc');
  });

  it('encodes to a QR sparse enough to read off paper', () => {
    // The plan for 6.4 asks for a symbol that scans off a sign in sunlight, and
    // the lever is payload size rather than error correction. Version 8 is 49
    // modules a side — about 5 mm each on an A4 sheet.
    const url = fieldUrl('https://satellite-chess.workers.dev', encodeFieldLink(field()));
    expect(encodeQr(url, { ecLevel: 'M' }).version).toBeLessThanOrEqual(8);
  });
});

/** base64url → standard base64, so the tests can take a blob apart with `atob`. */
function toStdBase64(blob: string): string {
  const std = blob.replace(/-/g, '+').replace(/_/g, '/');
  return std + '='.repeat((4 - (std.length % 4)) % 4);
}

/** And back again, after poking a byte. */
function fromBytes(bytes: number[]): string {
  const std = btoa(String.fromCharCode(...bytes));
  return std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('four-corner links (decision 0028)', () => {
  /** A board `fileM` x `rankM` with every corner, ready to share. */
  function pitch(fileM: number, rankM = fileM) {
    return makeFieldSpec(
      'The pitch',
      {
        a1: A1,
        h1: fromLocal(A1, { e: 7 * fileM, n: 0 }),
        h8: fromLocal(A1, { e: 7 * fileM, n: 7 * rankM }),
        a8: fromLocal(A1, { e: 0, n: 7 * rankM }),
      },
      { id: 'pitch-1' },
    );
  }

  it('carries a rectangular board through a link intact', () => {
    const decoded = decodeFieldLink(encodeFieldLink(pitch(10, 6)));
    expect(decoded).not.toBeNull();
    const geo = deriveGeometry(decoded!);
    expect(geo.fileM).toBeCloseTo(10, 1);
    expect(geo.rankM).toBeCloseTo(6, 1);
  });

  it('keeps a square board on the short layout, so its QR does not grow', () => {
    // The two-corner format is still written whenever it is enough. A field
    // printed on a sign should not gain eight bytes — and several QR modules —
    // for corners that carry no information.
    const square = makeFieldSpec('Square', { a1: A1, h8: fromLocal(A1, { e: 56, n: 56 }) });
    const shortBlob = encodeFieldLink(square);
    const longBlob = encodeFieldLink(pitch(8));
    expect(longBlob.length).toBeGreaterThan(shortBlob.length);
    // And the old format still decodes to the board it always meant.
    expect(deriveGeometry(decodeFieldLink(shortBlob)!).fileM).toBeCloseTo(8, 1);
  });

  it('refuses a four-corner blob whose corners collapse', () => {
    const spec = pitch(8);
    const bytes = [...atob(toStdBase64(encodeFieldLink(spec)))].map((c) => c.charCodeAt(0));
    // h1 offset to zero, putting it on top of a1.
    bytes[13] = 0;
    bytes[14] = 0;
    bytes[15] = 0;
    bytes[16] = 0;
    expect(decodeFieldLink(fromBytes(bytes))).toBeNull();
  });

  it('survives the same field going out and back through a game snapshot', () => {
    const spec = pitch(10, 6);
    const viaSnapshot = fieldLinkFromSnapshot(snapshotField(spec, 1000));
    expect(viaSnapshot.h1).toEqual(spec.h1);
    const geo = deriveGeometry(viaSnapshot);
    expect(geo.fileM).toBeCloseTo(10, 6);
    expect(geo.rankM).toBeCloseTo(6, 6);
  });
});
