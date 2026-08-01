import { describe, expect, it } from 'vitest';

import { joinGame } from '../src/client/join.js';
import type { FieldSnapshot } from '../src/shared/field.js';

/**
 * Taking a seat, and every way it can fail to happen.
 *
 * The failures are the point. The success path is exercised for real against a
 * Durable Object in `test/worker/game-do.test.ts` and end to end in a browser by
 * `scripts/check-join.mjs`; what neither of those can produce on demand is a
 * phone with no signal, a captive portal answering with HTML, or a server that
 * returns a 200 with nothing in it. Those are the cases that decide whether
 * someone standing in a park is told what to do next or shown a blank screen.
 */

const PLAYER = 'player-abcdef01';

const FIELD: FieldSnapshot = {
  fieldId: 'f1',
  name: 'The common',
  version: 1,
  a1: { lat: 51.4779, lng: -0.0015 },
  h8: { lat: 51.4784, lng: -0.0007 },
  squareM: 8,
  bearingDeg: 90,
  snapshotAt: 0,
};

/** A `fetch` that answers once with this status and body. */
function answers(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('joining a game', () => {
  it('returns the seat and the field', async () => {
    const outcome = await joinGame('abc 123', PLAYER, {
      fetch: answers(200, { color: 'b', field: FIELD }),
    });
    expect(outcome).toEqual({ ok: true, code: 'ABC123', colour: 'b', field: FIELD });
  });

  it('folds a code the way the typed entry and the deep link both do', async () => {
    // One normaliser for all three, so a code read aloud across a field — "O for
    // zero" — resolves identically however it was entered.
    const seen: string[] = [];
    const record: typeof fetch = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ color: 'b', field: FIELD }), { status: 200 });
    }) as unknown as typeof fetch;

    for (const typed of ['ABC123', 'abc-123', 'ABCI23', 'abc 123']) {
      const outcome = await joinGame(typed, PLAYER, { fetch: record });
      expect(outcome.ok && outcome.code, typed).toBe('ABC123');
    }
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toBe('/api/game/ABC123');
  });

  it('refuses an impossible code without spending a request', async () => {
    // The phone least likely to have signal is the one that has just been handed
    // a link, so a round trip that cannot succeed is not worth taking.
    const never: typeof fetch = (() => {
      throw new Error('should not have been called');
    }) as unknown as typeof fetch;

    const outcome = await joinGame('NOPE', PLAYER, { fetch: never });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe('bad_code');
    expect(!outcome.ok && outcome.hint).toContain('six characters');
  });

  it('says what the server said, and adds what to do about it', async () => {
    const outcome = await joinGame('ABC123', PLAYER, {
      fetch: answers(404, {
        error: 'not_found',
        message: 'No game with that code. It may have expired.',
      }),
    });
    expect(!outcome.ok && outcome.reason).toBe('not_found');
    // The API writes its messages for someone standing in a field, so they are
    // repeated rather than translated.
    expect(!outcome.ok && outcome.message).toBe('No game with that code. It may have expired.');
    expect(!outcome.ok && outcome.hint).toContain('invite again');
  });

  it('tells a full game apart from a missing one', async () => {
    // Different advice: one is "check the code", the other is "you are the third
    // person to open this link".
    const full = await joinGame('ABC123', PLAYER, {
      fetch: answers(409, { error: 'game_full', message: 'That game already has two players.' }),
    });
    expect(!full.ok && full.reason).toBe('full');
    expect(!full.ok && full.hint).toContain('joined from first');
  });

  it('falls back to the status when there is no error code', async () => {
    const gone = await joinGame('ABC123', PLAYER, { fetch: answers(404, {}) });
    expect(!gone.ok && gone.reason).toBe('not_found');
    const broken = await joinGame('ABC123', PLAYER, { fetch: answers(500, {}) });
    expect(!broken.ok && broken.reason).toBe('server');
  });

  it('reads a rejected fetch as no signal rather than as a broken game', async () => {
    // `fetch` rejects only when the request never got an answer. Reporting that
    // as "no game with that code" would send someone off checking a code that is
    // perfectly fine.
    const offline: typeof fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const outcome = await joinGame('ABC123', PLAYER, { fetch: offline });
    expect(!outcome.ok && outcome.reason).toBe('offline');
    expect(!outcome.ok && outcome.hint).toContain('signal');
  });

  it('does not mistake a captive portal for the game', async () => {
    // Hotel wifi and station wifi both answer every request with a login page.
    const portal: typeof fetch = (async () =>
      new Response('<html>Sign in to continue</html>', { status: 200 })) as unknown as typeof fetch;

    const outcome = await joinGame('ABC123', PLAYER, { fetch: portal });
    expect(!outcome.ok && outcome.reason).toBe('server');
  });

  it('refuses a 200 that carries no field', async () => {
    // There would be no geometry to draw a board with. Better to say the join
    // failed than to open a board on a field that does not exist.
    const outcome = await joinGame('ABC123', PLAYER, { fetch: answers(200, { color: 'b' }) });
    expect(!outcome.ok && outcome.reason).toBe('server');
  });

  it('posts the player id, which is what makes a re-join idempotent', async () => {
    let body: unknown = null;
    const capture: typeof fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ color: 'w', field: FIELD }), { status: 200 });
    }) as unknown as typeof fetch;

    await joinGame('ABC123', PLAYER, { fetch: capture });
    expect(body).toEqual({ playerId: PLAYER });
  });
});
