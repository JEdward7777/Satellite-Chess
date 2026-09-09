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
  - `2.1.5` active: Redirect URI registration for local dev and for the deployed
    origin, both documented in the README
    Console side done 2026-09-06: OAuth client created, `GOOGLE_CLIENT_SECRET`
    set as a Worker secret, `GOOGLE_CLIENT_ID` in `wrangler.jsonc`. Paths are
    fixed by decision 0030 — `/auth/google/login` and `/auth/google/callback`,
    `redirect_uri` derived from the request origin. Registered callback URLs:
    the deployed origin and `http://localhost:8787`. Remaining: the README
    paragraph, and confirming the console list once `auth.ts` exists.

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
  - `2.3.1` done: Addressed by `getByName(sub)`; `fields` and `game_index` tables
    `src/worker/user-schema.ts` holds the DDL — `account`, `fields`, `game_index`
    — applied idempotently on every construction, as `schema.ts` does for GameDO.
    `src/worker/user-do.ts` is the object: `touch(sub)` creates the account on
    first contact, because `getByName` addressing means there is no sign-up step
    to hang creation on. `userFor` in `index.ts` is the one place a stub is
    derived, and `GET /api/me` touches it, so a launch costs one request rather
    than two. The `fields` schema carries the decision 0017 asymmetry and the
    comment explaining why it is not a missing index.
  - `2.3.2` done: A Durable Object rather than KV, because saving a field and
    immediately loading it on the same phone is exactly the read-after-write
    pattern KV's propagation window breaks
    The reasoning is written down at the head of `user-do.ts` rather than left as
    a shape to be "simplified" into a KV namespace later, and it names what KV is
    still right for (sessions in 2.2.1, "fields near me" in 2.3.6 — neither is
    read immediately after being written by the same person). Asserted rather
    than merely asserted-in-prose: `test/worker/user-do.test.ts` reads a write
    back inside the real runtime, which is the test that would flake on KV.
  - `2.3.3` done: Saved fields — save, list, rename, re-calibrate with a version
    bump. Written on calibration confirm with no extra prompt (decision 0013's
    surviving rule: never leave a hard-won field living only in memory).
    Split on 2026-08-04: the behaviour is built and the store underneath it is
    not. Phase 1 and phase 6 needed fields on a phone long before an account
    existed to hang them on, so the whole feature was written against local
    storage. What is left is a migration, not a feature.
    Closed 2026-09-07 by `2.3.3.2`.
    - `2.3.3.1` done: The behaviour, against local storage
      `client/fields.ts` is the store (save, list, rename, re-calibrate with a
      version bump, delete); `client/views/field.ts` is the screen that reaches
      all four, and `views/calibrate.ts` writes on confirm with no extra prompt.
      Covered by `test/fields.test.ts` and driven for real through the UI by
      `scripts/check-field.mjs`.
    - `2.3.3.2` done: The same behaviour against the UserDO, so a field follows
      the account to a second phone
      This is where `2.3.7.4`'s copies land too — one migration, not two. Local
      storage does not stop being the offline cache when this lands; decision
      0013's rule is that a field never lives *only* in memory, and a phone in a
      field with no signal still has to open the board it calibrated.
      Done 2026-09-07, as **decision 0032**. `POST /api/fields/sync` is the whole
      API — one round trip pushes what changed, names what was deleted, and
      returns the account's list — and `client/field-sync.ts` wraps the local
      store so every screen that saves a field syncs it without knowing that
      synchronisation exists. The load-bearing part is the **journal**: a phone
      may delete a field locally only when the account has acknowledged holding
      it, which is the one thing that stops a delete on one phone being undone
      by the other. `src/worker/user-fields.ts` validates and maps the rows —
      `lineage_key` is always the server's own answer, never the client's, or a
      field could pose as a copy of somebody else's.
      Verified: `test/field-sync.test.ts` (the merge, including a delete on the
      other phone, an edit made in flight, and a lost journal),
      `test/user-fields.test.ts` (the row codec and untrusted input),
      `test/worker/fields-sync.test.ts` (the endpoint in the real runtime,
      including two accounts not seeing each other's ground), and by hand
      against `wrangler dev`. **`scripts/check-fields.mjs` is written but has
      never been run** — playwright is not installed in the container.
  - `2.3.4` done: Game index, for a cross-device resumable game list
    Until this existed, **a paused game was reachable only by its join code**,
    which matters more since decision 0025 — a game may sit suspended for a month
    and the code was the only handle on it.
    Done 2026-09-08, as **decision 0033**: the index is written by `GameDO` over
    the `USER` binding at every state change, and by nothing else. No endpoint
    lets a client write a row, which is what makes these rows worth building
    `2.3.5`'s permanent record on. `GET /api/games` lists them without waking a
    single game — the columns are denormalised for exactly that — and
    `POST /api/games/forget` is the only way one goes away.
    **It needed `3.5.2` to be true rather than merely listed**: a seat matched on
    a phone's UUID makes this a list you can read and not enter, because the
    second phone is a third player. The seat key is now the `sub` whenever the
    request carried a session.
    Verified by `test/worker/games.test.ts` (19 tests in `workerd`: the push, the
    two-phone seat, one account's games invisible to another, gc removing a row,
    and every refusal), `test/game-index.test.ts` and `test/game-list.test.ts` in
    node, and by hand against a real `wrangler dev` — two cookies for one `sub`,
    a third account seeing nothing, and the client's own transport bundled and
    run in node against that server.
    - `2.3.4.1` done: The index lists suspended games, showing who stopped each
      one and how long is left before the other player may claim (decision 0025).
      `claimStateFor` in `src/shared/game-index.ts` is the shared rule, and it is
      the same one `GameDO.suspensionFor` uses, so the countdown on the home
      screen and the countdown inside the game cannot disagree. The list says it
      from **both** sides: the player who paused is told their opponent's month is
      running, which their own `claimableInMs` is zero for and which is the thing
      they most need telling.
    - `2.3.4.2` done: Clearing out old games is an **offer, never a timer**
      (decision 0025). `mountTidy` is reached from a button home shows only once
      six or more games are removable, nothing is ticked to begin with, and
      `forgetIsRefused` — shared, so the client never offers what the server would
      refuse — allows only `finished` and `waiting`. A suspended game is never
      removable however long it has sat: the row is the only handle on a game that
      can still be claimed or resigned, and those are its exits.
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
  - `2.3.7` done: Share a field as a self-contained link (decision 0016)
    **Built by `6.4` and marked here on 2026-08-04, three sessions late.** Phase 6
    needed a field to travel with an invitation, which is this stage entire, so it
    was written there and the statuses were never brought back. Audited against
    the source; the evidence is named per stage. This is the second time — see the
    same note at the head of `05-clock.md` — and it is why `STATE.md` now says to
    grep for a phase's identifiers before recommending it.
    - `2.3.7.1` done: Compact encoder/decoder — `a1` at full precision, `h8` as a
      decimetre offset, name appended. Round-trip tests, including the extremes
      of the coordinate range and a name with non-ASCII characters.
      `src/shared/fieldlink.ts`, covered by `test/fieldlink.test.ts`. Decision
      0028 added format 2 for four corners; format 1 is still written whenever the
      board is square, so a square field's link did not grow.
    - `2.3.7.2` done: `/f/<blob>` route resolving with no server lookup
      `parseAppRoute` in `src/shared/routes.ts`, the one table both the Worker and
      the client read (O-06). Decoding is arithmetic — nothing is fetched — which
      is what makes a field link work on a phone with no signal.
    - `2.3.7.3` done: "Add this field?" confirmation showing derived square size
      and board size, so a bad link is visible before it is accepted
      `mountFieldOffer` in `client/views/field.ts`, showing square size, board
      size and bearing from `checkCalibration`, plus its errors and warnings.
      Always asked — decision 0027 makes this the asymmetric half, because a link
      is a message and a seat in a game is an act.
    - `2.3.7.4` done: Write as a copy into the recipient's UserDO, carrying
      provenance — original field id and version only, never the sharer's identity
      (decision 0017)
      `FieldLineage` and `fieldKey()` in `shared/fieldlink.ts`; the copy is
      written by `client/fields.ts`. Provenance is the origin key and version and
      nothing else, per 0017. Written to local storage first and to the UserDO
      after, since `2.3.3.2` — the store it writes through syncs, so a copy taken
      from a link or from a joined game reaches the account with no further code.
      The shape of what is stored did not change when it moved, as predicted.
    - `2.3.7.5` done: Offer "this is a newer version of a field you have" when the
      provenance id matches something already saved
      The `update` / `have` / `new` split in `client/fields.ts`, rendered by
      `mountFieldOffer`. The key is *inherited, never re-derived*, so A → B → C
      still matches A; re-deriving it at each hop stops the matching after one
      forward and is the obvious wrong simplification.

- `2.4` todo: KV namespace creation, secret setup, and documenting both
- `2.5` todo: Auth gate on the client
  - `2.5.1` todo: Unauthenticated launch goes to a sign-in screen and nowhere else
  - `2.5.2` done: A local-dev and simulator test seam, so the game stays testable
    without a live Google round-trip on every run. Dev-only, never reachable in a
    deployed build — this is a test seam, not a product fallback.
    Built first rather than last (decision 0029), which is what makes `2.3`
    reachable while `2.1` waits on the operator. `src/worker/identity.ts` holds
    the identity boundary — `identityOf`, which every authenticated route asks and
    which `2.1` extends rather than replaces — plus the seam itself and both of
    its locks. `GET /api/me` is the observable surface. 34 tests across
    `test/identity-token.test.ts` (the token, in node) and
    `test/worker/identity.test.ts` (the routes and the locks, in workerd), and
    exercised end to end against a real `wrangler dev`.
    - `2.5.2.1` done: The identity boundary, so `2.1` slots in beside the seam
      rather than replacing it
      `identityOf(request, env, url)` returns `{ sub, via }` or null. Null is a
      normal state, not an error — whether that becomes a 401 or a sign-in screen
      is the caller's business.
    - `2.5.2.2` done: Two independent locks — a set `DEV_AUTH_SECRET` *and* a
      loopback hostname — because a single lock made of "nobody sets this" is a
      lock made of everybody remembering
      The hostname check guards **reading** a token as well as minting one; a
      token minted locally must not survive a deployed build that happens to
      share the secret. That case has its own test, because it is the one a
      naive implementation misses.
    - `2.5.2.3` done: Switched on by `npm run dev`, and documented, because the
      mechanism is not guessable
      A shell environment variable does not reach a Worker, and the symptom is a
      404 — exactly what the seam looks like when switched off on purpose. The
      obvious fix, `.dev.vars`, is worse than it looks: `wrangler types` reads it
      too, so a gitignored per-developer file ends up deciding whether the
      committed `worker-env.d.ts` is up to date, and `npm run check` starts
      passing or failing according to who ran it. So the variable is passed on
      the `wrangler dev` command line instead (`--var`), where `wrangler types`
      cannot see it and `wrangler deploy` cannot carry it.
  - `2.5.3` todo: Honest failure messages when sign-in cannot complete, naming the
    likely cause (no signal, Safari handoff from a home-screen PWA)
