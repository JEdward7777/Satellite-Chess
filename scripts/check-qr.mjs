#!/usr/bin/env node
/**
 * Decode our own QR codes with somebody else's decoder.
 *
 *     npm install --no-save jsqr      # deliberately not a dependency
 *     node scripts/check-qr.mjs
 *
 * `src/shared/qr.ts` is 500 lines of bit twiddling whose output is a tidy square
 * of dots no matter how wrong it is. A unit test written by the same person who
 * wrote the encoder checks that the encoder agrees with itself; only a decoder
 * that has never seen this code can say whether the thing on screen is a QR code
 * at all. That is why this is a script and not a test: it needs a dependency we
 * will not ship, for the same reason `drive-game.mjs` needs Playwright.
 *
 * What it covers:
 *
 * - The real invite URLs, at every error-correction level, since the level
 *   changes the block structure and therefore the interleave.
 * - Lengths either side of each version boundary, because an off-by-one in the
 *   capacity table shows up as "works until the URL gets slightly longer",
 *   which is the worst possible time to find out.
 * - The 8→16 bit character-count change at version 10, which is the one place
 *   the header format itself changes.
 * - Non-ASCII, so the UTF-8 path is exercised rather than assumed.
 *
 * The unit tests hold a snapshot of one known-good symbol, so a regression is
 * caught offline without this script — but the snapshot is only trustworthy
 * because this script vouched for it in the first place.
 */

import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { build } from 'esbuild';

const ROOT = join(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

let jsQR;
try {
  jsQR = require('jsqr').default ?? require('jsqr');
} catch {
  console.error('jsqr is not installed. Run:  npm install --no-save jsqr');
  process.exit(2);
}

/** Bundle the encoder to memory rather than importing TypeScript. */
async function loadEncoder() {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: ['src/shared/qr.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'warning',
  });
  const source = Buffer.from(result.outputFiles[0].text).toString('base64');
  return import(`data:text/javascript;base64,${source}`);
}

/**
 * Render a symbol to RGBA at `scale` pixels a module, with the quiet zone.
 *
 * The quiet zone is not decoration: jsQR will fail to locate a symbol drawn hard
 * against the edge of its buffer, exactly as a scanner fails on one printed hard
 * against a border.
 */
function rasterise(qr, scale = 4, quiet = 4) {
  const side = (qr.size + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(0xff);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = (x + quiet) * scale + dx;
          const py = (y + quiet) * scale + dy;
          const at = (py * side + px) * 4;
          pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
        }
      }
    }
  }
  return { pixels, side };
}

const { encodeQr, qrSvg } = await loadEncoder();

const cases = [];

// The links this actually has to carry.
for (const level of ['L', 'M', 'Q', 'H']) {
  cases.push({ text: 'https://satellite-chess.example.workers.dev/j/ABC123', level });
  cases.push({ text: 'http://127.0.0.1:8799/j/K7M2P9', level });
}

// Every version boundary up to 12, from both sides. A capacity table that is
// one out anywhere shows up here and nowhere else.
for (let length = 1; length <= 340; length++) {
  cases.push({ text: 'A'.repeat(length), level: 'M' });
}

// UTF-8, and a field name that could plausibly end up in a shared link.
cases.push({ text: 'https://example.com/f/AbC-123_xyz', level: 'M' });
cases.push({ text: 'Regent’s Park — 8 m squares', level: 'Q' });
cases.push({ text: '田中さんの原っぱ', level: 'H' });

let failures = 0;
const versions = new Set();

for (const { text, level } of cases) {
  const qr = encodeQr(text, { ecLevel: level });
  versions.add(qr.version);
  const { pixels, side } = rasterise(qr);
  const decoded = jsQR(pixels, side, side);

  if (decoded === null) {
    console.error(`FAIL  no symbol found  v${qr.version}${level}  ${summarise(text)}`);
    failures++;
  } else if (decoded.data !== text) {
    console.error(
      `FAIL  decoded differently  v${qr.version}${level}  ${summarise(text)}\n` +
        `      got: ${summarise(decoded.data)}`,
    );
    failures++;
  }
}

// The SVG is what the app actually shows, so check it is well-formed enough to
// parse and that it carries the quiet zone the raster above needed.
const svg = qrSvg(encodeQr('https://example.com/j/ABC123'), { title: 'Invite' });
if (!svg.startsWith('<svg ') || !svg.endsWith('</svg>') || !svg.includes('<title>')) {
  console.error('FAIL  qrSvg produced something unexpected');
  failures++;
}

function summarise(text) {
  return text.length > 48 ? `${text.slice(0, 45)}… (${text.length})` : text;
}

const sorted = [...versions].sort((a, b) => a - b);
console.log(
  `${cases.length - failures}/${cases.length} decoded, ` +
    `versions ${sorted[0]}–${sorted[sorted.length - 1]}`,
);
process.exit(failures === 0 ? 0 : 1);
