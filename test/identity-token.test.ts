import { describe, expect, it } from 'vitest';

import {
  asSub,
  isLoopback,
  mintDevToken,
  readCookie,
  verifyDevToken,
} from '../src/worker/identity.js';
import { base64UrlDecode, base64UrlEncode, decodeUtf8, encodeUtf8, timingSafeEqual } from '../src/worker/crypto.js';

/**
 * The dev session token (stage 2.5.2).
 *
 * Pure crypto and pure parsing, so it runs in node rather than in workerd —
 * `crypto.subtle` is the same Web Crypto in both. The routes that wrap this, and
 * the two locks that keep them off a deployed build, are exercised against the
 * real runtime in `test/worker/identity.test.ts`.
 *
 * What is being defended here is small but absolute: this token names an
 * account. Every test below is a way of asking "can something that is not a
 * freshly minted, unexpired, correctly signed token be made to name one?"
 */

const SECRET = 'test-dev-auth-secret';
const NOW = 1_700_000_000_000;
const LATER = NOW + 60_000;

describe('dev session tokens', () => {
  it('round-trips a sub', async () => {
    const token = await mintDevToken('alice', SECRET, LATER);
    expect(await verifyDevToken(token, SECRET, NOW)).toBe('alice');
  });

  it('is tagged so it can never be mistaken for a real session', async () => {
    // Stage 2.2's sessions are opaque and stored; these are signed and
    // stateless. `identityOf` picks between them on this prefix, so it is part
    // of the format rather than decoration.
    expect(await mintDevToken('alice', SECRET, LATER)).toMatch(/^d1\./);
  });

  it('refuses a token signed with a different secret', async () => {
    const token = await mintDevToken('alice', 'some-other-secret', LATER);
    expect(await verifyDevToken(token, SECRET, NOW)).toBeNull();
  });

  it('refuses a token whose payload was edited', async () => {
    // The attack this exists to stop: mint `alice`, rewrite the claim to
    // `victim`, keep the signature. The signature covers the payload, so it
    // stops matching.
    const token = await mintDevToken('alice', SECRET, LATER);
    const [prefix, , signature] = token.split('.');
    const forged = encodeUtf8(JSON.stringify({ sub: 'victim', exp: LATER }));
    expect(await verifyDevToken(`${prefix}.${forged}.${signature}`, SECRET, NOW)).toBeNull();
  });

  it('refuses an unsigned token', async () => {
    // "Just drop the signature" is the classic one, and the reason the parts
    // count is checked before anything else.
    const payload = encodeUtf8(JSON.stringify({ sub: 'alice', exp: LATER }));
    expect(await verifyDevToken(`d1.${payload}`, SECRET, NOW)).toBeNull();
    expect(await verifyDevToken(`d1.${payload}.`, SECRET, NOW)).toBeNull();
  });

  it('refuses a token that has expired', async () => {
    const token = await mintDevToken('alice', SECRET, NOW);
    expect(await verifyDevToken(token, SECRET, NOW)).toBeNull();
    expect(await verifyDevToken(token, SECRET, NOW - 1)).toBe('alice');
  });

  it('refuses a token with no expiry at all', async () => {
    // A missing `exp` must not read as "never expires". Signed by the real
    // secret, so this is only caught by the claim check.
    const payload = encodeUtf8(JSON.stringify({ sub: 'alice' }));
    const { hmacSha256 } = await import('../src/worker/crypto.js');
    const signature = await hmacSha256(SECRET, `d1.${payload}`);
    expect(await verifyDevToken(`d1.${payload}.${signature}`, SECRET, NOW)).toBeNull();
  });

  it('refuses a sub the charset would not allow as an object name', async () => {
    const payload = encodeUtf8(JSON.stringify({ sub: '../../etc/passwd', exp: LATER }));
    const { hmacSha256 } = await import('../src/worker/crypto.js');
    const signature = await hmacSha256(SECRET, `d1.${payload}`);
    expect(await verifyDevToken(`d1.${payload}.${signature}`, SECRET, NOW)).toBeNull();
  });

  it('refuses junk without throwing', async () => {
    for (const junk of ['', '.', 'd1', 'd1.!!!.???', 'x1.a.b', 'not a token at all']) {
      expect(await verifyDevToken(junk, SECRET, NOW)).toBeNull();
    }
  });
});

describe('asSub', () => {
  it('accepts a readable dev name and a Google sub', () => {
    expect(asSub('alice')).toBe('alice');
    expect(asSub('117554968855954827048')).toBe('117554968855954827048');
    expect(asSub('  alice  ')).toBe('alice');
  });

  it('rejects anything that is not safe as a Durable Object name', () => {
    expect(asSub('')).toBeNull();
    expect(asSub('   ')).toBeNull();
    expect(asSub('a/b')).toBeNull();
    expect(asSub('a b')).toBeNull();
    expect(asSub('x'.repeat(129))).toBeNull();
    expect(asSub(42)).toBeNull();
    expect(asSub(null)).toBeNull();
  });

  it('rejects an account key made entirely of punctuation', () => {
    // The charset alone allows these, which is what the alphanumeric floor is
    // for. Caught by this test before anything depended on it.
    expect(asSub('..')).toBeNull();
    expect(asSub('.')).toBeNull();
    expect(asSub('---')).toBeNull();
    expect(asSub('_:.-')).toBeNull();
  });
});

describe('isLoopback', () => {
  it('recognises what wrangler dev serves', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'app.localhost']) {
      expect(isLoopback(host)).toBe(true);
    }
  });

  it('does not recognise anything a deployed Worker is reached by', () => {
    for (const host of [
      'satellite-chess.workers.dev',
      'example.com',
      // The near-misses. A suffix test on `localhost` written the obvious way
      // would accept the first two, and a substring test the third.
      'notlocalhost',
      'localhost.example.com',
      'my-localhost-app.com',
      '127.0.0.1.example.com',
    ]) {
      expect(isLoopback(host)).toBe(false);
    }
  });
});

describe('readCookie', () => {
  const withCookie = (value: string) =>
    new Request('http://127.0.0.1/', { headers: { cookie: value } });

  it('finds a cookie among others', () => {
    expect(readCookie(withCookie('a=1; satchess_session=tok; b=2'), 'satchess_session')).toBe('tok');
    expect(readCookie(withCookie('satchess_session=tok'), 'satchess_session')).toBe('tok');
  });

  it('does not match a name that merely ends the same way', () => {
    expect(readCookie(withCookie('not_satchess_session=tok'), 'satchess_session')).toBeNull();
  });

  it('returns null when there is no cookie header at all', () => {
    expect(readCookie(new Request('http://127.0.0.1/'), 'satchess_session')).toBeNull();
  });
});

describe('crypto helpers', () => {
  it('round-trips base64url, including bytes that need the URL-safe alphabet', () => {
    // 0xfb 0xff encodes to `+/` in standard base64 — the two characters the
    // URL-safe alphabet replaces, and so the ones a wrong implementation loses.
    const bytes = new Uint8Array([0xfb, 0xff, 0x00, 0x41]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(base64UrlDecode(encoded)).toEqual(bytes);
  });

  it('round-trips non-ASCII text', () => {
    const text = 'Champs-Élysées ♞ 日本';
    expect(decodeUtf8(encodeUtf8(text))).toBe(text);
  });

  it('rejects base64url that is not base64url', () => {
    expect(base64UrlDecode('a+b/c=')).toBeNull();
    expect(decodeUtf8('!!!')).toBeNull();
  });

  it('compares equal-length strings correctly, and unequal lengths as unequal', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abd', 'abc')).toBe(false);
    expect(timingSafeEqual('ab', 'abc')).toBe(false);
    expect(timingSafeEqual(null, 'abc')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});
