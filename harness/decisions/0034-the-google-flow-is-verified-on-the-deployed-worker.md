# 0034 — Local development signs in through the seam; Google is verified on the deployed Worker

- **Date:** 2026-09-16
- **Status:** accepted
- **Stage:** 2.1

## Decision

`GOOGLE_CLIENT_SECRET` has **no local home**, and that is the answer rather than a
gap. It is a Worker secret on the deployed origin and nowhere else.

So the two ways in are split by environment, permanently:

- **Locally** — `wrangler dev`, the eleven browser drivers, every test — sign-in
  is the dev seam (decision 0029). No Google, no secret, no network.
- **The real Google round-trip** is exercised against the **deployed** Worker, by
  hand, in a browser.

`test/worker/auth.test.ts` therefore asserts everything around the code exchange —
the redirect's parameters, the state and PKCE checks, the session that comes out —
and never the exchange itself.

## Why

The open question recorded on 2026-09-06 was where to put the client secret for
local development. Every answer is worse than not having one:

- **`.dev.vars`** is the obvious one and is already excluded for an unrelated
  reason that still applies: `wrangler types` reads it, so an untracked local file
  would decide whether the committed `worker-env.d.ts` is up to date, and
  `npm run check` would pass or fail depending on who ran it.
- **A `--var` on the `dev` script**, the way `DEV_AUTH_SECRET` is passed, would
  commit a real credential to the repository. That is fine for the seam's secret,
  which guards a loopback server full of invented accounts and is documented as
  publishable; it is not fine for a credential that authenticates this
  application to Google.
- **An environment variable the developer exports** works, and is what a second
  machine would need anyway, but it makes "does sign-in work here?" depend on
  invisible shell state — and the symptom of getting it wrong is a 503 that reads
  exactly like a misconfigured deployment.

The deciding point is that **nothing local needs it**. The seam was built first
precisely so the whole project could be developed and driven without Google
(decision 0029), and it does that job. The only thing a local secret would buy is
rehearsing the one code path that a container cannot rehearse convincingly
anyway: a browser session at accounts.google.com, a consent screen, and a
redirect back. That has to happen on a real origin in a real browser whatever we
do, because Google will not redirect to a loopback URL it has not been told about
and will not issue a code to a browser that never visited it.

Registering `http://localhost:8787/auth/google/callback` remains useful and stays
registered — it costs nothing and means a developer who *does* export the secret
can complete a real sign-in locally without a console trip.

## Rejected

**Mock Google in the test suite.** A fake token endpoint would let the exchange be
tested end to end. Rejected because the assertions would all be against our own
fixture: the failure modes that actually occur here — `redirect_uri_mismatch`, a
consent screen that returns a different `sub` than expected, a client in the wrong
publishing status — are precisely the ones a mock cannot have. It would convert
"untested" into "tested against a lie", which is worse, because the second one
stops anybody looking.

**Ship a `.dev.vars.example` and ask developers to fill it in.** Same
`wrangler types` problem, plus it invites someone to paste the production secret
into a file whose whole safety rests on a `.gitignore` line.

## Revisit if

- A second person works on this, or CI needs to exercise sign-in. Then the answer
  is a **separate OAuth client for development** with its own secret, not sharing
  the production one — which is the thing decision 0030 already says to do when
  the app leaves Testing status.
- The exchange itself ever grows real logic — token refresh, multiple providers,
  anything with branches. Today it is one `fetch` and a claim check, and the claim
  check *is* unit-tested; if that stops being true the balance shifts towards
  injecting the token endpoint so it can be driven.
