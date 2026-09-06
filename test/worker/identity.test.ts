import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { SESSION_COOKIE, mintDevToken } from '../../src/worker/identity.js';

/**
 * The dev identity seam (stage 2.5.2), against the real runtime.
 *
 * The token arithmetic is covered in `test/identity-token.test.ts`. What is
 * tested here is the thing that would actually hurt: **this endpoint mints a
 * session for any account you name**, so the tests that matter most are the ones
 * asserting it is not reachable. Both locks get their own case, including the
 * case where one is open and the other is not — because a single-lock design is
 * exactly what these are here to stop somebody quietly refactoring back to.
 */

const SECRET = 'test-dev-auth-secret';

/** As in `survey.test.ts`: secrets are set out of band, so tests set them here. */
const mutableEnv = env as unknown as Record<string, unknown>;

function withSecret(): void {
  mutableEnv.DEV_AUTH_SECRET = SECRET;
}

function withoutSecret(): void {
  delete mutableEnv.DEV_AUTH_SECRET;
}

/** `wrangler dev` serves loopback; a deployed Worker never does. */
const LOCAL = 'http://127.0.0.1';
const DEPLOYED = 'https://satellite-chess.workers.dev';

async function mint(
  sub: string,
  { origin = LOCAL, secret = SECRET as string | null } = {},
): Promise<Response> {
  return SELF.fetch(`${origin}/api/dev/session`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { 'x-dev-auth-secret': secret }),
    },
    body: JSON.stringify({ sub }),
  });
}

async function me(cookie: string | null, origin = LOCAL): Promise<Response> {
  return SELF.fetch(`${origin}/api/me`, {
    headers: cookie === null ? {} : { cookie },
  });
}

/** The `satchess_session=...` pair out of a Set-Cookie header. */
function sessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  expect(header).not.toBeNull();
  return (header as string).split(';')[0];
}

describe('the dev seam is off unless both locks are open', () => {
  it('404s with no secret configured, even on loopback', async () => {
    withoutSecret();
    const response = await mint('alice');
    expect(response.status).toBe(404);
    // "Not found" rather than "forbidden": as far as an unconfigured build is
    // concerned this endpoint genuinely does not exist, and saying "unauthorised"
    // would advertise that it could exist.
    expect((await response.json<{ error: string }>()).error).toBe('not_found');
  });

  it('404s on a deployed hostname even with the secret set', async () => {
    // The lock that a mistake cannot switch off. Setting the secret on a
    // deployed Worker by accident is plausible; making a deployed Worker answer
    // to `localhost` is not.
    withSecret();
    const response = await mint('alice', { origin: DEPLOYED });
    expect(response.status).toBe(404);
    expect((await response.json<{ error: string }>()).error).toBe('not_found');
  });

  it('401s on a bad or missing secret, on loopback', async () => {
    withSecret();
    expect((await mint('alice', { secret: 'wrong-secret-same-len' })).status).toBe(401);
    expect((await mint('alice', { secret: null })).status).toBe(401);
  });

  it('refuses a GET, so a session cannot be minted by following a link', async () => {
    withSecret();
    const response = await SELF.fetch(`${LOCAL}/api/dev/session?secret=${SECRET}&sub=alice`);
    expect(response.status).toBe(405);
  });
});

describe('minting a session', () => {
  it('sets a session cookie that /api/me then recognises', async () => {
    withSecret();
    const minted = await mint('alice');
    expect(minted.status).toBe(200);
    expect(await minted.json()).toMatchObject({ sub: 'alice', via: 'dev' });

    const cookie = sessionCookie(minted);
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=d1\\.`));

    const identity = await me(cookie);
    expect(identity.status).toBe(200);
    // `account` rides along since stage 2.3.1 — see `user-do.test.ts`. Asserted
    // loosely here because this file is about the seam, not the account.
    expect(await identity.json()).toMatchObject({ sub: 'alice', via: 'dev' });
  });

  it('marks the cookie HttpOnly and SameSite=Lax', async () => {
    withSecret();
    const header = (await mint('alice')).headers.get('set-cookie') as string;
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    // Deliberately not `Secure`: the seam is loopback-only and `wrangler dev` is
    // plain HTTP, where `Secure` would stop the cookie being stored at all.
    // Stage 2.2.1's real cookie is `Secure`, and that difference is intended.
    expect(header).not.toContain('Secure');
  });

  it('mints distinct identities, so two drivers can be two people', async () => {
    withSecret();
    const white = sessionCookie(await mint('white-player'));
    const black = sessionCookie(await mint('black-player'));
    expect(await (await me(white)).json()).toMatchObject({ sub: 'white-player' });
    expect(await (await me(black)).json()).toMatchObject({ sub: 'black-player' });
  });

  it('rejects a sub that would not be safe as an object name', async () => {
    withSecret();
    const response = await mint('../../elsewhere');
    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toBe('bad_message');
  });
});

describe('/api/me', () => {
  it('401s with no cookie', async () => {
    withSecret();
    const response = await me(null);
    expect(response.status).toBe(401);
    expect((await response.json<{ error: string }>()).error).toBe('unauthenticated');
  });

  it('401s on a cookie that is not a valid token', async () => {
    withSecret();
    expect((await me(`${SESSION_COOKIE}=d1.nonsense.nonsense`)).status).toBe(401);
    expect((await me(`${SESSION_COOKIE}=nonsense`)).status).toBe(401);
  });

  it('401s on an expired token', async () => {
    withSecret();
    const expired = await mintDevToken('alice', SECRET, Date.now() - 1);
    expect((await me(`${SESSION_COOKIE}=${expired}`)).status).toBe(401);
  });

  it('does not honour a dev token on a deployed hostname', async () => {
    // The same lock as minting, on the *reading* side — without it, a token
    // minted against a local build would keep working if the same secret were
    // ever set on a deployed one. This is the case that a naive implementation
    // gates only the mint route and misses entirely.
    withSecret();
    const cookie = sessionCookie(await mint('alice'));
    expect((await me(cookie, LOCAL)).status).toBe(200);
    expect((await me(cookie, DEPLOYED)).status).toBe(401);
  });

  it('does not honour a dev token once the secret is withdrawn', async () => {
    withSecret();
    const cookie = sessionCookie(await mint('alice'));
    expect((await me(cookie)).status).toBe(200);
    withoutSecret();
    expect((await me(cookie)).status).toBe(401);
  });
});
