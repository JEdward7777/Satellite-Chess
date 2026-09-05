/**
 * Small cryptographic helpers for the Worker.
 *
 * **Web Crypto only.** There is no Node `crypto` in a Worker, so everything here
 * goes through `crypto.subtle` — which is asynchronous, hence the promises on
 * what look like they ought to be plain functions.
 */

/**
 * Compare two byte strings in time that does not depend on how much of the
 * prefix matched.
 *
 * The windows this protects in this project are small — an attacker would have
 * to find the endpoint first, and the payoff is a debug log or a loopback-only
 * test seam — but a plain `===` on a credential is exactly the kind of thing
 * that gets copied into somewhere it does matter.
 *
 * Length is compared first and non-secretly, which leaks the length of the
 * expected value. That is the standard trade and it is fine here: the lengths
 * are fixed by the token format, not by anything secret.
 */
export function timingSafeEqual(given: string | null, expected: string): boolean {
  if (given === null || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/** HMAC-SHA256 over `message`, keyed by `secret`, as base64url. */
export async function hmacSha256(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return base64UrlEncode(new Uint8Array(signature));
}

/**
 * base64url, per RFC 4648 §5 — the padding-free, URL-safe alphabet.
 *
 * Tokens travel in a cookie and in a URL, where `+`, `/` and `=` all have to be
 * escaped by somebody. Encoding them away is cheaper than getting the escaping
 * right at every hop.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The inverse. Returns null on anything that is not valid base64url. */
export function base64UrlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** base64url of a UTF-8 string, and back. */
export function encodeUtf8(text: string): string {
  return base64UrlEncode(new TextEncoder().encode(text));
}

export function decodeUtf8(text: string): string | null {
  const bytes = base64UrlDecode(text);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}
