/**
 * The one sign-in every browser driver now needs (stage 2.5.1).
 *
 * Sign-in is mandatory (decision 0014), so a browser context that has not
 * signed in reaches the gate and nothing else. Every driver that drives the
 * *app* therefore has to establish a session before its first `goto`, or it will
 * sit waiting for a selector that is never going to render — and the failure
 * reads as a broken home screen rather than as a missing session, which is the
 * confusing way round.
 *
 * ## Why the request API and not the button
 *
 * The gate offers a test-account button, but only one account, and several of
 * these drivers are two phones belonging to two different people. Minting
 * through `context.request` names the account, and it shares the page's cookie
 * jar — which is the only way a driver can establish a session without a Google
 * round trip that no script can complete (decision 0034).
 *
 * `check-fields.mjs` and `check-games.mjs` had their own copies of this before
 * the gate existed, because they were the only drivers that needed an identity.
 * Now that every driver does, it lives here once.
 */

/** The secret `npm run dev` passes. Publishable: see `secrets.ts`. */
export const DEV_SECRET = 'local-dev-secret';

/**
 * Give this browser context a session, as `sub`.
 *
 * Call once per context, before the first navigation. Exits the process on
 * failure rather than returning, because every subsequent assertion in every
 * caller would otherwise fail against the gate and bury the real cause.
 */
export async function signIn(context, sub, origin, label = sub) {
  const response = await context.request.post(`${origin}/api/dev/session`, {
    headers: { 'x-dev-auth-secret': DEV_SECRET },
    data: { sub },
  });
  if (!response.ok()) {
    console.error(
      `${label}: could not mint a dev session (${response.status()}). ` +
        'Is wrangler dev running with DEV_AUTH_SECRET set? ' +
        'The seam is loopback-only, so the origin must be 127.0.0.1 or localhost.',
    );
    process.exit(2);
  }
}
