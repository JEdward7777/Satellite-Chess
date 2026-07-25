import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/**
 * Proves the test harness reaches the real runtime, and that the stub worker and
 * its Durable Objects are wired up as `wrangler.jsonc` declares.
 *
 * This is deliberately the first worker test written: phase 3 builds a
 * hibernating, SQLite-backed, alarm-driven object, and doing that with no way to
 * run it would be the expensive order.
 */
describe('the worker is wired up', () => {
  it('serves a health check', async () => {
    const res = await SELF.fetch('https://example.com/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: 'satellite-chess' });
  });

  it('claims the whole /api namespace rather than falling through to the shell', async () => {
    // A 200 of text/html here would mean an unbuilt endpoint silently returns the
    // app shell, which is far worse to debug than an honest 501.
    for (const path of ['/api', '/api/game', '/api/game/ABC123/ws']) {
      const res = await SELF.fetch(`https://example.com${path}`);
      expect(res.status, path).toBe(501);
      expect(res.headers.get('content-type'), path).toContain('application/json');
      expect(await res.json()).toMatchObject({ error: 'not_implemented' });
    }
  });

  it('exposes both Durable Object namespaces', () => {
    expect(env.GAME).toBeDefined();
    expect(env.USER).toBeDefined();
  });

  it('addresses a game object by join code, deterministically', async () => {
    // Decision 0007: the join code *is* the address, so there is no lookup table
    // and no eventual-consistency race when someone scans a QR three seconds
    // after the game was created.
    const a = env.GAME.idFromName('ABC123');
    const b = env.GAME.idFromName('ABC123');
    const other = env.GAME.idFromName('ABC124');
    expect(a.toString()).toBe(b.toString());
    expect(a.toString()).not.toBe(other.toString());
  });

  it('can construct a GameDO stub and get its honest 501', async () => {
    const stub = env.GAME.getByName('ABC123');
    const res = await stub.fetch('https://do/');
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ error: 'not_implemented' });
  });

  it('can construct a UserDO stub', async () => {
    const stub = env.USER.getByName('google-sub-123');
    const res = await stub.fetch('https://do/');
    expect(res.status).toBe(501);
  });
});
