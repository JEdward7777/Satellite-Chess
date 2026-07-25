/**
 * Bindings, as declared in `wrangler.jsonc`.
 *
 * Kept in its own file because both the router and the Durable Objects need it,
 * and importing it from `index.ts` would make every module depend on the router.
 */

import type { GameDO } from './game-do.js';
import type { UserDO } from './user-do.js';

export interface Env {
  /** The static PWA shell. */
  ASSETS: Fetcher;
  /** One per game, addressed by join code — see decision 0007. */
  GAME: DurableObjectNamespace<GameDO>;
  /** One per player, addressed by Google `sub` — see decision 0014. */
  USER: DurableObjectNamespace<UserDO>;
}
