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

- `6.2` done: Join
  - Verified end to end by `scripts/check-join.mjs`, the fourth browser driver.
    Every phone in it except the creator's has never calibrated a field, which is
    the only way to tell a working join from one that merely renders.
  - And by `scripts/check-scan.mjs`, the sixth, for the camera. It injects a
    `BarcodeDetector` because Chromium on Linux ships none — without one the
    driver could only ever exercise the *unsupported* path. What is faked is the
    platform API; the camera is Chrome's own fake device, so the tracks are real
    and "was the camera released?" is a real question with a real answer.
  - `6.2.1` done: `/j/CODE` deep link resolving straight into the game
    - `main.ts` reads `parseAppRoute(location.pathname)` at boot. The same parser
      the Worker used to decide the path was worth serving, so the two cannot
      disagree about what it means — which is the failure O-06 was about.
    - The game goes *into* the address bar on a typed join too, so a reload
      resumes rather than starting over, and comes back out on leaving. The join
      is idempotent at the far end, which is what makes that safe.
  - `6.2.2` done: Typed-code entry with lookalike folding already in `joincode.ts`
    - The folding was already right; what was missing is that the home screen
      only offered the box when a field was saved. Both ways in now go through
      one `joinGame` in `client/join.ts`, so they cannot fail differently.
  - `6.2.3` done: `BarcodeDetector` scanning where available
    `client/scan.ts` is the model half — capability detection, the advice, and
    `codeFromScan`, which is a *filter* before it is a parser because a camera
    swept across a park sees posters, bus stops and other people's wifi.
    `views/scan.ts` is the viewfinder. A scanned code goes through the same
    `showJoin` a deep link and a typed code take: three ways in, one join.
    - The camera is the part that bites. A `MediaStreamTrack` that is not
      stopped leaves the lens live after the screen has gone, so `stop()` runs
      on every path out — including the nasty one, where the screen is torn down
      while `getUserMedia` is still waiting on a permission prompt and the
      stream arrives with nothing left to display it. Tested directly, and
      `scripts/check-scan.mjs` asserts `readyState === 'ended'` on real tracks
      from Chrome's fake device.
  - `6.2.4` done: Safari has no `BarcodeDetector` — **decision 0026**: ship no
    decoder, advise the Camera app.
    The bundle cost was measured rather than guessed, and it decided this. The
    whole app is 74 KB minified / 27 KB gzipped; jsQR — the *pure-JS* option,
    no WASM needed — is 128 KB / 45 KB, nearly twice the application, and the
    service worker would precache it onto a phone in a field on one bar. iOS
    Camera already reads a QR and offers the link, which lands on `/j/CODE` and
    joins in fewer taps than our scanner would need. So the fallback is a line
    of advice naming the Camera app and the typed code, and `scanAdvice` is
    per-platform for the same reason `describeGpsError` is.
    - This is *not* a Cloudflare cost, which was the first thing worried about:
      a decoder is a static asset, run on the phone, outside the Worker bundle
      and outside the 100k requests/day. It fails the player's byte budget, not
      the free tier's. Written into the decision so the question is settled once.
  - `6.2.5` done: Clear failures — code not found, game already full, expired
    - Four outcomes, each with the server's own words and a hint that is ours,
      because the server does not know how the phone arrived: not found, full,
      no signal, and something else. Expired is deliberately folded into not
      found — an unclaimed game deletes itself, so neither end can tell it from
      a typo, and the advice is the same.
    - Offline is the one that could not be reached any other way and matters
      most: `check-deeplink.mjs` opens a deep link with the network cut and
      asserts the screen blames the network rather than the code.

- `6.4` todo: Share a field, reusing the same share sheet and QR encoder as the game
  invite. A field link is self-contained, so it also works printed on a sign at the
  park — worth making the QR sparse enough to scan off paper in sunlight.

- `6.3` done: The joiner needs the field
  - The creator's field snapshot travels with the game, so a joiner who has never
    calibrated anything can play immediately. Worth an explicit stage because it
    is the difference between a pickup game and a setup chore.
  - The snapshot now comes back from `POST /api/game/:code` with the seat. It was
    already stored — `create` snapshots the creator's field — and already in every
    `GameSnapshot` over the socket; the joining phone simply had no way to ask for
    it before the socket opened, and no board to draw until it did.
  - Two things had to change alongside it, and both were the real blockers:
    - The home screen used to send a phone with no fields straight into
      calibration, so the one phone that needed to type a code could not reach a
      screen with a box on it. It now shows home either way, with New game hidden
      (that does need a field) and Join always offered.
    - Calibration therefore needed a way out that is not "save a field", since it
      is now something you can walk into by choice rather than the first run.
  - Not done, deliberately: the joiner does **not** get the field saved to their
    phone. Handing someone a copy of ground they have never stood on, as a side
    effect of accepting an invitation, is `6.4`'s question rather than this one's.
