import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../src/worker/identity.js';
import { SESSION_TTL_MS, createSession, readSession } from '../../src/worker/sessions.js';

/**
 * A session's life after sign-in, against the real runtime (stages 2.2.3–2.2.5).
 *
 * `auth.test.ts` covers getting a session; this covers what the phone is told
 * about it — how long it has left and who it belongs to — keeping the cookie
 * alive as long as the record, and ending it.
 */

const ORIGIN = 'https://satellite-chess.example.workers.dev';
const LOCAL = 'http://127.0.0.1';
const DEV_SECRET = 'test-dev-auth-secret';
const DAY = 24 * 60 * 60 * 1000;

const mutableEnv = env as unknown as Record<string, unknown>;

async function me(cookie: string, origin = ORIGIN): Promise<Response> {
  return SELF.fetch(`${origin}/api/me`, { headers: { cookie } });
}

interface MeBody {
  sub: string;
  via: string;
  email: string | null;
  expiresAt: number;
  serverNow: number;
}

describe('what /api/me says about the session (2.2.3)', () => {
  it('reports the expiry beside its own clock, so the phone can take the difference', async () => {
    const createdAt = Date.now() - 60 * 60 * 1000;
    const token = await createSession(env as never, 'alice', createdAt);
    const response = await me(`${SESSION_COOKIE}=${token}`);
    expect(response.status).toBe(200);
    const body = await response.json<MeBody>();
    // Written an hour ago and not yet due for renewal, so the record still ends
    // a month after it was written — not a month from now.
    expect(body.expiresAt).toBe(createdAt + SESSION_TTL_MS);
    expect(typeof body.serverNow).toBe('number');
    expect(body.expiresAt - body.serverNow).toBeGreaterThan(29 * DAY);
  });

  it('reports the slid expiry after a renewal, not the old one', async () => {
    const token = await createSession(env as never, 'alice', Date.now() - 2 * DAY);
    const body = await (await me(`${SESSION_COOKIE}=${token}`)).json<MeBody>();
    expect(body.expiresAt).toBe(body.serverNow + SESSION_TTL_MS);
  });

  it('names the address the session was made with, and null for one without', async () => {
    const withEmail = await createSession(env as never, 'alice', Date.now(), {
      email: 'alice@example.com',
    });
    expect((await (await me(`${SESSION_COOKIE}=${withEmail}`)).json<MeBody>()).email).toBe(
      'alice@example.com',
    );
    // Every session minted before 2.2.5 looks like this, and must keep working.
    const without = await createSession(env as never, 'alice');
    const body = await (await me(`${SESSION_COOKIE}=${without}`)).json<MeBody>();
    expect(body.sub).toBe('alice');
    expect(body.email).toBeNull();
  });

  it('reports a dev token’s own expiry', async () => {
    mutableEnv.DEV_AUTH_SECRET = DEV_SECRET;
    try {
      const minted = await SELF.fetch(`${LOCAL}/api/dev/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dev-auth-secret': DEV_SECRET },
        body: JSON.stringify({ sub: 'white-player' }),
      });
      const { expiresAt } = await minted.json<{ expiresAt: number }>();
      const cookie = (minted.headers.get('set-cookie') as string).split(';')[0];
      const response = await me(cookie, LOCAL);
      const body = await response.json<MeBody>();
      expect(body).toMatchObject({ via: 'dev', email: null, expiresAt });
      // The seam's cookie is the seam's business; `/api/me` does not re-issue it.
      expect(response.headers.get('set-cookie')).toBeNull();
    } finally {
      delete mutableEnv.DEV_AUTH_SECRET;
    }
  });
});

describe('the cookie lives as long as the record (2.2.3)', () => {
  it('is re-issued on every launch check, so renewal is not undone by the browser', async () => {
    // Before this, the record slid and the cookie did not: a daily player's
    // browser discarded a live session a month after sign-in.
    const token = await createSession(env as never, 'alice', Date.now() - 20 * DAY);
    const response = await me(`${SESSION_COOKIE}=${token}`);
    const header = response.headers.get('set-cookie') as string;
    expect(header).toContain(`${SESSION_COOKIE}=${token}`);
    expect(header).toContain(`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
  });

  it('is not issued to somebody who is not signed in', async () => {
    const response = await me(`${SESSION_COOKIE}=g1_${'a'.repeat(43)}`);
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('a renewal that cannot be written (2.2.3)', () => {
  it('still answers, and reports the expiry that did not slide', async () => {
    // The free tier's ~1,000 KV writes a day are the likeliest cause. Before
    // 2.2.3 this threw through to a 500 on every authenticated call.
    const lastSeenAt = Date.now() - 28 * DAY;
    const record = JSON.stringify({ sub: 'alice', createdAt: lastSeenAt, lastSeenAt });
    const failingEnv = {
      SESSIONS: {
        get: async () => record,
        put: async () => {
          throw new Error('KV put() limit exceeded for the day.');
        },
      },
    };
    const session = await readSession(failingEnv as never, `g1_${'b'.repeat(43)}`);
    expect(session).toEqual({ sub: 'alice', email: null, expiresAt: lastSeenAt + SESSION_TTL_MS });
  });
});

describe('signing out (2.2.5)', () => {
  it('ends the session at the server and clears the cookie', async () => {
    const token = await createSession(env as never, 'alice');
    const cookie = `${SESSION_COOKIE}=${token}`;
    expect((await me(cookie)).status).toBe(200);

    const response = await SELF.fetch(`${ORIGIN}/api/signout`, {
      method: 'POST',
      headers: { cookie, origin: ORIGIN },
    });
    expect(response.status).toBe(200);
    const header = response.headers.get('set-cookie') as string;
    expect(header).toContain(`${SESSION_COOKIE}=;`);
    expect(header).toContain('Max-Age=0');

    // The record is gone, so a copy of the token kept anywhere is worthless —
    // the reason a session is a stored record at all (2.2.1).
    expect((await me(cookie)).status).toBe(401);
  });

  it('is a success with nothing to do when already signed out', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/signout`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('refuses a GET, so a link or an image cannot sign anybody out', async () => {
    const token = await createSession(env as never, 'alice');
    const cookie = `${SESSION_COOKIE}=${token}`;
    const response = await SELF.fetch(`${ORIGIN}/api/signout`, { headers: { cookie } });
    expect(response.status).toBe(405);
    expect((await me(cookie)).status).toBe(200);
  });

  it('refuses a POST from another site', async () => {
    const token = await createSession(env as never, 'alice');
    const cookie = `${SESSION_COOKIE}=${token}`;
    const response = await SELF.fetch(`${ORIGIN}/api/signout`, {
      method: 'POST',
      headers: { cookie, origin: 'https://elsewhere.example' },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect((await me(cookie)).status).toBe(200);
  });
});
