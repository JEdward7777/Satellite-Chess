import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { UserDO } from '../../src/worker/user-do.js';

/**
 * Display units on the account (stage 2.3.8, decision 0049), against the real
 * runtime.
 *
 * What needs the runtime: that the choice is stored on the UserDO and comes
 * back on `/api/me` — the launch check the phone makes anyway — for the same
 * account and for nobody else; and that the write route refuses what it
 * should. The formatting itself is tested in node (`test/units.test.ts`).
 */

const SECRET = 'test-dev-auth-secret';
const LOCAL = 'http://127.0.0.1';

const mutableEnv = env as unknown as Record<string, unknown>;

async function signIn(sub: string): Promise<string> {
  mutableEnv.DEV_AUTH_SECRET = SECRET;
  const response = await SELF.fetch(`${LOCAL}/api/dev/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-auth-secret': SECRET },
    body: JSON.stringify({ sub }),
  });
  expect(response.status).toBe(200);
  return (response.headers.get('set-cookie') as string).split(';')[0];
}

async function me(cookie: string): Promise<{ sub: string; units: unknown }> {
  const response = await SELF.fetch(`${LOCAL}/api/me`, { headers: { cookie } });
  expect(response.status).toBe(200);
  return response.json();
}

async function setUnits(
  cookie: string | null,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch(`${LOCAL}/api/settings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === null ? {} : { cookie }),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('display units on the account', () => {
  it('is null until the player chooses — never chosen is not metric', async () => {
    const cookie = await signIn('units-fresh');
    expect((await me(cookie)).units).toBeNull();
  });

  it('comes back on the launch check once chosen, and can be changed back', async () => {
    const cookie = await signIn('units-chooser');
    const response = await setUnits(cookie, { units: 'us' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ units: 'us' });
    expect((await me(cookie)).units).toBe('us');

    expect((await setUnits(cookie, { units: 'metric' })).status).toBe(200);
    expect((await me(cookie)).units).toBe('metric');
  });

  it('follows the account to a second phone, and to nobody else', async () => {
    const phoneOne = await signIn('units-owner');
    expect((await setUnits(phoneOne, { units: 'us' })).status).toBe(200);
    // A second session for the same account is a second phone.
    const phoneTwo = await signIn('units-owner');
    expect((await me(phoneTwo)).units).toBe('us');
    const stranger = await signIn('units-stranger');
    expect((await me(stranger)).units).toBeNull();
  });

  it('is stored in the account’s own object, as a settings row', async () => {
    const cookie = await signIn('units-stored');
    await setUnits(cookie, { units: 'us' });
    const stub = env.USER.getByName('units-stored');
    const settings = await runInDurableObject(stub, async (instance: UserDO) => instance.settings());
    expect(settings).toEqual({ units: 'us' });
  });

  it('refuses anything that is not one of the two', async () => {
    const cookie = await signIn('units-bad');
    for (const body of [{ units: 'imperial' }, { units: null }, {}, 'not json']) {
      expect((await setUnits(cookie, body)).status).toBe(400);
    }
    expect((await me(cookie)).units).toBeNull();
  });

  it('needs a session, a POST and this app’s own origin', async () => {
    expect((await setUnits(null, { units: 'us' })).status).toBe(401);
    const cookie = await signIn('units-guarded');
    const get = await SELF.fetch(`${LOCAL}/api/settings`, { headers: { cookie } });
    expect(get.status).toBe(405);
    const crossSite = await setUnits(cookie, { units: 'us' }, { origin: 'https://evil.example' });
    expect(crossSite.status).toBe(403);
    expect((await me(cookie)).units).toBeNull();
  });
});
