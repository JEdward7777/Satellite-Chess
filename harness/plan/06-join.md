# Phase 5 — Join: QR and typed code

- `6` todo: Join flow

- `6.1` todo: Create and share
  - `6.1.1` todo: Create screen — pick field, time control, colour, handicap
  - `6.1.2` todo: Show the six-character code large and grouped (`ABC 123`), and
    always show it alongside the QR. It is the smaller code path and it works
    when a camera permission prompt goes sideways.
  - `6.1.3` todo: QR encoding `https://<host>/j/CODE`, self-contained, no CDN
  - `6.1.4` todo: Share the invite through the OS share sheet (Web Share API),
    falling back to `mailto:` and copy-link where it is unavailable. One generic
    share path covers email, messaging apps and AirDrop without integrating any of
    them — see decision 0015. Inviting ahead of time also means your opponent
    signs in at home on wifi rather than on one bar in a field, which is the main
    thing that makes mandatory accounts (decision 0014) comfortable.

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
