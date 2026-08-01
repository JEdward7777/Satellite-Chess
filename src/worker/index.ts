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

import { snapshotField } from '../shared/field.js';
import { DEFAULT_TIME_CONTROL } from '../shared/clock.js';
import { generateJoinCode, normaliseJoinCode } from '../shared/joincode.js';
import { isAppRoute } from '../shared/routes.js';
import type { Color } from '../shared/squares.js';
import { GameDO } from './game-do.js';
import { UserDO } from './user-do.js';
import { SurveyDO } from './survey-do.js';
import { surveyRoutes } from './survey.js';
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

  if (path === '/api/game' && request.method === 'POST') {
    return createGame(request, env);
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
      return openSocket(request, stub);
    }
    if (request.method === 'GET') {
      return json(await stub.peek());
    }
    if (request.method === 'POST') {
      return joinGame(request, stub);
    }
    return apiError('method_not_allowed', `${request.method} is not allowed here.`, 405);
  }

  return apiError('not_found', 'No such endpoint.', 404);
}

/**
 * Create a game and return its join code.
 *
 * The code *is* the Durable Object's address (decision 0007), so creation is
 * "generate a code, ask that object to initialise itself, and if it is already
 * taken try another".
 */
async function createGame(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (body === null) return apiError('bad_message', 'Expected a JSON body.', 400);

  const playerId = asPlayerId(body.playerId);
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
      creatorColor,
      field,
      initialMs,
      incrementMs,
      reachBonusM: {
        w: asNonNegativeInt(body.whiteReachBonusM) ?? 0,
        b: asNonNegativeInt(body.blackReachBonusM) ?? 0,
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

async function joinGame(request: Request, stub: DurableObjectStub<GameDO>): Promise<Response> {
  const body = await readJson(request);
  const playerId = body === null ? null : asPlayerId(body.playerId);
  if (playerId === null) {
    return apiError('bad_message', 'A playerId is required.', 400);
  }

  const result = await stub.join(playerId);
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
 * WebSocket handshake is a GET. Phase 2 replaces this with the authenticated
 * session — until then it is trusted, which is fine while nothing is deployed
 * publicly and is exactly what stage 2.5 exists to close.
 */
async function openSocket(request: Request, stub: DurableObjectStub<GameDO>): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return apiError('bad_message', 'This endpoint requires a WebSocket upgrade.', 426);
  }
  const playerId = asPlayerId(new URL(request.url).searchParams.get('playerId'));
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
