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
    Split on 2026-08-04: the behaviour is built and the store underneath it is
    not. Phase 1 and phase 6 needed fields on a phone long before an account
    existed to hang them on, so the whole feature was written against local
    storage. What is left is a migration, not a feature.
    - `2.3.3.1` done: The behaviour, against local storage
      `client/fields.ts` is the store (save, list, rename, re-calibrate with a
      version bump, delete); `client/views/field.ts` is the screen that reaches
      all four, and `views/calibrate.ts` writes on confirm with no extra prompt.
      Covered by `test/fields.test.ts` and driven for real through the UI by
      `scripts/check-field.mjs`.
    - `2.3.3.2` todo: The same behaviour against the UserDO, so a field follows
      the account to a second phone
      This is where `2.3.7.4`'s copies land too — one migration, not two. Local
      storage does not stop being the offline cache when this lands; decision
      0013's rule is that a field never lives *only* in memory, and a phone in a
      field with no signal still has to open the board it calibrated.
  - `2.3.4` todo: Game index, for a cross-device resumable game list
    Until this exists, **a paused game is reachable only by its join code**, which
    matters more since decision 0025 — a game may now sit suspended for a month and
    the code is the only handle on it. Say so on the pause screen if the index is
    still missing when `5.3.4` ships to real players.
    - `2.3.4.1` todo: The index must list suspended games, showing who stopped each
      one and how long is left before the other player may claim (decision 0025).
      The snapshot already carries `suspension.claimableInMs`; the index needs the
      same numbers without opening the game.
    - `2.3.4.2` todo: Clearing out old games is an **offer, never a timer**
      (decision 0025). A prompt — shown when the index has grown, not on a
      schedule — suggesting finished and long-dead games to remove, with the
      player choosing. A game the player wants to keep lasts forever. Nothing
      server-side ever deletes a played game, so this UI is the only path by which
      one goes away, and it must never be able to remove a game that is merely
      suspended and still claimable.
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
      nothing else, per 0017. **Written to local storage rather than to a UserDO,
      because there is no UserDO yet** — the store moves with `2.3.3.2` and the
      shape of what is stored does not change when it does.
    - `2.3.7.5` done: Offer "this is a newer version of a field you have" when the
      provenance id matches something already saved
      The `update` / `have` / `new` split in `client/fields.ts`, rendered by
      `mountFieldOffer`. The key is *inherited, never re-derived*, so A → B → C
      still matches A; re-deriving it at each hop stops the matching after one
      forward and is the obvious wrong simplification.

- `2.4` todo: KV namespace creation, secret setup, and documenting both
- `2.5` todo: Auth gate on the client
  - `2.5.1` todo: Unauthenticated launch goes to a sign-in screen and nowhere else
  - `2.5.2` todo: A local-dev and simulator test seam, so the game stays testable
    without a live Google round-trip on every run. Dev-only, never reachable in a
    deployed build — this is a test seam, not a product fallback.
  - `2.5.3` todo: Honest failure messages when sign-in cannot complete, naming the
    likely cause (no signal, Safari handoff from a home-screen PWA)
