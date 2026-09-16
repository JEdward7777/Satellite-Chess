/**
 * Google sign-in: the real half of the identity boundary (stage 2.1).
 *
 * Two full-page browser navigations, at the paths decision 0030 fixed *before*
 * this file existed so that the code matches what is already registered in the
 * Google console rather than the other way round:
 *
 * | `GET /auth/google/login`    | build a PKCE challenge, redirect to Google |
 * | `GET /auth/google/callback` | Google sends the browser back with a code  |
 *
 * `redirect_uri` is derived from the incoming request's origin, never
 * hard-coded, so one build works on `localhost:8787` and on the deployed
 * `workers.dev` origin with no flag to set wrong.
 *
 * **These are not `/api/` routes and must never be moved under it.** Everything
 * under `/api/` is JSON fetched by the client; these are navigations that answer
 * with a 302 and a `Set-Cookie`. The service worker has a matching exclusion for
 * the same reason — without it a returning visitor's sign-in is answered from
 * the cached shell and never reaches the Worker at all.
 *
 * ## Why the ID token's signature is not verified
 *
 * The authorization code is exchanged **directly with Google over TLS**, by this
 * Worker, authenticating with the client secret. The ID token therefore arrives
 * over a channel that is already authenticated end to end, and Google's own
 * guidance for the server-side flow is that its payload may be trusted without
 * re-validating the signature (stage 2.1.3).
 *
 * **This stops being true the moment an ID token is accepted from a client.**
 * If a browser is ever allowed to post one here, RS256 verification against
 * Google's JWKS (`https://www.googleapis.com/oauth2/v3/certs`, cached) becomes
 * mandatory and this comment becomes a bug. The claims are still checked below —
 * issuer, audience, expiry and nonce — because "came from Google" and "was
 * issued to us, for this sign-in, and is still valid" are different questions.
 */

import { apiError } from './http.js';
import { parseAppRoute } from '../shared/routes.js';
import { SESSION_COOKIE, asSub, readCookie } from './identity.js';
import { base64UrlEncode, decodeUtf8, hmacSha256, timingSafeEqual } from './crypto.js';
import { clearCookieHeader, createSession, sessionCookieHeader } from './sessions.js';
import type { EnvWithSecrets } from './secrets.js';

/** Confirmed against Google's OpenID discovery document, 2026-09-16. */
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * The two spellings of Google's issuer claim.
 *
 * Both are emitted in practice and both are correct; checking for only one is a
 * sign-in that works until the day it does not.
 */
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

/**
 * Identity only (decision 0014). `openid` is required and must come first;
 * `email` is here so an account screen can say *which* Google account this is,
 * which is the one thing a player needs to recognise. No API scopes are
 * requested, so there is nothing to refresh and nothing to store.
 */
const SCOPE = 'openid email';

/**
 * How long the browser has to complete a sign-in.
 *
 * The window between being sent to Google and coming back. Generous enough for
 * choosing an account and typing a password, short enough that an abandoned
 * cookie is worthless long before anyone finds it.
 */
const FLOW_TTL_MS = 10 * 60 * 1000;

/**
 * Where the PKCE verifier waits while the browser is at Google.
 *
 * Its own cookie, cleared the moment the callback runs.
 */
const FLOW_COOKIE = 'satchess_oauth';

/** The paths this module owns, per decision 0030. */
const LOGIN_PATH = '/auth/google/login';
const CALLBACK_PATH = '/auth/google/callback';

/**
 * Route `/auth/...`. Returns null when the path is not ours, so the router can
 * fall through to the assets binding.
 */
export async function authRoutes(
  request: Request,
  env: EnvWithSecrets,
  url: URL,
  now: number = Date.now(),
): Promise<Response | null> {
  if (url.pathname !== LOGIN_PATH && url.pathname !== CALLBACK_PATH) return null;

  if (request.method !== 'GET') {
    return apiError('method_not_allowed', `${request.method} is not allowed here.`, 405);
  }

  // Unlike the survey (decision 0022) and the dev seam (0029), a missing secret
  // here is **not** answered with a 404. Those two are optional facilities and
  // pretending they do not exist is honest; sign-in is the only way into the
  // game, so a deployment without credentials is broken rather than minimal, and
  // saying so is what stops it looking like a routing bug.
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientSecret || !env.GOOGLE_CLIENT_ID) {
    return apiError(
      'signin_unconfigured',
      'Sign-in is not configured on this server. GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be set.',
      503,
    );
  }

  return url.pathname === LOGIN_PATH
    ? startSignIn(env, url, clientSecret, now)
    : completeSignIn(request, env, url, clientSecret, now);
}

/**
 * Send the browser to Google.
 *
 * Everything this flow needs to remember — the PKCE verifier, the anti-forgery
 * `state`, and the `nonce` — goes into one signed, short-lived cookie rather
 * than into KV. That is not a micro-optimisation: KV is eventually consistent,
 * and a value written here and read back a few seconds later in the callback is
 * exactly the read that can miss. A cookie is carried by the one browser that
 * matters and cannot be stale.
 */
async function startSignIn(
  env: EnvWithSecrets,
  url: URL,
  clientSecret: string,
  now: number,
): Promise<Response> {
  const verifier = randomToken();
  const state = randomToken();
  const nonce = randomToken();
  const next = safeNext(url.searchParams.get('next'));

  const flow = await sealFlow(
    { state, nonce, verifier, exp: now + FLOW_TTL_MS, next },
    clientSecret,
  );

  const target = new URL(AUTH_ENDPOINT);
  target.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  target.searchParams.set('redirect_uri', redirectUri(url));
  target.searchParams.set('response_type', 'code');
  target.searchParams.set('scope', SCOPE);
  target.searchParams.set('state', state);
  target.searchParams.set('nonce', nonce);
  target.searchParams.set('code_challenge', await challengeFor(verifier));
  target.searchParams.set('code_challenge_method', 'S256');

  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      'set-cookie': flowCookieHeader(flow, url),
      // A sign-in redirect must never be cached: the state and challenge in it
      // are single-use, and a cached copy would send the next attempt to Google
      // with a verifier this server has forgotten.
      'cache-control': 'no-store',
    },
  });
}

/**
 * Google has sent the browser back. Turn the code into a session.
 *
 * Every failure here ends as a redirect to the app with a reason in the query
 * rather than as JSON, because the thing looking at this response is a browser
 * showing a whole page to someone who just tapped "Sign in". Stage 2.5.3 turns
 * those reasons into sentences; until then the app ignores the parameter and
 * shows its ordinary screen, which is the right failure.
 */
async function completeSignIn(
  request: Request,
  env: EnvWithSecrets,
  url: URL,
  clientSecret: string,
  now: number,
): Promise<Response> {
  // Google's own refusal — the player declined consent, or closed the sheet.
  const denied = url.searchParams.get('error');
  if (denied !== null) return failed(url, denied === 'access_denied' ? 'declined' : 'google_error');

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (code === null || state === null) return failed(url, 'bad_response');

  const sealed = readCookie(request, FLOW_COOKIE);
  if (sealed === null) return failed(url, 'expired');
  const flow = await openFlow(sealed, clientSecret, now);
  if (flow === null) return failed(url, 'expired');

  // The anti-forgery check: the `state` that came back must be the one this
  // server issued to this browser. Compared in constant time because it is a
  // secret the attacker is trying to guess, not merely a value to match.
  if (!timingSafeEqual(state, flow.state)) return failed(url, 'bad_state', flow.next);

  const exchanged = await exchangeCode(env, code, flow.verifier, clientSecret, url);
  if (exchanged === null) return failed(url, 'exchange_failed', flow.next);

  const claims = readIdToken(exchanged);
  if (claims === null) return failed(url, 'bad_token', flow.next);

  if (!ISSUERS.has(claims.iss)) return failed(url, 'bad_token', flow.next);
  if (claims.aud !== env.GOOGLE_CLIENT_ID) return failed(url, 'bad_token', flow.next);
  if (claims.exp * 1000 <= now) return failed(url, 'bad_token', flow.next);
  // Replay protection: this token must have been minted for the sign-in this
  // browser actually started, not captured from another one.
  if (!timingSafeEqual(claims.nonce, flow.nonce)) return failed(url, 'bad_token', flow.next);

  // The account key is the `sub` and never the email (decision 0014, stage
  // 2.1.4). Folded through the same validator the dev seam uses, so a `sub` that
  // could not be a Durable Object name is refused here rather than becoming an
  // address later.
  const sub = asSub(claims.sub);
  if (sub === null) return failed(url, 'bad_token', flow.next);

  const token = await createSession(env, sub, now);

  // Wherever they were going, with the sign-in machinery gone from the address
  // bar — home for an ordinary sign-in, and the invite for someone who scanned a
  // QR while signed out. The flow cookie is cleared in the same response: it has
  // been spent, and leaving it would let a replayed callback be attempted
  // against it.
  const headers = new Headers({ location: flow.next, 'cache-control': 'no-store' });
  headers.append('set-cookie', sessionCookieHeader(SESSION_COOKIE, token, url));
  headers.append('set-cookie', clearCookieHeader(FLOW_COOKIE, url));
  return new Response(null, { status: 302, headers });
}

/** Trade the code for tokens, server to server. */
async function exchangeCode(
  env: EnvWithSecrets,
  code: string,
  verifier: string,
  clientSecret: string,
  url: URL,
): Promise<unknown> {
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: clientSecret,
    redirect_uri: redirectUri(url),
    grant_type: 'authorization_code',
    // The other half of PKCE. Google checks that its SHA-256 matches the
    // challenge sent at the start, which is what stops a stolen code being
    // redeemed by anyone but us.
    code_verifier: verifier,
  });

  try {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) {
      // The body carries Google's own diagnosis — `invalid_grant` for a reused
      // code, `redirect_uri_mismatch` for a console that does not match this
      // origin. Logged rather than shown: it is for whoever is reading the tail,
      // and the player gets a sentence instead.
      console.error('token exchange failed', response.status, await response.text());
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error('token exchange threw', error);
    return null;
  }
}

interface IdClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  nonce: string;
  email?: string;
  emailVerified?: boolean;
}

/**
 * The claims out of the ID token's payload.
 *
 * The signature is not checked — see the note at the top of this file for the
 * one condition under which that is safe, and for what has to change if that
 * condition ever stops holding.
 */
export function readIdToken(exchanged: unknown): IdClaims | null {
  const idToken = (exchanged as { id_token?: unknown } | null)?.id_token;
  if (typeof idToken !== 'string') return null;

  const parts = idToken.split('.');
  if (parts.length !== 3) return null;

  const decoded = decodeUtf8(parts[1]);
  if (decoded === null) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }

  const { iss, aud, sub, exp, nonce } = payload;
  if (
    typeof iss !== 'string' ||
    typeof aud !== 'string' ||
    typeof sub !== 'string' ||
    typeof exp !== 'number' ||
    typeof nonce !== 'string'
  ) {
    return null;
  }

  return {
    iss,
    aud,
    sub,
    exp,
    nonce,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    emailVerified: payload.email_verified === true,
  };
}

// ---------------------------------------------------------------------------
// The in-flight sign-in, sealed into a cookie
// ---------------------------------------------------------------------------

interface Flow {
  state: string;
  nonce: string;
  verifier: string;
  exp: number;
  /**
   * Where to land once this is over (stage 2.5.1).
   *
   * Carried in the sealed cookie rather than in the `state` parameter so Google
   * never sees which game someone was invited to, and so it cannot be edited by
   * the browser in flight. The commonest first-ever sign-in is a QR scanned in a
   * park, and returning that player to `/` loses the invitation at the exact
   * moment two people have already travelled to play.
   */
  next: string;
}

/**
 * `<payload>.<hmac>`, base64url throughout.
 *
 * Signed with the client secret, which is the one high-entropy value this
 * Worker already holds and never discloses. The payload is not encrypted and
 * does not need to be: it is this browser's own single-use `state`, `nonce` and
 * verifier, all of which Google is about to see anyway. What the signature buys
 * is that a browser cannot *choose* them, which is what the PKCE and state
 * checks depend on.
 */
async function sealFlow(flow: Flow, secret: string): Promise<string> {
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(flow)));
  return `${payload}.${await hmacSha256(secret, payload)}`;
}

/** The flow a sealed cookie describes, or null if it is not one of ours. */
async function openFlow(sealed: string, secret: string, now: number): Promise<Flow | null> {
  const parts = sealed.split('.');
  if (parts.length !== 2) return null;

  const [payload, signature] = parts;
  if (!timingSafeEqual(signature, await hmacSha256(secret, payload))) return null;

  // Only after the signature holds. Parsing first would make the signature
  // decorative, which is the shape of bug that turns a signed cookie into an
  // unsigned one.
  const decoded = decodeUtf8(payload);
  if (decoded === null) return null;

  let flow: Flow;
  try {
    flow = JSON.parse(decoded) as Flow;
  } catch {
    return null;
  }

  if (
    typeof flow.state !== 'string' ||
    typeof flow.nonce !== 'string' ||
    typeof flow.verifier !== 'string' ||
    typeof flow.exp !== 'number' ||
    flow.exp <= now
  ) {
    return null;
  }
  // Re-validated on the way out as well as on the way in. The cookie is signed,
  // so this cannot have been tampered with — but a flow sealed by the build
  // before 2.5.1 carries no `next` at all, and normalising rather than rejecting
  // means a sign-in already in flight across a deploy completes instead of
  // failing as "expired", which is the one failure that reads as a loop.
  flow.next = safeNext(flow.next);
  return flow;
}

function flowCookieHeader(sealed: string, url: URL): string {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  // `SameSite=Lax` is required rather than preferred: this cookie has to survive
  // the top-level navigation back from accounts.google.com, and `Strict` would
  // withhold it on exactly that request — the sign-in would fail as "expired"
  // every time, on every browser.
  return `${FLOW_COOKIE}=${sealed}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=${Math.floor(
    FLOW_TTL_MS / 1000,
  )}${secure}`;
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/**
 * The callback URL, derived from where this request actually arrived
 * (decision 0030).
 *
 * Must be byte-identical between the authorization request and the token
 * exchange, or Google refuses the exchange with `redirect_uri_mismatch` — which
 * is why it is computed here once and used by both.
 */
function redirectUri(url: URL): string {
  return `${url.origin}${CALLBACK_PATH}`;
}

/**
 * 32 random bytes as base64url — 43 characters.
 *
 * Doubles as the PKCE `code_verifier`, where Google requires 43 to 128
 * characters from the unreserved set; base64url is a subset of it, and 43 is the
 * floor exactly.
 */
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** base64url of the SHA-256 of the verifier, which is PKCE's `S256`. */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Back to the app, with the reason in the query for stage 2.5.3 to render.
 *
 * `next` is the destination the flow was carrying, so a sign-in that fails on
 * the way to an invite leaves the player on that invite's own URL rather than on
 * the home screen — retrying is then the button in front of them, not six
 * characters they have to ask for again. It defaults to home for the failures
 * that happen before the flow cookie has been opened, where there is nothing to
 * know.
 */
function failed(url: URL, reason: string, next = '/'): Response {
  // Resolved against a throwaway base so the query can be appended without
  // caring whether `next` already had one — `/j/ABC123?sim=1` is the case that
  // makes string concatenation wrong, and it is the case every browser driver
  // uses.
  const target = new URL(safeNext(next), 'https://app.invalid');
  target.searchParams.set('signin', 'failed');
  target.searchParams.set('reason', reason);
  return new Response(null, {
    status: 302,
    headers: {
      location: `${target.pathname}${target.search}${target.hash}`,
      'set-cookie': clearCookieHeader(FLOW_COOKIE, url),
      'cache-control': 'no-store',
    },
  });
}

/**
 * A destination this app is willing to send a browser to after sign-in.
 *
 * The allowlist is `parseAppRoute` — the one table the Worker and the client
 * already share (O-06) — plus the home screen, so there is no second list to
 * keep in step and no way to express an off-origin destination at all. Anything
 * else becomes `/`, which makes an open redirect unreachable rather than merely
 * guarded against: a protocol-relative `//evil.example`, an absolute URL and a
 * path this app does not own all fail the same check.
 *
 * The query string is preserved deliberately. Losing `?sim=1` here would end a
 * simulated game the moment anybody signed in, and that is how every browser
 * check in this project is run.
 */
export function safeNext(raw: string | null | undefined): string {
  // `undefined` is a real input, not a type-system formality: it is what a flow
  // cookie sealed before this field existed deserialises to.
  if (!raw || raw.length > MAX_NEXT) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  const path = raw.split(/[?#]/)[0];
  return path === '/' || parseAppRoute(path) !== null ? raw : '/';
}

/**
 * Long enough for `/f/<blob>` with a name on it, short enough that a junk
 * destination cannot be echoed back at length. `MAX_FIELD_BLOB` is 256.
 */
const MAX_NEXT = 512;
