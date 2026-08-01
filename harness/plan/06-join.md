# Phase 6 — Join: QR and typed code

- `6` active: Join flow

- `6.0` done: Serve the app shell from any path (closes O-06)
  - Everything else in this phase points a camera at a URL that is not `/`. Until
    the shell loads from `/j/CODE`, a QR encoder only produces links that fail —
    so this comes first, before `6.1.3`.
  - `6.0.1` done: Absolute asset paths in `index.html`, the manifest, and the
    service worker registration. `register('sw.js')` resolves against the
    *document*, so from `/j/CODE` it asks for `/j/sw.js` and registration fails
    silently — there is no offline shell at all after a scan.
  - `6.0.2` done: A shared table of client-side routes (`src/shared/routes.ts`),
    so the worker's "which paths get the shell" and the client's "what does this
    path mean" cannot drift apart.
  - `6.0.3` done: The worker answers an app route with the shell, and still 404s
    an unknown path rather than returning HTML with a 200.
  - `6.0.4` done: The service worker's precache list and its cache-first matching
    agree with the new paths, guarded by a test that reads both files.
  - `6.0.5` done: Re-verify in a browser: a cold deep link loads, and a deep link
    opened offline still starts the app.

- `6.1` done: Create and share
  - Verified end to end by `scripts/check-invite.mjs`, which drives the flow in
    Chromium and **decodes the QR out of a screenshot** — the only way to tell a
    correct matrix from a scannable one. It found the reach bug below.
  - `6.1.1` done: Create screen — pick field, time control, colour, handicap
    - Handicap is asked as "me" or "my opponent" rather than by colour, because
      the creator may not have picked one yet and that is what people say out
      loud. `MAX_HANDICAP_M` bounds the control at 4 m; that is a bound, not the
      fix for O-02.
    - The screen also exposed a real bug: the client computed reach with **no
      handicap at all**, so a handicapped player's circle was smaller than the
      one the server judges by. Fixed in `game.ts` (`myReachBonusM`), which
      reads it from the snapshot — the joining phone never saw the create
      screen, and decision 0004 turns on both players seeing the same circle.
  - `6.1.2` done: Show the six-character code large and grouped (`ABC 123`), and
    always show it alongside the QR. It is the smaller code path and it works
    when a camera permission prompt goes sideways.
    - The code is the largest thing on the invite screen, above the QR rather
      than under it as a footnote.
  - `6.1.3` done: QR encoding `https://<host>/j/CODE`, self-contained, no CDN
    - `src/shared/qr.ts`, byte mode, versions 1–40, all four EC levels. Decision
      0024 records why it is ours and why byte mode. Verified by decoding 351
      cases with jsQR (`scripts/check-qr.mjs`); the unit tests hold a snapshot
      that decoder vouched for, so a regression fails offline.
  - `6.1.4` done: Share the invite through the OS share sheet (Web Share API),
    falling back to `mailto:` and copy-link where it is unavailable. One generic
    share path covers email, messaging apps and AirDrop without integrating any of
    them — see decision 0015. Inviting ahead of time also means your opponent
    signs in at home on wifi rather than on one bar in a field, which is the main
    thing that makes mandatory accounts (decision 0014) comfortable.
    - `src/client/share.ts`. `shareInvite` is deliberately not `async`: one
      `await` in front of `navigator.share` and the browser has discarded the
      user gesture, with no visible cause. A dismissed sheet is a decision, not
      a failure, and must not cascade into opening a mail client.

- `6.2` todo: Join
  - `6.2.1` todo: `/j/CODE` deep link resolving straight into the game
  - `6.2.2` todo: Typed-code entry with lookalike folding already in `joincode.ts`
  - `6.2.3` todo: `BarcodeDetector` scanning where available
  - `6.2.4` todo: Safari has no `BarcodeDetector`. Decide between a WASM fallback
    and leaning on the typed code — measure the bundle cost before committing,
    since the service worker has to cache whatever we choose.
  - `6.2.5` todo: Clear failures — code not found, game already full, expired

- `6.4` todo: Share a field, reusing the same share sheet and QR encoder as the game
  invite. A field link is self-contained, so it also works printed on a sign at the
  park — worth making the QR sparse enough to scan off paper in sunlight.

- `6.3` todo: The joiner needs the field
  - The creator's field snapshot travels with the game, so a joiner who has never
    calibrated anything can play immediately. Worth an explicit stage because it
    is the difference between a pickup game and a setup chore.
