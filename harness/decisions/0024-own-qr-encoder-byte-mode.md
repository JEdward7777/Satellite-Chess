# 0024 — Ship our own QR encoder, byte mode only

- **Date:** 2026-08-01
- **Status:** accepted
- **Stage:** 6.1.3

## Decision

`src/shared/qr.ts` is a complete QR encoder written in this repository: versions
1–40, all four error-correction levels, **byte mode only**. No library, no CDN,
no build-time asset.

Invites are encoded at level **M**, and rendered as an SVG with a four-module
quiet zone, an opaque white background and `shape-rendering: crispEdges`.

Correctness is established by decoding our own output with **jsQR**, an
independent decoder, in `scripts/check-qr.mjs` — 351 cases across versions 1–14
and every level. jsQR is installed with `--no-save`, like Playwright, and is not
a dependency. The unit suite holds a snapshot of one symbol that script has
vouched for, so a regression fails `npm test` offline.

## Why

**No CDN, because the phone that needs the QR is the one with no signal.** The
service worker has to be able to cache whatever draws the symbol, so it has to be
in our own bundle. A `<script src="https://cdn…">` is a QR code that works in the
café and fails on the grass — and the grass is the entire product.

**Byte mode only, because half our links are case-sensitive.** QR's alphanumeric
mode packs 11 bits per character *pair* against byte mode's 8 bits per character,
which for a typical invite is the difference between a 25×25 and a 33×33 symbol —
a real gain when scanning off paper at distance. It requires the whole payload to
be drawn from `0-9 A-Z $%*+-./: ` and a space, so the URL would have to be
uppercased. That is safe for `/j/CODE`: scheme and host are case-insensitive, and
a join code folds through `normaliseJoinCode` anyway. It is **not** safe for the
`/f/<blob>` field links of stage 6.4, whose base64url payload is case-sensitive
and would be destroyed. One mode that carries every link beats two that disagree
about which links they can carry, and 33×33 scans fine off a phone screen.

**Level M, not L.** The symbol is read off a phone held at an angle in daylight,
often through a fingerprint. Two extra versions buys recovery from about 15% of
the symbol being unreadable instead of 7%. Printed on a sign (6.4) the argument
is stronger still.

**An independent decoder, because self-agreement proves nothing.** A wrong QR
encoder produces a tidy square of dots. Unit tests written by the encoder's own
author check that it agrees with itself. This is why `check-qr.mjs` exists as a
script rather than a test, and why `check-invite.mjs` goes further and decodes a
*screenshot* of the rendered symbol: between a correct matrix and a camera there
is an SVG, a stylesheet and a background colour, and a transparent QR over dark
chrome is mathematically perfect and physically unscannable.

## Rejected

**A QR library as a dependency** (`qrcode`, `qrcode-generator`). Smaller diff,
and the encoder is a solved problem. Rejected on weight and on the offline story:
these pull in canvas and Node paths we would then have to tree-shake, for
something that is 500 lines of table-driven bit twiddling with a published
specification and an independent oracle available to check it against.

**Alphanumeric mode with an uppercased URL.** Denser, and it would work today,
because today the only link is `/j/CODE`. Rejected because it silently breaks the
moment 6.4 shares a field, and the failure would be a link that scans perfectly
and resolves to nothing.

**Mixed-mode segmentation** — an alphanumeric segment for the origin and a byte
segment for the path — which is what a serious encoder does and would recover
most of the density without the case problem. Rejected as more machinery than the
gain justifies at these sizes. This is the one to reach for if a symbol ever
needs to be sparser.

**A canvas rather than an SVG.** Rejected: SVG scales without resampling, prints
sharply for 6.4, and drops into `innerHTML` from a view that owns no drawing
surface.

## Revisit if

- A symbol needs to be scanned off paper at a distance where 33×33 is too dense —
  take mixed-mode segmentation, not a blanket uppercase.
- Something else in the app needs a QR with a payload this encoder cannot carry
  (kanji mode, structured append). Both are real QR features and neither is
  implemented here.
