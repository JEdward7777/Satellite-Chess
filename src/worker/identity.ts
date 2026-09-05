/**
 * Who a request is from — and, for now, a way to say so without Google.
 *
 * This is the **identity boundary**: one function, `identityOf`, that every
 * authenticated route asks and that every way of establishing an identity feeds
 * into. Today there is exactly one such way and it is a test seam (stage 2.5.2).
 * Stage 2.1 adds the real one — the Google OAuth code exchange — beside it, and
 * nothing downstream of this file has to change when it does. That is the point
 * of building the seam first: `2.3`'s UserDO can be written and driven through a
 * browser now, rather than waiting on a Google round-trip that needs a deployed
 * origin that does not exist yet.
 *
 * ## The dev seam is not a fallback
 *
 * Decision 0014 makes sign-in mandatory to play. This file does not soften that.
 * `POST /api/dev/session` mints a session for any `sub` you name, which in a
 * deployed build would be a total authentication bypass — so it is behind **two
 * independent locks**, and both must hold:
 *
 * 1. `DEV_AUTH_SECRET` must be set. Absent — the default, and what every deploy
 *    gets unless someone deliberately runs `wrangler secret put` — and the route
 *    404s as though it did not exist. Same shape as `SURVEY_SECRET`.
 * 2. The request must have arrived on a **loopback host**. `127.0.0.1`,
 *    `localhost` or `[::1]`, which is what `wrangler dev` serves and what no
 *    deployed Worker is ever reached by: Cloudflare routes to a Worker by the
 *    hostname in the request, so a request that arrives at a deployed build has
 *    a hostname that resolves to Cloudflare, never to a loopback address.
 *
 * The second lock is the one that matters, because it is the one a mistake
 * cannot switch off. Setting the secret on a deployed Worker by accident is a
 * plausible slip; making a deployed Worker answer to `localhost` is not.
 *
 * ## Why the dev token has its own format
 *
 * The real session (stage 2.2.1) is specified as an **opaque** token with the
 * record in KV. This one is a **signed, stateless** token, which is a different
 * thing on purpose: a test seam that needed a KV write to mint a session would
 * drag KV into every driver run, and the read-after-write window that made the
 * UserDO a Durable Object (stage 2.3.2) would show up in the tests as flake.
 *
 * So the two formats coexist rather than one anticipating the other. The `d1.`
 * prefix keeps them distinguishable, and `identityOf` reports which one answered
 * — so a session established by the seam can never be mistaken for a real one in
 * a log.
 */

import { apiError, json } from './http.js';
import type { EnvWithSecrets } from './secrets.js';
import { decodeUtf8, encodeUtf8, hmacSha256, timingSafeEqual } from './crypto.js';

export interface Identity {
  /**
   * The account key. In production this is the Google `sub` claim, never the
   * email, because email changes and `sub` does not (decision 0014). It is also
   * the `UserDO` name — `env.USER.getByName(sub)`.
   */
  sub: string;
  /**
   * How the identity was established. `dev` is structurally impossible in a
   * deployed build; it exists so a log line can prove that rather than assert it.
   */
  via: 'dev' | 'google';
}

/** The session cookie. Shared with stage 2.2's real sessions when they land. */
export const SESSION_COOKIE = 'satchess_session';

/** Version tag on a dev token, so it can never be confused with a real one. */
const DEV_PREFIX = 'd1';

/**
 * How long a minted dev session lasts.
 *
 * Long enough that a driver run, or an afternoon of poking at `wrangler dev`,
 * never has to think about it; short enough that a token pasted into a scratch
 * file is not useful next week.
 */
const DEV_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Is the dev seam available on this request?
 *
 * Both locks, and deliberately one function so there is a single place to read
 * the rule and a single place a test can point at.
 */
export function devSeamEnabled(env: EnvWithSecrets, url: URL): boolean {
  return Boolean(env.DEV_AUTH_SECRET) && isLoopback(url.hostname);
}

/**
 * Loopback, by hostname.
 *
 * `URL` strips the brackets from an IPv6 literal in `hostname`, so `[::1]`
 * arrives here as `::1`. Both spellings are accepted because it is cheap to be
 * wrong about which one a runtime hands over.
 */
export function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost')
  );
}

/**
 * Establish who this request is from, or null for nobody.
 *
 * Null is not an error — an unauthenticated request is a normal state, and it is
 * the caller's business whether that is a 401 or a sign-in screen.
 */
export async function identityOf(
  request: Request,
  env: EnvWithSecrets,
  url: URL,
  now: number = Date.now(),
): Promise<Identity | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token === null) return null;

  if (token.startsWith(`${DEV_PREFIX}.`)) {
    // A dev token is only ever honoured where a dev token could have been
    // minted. Without this, a token minted against a local build would keep
    // working if the same secret were ever set on a deployed one.
    if (!devSeamEnabled(env, url)) return null;
    const sub = await verifyDevToken(token, env.DEV_AUTH_SECRET as string, now);
    return sub === null ? null : { sub, via: 'dev' };
  }

  // Stage 2.1/2.2: the real session is resolved here. Until then an unrecognised
  // token is simply nobody, which is the correct answer rather than a placeholder.
  return null;
}

/**
 * The dev seam's routes. Returns null when the path is not its own, so the
 * router can fall through.
 */
export async function devAuthRoutes(
  request: Request,
  env: EnvWithSecrets,
  url: URL,
  now: number = Date.now(),
): Promise<Response | null> {
  if (url.pathname !== '/api/dev/session') return null;

  // Not "forbidden": as far as any build without both locks open is concerned,
  // this endpoint genuinely does not exist. Same reasoning as `survey.ts`.
  if (!devSeamEnabled(env, url)) {
    return apiError('not_found', 'No such endpoint.', 404);
  }

  if (request.method !== 'POST') {
    return apiError('method_not_allowed', `${request.method} is not allowed here.`, 405);
  }

  const given =
    request.headers.get('x-dev-auth-secret') ?? url.searchParams.get('secret') ?? null;
  if (!timingSafeEqual(given, env.DEV_AUTH_SECRET as string)) {
    return apiError('unauthorised', 'Bad or missing dev auth secret.', 401);
  }

  const body = await readJson(request);
  const sub = asSub(body?.sub ?? url.searchParams.get('sub'));
  if (sub === null) {
    return apiError(
      'bad_message',
      'A `sub` is required: 1-128 characters of letters, digits, dot, underscore, colon or hyphen.',
      400,
    );
  }

  const token = await mintDevToken(sub, env.DEV_AUTH_SECRET as string, now + DEV_TTL_MS);
  return json(
    { sub, via: 'dev', expiresAt: now + DEV_TTL_MS },
    {
      headers: {
        // No `Secure`. The seam is loopback-only and `wrangler dev` is plain
        // HTTP, so `Secure` would stop the cookie being stored at all in some
        // browsers and buy nothing — there is no network to intercept. Stage
        // 2.2.1's real cookie is `Secure`, and that difference is deliberate.
        'set-cookie': `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(DEV_TTL_MS / 1000)}`,
      },
    },
  );
}

// ---------------------------------------------------------------------------
// The dev token itself
// ---------------------------------------------------------------------------

/**
 * `d1.<payload>.<signature>`, where payload is base64url JSON `{sub, exp}`.
 *
 * Stateless and signed rather than opaque and stored — see the note at the top
 * of this file for why that is right for a seam and wrong for the real thing.
 */
export async function mintDevToken(sub: string, secret: string, expiresAt: number): Promise<string> {
  const payload = encodeUtf8(JSON.stringify({ sub, exp: expiresAt }));
  const signed = `${DEV_PREFIX}.${payload}`;
  return `${signed}.${await hmacSha256(secret, signed)}`;
}

/** The sub carried by a valid, unexpired dev token, or null for anything else. */
export async function verifyDevToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== DEV_PREFIX) return null;

  const [, payload, signature] = parts;
  const expected = await hmacSha256(secret, `${DEV_PREFIX}.${payload}`);
  if (!timingSafeEqual(signature, expected)) return null;

  // Only after the signature holds — parsing attacker-controlled JSON before
  // authenticating it is the shape of bug that turns a signed token into an
  // unsigned one.
  const decoded = decodeUtf8(payload);
  if (decoded === null) return null;
  let claims: { sub?: unknown; exp?: unknown };
  try {
    claims = JSON.parse(decoded) as typeof claims;
  } catch {
    return null;
  }

  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now) {
    return null;
  }
  return asSub(claims.sub);
}

// ---------------------------------------------------------------------------
// Input handling. Everything from a client is untrusted.
// ---------------------------------------------------------------------------

/**
 * A `sub` that is safe to use as a Durable Object name.
 *
 * Looser at the short end than `asPlayerId` in the router, which wants at least
 * eight characters because it is validating a UUID. A dev seam wants to mint
 * `alice`, and a readable name in a driver's output is worth more than a length
 * rule that is not protecting anything — the charset is what keeps this safe as
 * an object name.
 *
 * **At least one alphanumeric character**, which is what stops `..` and `.` and
 * `---`. A Durable Object name is hashed rather than used as a path, so those
 * are not a traversal in the way they look like one; they are rejected because
 * an account key made entirely of punctuation is never a real Google `sub` and
 * never a useful dev name, and the cheapest time to exclude a whole category is
 * before anything depends on it.
 */
export function asSub(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 128) return null;
  if (!/[A-Za-z0-9]/.test(trimmed)) return null;
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : null;
}

/**
 * One cookie out of the header.
 *
 * Hand-rolled because a Worker has no cookie parser and the alternative is a
 * dependency for six lines. Values are token-shaped here — base64url and dots —
 * so nothing needs unquoting.
 */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return null;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
