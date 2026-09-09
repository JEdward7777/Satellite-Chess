/**
 * The Worker: an API router in front of the static PWA shell.
 *
 * Thin by design. It resolves a join code to a Durable Object, identifies the
 * player, and hands over — every rule and every piece of state lives in the DO,
 * which is the only authority.
 *
 * Anything that is not `/api/...` falls through to the assets binding, except
 * the client-side routes in `shared/routes.ts` (`/j/CODE`, `/f/<blob>`), which
 * are answered with the shell — there is no file at those paths, and a QR scan
 * lands on one.
 */

import { type FieldSpec, snapshotField } from '../shared/field.js';
import { DEFAULT_TIME_CONTROL } from '../shared/clock.js';
import { generateJoinCode, normaliseJoinCode } from '../shared/joincode.js';
import { isAppRoute } from '../shared/routes.js';
import { clampHandicapSquares, reachFromSquares } from '../shared/reach.js';
import type { Color } from '../shared/squares.js';
import { GameDO } from './game-do.js';
import { UserDO } from './user-do.js';
import { SurveyDO } from './survey-do.js';
import { surveyRoutes } from './survey.js';
import { devAuthRoutes, type Identity, identityOf } from './identity.js';
import { MAX_FIELDS_PER_ACCOUNT, asFieldSpec, asId } from './user-fields.js';
import { MAX_GAMES_PER_ACCOUNT, asJoinCode } from './user-games.js';
import { byMostWanted, listedGame } from '../shared/game-index.js';
import { apiError, json } from './http.js';

// Wrangler needs the Durable Object classes exported from the entry point.
export { GameDO, UserDO, SurveyDO };

/**
 * How many fresh codes to try before giving up on a collision.
 *
 * The space is ~1.07e9 and collisions are detected at the object rather than
 * prevented, so in practice this never loops twice. Bounded anyway, because an
 * unbounded retry against a systematic failure would burn the request budget.
 */
const CREATE_ATTEMPTS = 5;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // The whole `/api` namespace belongs to the router, so an endpoint that does
    // not exist must never fall through to the assets binding and come back as
    // the HTML shell with a 200.
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env, url);
      } catch (error) {
        // A thrown error would otherwise surface as an opaque 500 to someone
        // standing in a field. Log it and say something honest.
        console.error('unhandled API error', error);
        return apiError('internal', 'Something broke on the server.', 500);
      }
    }

    // A client-side route has no file behind it, so serve the shell and let the
    // client read the path. Deliberately a fixed list rather than a catch-all
    // "unknown path gets index.html": a typo should still 404 honestly instead
    // of returning HTML with a 200, which is the failure mode that makes a
    // broken link look like a broken app.
    //
    // The shell is fetched as `/`, not as `/index.html`. The assets binding's
    // default `html_handling` strips `index.html` and answers it with a **307 to
    // `/`** — which a browser follows, so a scanned invite would land on the home
    // screen with the code gone from the URL. That reads as the client failing to
    // parse the code, and nothing in the Worker looks wrong.
    if (isAppRoute(url.pathname)) {
      return env.ASSETS.fetch(new Request(new URL('/', url), request));
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;

  if (path === '/api/health') {
    return json({ ok: true, service: 'satellite-chess', now: Date.now() });
  }

  // Field survey (stage 1.9.3). Returns null unless the path is its own, and
  // 404s entirely unless SURVEY_SECRET is configured.
  const survey = await surveyRoutes(request, env, url);
  if (survey) return survey;

  // The dev identity seam (stage 2.5.2). Returns null unless the path is its
  // own, and 404s entirely unless both of its locks are open — a set
  // DEV_AUTH_SECRET *and* a loopback hostname.
  const devAuth = await devAuthRoutes(request, env, url);
  if (devAuth) return devAuth;

  // Who the session says you are. The client's sign-in gate (stage 2.5.1) reads
  // this, and it is how a driver proves the seam actually took.
  //
  // It is also where an account comes into existence (stage 2.3.1). There is no
  // sign-up step to hang creation on — `getByName(sub)` means the first request
  // from a new player addresses a real object immediately — so the launch check
  // doubles as the account touch. One request rather than two on every app
  // start, which is worth having against a 100k/day budget.
  if (path === '/api/me') {
    if (request.method !== 'GET') {
      return apiError('method_not_allowed', `${request.method} is not allowed here.`, 405);
    }
    const identity = await identityOf(request, env, url);
    if (identity === null) {
      return apiError('unauthenticated', 'Not signed in.', 401);
    }
    const account = await userFor(env, identity.sub).touch(identity.sub);
    return json({ ...identity, account });
  }

  // Saved fields, off the phone and onto the account (stage 2.3.3.2).
  if (path === '/api/fields/sync') {
    return syncFields(request, env, url);
  }

  // The game index (stage 2.3.4): what am I playing, and what did I play?
  if (path === '/api/games') {
    return listGames(request, env, url);
  }
  if (path === '/api/games/forget') {
    return forgetGames(request, env, url);
  }

  if (path === '/api/game' && request.method === 'POST') {
    return createGame(request, env, url);
  }

  // `/api/game/:code` and `/api/game/:code/ws`
  const match = /^\/api\/game\/([^/]+)(\/ws)?$/.exec(path);
  if (match !== null) {
    const code = normaliseJoinCode(decodeURIComponent(match[1]));
    if (code === null) {
      return apiError(
        'bad_code',
        'That is not a six-character game code. Check for a typo — letters I, L, O and U are never used.',
        400,
      );
    }
    const stub = env.GAME.getByName(code);

    if (match[2] === '/ws') {
      return openSocket(request, env, url, stub);
    }
    if (request.method === 'GET') {
      return json(await stub.peek());
    }
    if (request.method === 'POST') {
      return joinGame(request, env, url, stub);
    }
    return apiError('method_not_allowed', `${request.method} is not allowed here.`, 405);
  }

  return apiError('not_found', 'No such endpoint.', 404);
}

/**
 * The Durable Object holding one player's account (stage 2.3.1).
 *
 * One line, and it exists so that there is exactly one of it. The `sub` *is* the
 * address (decision 0014), so every authenticated route that needs an account
 * must derive the stub the same way — a second call site that hashed an email,
 * or a user id, or a lower-cased `sub`, would silently address a different and
 * empty object, and the symptom is a player whose saved fields have vanished
 * rather than an error anybody sees.
 */
function userFor(env: Env, sub: string): DurableObjectStub<UserDO> {
  return env.USER.getByName(sub);
}

/**
 * Who is taking this seat (stage 3.5.2).
 *
 * **A session wins over the body, always.** The `playerId` a client sends is a
 * UUID it made up on first run, which was the right answer while there were no
 * accounts and is the wrong one now: it belongs to a *phone*, so a game resumed
 * on a second phone would find both seats taken by strangers. When there is a
 * session, the seat key is the Google `sub` (decision 0014), which is the same
 * on every phone the player owns — and is what makes stage 2.3.4's game index a
 * list you can act on rather than a list you can only read.
 *
 * The `sub` is never shown to the opponent: `PlayerView` carries a colour, a
 * connection and a position, and no identifier at all.
 *
 * `account` is null for a seat with no session behind it, and that is a real
 * state until stage 2.5.1 makes sign-in mandatory: the game still plays, and it
 * simply never appears in anybody's index.
 */
function seatFor(identity: Identity | null, body: unknown): { seat: string | null; account: string | null } {
  if (identity !== null) return { seat: identity.sub, account: identity.sub };
  return { seat: asPlayerId(body), account: null };
}

/**
 * The account's game index (stage 2.3.4).
 *
 * A pure read of denormalised rows: no game is woken, which is the whole reason
 * the rows are denormalised. Ten games would otherwise be ten Durable Object
 * requests every time somebody opened the app.
 *
 * The claim countdown is computed here rather than stored, because it is a
 * function of the clock and the row would be wrong the moment it was written.
 * The client re-computes it too, from the same shared rule.
 */
async function listGames(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') {
    return apiError('method_not_allowed', `${request.method} is not allowed here.`, 405);
  }
  const identity = await identityOf(request, env, url);
  if (identity === null) {
    return apiError('unauthenticated', 'Not signed in.', 401);
  }
  const entries = await userFor(env, identity.sub).listGames();
  const now = Date.now();
  // Sorted here rather than in SQL: "most wanted" puts a game still in play
  // above a finished one whatever the dates say, and that is a rule about what
  // the list is *for* rather than a property of a column.
  return json({
    games: [...entries].sort(byMostWanted).map((entry) => listedGame(entry, now)),
    now,
  });
}

/**
 * Forget games, at the player's request (stage 2.3.4.2).
 *
 * An offer and never a timer (decision 0025): nothing server-side ever deletes a
 * played game, so this route is the only path by which one leaves a list, and it
 * refuses any game that is not over. The refusals come back named rather than as
 * a 400 for the batch — a player tidying up ten games should not have the whole
 * gesture fail because one of them turned out to be suspended.
 */
async function forgetGames(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'POST') {
    return apiError('method_not_allowed', `${request.method} is not allowed here.`, 405);
  }
  const identity = await identityOf(request, env, url);
  if (identity === null) {
    return apiError('unauthenticated', 'Not signed in.', 401);
  }

  const body = await readJson(request);
  if (body === null) return apiError('bad_message', 'Expected a JSON body.', 400);
  const asked = asArray(body.joinCodes);
  if (asked === null) {
    return apiError('bad_message', '`joinCodes` must be an array.', 400);
  }
  if (asked.length > MAX_GAMES_PER_ACCOUNT) {
    return apiError(
      'too_many_games',
      `At most ${MAX_GAMES_PER_ACCOUNT} games can be forgotten at once.`,
      413,
    );
  }

  const joinCodes: string[] = [];
  for (const candidate of asked) {
    // Normalised first, so a code read off a screen and typed back — with an O
    // for a 0 — addresses the row it was meant to. `asJoinCode` is the shape
    // check behind it; a code that is not a code is simply not in the index.
    const code = normaliseJoinCode(typeof candidate === 'string' ? candidate : '');
    const usable = asJoinCode(code);
    if (usable !== null) joinCodes.push(usable);
  }

  const result = await userFor(env, identity.sub).forgetGames(joinCodes);
  return json(result);
}

/**
 * Synchronise this account's saved fields (stage 2.3.3.2).
 *
 * **One endpoint, not a REST resource per field**, and the reason is the phone
 * this runs on: outdoors, on one bar, against a 100k/day request budget. A push
 * of what changed, a list of what was deleted, and the account's whole list
 * coming back is one request for the commonest case — nothing changed — and one
 * request for the worst.
 *
 * The client is untrusted here in the ordinary way, and in one particular way
 * worth naming: `lineage_key` is computed by the server from the field's own
 * provenance, never taken from the body, because a chosen lineage key would let
 * a field pose as a newer version of somebody else's and be offered as an
 * update to it.
 *
 * A field that fails validation is **dropped rather than failing the batch**.
 * One corrupt row on a phone must not be able to stop every other field from
 * ever reaching the account; the ids come back in `rejected` so the client can
 * say so rather than retry in silence.
 */
async function syncFields(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'POST') {
    return apiError('method_not_allowed', `${request.method} is not allowed here.`, 405);
  }

  const identity = await identityOf(request, env, url);
  if (identity === null) {
    // The phone treats this as "local only" rather than as a failure: fields
    // live on it whether or not anyone is signed in (decision 0013).
    return apiError('unauthenticated', 'Not signed in.', 401);
  }

  const body = await readJson(request);
  if (body === null) return apiError('bad_message', 'Expected a JSON body.', 400);

  const pushed = asArray(body.push);
  const removed = asArray(body.remove);
  if (pushed === null || removed === null) {
    return apiError('bad_message', '`push` and `remove` must be arrays.', 400);
  }
  if (pushed.length > MAX_FIELDS_PER_ACCOUNT || removed.length > MAX_FIELDS_PER_ACCOUNT) {
    return apiError(
      'too_many_fields',
      `A sync carries at most ${MAX_FIELDS_PER_ACCOUNT} fields.`,
      413,
    );
  }

  const push: FieldSpec[] = [];
  const rejected: string[] = [];
  for (const candidate of pushed) {
    const spec = asFieldSpec(candidate);
    if (spec !== null) {
      push.push(spec);
      continue;
    }
    // Best effort at naming it. An id we cannot read is one the client cannot
    // act on either, so an empty entry would be noise.
    const id = asId((candidate as { id?: unknown } | null)?.id);
    if (id !== null) rejected.push(id);
  }

  const remove: string[] = [];
  for (const candidate of removed) {
    const id = asId(candidate);
    if (id !== null) remove.push(id);
  }

  const result = await userFor(env, identity.sub).syncFields(identity.sub, push, remove);
  return json({ fields: result.fields, rejected: [...rejected, ...result.rejected] });
}

/**
 * Create a game and return its join code.
 *
 * The code *is* the Durable Object's address (decision 0007), so creation is
 * "generate a code, ask that object to initialise itself, and if it is already
 * taken try another".
 */
async function createGame(request: Request, env: Env, url: URL): Promise<Response> {
  const body = await readJson(request);
  if (body === null) return apiError('bad_message', 'Expected a JSON body.', 400);

  const identity = await identityOf(request, env, url);
  const { seat: playerId, account } = seatFor(identity, body.playerId);
  if (playerId === null) {
    return apiError('bad_message', 'A playerId is required.', 400);
  }

  // The field travels with the game as an immutable snapshot, so a
  // re-calibration on another phone cannot reshape a game in progress — and so a
  // joiner who has never calibrated anything can play immediately.
  let field;
  try {
    field = snapshotField(body.field as Parameters<typeof snapshotField>[0]);
  } catch {
    return apiError('bad_field', 'That field is not usable. Re-calibrate and try again.', 400);
  }

  const creatorColor: Color = body.color === 'b' ? 'b' : 'w';
  const initialMs = asPositiveInt(body.initialMs) ?? DEFAULT_TIME_CONTROL.initialMs;
  const incrementMs = asNonNegativeInt(body.incrementMs) ?? DEFAULT_TIME_CONTROL.incrementMs;

  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
    const joinCode = generateJoinCode();
    const created = await env.GAME.getByName(joinCode).create({
      joinCode,
      creatorPlayerId: playerId,
      creatorAccount: account,
      creatorColor,
      field,
      initialMs,
      incrementMs,
      // Clamped with the same shared rule the create screen uses, because the
      // client is untrusted: without this a hand-rolled request could ask for a
      // reach the UI would never offer (O-02).
      reach: reachFromSquares(body.reachSquares),
      reachBonusSquares: {
        w: clampHandicapSquares(body.whiteReachBonusSquares),
        b: clampHandicapSquares(body.blackReachBonusSquares),
      },
    });
    if (created) {
      return json({ joinCode, color: creatorColor }, { status: 201 });
    }
  }

  return apiError(
    'code_exhausted',
    'Could not allocate a game code. Try again.',
    503,
  );
}

async function joinGame(
  request: Request,
  env: Env,
  url: URL,
  stub: DurableObjectStub<GameDO>,
): Promise<Response> {
  const body = await readJson(request);
  const identity = await identityOf(request, env, url);
  const { seat: playerId, account } = seatFor(identity, body?.playerId);
  if (playerId === null) {
    return apiError('bad_message', 'A playerId is required.', 400);
  }

  const result = await stub.join(playerId, account);
  if (result.ok) {
    // The field travels back with the seat (stage 6.3). A phone that arrived by
    // scanning a QR has calibrated nothing, and this is the only thing it is
    // missing — the game snapshotted the creator's field when it was created.
    return json({ color: result.color, field: result.field });
  }
  if (result.reason === 'full') {
    return apiError('game_full', 'That game already has two players.', 409);
  }
  return apiError('not_found', 'No game with that code. It may have expired.', 404);
}

/**
 * Upgrade to a WebSocket.
 *
 * Forwarded to the object with `fetch` rather than an RPC call, because a
 * `Response` carrying a `webSocket` cannot be serialised across the RPC boundary.
 *
 * The player id arrives as a query parameter rather than a body, because the
 * WebSocket handshake is a GET. It is only consulted when there is no session:
 * since stage 3.5.2 an authenticated request is seated by its `sub` and the
 * parameter is ignored, so the trusted-client hole is open only for a phone that
 * has not signed in — which stage 2.5.1 closes for good.
 */
async function openSocket(
  request: Request,
  env: Env,
  url: URL,
  stub: DurableObjectStub<GameDO>,
): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return apiError('bad_message', 'This endpoint requires a WebSocket upgrade.', 426);
  }
  // The same rule as the seat itself: a session names the player, and the query
  // parameter is only what a signed-out phone has instead. They have to agree,
  // or a game joined as an account would be reconnected to as a phone and the
  // object would answer "not a player in this game".
  const identity = await identityOf(request, env, url);
  const { seat: playerId } = seatFor(identity, url.searchParams.get('playerId'));
  if (playerId === null) {
    return apiError('bad_message', 'A playerId is required.', 400);
  }
  // The path is rewritten to `/ws` so the object's `fetch` has one shape to
  // handle, independent of the public route.
  return stub.fetch(`https://game/ws?playerId=${encodeURIComponent(playerId)}`, request);
}

// ---------------------------------------------------------------------------
// Input handling. Everything from a client is untrusted.
// ---------------------------------------------------------------------------

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asArray(value: unknown): unknown[] | null {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : null;
}

function asPlayerId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Long enough to be a UUID or a Google `sub`, short enough not to be a payload.
  if (trimmed.length < 8 || trimmed.length > 128) return null;
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : null;
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function asNonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}
