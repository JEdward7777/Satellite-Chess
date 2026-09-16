import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../src/worker/identity.js';
import { createSession, destroySession } from '../../src/worker/sessions.js';

/**
 * Google sign-in against the real runtime (stages 2.1 and 2.2.1).
 *
 * Nothing here talks to Google. The one request that would — the code exchange —
 * is the only part that cannot be tested without a live round-trip, so what is
 * asserted instead is everything *around* it: that the redirect we send is the
 * one Google's contract requires, that a callback which cannot be trusted is
 * refused rather than half-honoured, and that a minted session is recognised by
 * the same `identityOf` the dev seam feeds.
 *
 * The live half is verified by signing in against the deployed Worker by hand
 * (decision 0034), because a container cannot hold a browser session at Google.
 */

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'test-client-secret';

/** As in `identity.test.ts`: secrets are set out of band, so tests set them here. */
const mutableEnv = env as unknown as Record<string, unknown>;

function configured(): void {
  mutableEnv.GOOGLE_CLIENT_ID = CLIENT_ID;
  mutableEnv.GOOGLE_CLIENT_SECRET = CLIENT_SECRET;
}

function unconfigured(): void {
  delete mutableEnv.GOOGLE_CLIENT_SECRET;
}

const ORIGIN = 'https://satellite-chess.example.workers.dev';

/** The 302 away to Google, without following it. */
async function login(origin = ORIGIN): Promise<Response> {
  return SELF.fetch(`${origin}/auth/google/login`, { redirect: 'manual' });
}

/** The `satchess_oauth=...` pair out of a Set-Cookie header. */
function flowCookie(response: Response): string {
  const header = response.headers.get('set-cookie');
  expect(header).not.toBeNull();
  return (header as string).split(';')[0];
}

describe('starting a sign-in', () => {
  it('redirects to Google with every parameter the contract requires', async () => {
    configured();
    const response = await login();
    expect(response.status).toBe(302);

    const target = new URL(response.headers.get('location') as string);
    expect(`${target.origin}${target.pathname}`).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(target.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(target.searchParams.get('response_type')).toBe('code');
    // `openid` must come first, and `email` is what lets an account screen name
    // the account. No API scopes: this is sign-in only (decision 0014).
    expect(target.searchParams.get('scope')).toBe('openid email');
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    // 32 bytes of base64url. Absent or short means PKCE is not actually on.
    expect(target.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(target.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(target.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('derives redirect_uri from the origin it was reached on (decision 0030)', async () => {
    configured();
    // The same build has to work on the deployed origin and on `wrangler dev`,
    // which is the whole reason this is derived rather than configured. A
    // hard-coded value passes the test above and fails in exactly one
    // environment — the one nobody is looking at.
    const deployed = new URL((await login()).headers.get('location') as string);
    expect(deployed.searchParams.get('redirect_uri')).toBe(
      `${ORIGIN}/auth/google/callback`,
    );

    const local = new URL(
      (await login('http://localhost:8787')).headers.get('location') as string,
    );
    expect(local.searchParams.get('redirect_uri')).toBe(
      'http://localhost:8787/auth/google/callback',
    );
  });

  it('sends a different challenge and state every time', async () => {
    configured();
    const first = new URL((await login()).headers.get('location') as string);
    const second = new URL((await login()).headers.get('location') as string);
    // A fixed verifier would make PKCE decorative and a fixed state would make
    // the anti-forgery check meaningless, and both would still pass every other
    // assertion in this file.
    expect(first.searchParams.get('code_challenge')).not.toBe(
      second.searchParams.get('code_challenge'),
    );
    expect(first.searchParams.get('state')).not.toBe(second.searchParams.get('state'));
  });

  it('parks the flow in an HttpOnly cookie scoped to /auth', async () => {
    configured();
    const header = (await login()).headers.get('set-cookie') as string;
    expect(header).toContain('HttpOnly');
    // Required rather than preferred: the cookie has to survive the top-level
    // navigation back from accounts.google.com, and `Strict` would withhold it
    // on exactly that request.
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/auth');
    expect(header).toContain('Secure');
  });

  it('is not Secure on plain HTTP, so a local experiment can store it', async () => {
    configured();
    const header = (await login('http://localhost:8787')).headers.get('set-cookie') as string;
    expect(header).not.toContain('Secure');
  });
});

describe('the sign-in routes are the Worker’s, not the asset binding’s', () => {
  it('answers 503 rather than the shell when credentials are missing', async () => {
    unconfigured();
    const response = await login();
    // Deliberately not a 404 like the survey or the dev seam. Those are optional
    // facilities; sign-in is the only way into the game, so a deployment without
    // credentials is broken rather than minimal and must say so.
    expect(response.status).toBe(503);
    expect((await response.json<{ error: string }>()).error).toBe('signin_unconfigured');
  });

  it('refuses a POST', async () => {
    configured();
    const response = await SELF.fetch(`${ORIGIN}/auth/google/login`, { method: 'POST' });
    expect(response.status).toBe(405);
  });

  it('404s an unknown path under /auth rather than serving the shell', async () => {
    configured();
    // The failure this guards: `/auth/` falling through to the assets binding
    // comes back as HTML with a 200, so a mistyped route looks like the app
    // loading and the sign-in appears to do nothing at all.
    const response = await SELF.fetch(`${ORIGIN}/auth/nonsense`, { redirect: 'manual' });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('json');
  });
});

describe('completing a sign-in', () => {
  it('turns Google’s own refusal into a reason, not an error page', async () => {
    configured();
    const response = await SELF.fetch(
      `${ORIGIN}/auth/google/callback?error=access_denied&state=x`,
      { redirect: 'manual' },
    );
    expect(response.status).toBe(302);
    // A player who tapped "cancel" has not hit a fault, and must land back in
    // the app rather than on a JSON body.
    expect(response.headers.get('location')).toBe('/?signin=failed&reason=declined');
  });

  it('refuses a callback with no flow cookie', async () => {
    configured();
    // The commonest real case: a bookmarked callback, or one opened an hour
    // later. There is no verifier to exchange with, so there is nothing to do
    // but start again.
    const response = await SELF.fetch(`${ORIGIN}/auth/google/callback?code=abc&state=xyz`, {
      redirect: 'manual',
    });
    expect(response.headers.get('location')).toBe('/?signin=failed&reason=expired');
  });

  it('refuses a state that is not the one it issued', async () => {
    configured();
    const started = await login();
    const response = await SELF.fetch(
      `${ORIGIN}/auth/google/callback?code=abc&state=not-the-issued-state`,
      { redirect: 'manual', headers: { cookie: flowCookie(started) } },
    );
    // The anti-forgery check. Without it, a callback can be handed to a browser
    // that never started a sign-in.
    expect(response.headers.get('location')).toBe('/?signin=failed&reason=bad_state');
  });

  it('refuses a forged flow cookie', async () => {
    configured();
    // Signed with the client secret, so a browser cannot choose its own verifier
    // and state — which is what the PKCE and state checks rest on.
    const forged = btoa(JSON.stringify({ state: 'mine', nonce: 'n', verifier: 'v', exp: 9e15 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const response = await SELF.fetch(`${ORIGIN}/auth/google/callback?code=abc&state=mine`, {
      redirect: 'manual',
      headers: { cookie: `satchess_oauth=${forged}.not-a-real-signature` },
    });
    expect(response.headers.get('location')).toBe('/?signin=failed&reason=expired');
  });

  it('refuses a callback carrying no code', async () => {
    configured();
    const started = await login();
    const response = await SELF.fetch(`${ORIGIN}/auth/google/callback?state=xyz`, {
      redirect: 'manual',
      headers: { cookie: flowCookie(started) },
    });
    expect(response.headers.get('location')).toBe('/?signin=failed&reason=bad_response');
  });
});

describe('a real session', () => {
  it('is recognised by /api/me as a Google identity', async () => {
    configured();
    const token = await createSession(env as never, '117554968855954827048');
    const response = await SELF.fetch(`${ORIGIN}/api/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(response.status).toBe(200);
    // `via` is how a log tells a real sign-in from the seam (decision 0029), and
    // this is the branch that did not exist until stage 2.1.
    expect(await response.json()).toMatchObject({
      sub: '117554968855954827048',
      via: 'google',
    });
  });

  it('is opaque — the token says nothing about the account', async () => {
    const token = await createSession(env as never, 'a-very-recognisable-sub');
    expect(token).not.toContain('a-very-recognisable-sub');
    expect(token).toMatch(/^g1_[A-Za-z0-9_-]{43}$/);
  });

  it('stops working the moment it is destroyed', async () => {
    configured();
    const token = await createSession(env as never, 'alice');
    const cookie = `${SESSION_COOKIE}=${token}`;
    expect((await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie } })).status).toBe(200);

    // This is the thing a stateless token could not do, and the reason the
    // record is in KV at all (stage 2.2.1).
    await destroySession(env as never, token);
    expect((await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie } })).status).toBe(401);
  });

  it('401s on a token that was never a session', async () => {
    configured();
    for (const cookie of [`${SESSION_COOKIE}=g1_${'a'.repeat(43)}`, `${SESSION_COOKIE}=junk`]) {
      expect((await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie } })).status).toBe(401);
    }
  });

  it('does not answer a dev token on a deployed hostname, even now', async () => {
    // The seam's second lock, re-asserted from the other side of stage 2.1: the
    // two formats coexist and the dev one is still structurally impossible in a
    // deployed build (decision 0029).
    configured();
    mutableEnv.DEV_AUTH_SECRET = 'test-dev-auth-secret';
    const minted = await SELF.fetch('http://127.0.0.1/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dev-auth-secret': 'test-dev-auth-secret' },
      body: JSON.stringify({ sub: 'alice' }),
    });
    const cookie = (minted.headers.get('set-cookie') as string).split(';')[0];
    expect((await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie } })).status).toBe(401);
    delete mutableEnv.DEV_AUTH_SECRET;
  });
});
