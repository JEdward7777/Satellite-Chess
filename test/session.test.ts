import { describe, expect, it } from 'vitest';

import {
  currentDestination,
  loadSession,
  signInFailure,
  signInHref,
} from '../src/client/session.js';

/**
 * The client's half of the sign-in gate (stage 2.5.1).
 *
 * The screen is `views/signin.ts` and is driven in a browser; what is tested
 * here is the decision underneath it, which has exactly one interesting case:
 * **"the server did not answer" must not mean "you are not signed in".**
 *
 * Getting that wrong shows a sign-in screen to somebody standing in a field with
 * a fortnight-old session, who then cannot complete it — O-01 arriving by a
 * route decision 0014 never considered. It is also invisible to every other kind
 * of test, because it only happens when the network is gone.
 */

/** A `fetch` that answers once, with whatever is asked for. */
function answers(status: number, body: unknown, ok = true): typeof fetch {
  return (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: ok ? { 'content-type': 'application/json' } : {},
    })) as unknown as typeof fetch;
}

/** A `fetch` that never reaches anything, which is what no signal looks like. */
const offline: typeof fetch = (async () => {
  throw new TypeError('Failed to fetch');
}) as unknown as typeof fetch;

describe('loading the session', () => {
  it('reports a live session, and which way it was established', async () => {
    const state = await loadSession({
      fetch: answers(200, { sub: 'g-117554968855954827048', via: 'google' }),
    });
    expect(state).toEqual({
      kind: 'signed_in',
      sub: 'g-117554968855954827048',
      via: 'google',
    });
  });

  it('reports a dev session as dev, so a log can prove it rather than assert it', async () => {
    const state = await loadSession({ fetch: answers(200, { sub: 'alice', via: 'dev' }) });
    expect(state).toMatchObject({ kind: 'signed_in', via: 'dev' });
  });

  it('closes the gate on a 401, and carries the dev-seam flag through', async () => {
    expect(await loadSession({ fetch: answers(401, { error: 'unauthenticated' }) })).toEqual({
      kind: 'signed_out',
      devSeam: false,
    });
    expect(
      await loadSession({ fetch: answers(401, { error: 'unauthenticated', devSeam: true }) }),
    ).toEqual({ kind: 'signed_out', devSeam: true });
  });

  it('never treats a missing network as a sign-out', async () => {
    // The case this whole three-state design exists for. A phone that cannot
    // reach the server must open the app, not a sign-in screen it cannot finish.
    expect(await loadSession({ fetch: offline })).toEqual({ kind: 'unknown' });
  });

  it('never treats a broken server as a sign-out either', async () => {
    for (const status of [500, 502, 503, 504]) {
      expect(await loadSession({ fetch: answers(status, { error: 'internal' }) })).toEqual({
        kind: 'unknown',
      });
    }
  });

  it('treats a captive portal as a network problem rather than an answer', async () => {
    // A 200 of HTML is a hotel wifi login page, not this API. Reading it as a
    // sign-out would gate a player who is merely behind a portal.
    expect(await loadSession({ fetch: answers(200, '<html>Sign in to WiFi</html>') })).toEqual({
      kind: 'unknown',
    });
  });

  it('treats a 200 with no sub as unusable rather than as an identity', async () => {
    for (const body of [{}, { sub: '' }, { sub: 42 }, { via: 'google' }]) {
      expect(await loadSession({ fetch: answers(200, body) })).toEqual({ kind: 'unknown' });
    }
  });

  it('still reports signed out when a 401 body cannot be read', async () => {
    // The status is what carries the meaning; the body only offers the button.
    expect(await loadSession({ fetch: answers(401, 'not json at all') })).toEqual({
      kind: 'signed_out',
      devSeam: false,
    });
  });
});

describe('the sign-in link', () => {
  it('carries where to come back to', () => {
    expect(signInHref('/j/ABC123')).toBe('/auth/google/login?next=%2Fj%2FABC123');
  });

  it('encodes a destination that has a query of its own', () => {
    // `?sim=1` must survive, and must not be read as a parameter of the login
    // URL — which is exactly what would happen unencoded.
    expect(signInHref('/j/ABC123?sim=1')).toBe('/auth/google/login?next=%2Fj%2FABC123%3Fsim%3D1');
  });

  it('describes where we are, path and query together', () => {
    expect(currentDestination({ pathname: '/j/ABC123', search: '?sim=1' })).toBe(
      '/j/ABC123?sim=1',
    );
    expect(currentDestination({ pathname: '/', search: '' })).toBe('/');
  });
});

describe('a sign-in that came back failed', () => {
  it('names the reason the server gave', () => {
    expect(signInFailure('?signin=failed&reason=declined')).toBe('declined');
    expect(signInFailure('?signin=failed&reason=exchange_failed')).toBe('exchange_failed');
  });

  it('is silent on an ordinary launch', () => {
    expect(signInFailure('')).toBeNull();
    expect(signInFailure('?sim=1')).toBeNull();
    // Present but not a failure: nothing to apologise for.
    expect(signInFailure('?signin=ok')).toBeNull();
  });

  it('refuses to render a reason it did not send', () => {
    // The query is untrusted and this reaches the screen. Anything unrecognised
    // becomes a fixed word rather than being echoed.
    expect(signInFailure('?signin=failed&reason=<script>')).toBe('unknown');
    expect(signInFailure(`?signin=failed&reason=${'x'.repeat(40)}`)).toBe('unknown');
    expect(signInFailure('?signin=failed')).toBe('unknown');
  });
});
