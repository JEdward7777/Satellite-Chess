/**
 * Six-character join codes in Crockford base32.
 *
 * Crockford's alphabet drops I, L, O and U, which removes every character pair
 * people confuse when reading a code aloud across a field, and the decoder
 * folds the lookalikes back in so a mis-typed "0" for "O" still works.
 *
 * 32^6 is about 1.07e9. Collisions are handled at the Durable Object rather
 * than by checking uniqueness up front: the DO derived from a code refuses a
 * join if it already has two players, so a collision costs the loser one retry.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const JOIN_CODE_LENGTH = 6;

export function generateJoinCode(): string {
  const bytes = new Uint8Array(JOIN_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    // 256 is not a multiple of 32... it is (8 * 32), so the modulo is unbiased.
    out += ALPHABET[bytes[i] % 32];
  }
  return out;
}

/**
 * Fold a human-typed code into canonical form, or return null if it can't be
 * one. Case-insensitive; tolerates spaces and hyphens; maps the lookalikes.
 */
export function normaliseJoinCode(input: string): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    // Not part of Crockford's alphabet, but "U" is what a hurried player types
    // when they mean "V".
    .replace(/U/g, 'V');

  if (cleaned.length !== JOIN_CODE_LENGTH) return null;
  for (const ch of cleaned) {
    if (!ALPHABET.includes(ch)) return null;
  }
  return cleaned;
}

export function isJoinCode(input: string): boolean {
  return normaliseJoinCode(input) !== null;
}

/** Grouped for display: "ABC 123" reads aloud better than "ABC123". */
export function formatJoinCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

export function joinUrl(origin: string, code: string): string {
  return `${origin.replace(/\/$/, '')}/j/${code}`;
}
