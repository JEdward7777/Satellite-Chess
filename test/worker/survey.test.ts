import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/**
 * The survey API (stage 1.9.3). The property that matters most is the one that
 * is easiest to get wrong by accident: **it must be invisible unless a secret is
 * configured**, because it stores a precise record of where a person stood.
 */

const SECRET = 'test-survey-secret';

/**
 * The bindings vitest gives us come from `wrangler.jsonc`, and a secret is not
 * in there — it is set out of band with `wrangler secret put`. So the tests set
 * and unset it directly, which is also how the "off by default" case is covered.
 */
const mutableEnv = env as unknown as Record<string, unknown>;

function withSecret(): void {
  mutableEnv.SURVEY_SECRET = SECRET;
}

function withoutSecret(): void {
  delete mutableEnv.SURVEY_SECRET;
}

function trace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    label: 'test trace',
    startedAt: 1_000,
    endedAt: 5_000,
    device: 'test-agent',
    fixes: [
      { t: 1_000, lat: 51.4779, lng: -0.0015, acc: 4 },
      { t: 2_000, lat: 51.47791, lng: -0.0015, acc: 5 },
    ],
    markers: [{ t: 2_000, step: 'A1', label: 'Mark point A', atFix: 1 }],
    ...overrides,
  };
}

async function post(body: unknown, secret: string | null = SECRET): Promise<Response> {
  return SELF.fetch('https://example.com/api/survey/trace', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { 'x-survey-secret': secret }),
    },
    body: JSON.stringify(body),
  });
}

describe('the survey API is off by default', () => {
  it('404s every route when no secret is configured', async () => {
    withoutSecret();
    for (const [path, init] of [
      ['/api/survey/traces', {}],
      ['/api/survey/trace/anything', {}],
    ] as const) {
      const res = await SELF.fetch(`https://example.com${path}`, init);
      expect(res.status).toBe(404);
    }
    // Even with a guessed secret, because there is nothing to match against.
    expect((await post(trace(), 'guess')).status).toBe(404);
  });

  it('says "not found" rather than "unauthorised", so it looks absent', async () => {
    withoutSecret();
    const body = (await (await post(trace())).json()) as { error: string };
    expect(body.error).toBe('not_found');
  });
});

describe('with a secret configured', () => {
  it('rejects a wrong secret', async () => {
    withSecret();
    expect((await post(trace(), 'wrong-length')).status).toBe(401);
    // Same length, different content — the constant-time path.
    expect((await post(trace(), 'test-survey-secreT')).status).toBe(401);
  });

  it('rejects a missing secret', async () => {
    withSecret();
    expect((await post(trace(), null)).status).toBe(401);
  });

  it('accepts a trace and reports what it kept', async () => {
    withSecret();
    const res = await post(trace());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, fixes: 2, markers: 1 });
  });

  it('accepts the secret in the query string, for a phone following a link', async () => {
    withSecret();
    const res = await SELF.fetch(`https://example.com/api/survey/traces?secret=${SECRET}`);
    expect(res.status).toBe(200);
  });

  it('round-trips a trace intact — the fixes are the whole point', async () => {
    withSecret();
    const sent = trace({ id: 'round-trip' });
    await post(sent);

    const res = await SELF.fetch('https://example.com/api/survey/trace/round-trip', {
      headers: { 'x-survey-secret': SECRET },
    });
    const got = (await res.json()) as { fixes: Record<string, unknown>[]; markers: unknown[]; device: string };
    // Optional platform fields are normalised to null on the way in, so compare
    // the four that carry the measurement rather than the whole shape.
    expect(got.fixes.map((f) => [f.t, f.lat, f.lng, f.acc])).toEqual(
      (sent.fixes as Record<string, number>[]).map((f) => [f.t, f.lat, f.lng, f.acc]),
    );
    expect(got.markers).toEqual(sent.markers);
    expect(got.device).toBe('test-agent');
  });

  it('lists traces without their fixes, so a listing stays small', async () => {
    withSecret();
    await post(trace({ id: 'listed' }));
    const res = await SELF.fetch('https://example.com/api/survey/traces', {
      headers: { 'x-survey-secret': SECRET },
    });
    const body = (await res.json()) as { traces: { id: string; fixes: number }[] };
    const found = body.traces.find((t) => t.id === 'listed');
    expect(found).toBeDefined();
    expect(found?.fixes).toBe(2);
    expect(found).not.toHaveProperty('body');
  });

  it('404s a trace that does not exist', async () => {
    withSecret();
    const res = await SELF.fetch('https://example.com/api/survey/trace/nope', {
      headers: { 'x-survey-secret': SECRET },
    });
    expect(res.status).toBe(404);
  });

  it('deletes on request, so a trace need not outlive its usefulness', async () => {
    withSecret();
    await post(trace({ id: 'doomed' }));
    const del = await SELF.fetch('https://example.com/api/survey/trace/doomed', {
      method: 'DELETE',
      headers: { 'x-survey-secret': SECRET },
    });
    expect(del.status).toBe(200);
    const after = await SELF.fetch('https://example.com/api/survey/trace/doomed', {
      headers: { 'x-survey-secret': SECRET },
    });
    expect(after.status).toBe(404);
  });
});

describe('upload validation', () => {
  it('refuses a trace with no fixes, which would say nothing', async () => {
    withSecret();
    const res = await post(trace({ fixes: [] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain('says nothing');
  });

  it('refuses a fix off the planet', async () => {
    withSecret();
    const res = await post(trace({ fixes: [{ t: 1, lat: 200, lng: 0, acc: 4 }] }));
    expect(res.status).toBe(400);
  });

  it('refuses a fix with a missing accuracy, since accuracy is the measurement', async () => {
    withSecret();
    const res = await post(trace({ fixes: [{ t: 1, lat: 51.4, lng: -0.1 }] }));
    expect(res.status).toBe(400);
  });

  it('refuses malformed JSON rather than storing rubbish', async () => {
    withSecret();
    const res = await SELF.fetch('https://example.com/api/survey/trace', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-survey-secret': SECRET },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('keeps optional platform fields when present, nulls them when not', async () => {
    withSecret();
    await post(
      trace({
        id: 'optional-fields',
        fixes: [{ t: 1, lat: 51.4, lng: -0.1, acc: 4, alt: 12, spd: 1.3, hdg: 90 }],
      }),
    );
    const res = await SELF.fetch('https://example.com/api/survey/trace/optional-fields', {
      headers: { 'x-survey-secret': SECRET },
    });
    const got = (await res.json()) as { fixes: Record<string, unknown>[] };
    expect(got.fixes[0]).toMatchObject({ alt: 12, spd: 1.3, hdg: 90, altAcc: null });
  });
});
