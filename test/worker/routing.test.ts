import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/**
 * Deep links (O-06). A QR code lands the browser on `/j/ABC123`, where there is
 * no file — the Worker has to answer with the shell, and the shell has to be the
 * same bytes it serves at `/` so the client is identical whichever way in you
 * came.
 */
describe('client-side routes are answered with the shell', () => {
  it('serves the shell at a game invite, without redirecting', async () => {
    // `redirect: 'manual'` is the whole point of this assertion. Asking the
    // assets binding for `/index.html` produces a **307 to `/`**, which
    // `SELF.fetch` follows silently — so the naive test passes, and the scanned
    // invite arrives at the home screen with the code gone from the URL.
    const res = await SELF.fetch('https://example.com/j/ABC123', { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<div id="app"></div>');
  });

  it('serves the shell at a shared field link', async () => {
    const res = await SELF.fetch('https://example.com/f/AbC-123_xyz', { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="app"></div>');
  });

  it('serves byte-identical HTML at the deep link and at the root', async () => {
    // If these ever diverge, "works at /" stops being evidence that a scan works.
    const [root, deep] = await Promise.all([
      SELF.fetch('https://example.com/').then((r) => r.text()),
      SELF.fetch('https://example.com/j/ABC123').then((r) => r.text()),
    ]);
    expect(deep).toBe(root);
  });

  it('preserves the query string, so ?sim=1 survives a deep link', async () => {
    // The simulator, and the survey secret, both live in the query. Rewriting the
    // path must not take the search with it.
    const res = await SELF.fetch('https://example.com/j/ABC123?sim=1', { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="app"></div>');
  });

  it('still 404s a path that is not a route', async () => {
    // The tempting fix for O-06 is `not_found_handling: single-page-application`,
    // which returns the shell with a 200 for *everything*. Then a typo in an
    // asset path is a blank screen with no error anywhere, which is the hardest
    // possible thing to debug from a field.
    for (const path of ['/nonsense', '/j/', '/j/SHORT', '/j/ABC123/extra', '/f/not+base64url']) {
      const res = await SELF.fetch(`https://example.com${path}`);
      expect(res.status, path).toBe(404);
    }
  });

  it('leaves the assets and the API alone', async () => {
    const app = await SELF.fetch('https://example.com/app.js');
    expect(app.status).toBe(200);
    expect(app.headers.get('content-type')).toContain('javascript');

    const health = await SELF.fetch('https://example.com/api/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
  });
});
