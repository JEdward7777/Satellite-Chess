# Phase 2 — Identity: accounts required, and a permanent record

**Google sign-in is required to play.** No account, no game. The point is that
every game, result and metre walked accrues to a permanent personal record rather
than evaporating with a browser profile. See decision 0014.

This sits at phase 2 — after the field work that proves the concept, before any
game state exists that could be stranded on an anonymous id. It needs a deployed
HTTPS origin for the OAuth redirect, which phase 1.9 already provides.

- `2` todo: Accounts and the permanent record

- `2.1` todo: Google OAuth in the Worker (`src/worker/auth.ts`)
  - `2.1.1` todo: Authorization Code flow with PKCE. `client_secret` in a Worker
    secret binding; the code exchange happens server-side.
  - `2.1.2` todo: Web Crypto only (`crypto.subtle`) for the PKCE challenge and
    session token signing. There is no Node crypto in a Worker.
  - `2.1.3` todo: Because the code is exchanged directly with Google over TLS, the
    returned ID token's payload may be trusted without verifying its signature,
    per Google's guidance for the server-side flow. **This stops being true the
    moment a client-supplied ID token is accepted**, which would make RS256 JWKS
    verification mandatory (cache the JWKS in KV). Say so at the call site.
  - `2.1.4` todo: Identity key is the Google `sub` claim, never the email. Email
    changes; `sub` does not. `UserDO` is addressed by `getByName(sub)`.
  - `2.1.5` todo: Redirect URI registration for local dev and for the deployed
    origin, both documented in the README

- `2.2` todo: Sessions that survive a walk to the park
  - Login-first has one sharp edge: a player who cannot reach Google cannot play.
    A long-lived session is the mitigation that keeps that from mattering, because
    sign-in then happens at home on wifi rather than in a field.
  - `2.2.1` todo: Opaque token in an HttpOnly, Secure, SameSite=Lax cookie;
    session record in KV with a long TTL
  - `2.2.2` todo: Sliding renewal, so an active player is never logged out
  - `2.2.3` todo: Pre-flight check — warn on the home screen, while there is still
    wifi, if the session is close to expiring
  - `2.2.4` todo: Cache the session identity for offline start, so the app opens
    into a playable state with no network. Only sign-*in* needs Google reachable.
  - `2.2.5` todo: Sign out, and a clear account screen

- `2.3` todo: UserDO (`src/worker/user-do.ts`)
  - `2.3.1` todo: Addressed by `getByName(sub)`; `fields` and `game_index` tables
  - `2.3.2` todo: A Durable Object rather than KV, because saving a field and
    immediately loading it on the same phone is exactly the read-after-write
    pattern KV's propagation window breaks
  - `2.3.3` todo: Saved fields — save, list, rename, re-calibrate with a version
    bump. Written on calibration confirm with no extra prompt (decision 0013's
    surviving rule: never leave a hard-won field living only in memory).
  - `2.3.4` todo: Game index, for a cross-device resumable game list
  - `2.3.5` todo: The permanent record — games played, results, total distance
    walked, biggest field, longest carry, and fields played on. This is the reason
    accounts are mandatory, so it is a first-class feature rather than a stats
    footnote.
    - Indexed player → fields, never field → players (decision 0017). The `field`
      record must gain no player reference; that asymmetry is deliberate and needs
      a comment in the schema so a future session does not "fix" it.
    - Metres walked is the headline, not games played (decision 0019). Board
      crossings — distance ÷ board diagonal — beside it as the field-independent
      measure. Games and moves are recorded but never lead and never rank.
    - `2.3.5.2` todo: Exclude games on sub-4 m squares from totals and any
      leaderboard, marking them as practice. They still appear in the player's own
      history. Threshold tracks `checkCalibration` and moves with stage 9.2.
    - `2.3.5.1` todo: Privacy statement in the app — what location data is stored,
      what an opponent can see, and what never leaves the account. Players are
      handing us their whereabouts; say so plainly.
  - `2.3.6` todo: "Fields near me", read-cached in KV — public discovery, as
    distinct from sending a field to one person (2.3.7)
  - `2.3.7` todo: Share a field as a self-contained link (decision 0016)
    - `2.3.7.1` todo: Compact encoder/decoder — `a1` at full precision, `h8` as a
      decimetre offset, name appended. Round-trip tests, including the extremes
      of the coordinate range and a name with non-ASCII characters.
    - `2.3.7.2` todo: `/f/<blob>` route resolving with no server lookup
    - `2.3.7.3` todo: "Add this field?" confirmation showing derived square size
      and board size, so a bad link is visible before it is accepted
    - `2.3.7.4` todo: Write as a copy into the recipient's UserDO, carrying
      provenance — original field id and version only, never the sharer's identity
      (decision 0017)
    - `2.3.7.5` todo: Offer "this is a newer version of a field you have" when the
      provenance id matches something already saved

- `2.4` todo: KV namespace creation, secret setup, and documenting both
- `2.5` todo: Auth gate on the client
  - `2.5.1` todo: Unauthenticated launch goes to a sign-in screen and nowhere else
  - `2.5.2` todo: A local-dev and simulator test seam, so the game stays testable
    without a live Google round-trip on every run. Dev-only, never reachable in a
    deployed build — this is a test seam, not a product fallback.
  - `2.5.3` todo: Honest failure messages when sign-in cannot complete, naming the
    likely cause (no signal, Safari handoff from a home-screen PWA)
