/**
 * Real sessions: an opaque token in a cookie, the record in KV (stage 2.2.1).
 *
 * The counterpart to the dev seam's token (`identity.ts`), and deliberately the
 * opposite shape. A dev token is **signed and stateless** so a driver never has
 * to wait for a write to propagate; this one is **opaque and stored**, because
 * the things a real session needs — signing out, expiring, sliding renewal —
 * are all properties of a *record*, and a stateless token cannot have any of
 * them. A token that asserts its own validity cannot be revoked.
 *
 * ## Why KV and not a Durable Object
 *
 * This is read on every authenticated request. A Durable Object read wakes an
 * object and is billed as a request against a 100k/day budget
 * (`reference/budget.md`); a KV read is a separate, much larger allowance and is
 * cached at the edge. The UserDO is addressed by `sub`, which is the answer we
 * are trying to find, so it could not serve this lookup anyway without the
 * token carrying the `sub` in clear — at which point it is not opaque.
 *
 * ## The write budget is the real constraint, and it shapes renewal
 *
 * Free-tier KV allows ~1,000 writes a day against ~100,000 reads. Sliding the
 * expiry on every request (stage 2.2.2 read literally) would therefore cost one
 * write per API call and exhaust the day's writes in a single game. So renewal
 * is **throttled**: the record is rewritten only once `RENEW_AFTER_MS` has
 * passed since it was last touched. A player active every day keeps a session
 * that never expires, at one write a day, which is what 2.2.2 is actually for.
 *
 * ## KV is eventually consistent, and this is the one place it shows
 *
 * A session is written in the OAuth callback and read a second later by the
 * first `/api/me`. Cloudflare serves that read from the colo that performed the
 * write, so in practice it is there — but the guarantee is up to 60 seconds
 * globally, and a player whose two requests land in different colos could be
 * bounced back to the sign-in screen once. Logged rather than designed around,
 * because the alternatives (a signed token that cannot be revoked, or a DO read
 * on every request) each cost more than the failure does.
 */

import { base64UrlEncode } from './crypto.js';
import type { EnvWithSecrets } from './secrets.js';

/**
 * How long a session lasts without being used.
 *
 * Long on purpose, and it is the mitigation for the sharp edge in decision 0014:
 * sign-in is mandatory, so a player who cannot reach Google cannot play, and the
 * worst moment for that is a park with one bar of signal. A month of idle life
 * means sign-in happens at home on wifi and essentially never in a field
 * (O-01, stage 2.2).
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How stale a record may get before a read rewrites it.
 *
 * The throttle described above. A day is short enough that an active player's
 * session is always far from expiry, and long enough that a session costs at
 * most one write per day no matter how much it is used.
 */
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Tag on a real session token.
 *
 * The token is still opaque — the tag encodes nothing about the account and is
 * not a claim about anything — but it lets a cookie that could not have come
 * from here be rejected without spending a KV read on it, and it keeps the two
 * token formats distinguishable in a log (decision 0029). An underscore rather
 * than a dot, so the shape cannot be mistaken for the dev token's `d1.` triple.
 */
const SESSION_PREFIX = 'g1_';

/** Where a session lives in KV. Prefixed so the namespace can hold other things. */
function keyFor(token: string): string {
  return `session:${token}`;
}

/**
 * What is stored against a token. Deliberately small: the account, two stamps,
 * and the address the player signed in with.
 *
 * `email` is for the account screen and nothing else (stage 2.2.5). It is never
 * a key and never compared — the `sub` is the account (decision 0014) — and it
 * lives on the session rather than on the account because it is a fact about
 * *this sign-in*: Google tells us once, at the callback, and a later sign-in may
 * tell us something different. Optional because every session minted before
 * 2.2.5 has none, and those must keep working.
 */
interface SessionRecord {
  sub: string;
  createdAt: number;
  lastSeenAt: number;
  email?: string;
}

/** A live session, as the rest of the Worker sees it. */
export interface SessionInfo {
  sub: string;
  /** The address Google gave at sign-in, for display only. Null if not known. */
  email: string | null;
  /**
   * When KV will drop the record, in **server** milliseconds (stage 2.2.3).
   *
   * Every write sets `expirationTtl` from the moment of writing, and every write
   * stamps `lastSeenAt`, so the expiry is exactly `lastSeenAt + SESSION_TTL_MS`
   * — after a renewal on this very read, if there was one. A server timestamp:
   * the client must not compare it with its own clock (`gotchas.md`), which is
   * why `/api/me` sends its own `now` beside it.
   */
  expiresAt: number;
}

/**
 * Mint a session for an account, and return the token for the cookie.
 *
 * 32 bytes from `crypto.getRandomValues` — the same order of entropy as a UUIDv4
 * and then some. There is nothing to guess here and nothing to forge: a token
 * that is not in KV is not a session, whatever it looks like.
 */
export async function createSession(
  env: EnvWithSecrets,
  sub: string,
  now: number = Date.now(),
  details: { email?: string | null } = {},
): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = `${SESSION_PREFIX}${base64UrlEncode(bytes)}`;

  const record: SessionRecord = { sub, createdAt: now, lastSeenAt: now };
  if (typeof details.email === 'string' && details.email !== '') record.email = details.email;
  await env.SESSIONS.put(keyFor(token), JSON.stringify(record), {
    // KV expires the record itself, so an abandoned session cannot outlive its
    // welcome even if nothing ever reads it again.
    expirationTtl: Math.floor(SESSION_TTL_MS / 1000),
  });
  return token;
}

/**
 * The session a token names, or null for anything that is not a live session.
 *
 * Renews in the background when the record has gone stale — `waitUntil` is not
 * available here, so the write is awaited, but it happens at most once a day per
 * session and only on a request that was already going to touch KV.
 */
export async function readSession(
  env: EnvWithSecrets,
  token: string,
  now: number = Date.now(),
): Promise<SessionInfo | null> {
  // Rejected before the lookup: a cookie from another app, or junk, must not
  // cost a KV read. Every real token was minted with this prefix.
  if (!token.startsWith(SESSION_PREFIX)) return null;

  const raw = await env.SESSIONS.get(keyFor(token));
  if (raw === null) return null;

  let record: SessionRecord;
  try {
    record = JSON.parse(raw) as SessionRecord;
  } catch {
    return null;
  }
  if (typeof record.sub !== 'string' || record.sub === '') return null;

  // When the record was last written, which is what its KV expiry counts from.
  // A record with no usable stamp is treated as written now: the only way to
  // get one is a hand edit, and pretending it is about to expire would put a
  // warning on the home screen that nothing the player does can clear.
  let writtenAt =
    typeof record.lastSeenAt === 'number' && Number.isFinite(record.lastSeenAt)
      ? record.lastSeenAt
      : now;

  // Sliding renewal (stage 2.2.2), throttled — see the note at the top of this
  // file for why this is not done on every read.
  if (now - writtenAt >= RENEW_AFTER_MS) {
    try {
      await env.SESSIONS.put(
        keyFor(token),
        JSON.stringify({ ...record, lastSeenAt: now } satisfies SessionRecord),
        { expirationTtl: Math.floor(SESSION_TTL_MS / 1000) },
      );
      writtenAt = now;
    } catch (error) {
      // A failed renewal is not a failed request. The free tier's ~1,000 KV
      // writes a day are the likeliest cause, and before stage 2.2.3 this threw
      // straight through to a 500 on every authenticated call — which the
      // client reads as "server unreachable" (decision 0035), so the player
      // could open the app and then do nothing in it. The record is still
      // valid; it simply did not slide, and the expiry reported below says so
      // honestly, which is exactly the case the pre-flight warning exists for.
      console.error('session renewal failed', error);
    }
  }

  return {
    sub: record.sub,
    email: typeof record.email === 'string' && record.email !== '' ? record.email : null,
    expiresAt: writtenAt + SESSION_TTL_MS,
  };
}

/**
 * End a session (stage 2.2.5).
 *
 * Deleting the record is what actually signs someone out; clearing the cookie
 * only stops the browser sending it. Doing both matters because a token copied
 * out of a browser before signing out would otherwise keep working.
 */
export async function destroySession(env: EnvWithSecrets, token: string): Promise<void> {
  if (!token.startsWith(SESSION_PREFIX)) return;
  await env.SESSIONS.delete(keyFor(token));
}

/**
 * The `Set-Cookie` for a freshly minted session.
 *
 * `Secure` is set whenever the request arrived over HTTPS, which is every real
 * sign-in — the deployed origin is HTTPS and Google refuses a plain-HTTP
 * redirect URI. It is omitted on plain HTTP so that a local `wrangler dev`
 * experiment is not silently unable to store the cookie, which is the same trap
 * the dev seam documents and the reason that one is never `Secure`.
 *
 * `SameSite=Lax` rather than `Strict` because the cookie is set on a **redirect
 * back from Google** and has to be sent on the navigation that follows it;
 * `Strict` would withhold it and the player would land on the app signed out.
 */
export function sessionCookieHeader(name: string, token: string, url: URL): string {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${name}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(
    SESSION_TTL_MS / 1000,
  )}${secure}`;
}

/** And the one that takes it away. */
export function clearCookieHeader(name: string, url: URL): string {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}
