/**
 * UserDO — one Durable Object per player, holding saved fields, the game index
 * and the permanent record.
 *
 * **Stub.** Phase 2 fills this in; like `GameDO` it exists now because
 * `wrangler.jsonc` names the class at deploy time.
 *
 * The constraints that matter when phase 2 arrives:
 *
 * - Addressed by `getByName(sub)` — the Google `sub` claim, never the email,
 *   because email changes and `sub` does not (decision 0014).
 * - A Durable Object rather than KV, because saving a field and immediately
 *   loading it on the same phone is exactly the read-after-write pattern KV's
 *   propagation window breaks.
 * - The `field` record must gain **no** player reference. Play history is
 *   indexed player → fields and never the reverse; that asymmetry is deliberate
 *   and load-bearing (decision 0017). Do not "fix" it.
 * - Metres walked is the headline figure, not games played (decision 0019).
 */

import { DurableObject } from 'cloudflare:workers';

import { notImplemented } from './http.js';

export class UserDO extends DurableObject<Env> {
  override async fetch(): Promise<Response> {
    return notImplemented('UserDO', 'harness/plan/02-identity.md');
  }
}
