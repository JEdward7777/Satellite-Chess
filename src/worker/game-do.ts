/**
 * GameDO — one Durable Object per game, authoritative for everything.
 *
 * **Stub.** Phase 3 fills this in; it exists now only because
 * `wrangler.jsonc` names the class in a binding and in the
 * `new_sqlite_classes` migration, so a deploy fails without it. That deploy is
 * what unblocks walking a real field (stage 1.9.3), which is the thing the whole
 * project has been built toward — so the stub earns its keep.
 *
 * When phase 3 arrives, the constraints that matter are in `harness/AGENTS.md`
 * section 6 and decision 0006. In short:
 *
 * - `ctx.acceptWebSocket()`, never `server.accept()`. Hibernation is mandatory.
 * - Therefore **no timing state in memory** and no `setTimeout`. The clock is
 *   pure functions over stored timestamps (`src/shared/clock.ts`).
 * - Per-socket state goes in `ws.serializeAttachment()`, because nothing
 *   survives in memory across a hibernation.
 * - A DO has exactly one alarm, and this design needs three deadlines
 *   (flag-fall, disconnect grace, garbage collection). They are multiplexed
 *   through a `timers` table; feature code must not call `setAlarm` directly.
 * - Keepalive goes through `ctx.setWebSocketAutoResponse()`, which answers a
 *   ping without waking the object and without being billed.
 */

import { DurableObject } from 'cloudflare:workers';

import { notImplemented } from './http.js';

export class GameDO extends DurableObject<Env> {
  /**
   * Deliberately creates no tables and accepts no sockets yet.
   *
   * A Durable Object whose storage is entirely empty ceases to exist, which is
   * exactly what we want from a stub: deploying this does not litter the account
   * with objects that have to be garbage-collected later.
   */
  override async fetch(): Promise<Response> {
    return notImplemented('GameDO', 'harness/plan/03-transport.md');
  }
}
