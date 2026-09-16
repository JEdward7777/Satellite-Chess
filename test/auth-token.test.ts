import { describe, expect, it } from 'vitest';

import { challengeFor, readIdToken, safeNext } from '../src/worker/auth.js';
import { encodeUtf8 } from '../src/worker/crypto.js';

/**
 * The pure halves of Google sign-in (stage 2.1).
 *
 * PKCE arithmetic and ID token parsing, both of which are `crypto.subtle` and
 * string handling and therefore identical in node and in workerd. The routes,
 * the redirect and the cookies are exercised against the real runtime in
 * `test/worker/auth.test.ts`.
 *
 * What is being defended here is the same thing as in `identity-token.test.ts`:
 * this payload names an account. The signature is deliberately **not** checked
 * (see the note at the top of `auth.ts` for the one condition that makes that
 * safe), so every other claim check is load-bearing rather than belt-and-braces
 * — they are the only things standing between a malformed token and a `sub`.
 */

/** A JWT-shaped string with `payload` in the middle. The signature is never read. */
function idToken(payload: Record<string, unknown>): string {
  const header = encodeUtf8(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  return `${header}.${encodeUtf8(JSON.stringify(payload))}.not-a-real-signature`;
}

const VALID = {
  iss: 'https://accounts.google.com',
  aud: 'client-id.apps.googleusercontent.com',
  sub: '117554968855954827048',
  exp: 1_700_000_060,
  nonce: 'the-nonce',
  email: 'player@example.com',
  email_verified: true,
};

describe('PKCE code challenge', () => {
  it('matches the S256 vector from RFC 7636', async () => {
    // The canonical worked example from the specification. If this ever drifts,
    // Google rejects every exchange with `invalid_grant` and the cause is three
    // layers away from the symptom — so it is pinned to an external constant
    // rather than to whatever our own implementation happens to produce.
    expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('produces base64url with no padding, which is what the parameter allows', async () => {
    const challenge = await challengeFor('a'.repeat(43));
    expect(challenge).not.toMatch(/[+/=]/);
    // SHA-256 is 32 bytes, which is 43 base64url characters unpadded.
    expect(challenge).toHaveLength(43);
  });
});

describe('reading the ID token', () => {
  it('pulls out the claims that identify a player', () => {
    const claims = readIdToken({ id_token: idToken(VALID) });
    expect(claims).toMatchObject({
      iss: 'https://accounts.google.com',
      aud: 'client-id.apps.googleusercontent.com',
      sub: '117554968855954827048',
      exp: 1_700_000_060,
      nonce: 'the-nonce',
      email: 'player@example.com',
      emailVerified: true,
    });
  });

  it('reports an unverified email as unverified rather than as absent', () => {
    // `email_verified` is only ever true when Google says so. Anything else —
    // false, missing, the string "true" — is not a verified address.
    for (const value of [false, undefined, 'true']) {
      const claims = readIdToken({ id_token: idToken({ ...VALID, email_verified: value }) });
      expect(claims?.emailVerified).toBe(false);
    }
  });

  it('survives a token with no email at all', () => {
    // `email` is a scope we ask for, not one we are guaranteed. The account key
    // is the `sub`, so a token without an address is still a sign-in.
    const { email, ...withoutEmail } = VALID;
    const claims = readIdToken({ id_token: idToken(withoutEmail) });
    expect(claims?.sub).toBe('117554968855954827048');
    expect(claims?.email).toBeUndefined();
  });

  it('refuses a payload missing any claim the callback checks', () => {
    // Each of these is compared against something in `completeSignIn`. A token
    // missing one would otherwise reach that comparison as `undefined` and
    // compare unequal — which is the right answer by accident rather than on
    // purpose, and stops being right the moment a check is reordered.
    for (const claim of ['iss', 'aud', 'sub', 'exp', 'nonce'] as const) {
      const { [claim]: _dropped, ...rest } = VALID;
      expect(readIdToken({ id_token: idToken(rest) }), claim).toBeNull();
    }
  });

  it('refuses claims of the wrong type', () => {
    // `exp` as a string is the interesting one: `'9999999999' * 1000` is a
    // number, so a loose check would let a string expiry through and compare it
    // successfully against the clock.
    expect(readIdToken({ id_token: idToken({ ...VALID, exp: '1700000060' }) })).toBeNull();
    expect(readIdToken({ id_token: idToken({ ...VALID, sub: 12345 }) })).toBeNull();
    expect(readIdToken({ id_token: idToken({ ...VALID, iss: null }) })).toBeNull();
  });

  it('refuses anything that is not a three-part JWT', () => {
    for (const junk of ['', 'a', 'a.b', 'a.b.c.d', '..', 'not a token at all']) {
      expect(readIdToken({ id_token: junk }), junk).toBeNull();
    }
  });

  it('refuses a response with no id_token, without throwing', () => {
    for (const body of [null, undefined, {}, { id_token: 42 }, { access_token: 'x' }, 'string']) {
      expect(readIdToken(body)).toBeNull();
    }
  });

  it('refuses a payload that is not base64url, or not JSON', () => {
    expect(readIdToken({ id_token: 'head.!!!not-base64url!!!.sig' })).toBeNull();
    expect(readIdToken({ id_token: `head.${encodeUtf8('not json')}.sig` })).toBeNull();
  });
});

/**
 * Where a completed sign-in is allowed to land (stage 2.5.1).
 *
 * The gate carries a destination through the flow so that someone who scanned an
 * invite while signed out comes back to *that invite* rather than to the home
 * screen — the commonest first-ever sign-in is a QR in a park, and losing it is
 * the worst moment to lose anything.
 *
 * That makes this function the app's only open-redirect surface, so it is an
 * allowlist rather than a denylist: a destination has to be a route this app
 * actually owns. Every "clever" off-origin spelling below therefore has the same
 * boring answer, which is the point.
 */
describe('where sign-in may return to', () => {
  it('keeps a route this app owns', () => {
    expect(safeNext('/')).toBe('/');
    expect(safeNext('/j/ABC123')).toBe('/j/ABC123');
    expect(safeNext('/f/AAAAAAAAAAAAAAAA')).toBe('/f/AAAAAAAAAAAAAAAA');
  });

  it('keeps the query string, because the simulator lives there', () => {
    // Losing `?sim=1` would end a simulated game the moment anybody signed in,
    // and that is how every browser check in this project is run.
    expect(safeNext('/j/ABC123?sim=1')).toBe('/j/ABC123?sim=1');
    expect(safeNext('/?sim=1')).toBe('/?sim=1');
  });

  it('sends anything off-origin home instead', () => {
    for (const hostile of [
      'https://evil.example/',
      '//evil.example',
      'http://127.0.0.1:8799/j/ABC123',
      'javascript:alert(1)',
      '/\\evil.example',
    ]) {
      expect(safeNext(hostile), hostile).toBe('/');
    }
  });

  it('sends a path this app does not own home', () => {
    // Not a security question so much as an honesty one: the Worker would 404
    // these, so returning a freshly signed-in player to one would end a
    // successful sign-in on an error page.
    for (const unowned of ['/api/me', '/auth/google/login', '/nonsense', '/j/nope']) {
      expect(safeNext(unowned), unowned).toBe('/');
    }
  });

  it('treats a missing, empty or over-long destination as home', () => {
    expect(safeNext(null)).toBe('/');
    expect(safeNext(undefined)).toBe('/');
    expect(safeNext('')).toBe('/');
    // `undefined` is what a flow cookie sealed before this field existed
    // deserialises to, so it is a real input rather than a type formality.
    expect(safeNext(`/j/ABC123?${'x'.repeat(600)}`)).toBe('/');
  });
});
