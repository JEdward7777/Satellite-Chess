/**
 * Secrets, which `wrangler types` cannot see.
 *
 * `worker-env.d.ts` is generated from `wrangler.jsonc` and only knows about
 * bindings declared there. Secrets are set out of band:
 *
 *     npx wrangler secret put SURVEY_SECRET
 *
 * Declaring them as an explicit intersection rather than by merging into the
 * global `Env` keeps them visible at the point of use: a reader of `survey.ts`
 * can see that it depends on something the config file does not mention.
 *
 * Every secret is optional, because a deployment that has not set it is a real
 * and supported state — the code must check rather than assume.
 */

export type EnvWithSecrets = Env & {
  /**
   * Enables the field-survey API (`/api/survey/...`).
   *
   * Absent — the default — means those routes 404 as though they did not exist.
   * See `src/worker/survey.ts` and stage 1.9.3.
   */
  SURVEY_SECRET?: string;

  /**
   * Enables the dev identity seam (`POST /api/dev/session`), which mints a
   * session for any named `sub` without a Google round-trip.
   *
   * **Never set this on a deployed Worker.** It is half of an authentication
   * bypass; the other half is a loopback hostname, which is why setting it by
   * mistake is not on its own a breach. See `src/worker/identity.ts` and stage
   * 2.5.2 for both locks and why there are two.
   *
   * Unlike `SURVEY_SECRET` this is never a deployed secret, so it is not set
   * with `wrangler secret put`. `npm run dev` passes it on the command line
   * (`wrangler dev --var DEV_AUTH_SECRET:…`) — deliberately not via `.dev.vars`,
   * which `wrangler types` also reads, and which would therefore let an
   * untracked local file decide whether the committed `worker-env.d.ts` is up
   * to date.
   */
  DEV_AUTH_SECRET?: string;
};
