#!/usr/bin/env node
/**
 * Walk out a board with four taps, on ground that is **not square** (stage
 * 1.2.5, decision 0028).
 *
 *     npm run build:client
 *     npx wrangler dev --port 8799 --local &
 *     npm install --no-save playwright
 *     node scripts/check-calibrate.mjs
 *
 * The seventh browser driver, and the only one that walks the calibration flow
 * through the UI rather than seeding a field into IndexedDB. That distinction is
 * the point: every other driver starts from a field that was *constructed*, so
 * none of them would notice if the four taps were recorded in the wrong order,
 * assigned to the wrong corner, or quietly collapsed back to a square.
 *
 * The board here is **12 m along the files and 6 m along the ranks** — a shape
 * the two-tap model could not express at all, and which it would have forced
 * into a square of some averaged size, putting every square metres from where
 * the players walked it. So the real assertion is the last one: stand on the
 * centre of a named square, and the game agrees it is that square.
 */

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);
const ORIGIN = args.get('origin') ?? 'http://127.0.0.1:8799';
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-cal-'));

function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  for (const dir of readdirSync(root)) {
    if (!dir.startsWith('chromium-')) continue;
    const exe = join(root, dir, 'chrome-linux', 'chrome');
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

const A1 = { lat: 51.4779, lng: -0.0015 }; // `SIM_START` in client/main.ts
/** Deliberately unequal. This is the whole experiment. */
const FILE_M = 12;
const RANK_M = 6;
const M_PER_DEG_LAT = (6378137 * Math.PI) / 180;

/** Ground position of a square centre, in the board we are about to walk out. */
function squareLatLng(file, rank) {
  return {
    lat: A1.lat + (rank * RANK_M) / M_PER_DEG_LAT,
    lng: A1.lng + (file * FILE_M) / (M_PER_DEG_LAT * Math.cos((A1.lat * Math.PI) / 180)),
  };
}

const CORNERS = [
  ['a1', 0, 0],
  ['h1', 7, 0],
  ['h8', 7, 7],
  ['a8', 0, 7],
];

let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ executablePath: findChromium() });
const consoleErrors = [];

try {
  console.log(`screenshots -> ${OUT}`);
  const context = await browser.newContext({ viewport: { width: 480, height: 900 } });
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto(`${ORIGIN}/?sim=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-calibrate]', { timeout: 15_000 });
  await page.click('[data-calibrate]');
  await page.waitForSelector('[data-tap]', { timeout: 15_000 });

  console.log('\n1. Walk the perimeter, tapping each corner');
  for (const [name, file, rank] of CORNERS) {
    // The step counter has to name the corner we think we are on, or the taps
    // are being recorded against the wrong corners and nothing downstream can
    // tell. This is the check that the *order* is right.
    const brief = (await page.textContent('[data-brief]')) ?? '';
    check(
      brief.includes(name),
      `is asking for ${name}`,
      brief.slice(0, 54).replace(/\s+/g, ' '),
    );

    await page.evaluate((pos) => globalThis.satchess.me.moveTo(pos), squareLatLng(file, rank));
    // The simulator emits at 1 Hz, and a tap carries whatever fix it has — so a
    // tap dispatched too early records the *previous* corner's position, which
    // is exactly the bug this driver exists to catch and would look like a
    // maths error rather than a timing one.
    await page.waitForTimeout(1400);
    await page.waitForFunction(
      () => document.querySelector('[data-tap]')?.hasAttribute('disabled') === false,
      undefined,
      { timeout: 15_000 },
    );
    await page.click('[data-tap]');
    await page.waitForTimeout(150);
  }

  console.log('\n2. The review screen describes the board that was walked');
  await page.waitForSelector('[data-save]', { timeout: 15_000 });
  const squares = (await page.textContent('[data-square]')) ?? '';
  check(
    /12\.\d\s*m along the files/.test(squares) && /6\.\d\s*m along the ranks/.test(squares),
    'reports both axes rather than one averaged number',
    squares.trim(),
  );
  const residual = (await page.textContent('[data-residual]')) ?? '';
  check(
    Number.parseFloat(residual.replace(/[^\d.]/g, '')) < 2,
    'and the four corners agree with each other',
    residual.trim(),
  );
  await page.screenshot({ path: `${OUT}/1-review.png`, fullPage: true });

  console.log('\n3. Save it, and open it');
  await page.fill('[data-name]', 'The long pitch');
  await page.click('[data-save]');
  await page.waitForSelector('[data-field]', { timeout: 15_000 });
  await page.click('[data-field]');
  await page.waitForSelector('[data-open]', { timeout: 15_000 });
  const listed = (await page.textContent('[data-square]')) ?? '';
  check(/12/.test(listed) && /6/.test(listed), 'the saved field keeps both spacings', listed.trim());
  await page.click('[data-open]');
  await page.waitForSelector('[data-board]', { timeout: 15_000 });
  await page.screenshot({ path: `${OUT}/2-board.png`, fullPage: true });

  console.log('\n4. Standing on a square, the game agrees which one it is');
  // The claim the whole change rests on. With the old square-board model these
  // would be wrong by tens of metres at the far corner.
  for (const [name, file, rank] of [
    ['a1', 0, 0],
    ['e1', 4, 0],
    ['a5', 0, 4],
    ['e5', 4, 4],
    ['h8', 7, 7],
  ]) {
    await page.evaluate((pos) => globalThis.satchess.me.moveTo(pos), squareLatLng(file, rank));
    const seen = await page
      .waitForFunction(
        (sq) => document.querySelector('[data-square]')?.textContent === sq,
        name,
        { timeout: 8_000 },
      )
      .then(() => name)
      .catch(async () => (await page.textContent('[data-square]')) ?? '(nothing)');
    check(seen === name, `standing on ${name} reads as ${name}`, seen);
  }
  await page.screenshot({ path: `${OUT}/3-on-h8.png`, fullPage: true });

  console.log('\n5. Nothing threw');
  check(consoleErrors.length === 0, 'no console errors', consoleErrors.join(' | ').slice(0, 200));
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? 'all good' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
