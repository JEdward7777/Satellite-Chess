/**
 * The Worker: an API router in front of the static PWA shell.
 *
 * Currently minimal on purpose. `wrangler.jsonc` points `main` here, so until
 * this file exists no deploy succeeds — and a deploy is what unblocks walking a
 * real field (stage 1.9.3), which is the assumption the whole project rests on.
 * Phase 3 grows the `/api` branch into the real thing rather than replacing it.
 *
 * Anything that is not `/api/...` falls through to the assets binding. Note that
 * the shell currently uses *relative* asset paths, so only `/` works — see O-06
 * before adding deep-link routes such as `/j/CODE` or `/f/<blob>`.
 */

import { GameDO } from './game-do.js';
import { UserDO } from './user-do.js';
import { json, notImplemented } from './http.js';

// Wrangler needs the Durable Object classes exported from the entry point.
export { GameDO, UserDO };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return health();
    }

    // The whole `/api` namespace belongs to the router, so a request for an
    // endpoint that does not exist yet must never fall through to the assets
    // binding and come back as the HTML shell with a 200.
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      // Every real endpoint arrives in phase 2 or 3. Answering 501 with the plan
      // file named is more useful than a 404, which would read as a routing bug
      // rather than as unwritten work.
      return notImplemented(
        `${request.method} ${url.pathname}`,
        'harness/plan/03-transport.md',
      );
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

/**
 * Enough to confirm from a phone, standing outside, that the thing deployed at
 * all — which is the entire question at stage 1.9.1. Deliberately touches no
 * Durable Object, so it stays a pure liveness check.
 */
function health(): Response {
  return json({
    ok: true,
    service: 'satellite-chess',
    phase: 'field calibration; game server not built yet',
    now: Date.now(),
  });
}
