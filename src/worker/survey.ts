/**
 * The survey API: upload a GPS trace from a field, read it back for analysis.
 *
 * Deliberately separate from the game's routes. This exists to answer stage
 * 1.9.3 — whether consumer GPS can really tell 8 m squares apart on grass — and
 * it should be deletable in one commit once that question is settled.
 *
 * **Off unless `SURVEY_SECRET` is set.** With no secret configured every route
 * here 404s, exactly as though the namespace did not exist, so a normal deploy
 * cannot accidentally expose a location recorder. Setting it is a deliberate act:
 *
 *     npx wrangler secret put SURVEY_SECRET
 */

import type { EnvWithSecrets } from './secrets.js';
import type { Trace } from './survey-do.js';
import { apiError, json } from './http.js';

/** The object is a singleton; there is only ever one survey log. */
const SURVEY_NAME = 'survey';

/**
 * Compare in time that does not depend on how much of the secret matched.
 *
 * The window here is small — an attacker would have to find the endpoint, and
 * the payoff is a debug log — but a string `===` on a credential is the kind of
 * thing that gets copied into somewhere it matters.
 */
function secretMatches(given: string | null, expected: string): boolean {
  if (given === null || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Authorise, or explain why not.
 *
 * Returns a Response when the caller should be turned away, or null to proceed.
 */
function authorise(request: Request, url: URL, env: EnvWithSecrets): Response | null {
  const expected = env.SURVEY_SECRET;
  if (!expected) {
    // Not "forbidden" — as far as an unconfigured deployment is concerned this
    // namespace genuinely does not exist.
    return apiError('not_found', 'No such endpoint.', 404);
  }

  // Header for machines, query string for a phone following a link.
  const given =
    request.headers.get('x-survey-secret') ?? url.searchParams.get('secret') ?? null;
  if (!secretMatches(given, expected)) {
    return apiError('unauthorised', 'Bad or missing survey secret.', 401);
  }
  return null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate an uploaded trace.
 *
 * The uploader holds the secret, but "trusted" and "correct" are different
 * things — a half-written trace from a phone that lost signal should be
 * rejected here rather than confuse the analysis three days later.
 */
function parseTrace(body: unknown): { trace: Trace } | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'Body must be an object.' };
  const raw = body as Record<string, unknown>;

  if (typeof raw.id !== 'string' || raw.id.length < 1 || raw.id.length > 100) {
    return { error: 'id must be a short string.' };
  }
  if (typeof raw.label !== 'string' || raw.label.length > 200) {
    return { error: 'label must be a string.' };
  }
  if (!Array.isArray(raw.fixes) || raw.fixes.length === 0) {
    return { error: 'A trace with no fixes says nothing.' };
  }

  const fixes = [];
  for (const item of raw.fixes) {
    const fix = item as Record<string, unknown>;
    if (!isFiniteNumber(fix.t) || !isFiniteNumber(fix.lat) || !isFiniteNumber(fix.lng)) {
      return { error: 'Every fix needs finite t, lat and lng.' };
    }
    if (!isFiniteNumber(fix.acc)) return { error: 'Every fix needs a finite accuracy.' };
    if (fix.lat < -90 || fix.lat > 90 || fix.lng < -180 || fix.lng > 180) {
      return { error: 'A fix is off the planet.' };
    }
    fixes.push({
      t: fix.t,
      lat: fix.lat,
      lng: fix.lng,
      acc: fix.acc,
      alt: isFiniteNumber(fix.alt) ? fix.alt : null,
      altAcc: isFiniteNumber(fix.altAcc) ? fix.altAcc : null,
      spd: isFiniteNumber(fix.spd) ? fix.spd : null,
      hdg: isFiniteNumber(fix.hdg) ? fix.hdg : null,
    });
  }

  const markers = [];
  for (const item of Array.isArray(raw.markers) ? raw.markers : []) {
    const marker = item as Record<string, unknown>;
    if (!isFiniteNumber(marker.t) || typeof marker.step !== 'string') {
      return { error: 'Every marker needs a time and a step.' };
    }
    markers.push({
      t: marker.t,
      step: marker.step,
      label: typeof marker.label === 'string' ? marker.label : marker.step,
      atFix: isFiniteNumber(marker.atFix) ? marker.atFix : 0,
      note: typeof marker.note === 'string' ? marker.note : undefined,
    });
  }

  return {
    trace: {
      id: raw.id,
      label: raw.label,
      startedAt: isFiniteNumber(raw.startedAt) ? raw.startedAt : fixes[0].t,
      endedAt: isFiniteNumber(raw.endedAt) ? raw.endedAt : fixes[fixes.length - 1].t,
      device: typeof raw.device === 'string' ? raw.device.slice(0, 300) : 'unknown',
      fixes,
      markers,
    },
  };
}

/** Route `/api/survey/...`. Returns null when the path is not ours. */
export async function surveyRoutes(
  request: Request,
  env: EnvWithSecrets,
  url: URL,
): Promise<Response | null> {
  const path = url.pathname;
  if (path !== '/api/survey' && !path.startsWith('/api/survey/')) return null;

  const denied = authorise(request, url, env);
  if (denied) return denied;

  const stub = env.SURVEY.getByName(SURVEY_NAME);

  // POST /api/survey/trace — the phone confessing.
  if (path === '/api/survey/trace' && request.method === 'POST') {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError('bad_request', 'Body must be JSON.');
    }
    const parsed = parseTrace(body);
    if ('error' in parsed) return apiError('bad_request', parsed.error);

    const receipt = await stub.put(parsed.trace);
    return json({ ok: true, ...receipt });
  }

  // GET /api/survey/traces — what has been collected.
  if (path === '/api/survey/traces' && request.method === 'GET') {
    return json({ traces: await stub.list() });
  }

  // GET /api/survey/trace/:id — the whole thing, for analysis.
  const match = /^\/api\/survey\/trace\/([^/]+)$/.exec(path);
  if (match && request.method === 'GET') {
    const trace = await stub.get(decodeURIComponent(match[1]));
    if (!trace) return apiError('not_found', 'No such trace.', 404);
    return json(trace);
  }
  if (match && request.method === 'DELETE') {
    await stub.remove(decodeURIComponent(match[1]));
    return json({ ok: true });
  }

  return apiError('not_found', 'No such survey endpoint.', 404);
}
