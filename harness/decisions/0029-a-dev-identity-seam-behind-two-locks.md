# 0029 — A dev identity seam, behind two locks

- **Date:** 2026-09-05
- **Status:** accepted
- **Stage:** 2.5.2

## Decision

Phase 2 is built **bottom-up, with the Google round-trip last**. The first piece
is an identity *boundary* — `identityOf(request, env, url)` in
`src/worker/identity.ts`, the one function every authenticated route asks — and
behind it, for now, exactly one way of establishing an identity: a dev seam that
mints a session for any named `sub`.

`POST /api/dev/session` is available only when **both** of these hold:

1. `DEV_AUTH_SECRET` is set. Absent by default, so a deploy has to be deliberately
   sabotaged to get halfway.
2. The request arrived on a **loopback hostname** — `localhost`, `127.0.0.1`,
   `::1`. What `wrangler dev` serves, and what a deployed Worker is never reached
   by, because Cloudflare routes to a Worker by hostname.

The dev token is **signed and stateless** (`d1.<payload>.<hmac>`), which is
deliberately *not* what stage 2.2.1 specifies for the real session (opaque, with
the record in KV). The two formats coexist; `identityOf` reports which one
answered, as `via: 'dev' | 'google'`.

## Why

**Why a seam at all, and why first.** The UserDO (`2.3`) is addressed by
`getByName(sub)`, so nothing in it can be built or driven through a browser until
something supplies a `sub`. The real supplier is Google OAuth, which needs a
`client_secret`, registered redirect URIs, and a deployed HTTPS origin — none of
which exist, and the first of which cannot be obtained from the container this
project is developed in (the egress proxy 403s Cloudflare's API). Building the
seam first turns a blocked *phase* into a blocked *stage*: `2.3`, `2.3.4` and
`2.3.3.2` all become reachable now, and `2.1` is the only thing left waiting on
the operator.

**Why two locks and not one.** The survey API (stage 1.9.3) is gated on a secret
alone, and that is right for it: the worst case is an exposed debug log. The
worst case here is *authentication bypass on every account*, because the endpoint
mints a session for whatever `sub` you ask for. A single lock made of "nobody
sets this variable" is a lock made of everybody remembering — and the plan's own
words for this stage are "never reachable in a deployed build", which a
convention cannot deliver.

So the second lock is chosen specifically to be one a **mistake cannot open**.
Setting a secret on the wrong Worker is an ordinary slip; making a deployed
Worker answer to `localhost` is not something you do by accident. The locks fail
independently, and the endpoint needs both.

The same check guards **reading** a token, not just minting one. Without that, a
token minted against a local build would keep working against a deployed one that
happened to share the secret — the case a naive implementation misses, because
the mint route is the one that looks dangerous.

**Why the dev token is stateless when the real one will not be.** A seam that
needed a KV write to mint a session would drag KV into every driver run, and the
read-after-write window that made the UserDO a Durable Object in the first place
(stage 2.3.2) would surface in the test suite as flake. The seam has to be more
reliable than the thing it is testing. Signing is a dozen lines of Web Crypto and
has no propagation window.

Keeping the formats distinct also means the real session never inherits a shape
chosen for a test's convenience — the `d1.` prefix is what stops "the dev token
already works, just use that" from quietly becoming the design.

## Rejected

- **A client-side flag** (`?dev=1`, or a fake identity in `localStorage`). Nothing
  server-side would know who the player is, so `2.3` still could not be written.
  The seam has to be where the trust boundary is.
- **A secret alone, like `SURVEY_SECRET`.** Right for a debug log, not for
  something that mints accounts. See above.
- **Localhost only, with no secret.** Then anything running on the developer's own
  machine — a page in another tab, a stray script — can mint a session as anyone.
  Cheap to add the secret; no reason not to.
- **Deferring the seam until after `2.1`.** The original plan order. It makes the
  entire phase wait on a Google Cloud console and a deploy that the development
  container cannot perform, for no gain — `2.1` still has to be written and
  tested, and the seam is what makes testing it possible without a live
  round-trip on every run.

## Revisit if

- **`2.1` lands and the real session works.** The seam does not go away then — it
  is what keeps eight browser drivers from needing Google — but `identityOf` gains
  its second branch and this file should be re-read to check the `via` split is
  still honest.
- **Anything ever needs the seam somewhere that is not loopback** — a staging
  deployment, a device on the LAN testing against a laptop. That is a real need
  and the answer is *not* to loosen the hostname check. Give staging its own
  short-lived real credentials, or the second lock stops meaning anything.
- **A third gated-by-secret endpoint appears.** Two is a coincidence; three wants
  a shared `gate()` helper with the policy in one place rather than the pattern
  copied a third time.
