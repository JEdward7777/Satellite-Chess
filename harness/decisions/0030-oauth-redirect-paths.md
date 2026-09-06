# 0030 — Fix the OAuth redirect path before the code that uses it

- **Date:** 2026-09-06
- **Status:** accepted
- **Stage:** 2.1.5

## Decision

The Google OAuth browser-redirect endpoints live at a fixed pair of paths, and
`src/worker/auth.ts` (stage `2.1`, not yet written) must use exactly these:

| Purpose | Path |
|---|---|
| Start sign-in (build PKCE challenge, redirect to Google) | `GET /auth/google/login` |
| Google redirects the browser back here with the code | `GET /auth/google/callback` |

`redirect_uri` is **derived from the incoming request's origin** —
`new URL(request.url).origin + '/auth/google/callback'` — never hard-coded, so
the same build works local and deployed.

Redirect URIs registered on the OAuth client (`Client ID`
`908007056119-hvrj0p5sa9k3rtcsbecqs7ehmf9rc82j.apps.googleusercontent.com`) as
of this date:

- `https://satellite-chess.hootowl7777-cloud.workers.dev/auth/google/callback`
- `http://localhost:8787/auth/google/callback`

`8787` is the default `wrangler dev` port, which is what `npm run dev` uses.
Running dev on another port means adding that origin's callback URL in the Google
console too — additive, ~30 seconds, no code change.

## Why

The redirect path is a contract between two places that are edited separately:
the Google Cloud console and the Worker's router. Writing it down now, before
`auth.ts` exists, means the code is written to match what is already registered
rather than the registration being revised to match whatever the code session
happened to pick. The **path** is the expensive half to change — it needs a
console round-trip and, once there are real users, re-consent in some flows.
Origins and ports are cheap because Google's redirect-URI list is additive.

`/auth/...` rather than `/api/auth/...`: everything under `/api/` in this
project is a JSON endpoint called by `fetch`. These two are full-page browser
navigations — Google redirects the user agent to the callback, it is a GET that
returns a `Set-Cookie` and a 302 to `/`. Keeping them off the `/api/` prefix
marks that difference. The Worker router must claim `/auth/` before the assets
binding, the same way it already claims `/api/`; `parseAppRoute` in
`src/shared/routes.ts` does **not** match `/auth/` and must not — it is a server
route, not a client one.

## Rejected

**`/api/auth/callback`.** Consistent with the other endpoints by prefix, but
wrong by kind — it is not an API call, and lumping it in invites a future
session to wrap it in the same JSON error middleware the real API uses, which
would break the redirect.

**Hard-code `redirect_uri` per environment, selected by a build flag.** More
moving parts than deriving it from the request origin, and a build flag is
exactly the kind of thing that is set wrong once and wastes an afternoon.

**Leave the path open until `2.1` is built.** That is what this decision exists
to avoid: it would mean a second trip into the Google console once the code
picks a path, and the operator asked specifically not to have to redo that.

## Revisit if

- A custom domain replaces `*.workers.dev` — add its callback URL to the list;
  do not remove the `workers.dev` one until the domain is proven.
- The app leaves Testing status and is verified — publishing does not change the
  redirect path, but it is the moment to prune any dev URLs that crept onto the
  production client, or better, split dev onto its own OAuth client.
- A client-supplied ID token is ever accepted (see `2.1.3`) — unrelated to the
  path, but the same file, and it changes the trust model.
