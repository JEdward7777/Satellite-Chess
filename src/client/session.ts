/**
 * Who this phone is signed in as (stage 2.5.1).
 *
 * The data half of the sign-in gate; `views/signin.ts` draws it. Split for the
 * same reason `join.ts` is split from `views/join.ts` — the interesting cases
 * here are failures, and a real server is a poor way to produce "no signal".
 *
 * ## Three states, and the third one is the important one
 *
 * Sign-in is mandatory (decision 0014), so it is tempting to write this as a
 * boolean. It cannot be one. The app is opened outdoors, on one bar, by someone
 * who signed in at home a fortnight ago, and **"the server did not answer" is
 * not the same as "you are not signed in"** — treating it as such would show a
 * sign-in screen to a player standing in a field, who then cannot complete it,
 * which is O-01 arriving by a route decision 0014 never considered.
 *
 * So only a real 401 closes the gate. A fetch that throws, a 500, a captive
 * portal returning HTML — all of those are {@link SessionState} `unknown`, and
 * the app opens. Nothing is faked by doing that: the session cookie is either in
 * the jar or it is not, every API call still carries it, and the server still
 * refuses every one of them without it (`signInRequired` in `worker/index.ts`).
 * What the phone gets is the benefit of the doubt about a question only the
 * server can answer, in the one situation where the server cannot be asked.
 *
 * The cost is that a phone which has *never* signed in also opens the app when
 * it is offline, and then cannot start a game. That is the right way round: it
 * could not have started one anyway, and calibrating a field — which needs no
 * account and no network at all (decision 0013) — still works.
 */

/** What `/api/me` said, or what we assume when it could not say anything. */
export type SessionState =
  /** A live session. `sub` is the account key; it is never shown to an opponent. */
  | { kind: 'signed_in'; sub: string; via: 'dev' | 'google' }
  /**
   * The server said 401. The gate closes.
   *
   * `devSeam` is the server reporting that its dev identity seam is reachable —
   * both of decision 0029's locks open — so the gate may offer a test-account
   * button. False on every deployed build, and the button it gates could do
   * nothing there even if it were drawn.
   */
  | { kind: 'signed_out'; devSeam: boolean }
  /** The server could not be asked. Carry on; see the note above. */
  | { kind: 'unknown' };

export interface SessionOptions {
  /** Injectable so a test need not run a server. */
  fetch?: typeof fetch;
  /** Overridable for tests; defaults to a same-origin request. */
  origin?: string;
}

/**
 * Ask the server who we are.
 *
 * This is also what brings an account into existence: `/api/me` touches the
 * UserDO, because `getByName(sub)` addressing means there is no sign-up step to
 * hang creation on (stage 2.3.1). So the launch check and the account touch are
 * one request rather than two, which matters against a 100k/day budget.
 */
export async function loadSession(options: SessionOptions = {}): Promise<SessionState> {
  const request = options.fetch ?? fetch;

  let response: Response;
  try {
    response = await request(`${options.origin ?? ''}/api/me`, {
      headers: { accept: 'application/json' },
    });
  } catch {
    // A fetch only rejects when the request never got an answer — DNS, no route,
    // aeroplane mode. This is the case the whole three-state design exists for.
    return { kind: 'unknown' };
  }

  if (response.status === 401) {
    // A 401 is our own API answering, so its body is ours to read. A body that
    // is missing or unreadable still means signed out — it is the status that
    // carries that — and simply offers no dev button.
    let devSeam = false;
    try {
      devSeam = ((await response.json()) as { devSeam?: unknown }).devSeam === true;
    } catch {
      devSeam = false;
    }
    return { kind: 'signed_out', devSeam };
  }

  if (!response.ok) return { kind: 'unknown' };

  let body: { sub?: unknown; via?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // A 200 that is not JSON is not this API — a captive portal's landing page
    // is the likely culprit, and that is a network problem, not a sign-out.
    return { kind: 'unknown' };
  }

  if (typeof body.sub !== 'string' || body.sub === '') return { kind: 'unknown' };
  return {
    kind: 'signed_in',
    sub: body.sub,
    via: body.via === 'dev' ? 'dev' : 'google',
  };
}

/**
 * Where the "Sign in with Google" button goes.
 *
 * `next` is carried so the player comes back to what they were opening rather
 * than to the home screen. The server validates it against `parseAppRoute`
 * before trusting it (`safeNext` in `worker/auth.ts`), so nothing here needs to
 * be careful on the server's behalf — but the query string is included on
 * purpose, because losing `?sim=1` would end a simulated game the moment anyone
 * signed in, and that is how every browser check in this project is run.
 *
 * A plain `href`, not a `fetch`. Sign-in is a full-page navigation to the
 * Worker; `sw.js` has a matching `/auth/` exclusion, without which the cached
 * shell would answer it and the button would silently do nothing (O-10).
 */
export function signInHref(next: string): string {
  return `/auth/google/login?next=${encodeURIComponent(next)}`;
}

/**
 * The reason a sign-in failed, if this launch is the return leg of one.
 *
 * `auth.ts` sends every failure back to `…?signin=failed&reason=<code>`, and
 * until the gate existed nothing rendered it — a failed sign-in landed silently
 * on the home screen, which reads as a button that does nothing when pressed.
 * Naming the likely *cause* in a sentence is stage 2.5.3; this is the honest
 * minimum until then.
 */
export function signInFailure(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get('signin') !== 'failed') return null;
  const reason = params.get('reason');
  // A reason we did not send is not one we will render. Bounded and charset-
  // checked because it reaches the screen, and everything in a URL is untrusted.
  return reason !== null && /^[a-z_]{1,32}$/.test(reason) ? reason : 'unknown';
}

/** The path the player should be returned to after signing in. */
export function currentDestination(location: {
  pathname: string;
  search: string;
}): string {
  return `${location.pathname}${location.search}`;
}

/**
 * Mint a session through the dev seam (stage 2.5.2, decision 0029).
 *
 * Only ever called from a button the server said to draw. It is a `fetch` rather
 * than a navigation because the seam is deliberately POST-only: a GET that
 * minted a session could be reached by a top-level navigation from any page,
 * which is precisely the "a page in another tab, a stray script" threat that
 * decision 0029 named when it rejected a loopback-only lock with no secret.
 *
 * The secret is the committed dev one. That is safe to ship — it guards a
 * loopback server full of invented accounts, and the second lock is what makes
 * it worthless anywhere else — and it is the same value `npm run dev` passes.
 */
export async function devSignIn(
  sub: string,
  secret: string,
  options: SessionOptions = {},
): Promise<boolean> {
  const request = options.fetch ?? fetch;
  try {
    const response = await request(`${options.origin ?? ''}/api/dev/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dev-auth-secret': secret },
      body: JSON.stringify({ sub }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
