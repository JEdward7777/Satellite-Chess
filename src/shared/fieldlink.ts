/**
 * A field, encoded into a URL, so it can be sent to anyone without a server
 * knowing anything about it.
 *
 * Decision 0016 is the specification, and its premise is the thing worth
 * repeating here: **a field is four numbers and a name**. There is no reason to
 * build a sharing service for four numbers — no upload, no ownership records, no
 * access-control list, no "who can see my fields" screen, nothing that breaks
 * when the sender deletes their account. `https://<host>/f/<blob>` carries the
 * whole field, so resolving it is arithmetic rather than a request.
 *
 * That also means it works in places a server-backed share would not: printed on
 * a sign at the park, in a group chat that outlives the sender's account, or
 * scanned once and used forever. Which is why the layout below is miserly. Every
 * byte is a module in the QR, and a QR on a laminated sign is read at an angle,
 * in sunlight, by a phone that is not being held still.
 *
 *     byte  0       format tag
 *     bytes 1–4     a1 latitude,  int32 BE, degrees x 1e7
 *     bytes 5–8     a1 longitude, int32 BE, degrees x 1e7
 *     bytes 9–10    h8 offset east,  int16 BE, decimetres from a1
 *     bytes 11–12   h8 offset north, int16 BE, decimetres from a1
 *     bytes 13–20   origin key — see below
 *     bytes 21–22   origin version, uint16 BE
 *     bytes 23…     name, UTF-8
 *
 * Twelve bytes of geometry, exactly as decision 0016 sized it. The two corners
 * are stored the way they are stored everywhere else — raw taps, never derived
 * geometry (`harness/AGENTS.md` §6) — so a later revision of the projection maths
 * can reinterpret an old link rather than being stuck with one field's opinion of
 * where h8 was.
 *
 * **h8 is an offset in metres, not in degrees.** A degree of longitude is a
 * different distance at every latitude, and quantising it would put a fixed error
 * in the square size that varies with where you are on the planet. Decimetres of
 * east and north quantise the thing that actually matters, uniformly: 0.1 m on
 * the diagonal is about 0.01 m on a square edge, which is a hundredth of the GPS
 * error the game is built to absorb.
 *
 * The format tag is the one byte spent on the future. A link printed on a sign
 * outlives several versions of this app, and a decoder that cannot tell which
 * layout it is looking at has to guess from the length.
 */

import type { FieldLineage, FieldSpec, FieldSnapshot } from './field.js';
import { type LatLng, fromLocal, toLocal } from './geo.js';

/** The only layout so far. Bump it, do not reuse it. */
const FORMAT = 1;

/** Fixed part: tag, two corners, provenance. The name follows. */
const HEADER_BYTES = 23;

/** Coordinates are stored as integers, this many per degree. About 1.1 cm. */
const COORD_SCALE = 1e7;

/**
 * How far off `a1` the far corner may sit, in decimetres, given a signed 16-bit
 * offset. About 3.2 km, against a board that `checkCalibration` refuses beyond
 * 40 m squares — so this bound is unreachable through the app, and exists to make
 * a corrupt link fail loudly rather than fold silently.
 */
const MAX_OFFSET_DM = 32767;

/**
 * The name's budget in the link, in UTF-8 bytes.
 *
 * The calibrate screen allows sixty characters, which can be well over a hundred
 * bytes once someone names a field in Greek — enough to push the QR up several
 * versions for text that is a label, not the field. A truncated name is a
 * cosmetic loss the recipient can fix in one tap; a QR that will not scan off a
 * sign is the whole feature lost.
 */
export const MAX_LINK_NAME_BYTES = 64;

/** A field as it arrives in a link: geometry, a name, and where it came from. */
export interface FieldLink {
  name: string;
  a1: LatLng;
  h8: LatLng;
  /** No `via`: that is decided by whoever takes the copy, not by the link. */
  origin: FieldLineage;
}

/**
 * The lineage key for a field this phone holds.
 *
 * A field that was walked out here has no `origin`, so its key is derived from
 * its own id; a field that arrived as a copy keeps the key it came with. That is
 * what lets the sharer recognise their own field coming back to them, and lets a
 * copy of a copy still match the original.
 */
export function fieldKey(spec: Pick<FieldSpec, 'id' | 'origin'>): string {
  return spec.origin?.key ?? originKeyFor(spec.id);
}

/**
 * Eight bytes of digest over a field id.
 *
 * The id itself is a UUID — thirty-six characters, forty-eight more in base64url,
 * for a value nobody ever reads. Only equality is ever asked of it, so a digest
 * answers the same question in a fifth of the space. FNV-1a because this is
 * de-duplication, not security: the worst a collision can do is offer to update
 * the wrong field, on a phone that holds perhaps five.
 */
export function originKeyFor(fieldId: string): string {
  const OFFSET = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = OFFSET;
  for (const byte of new TextEncoder().encode(fieldId)) {
    hash = ((hash ^ BigInt(byte)) * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** What a field looks like on the way into a link. Either kind of copy fits. */
type Shareable = Pick<FieldSpec, 'id' | 'name' | 'a1' | 'h8' | 'version' | 'origin'>;

/**
 * Encode a field as the blob half of `/f/<blob>`.
 *
 * Throws only for geometry no calibration could have produced — a corner off the
 * planet, or a board kilometres across. Callers treat that the way the invite
 * screen treats an unencodable QR: lose the feature, not the screen.
 */
export function encodeFieldLink(spec: Shareable): string {
  const offset = toLocal(spec.a1, spec.h8);
  const east = Math.round(offset.e * 10);
  const north = Math.round(offset.n * 10);
  if (Math.abs(east) > MAX_OFFSET_DM || Math.abs(north) > MAX_OFFSET_DM) {
    throw new Error('field too large to encode into a link');
  }

  const name = truncateUtf8(spec.name.trim(), MAX_LINK_NAME_BYTES);
  const bytes = new Uint8Array(HEADER_BYTES + name.length);
  const view = new DataView(bytes.buffer);

  bytes[0] = FORMAT;
  view.setInt32(1, coordToInt(spec.a1.lat), false);
  view.setInt32(5, coordToInt(spec.a1.lng), false);
  view.setInt16(9, east, false);
  view.setInt16(11, north, false);
  bytes.set(keyToBytes(fieldKey(spec)), 13);
  // Clamped rather than refused: a version counter overflowing at 65535 is not a
  // reason to refuse to share ground, and the only cost is that the recipient
  // stops being offered updates.
  view.setUint16(21, Math.min(0xffff, Math.max(0, Math.trunc(spec.version))), false);
  bytes.set(name, HEADER_BYTES);

  return base64UrlEncode(bytes);
}

/** The whole link, for a QR or a share sheet. Mirrors `joinUrl`. */
export function fieldUrl(origin: string, blob: string): string {
  return `${origin.replace(/\/$/, '')}/f/${blob}`;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Read a blob back, or `null` if it is not one of ours.
 *
 * `null` rather than a throw, because every caller is holding a URL somebody
 * else produced — a truncated paste, a link mangled by a chat client, a QR from
 * a different app entirely — and "this is not a field" is an ordinary answer
 * rather than an exceptional one.
 */
export function decodeFieldLink(blob: string): FieldLink | null {
  const bytes = base64UrlDecode(blob);
  if (bytes === null || bytes.length < HEADER_BYTES) return null;
  if (bytes[0] !== FORMAT) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const a1 = {
    lat: intToCoord(view.getInt32(1, false)),
    lng: intToCoord(view.getInt32(5, false)),
  };
  if (Math.abs(a1.lat) > 90 || Math.abs(a1.lng) > 180) return null;

  const east = view.getInt16(9, false) / 10;
  const north = view.getInt16(11, false) / 10;
  // Two corners in the same place is a degenerate field: `deriveGeometry` throws
  // on it, and every screen downstream assumes it does not have to.
  if (east === 0 && north === 0) return null;

  let name: string;
  try {
    // `ignoreBOM` is spelt out because the Workers typings require it, and
    // `src/shared` compiles under both runtimes (decision 0021).
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
    name = decoder.decode(bytes.subarray(HEADER_BYTES));
  } catch {
    // A name that is not UTF-8 means the blob is not what it claims to be, and
    // the geometry alongside it is not worth trusting either.
    return null;
  }

  return {
    name: name.trim(),
    a1,
    h8: fromLocal(a1, { e: east, n: north }),
    origin: {
      key: keyFromBytes(bytes.subarray(13, 21)),
      version: view.getUint16(21, false),
    },
  };
}

/**
 * The same reading, from the field a game carried with it.
 *
 * A game's snapshot and a shared link hold the same four numbers for the same
 * reason — both are copies taken so that a re-calibration elsewhere cannot
 * reshape ground somebody is standing on. Producing one shape from both is what
 * lets a joiner keep the field they played on through exactly the path a shared
 * link takes (decision 0027).
 */
export function fieldLinkFromSnapshot(snap: FieldSnapshot): FieldLink {
  return {
    name: snap.name,
    a1: snap.a1,
    h8: snap.h8,
    origin: { key: originKeyFor(snap.fieldId), version: snap.version },
  };
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

function coordToInt(deg: number): number {
  return Math.round(deg * COORD_SCALE);
}

function intToCoord(value: number): number {
  return value / COORD_SCALE;
}

function keyToBytes(key: string): Uint8Array {
  const bytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number.parseInt(key.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return bytes;
}

function keyFromBytes(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * Cut a string to a byte budget without splitting a character in half.
 *
 * Byte-counted rather than character-counted because that is what the QR pays
 * for, and dropping a lone surrogate or half a UTF-8 sequence would produce a
 * name that `TextDecoder` refuses — a link that fails to decode over a label.
 */
function truncateUtf8(text: string, maxBytes: number): Uint8Array {
  const encoder = new TextEncoder();
  const full = encoder.encode(text);
  if (full.length <= maxBytes) return full;
  let cut = text;
  while (cut.length > 0 && encoder.encode(cut).length > maxBytes) {
    // By code point, so an emoji or a surrogate pair leaves together.
    cut = [...cut].slice(0, -1).join('');
  }
  return encoder.encode(cut);
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * base64url, unpadded, written out by hand.
 *
 * `btoa` would do, but it is a different global in each of this project's three
 * runtimes (decision 0021) and it round-trips through a binary string, which is
 * the classic way to lose a byte above 0x7f. Twenty lines here is cheaper than
 * finding that out from a field whose name is in Greek.
 */
function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64URL[a >> 2];
    out += B64URL[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += B64URL[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += B64URL[c & 63];
  }
  return out;
}

function base64UrlDecode(text: string): Uint8Array | null {
  const length = text.length;
  // A base64 group is 4, 3 or 2 characters. One left over encodes six bits of
  // nothing and means the string was cut short.
  if (length === 0 || length % 4 === 1) return null;

  const bytes = new Uint8Array(Math.floor((length * 3) / 4));
  let out = 0;
  let acc = 0;
  let bits = 0;
  for (const ch of text) {
    const value = B64URL.indexOf(ch);
    if (value < 0) return null;
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (acc >> bits) & 0xff;
    }
  }
  return bytes.subarray(0, out);
}
