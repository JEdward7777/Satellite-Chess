# 0026 — Ship no QR decoder; the phone's own camera app is the iOS fallback

- **Date:** 2026-08-03
- **Status:** accepted
- **Stage:** 6.2.3, 6.2.4
- **Builds on:** [0015](0015-invite-by-share-sheet.md),
  [0024](0024-own-qr-encoder-byte-mode.md)

## Decision

**Scan with `BarcodeDetector` where the browser has it, and ship nothing at all
where it does not.**

1. Android Chrome gets a real in-app scanner. The API is free — the platform
   decodes the frame — so it costs bytes we were going to spend anyway.
2. Safari has no `BarcodeDetector`, and **on iOS every browser is WebKit
   underneath**, so there is no iPhone browser that can do this and no "try
   another browser" to offer.
3. On those phones the home screen shows **advice instead of a button**: point the
   *Camera app* at the QR, or type the six characters. Both work today.
4. We bundle no decoder — not jsQR, not a WASM one. The gap stays open on purpose.
5. The typed code is on the scan screen too, not just on home, so a camera that
   will not focus does not send anyone back a screen to find the other way in.

## Why

**The measurement, first, because it is decisive.** The whole application is
**74 KB minified, 27 KB gzipped**. jsQR — the *pure-JavaScript* option, no WASM
involved — is **128 KB minified, 45 KB gzipped**: nearly **twice the size of the
entire game**. A WASM decoder (zxing) is larger again. This is not a rounding
error to be waved through; it is the single largest thing we would ever have
shipped, and it would be shipped for one platform's fallback path.

**And the service worker precaches the shell**, so that weight is not paid lazily
by someone who taps Scan. It is paid at install time, by a phone in a park on one
bar — the exact phone, and the exact moment, that decision 0015 is organised
around protecting. Charging the worst connection in the game for a feature it
cannot use is precisely backwards.

**The iPhone already does this, and does it better than we would.** iOS Camera
detects a QR and offers the link. That link is `/j/CODE`, which stage 6.0 made
load the shell cold, online or offline. So the iPhone flow is: raise phone, tap
banner, arrive in the game — fewer taps than our in-app scanner would need, with
no permission prompt of ours and no decoder. We would be spending 45 KB to lose a
race against the operating system.

**The typed code already covers the case completely.** Stages 6.2.2 and 6.2.5 are
done and a scanned link and a typed code are one path in `client/join.ts`. So a
decoder buys **speed, never capability** — no game becomes playable that was not
playable before. That is the test a 45 KB dependency has to pass, and it fails it.

**It is not a Cloudflare cost, and that is worth writing down** because it was the
first worry raised and it is a reasonable one on a project whose central
constraint is a free-tier budget. A decoder would be a static asset: fetched by
the phone, run on the phone, never in the Worker bundle, never spending Worker
CPU, and not part of the 100,000 requests/day — which
`harness/reference/budget.md` measures in *inbound WebSocket messages to a
Durable Object*. Even assuming every asset fetch were billed, it is one fetch per
phone per release and then the service worker answers from cache; 100,000 fresh
installs a day is not a problem this project has. **The cost is entirely the
player's bytes and battery.** That is the budget it fails, and it fails it badly
enough that the free tier never enters the argument.

## Rejected

**Bundling jsQR.** 45 KB gzipped, 1.7× the app, precached, to save an iPhone user
from either typing six characters or using the camera app in their hand.

**A WASM decoder (zxing-wasm et al).** Everything wrong with jsQR, larger, plus a
second artifact type in the service worker's precache list and a fourth thing that
can fail to load offline.

**Lazy-loading a decoder only when Scan is tapped.** Tempting, and it fixes the
precache objection but not the others: it still cannot be used offline, it still
loses to the Camera app on taps, and it puts a several-hundred-millisecond
download between a raised phone and a viewfinder — in a park, on one bar, at the
one moment the player is standing still holding a phone up at their friend.

**Telling iPhone users to use a different browser.** Impossible, not merely rude:
iOS requires WebKit, so Chrome on iPhone has no `BarcodeDetector` either.

**Saying nothing on unsupported browsers.** The cheapest option and the worst. A
missing button is indistinguishable from a broken one, and someone hunting for a
scanner that will never appear is worse off than someone told in one sentence to
use their camera app.

## Revisit if

- **Safari ships `BarcodeDetector`.** Then this is over: the capability check
  already routes to the real scanner and the advice simply stops rendering.
- The app grows enough that 45 KB stops being twice its size — though the
  precache and offline arguments survive that, so the bar is "it also became
  something a player cannot do without".
- Playtesting shows people genuinely stuck on iOS: not slower, *stuck*. The
  advice line names both alternatives, so the evidence to watch for is someone
  who read it and still could not join.
