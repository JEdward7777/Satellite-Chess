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
};
