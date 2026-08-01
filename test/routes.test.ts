import { describe, expect, it } from 'vitest';

import { isAppRoute, parseAppRoute } from '../src/shared/routes.js';

/**
 * The Worker decides what to serve from these answers and the client decides
 * what to show from the same ones, so "is this a route" and "what does it mean"
 * are the same question asked twice (O-06).
 */
describe('parseAppRoute', () => {
  it('reads a game invite', () => {
    expect(parseAppRoute('/j/ABC123')).toEqual({ kind: 'join', code: 'ABC123' });
  });

  it('folds a retyped code the same way the typed entry does', () => {
    // Someone reading a link aloud, or retyping one off a poster, produces the
    // lookalikes `joincode.ts` already maps. A deep link should be no stricter
    // than the keyboard.
    expect(parseAppRoute('/j/abc123')).toEqual({ kind: 'join', code: 'ABC123' });
    expect(parseAppRoute('/j/ABCI23')).toEqual({ kind: 'join', code: 'ABC123' });
    expect(parseAppRoute('/j/ABC-123')).toEqual({ kind: 'join', code: 'ABC123' });
  });

  it('tolerates a trailing slash, which is what a share sheet sometimes adds', () => {
    expect(parseAppRoute('/j/ABC123/')).toEqual({ kind: 'join', code: 'ABC123' });
  });

  it('reads a shared field blob', () => {
    expect(parseAppRoute('/f/AbC-123_xyz')).toEqual({ kind: 'field', blob: 'AbC-123_xyz' });
  });

  it('refuses anything that could not be a code', () => {
    // These must stay null: the Worker turns null into an honest 404, and a 200
    // of HTML for `/j/nonsense` would make a broken link look like a broken app.
    for (const path of [
      '/j/',
      '/j/SHORT',
      '/j/TOOLONG1',
      '/j/AB C12',
      '/j/ABC123/extra',
      '/f/',
      '/f/not+base64url',
      `/f/${'A'.repeat(257)}`,
      '/x/ABC123',
      '/',
      '/app.js',
      '/icons/icon-192.png',
      '/api/game/ABC123',
    ]) {
      expect(parseAppRoute(path), path).toBeNull();
    }
  });

  it('survives a malformed percent-escape rather than throwing', () => {
    // `decodeURIComponent` throws on a lone `%`, and this runs on the request
    // path of every non-API request in the Worker.
    expect(() => parseAppRoute('/j/%E0%A4%A')).not.toThrow();
    expect(parseAppRoute('/j/%E0%A4%A')).toBeNull();
  });

  it('percent-decodes before matching', () => {
    expect(parseAppRoute('/j/ABC%31%32%33')).toEqual({ kind: 'join', code: 'ABC123' });
  });

  it('agrees with isAppRoute', () => {
    expect(isAppRoute('/j/ABC123')).toBe(true);
    expect(isAppRoute('/nonsense')).toBe(false);
  });
});
