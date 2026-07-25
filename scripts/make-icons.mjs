#!/usr/bin/env node
/**
 * Draw the app icons procedurally and write them as PNGs.
 *
 *   node scripts/make-icons.mjs
 *
 * The outputs are committed, so this only needs running when the icon changes.
 *
 * It encodes PNG by hand rather than pulling in an image library or a headless
 * browser. The icon is four flat colours and a couple of circles — the whole
 * encoder is `zlib.deflateSync` plus four chunk headers, which is far less to
 * carry than a dependency that renders it. iOS needs a real PNG for
 * `apple-touch-icon` (it will not take an SVG), so shipping only a vector was
 * not an option.
 *
 * The icon is the game in miniature: a patch of board, and you standing on it
 * inside your reach circle.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = join(import.meta.dirname, '..', 'public', 'icons');

const BACKGROUND = [13, 17, 23];
const LIGHT_SQUARE = [239, 230, 207];
const DARK_SQUARE = [79, 122, 70];
const REACH = [88, 166, 255];
const DOT = [255, 255, 255];

/**
 * Board fills this fraction of the icon.
 *
 * A maskable icon may be cropped to a circle of 80% width, so nothing that
 * matters may sit beyond radius 0.4. The board's corners are the furthest point
 * out, at `fraction * sqrt(2) / 2` — which at 0.56 lands just inside.
 */
const BOARD_FRACTION = 0.56;
const SQUARES = 4;
const SAMPLES = 4;

/** Colour at a point in unit space, with 0,0 at the centre. */
function colourAt(x, y) {
  const half = BOARD_FRACTION / 2;
  if (Math.abs(x) > half || Math.abs(y) > half) return BACKGROUND;

  const file = Math.floor(((x + half) / BOARD_FRACTION) * SQUARES);
  const rank = Math.floor(((y + half) / BOARD_FRACTION) * SQUARES);
  const square = (file + rank) % 2 === 0 ? DARK_SQUARE : LIGHT_SQUARE;

  const r = Math.hypot(x, y);
  if (r < 0.045) return DOT;
  // The reach circle, drawn as a translucent wash with a solid rim.
  if (r < 0.2) return mix(square, REACH, r > 0.185 ? 0.95 : 0.3);
  return square;
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Supersampled RGBA rows, each prefixed with PNG filter byte 0. */
function render(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let at = 0;
  for (let py = 0; py < size; py++) {
    raw[at++] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) / size - 0.5;
          const y = (py + (sy + 0.5) / SAMPLES) / size - 0.5;
          const c = colourAt(x, y);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const n = SAMPLES * SAMPLES;
      raw[at++] = Math.round(r / n);
      raw[at++] = Math.round(g / n);
      raw[at++] = Math.round(b / n);
      raw[at++] = 255;
    }
  }
  return raw;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function png(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 bits per channel
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(render(size), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  // iOS ignores the manifest for the home-screen icon and uses this one.
  ['apple-touch-icon.png', 180],
]) {
  const file = join(OUT_DIR, name);
  writeFileSync(file, png(size));
  console.log(`  ${name}  ${size}x${size}`);
}
