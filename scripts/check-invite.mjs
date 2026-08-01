#!/usr/bin/env node
/**
 * Drive the create-and-share flow, and read the QR code off the screen.
 *
 *     npm run build:client
 *     npx wrangler dev --port 8799 --local &
 *     npm install --no-save playwright jsqr     # deliberately not dependencies
 *     node scripts/check-invite.mjs
 *
 * The third browser driver, alongside `drive-game.mjs` (does a game work) and
 * `check-deeplink.mjs` (does the shell load from a scanned link). This one asks
 * the question the other two cannot: **is the thing on the phone's screen a QR
 * code that goes to this game?**
 *
 * `scripts/check-qr.mjs` proves the encoder is correct in the abstract. That is
 * not the same claim. Between the encoder and a camera there is an SVG, a
 * stylesheet, a `<figure>` with a background colour, and a device pixel ratio —
 * and every one of them can produce a symbol that is mathematically perfect and
 * physically unscannable. A QR drawn transparent over this app's near-black
 * chrome is dark-on-dark. One bled to the edge of its box has no quiet zone. One
 * left antialiased has fuzzy module boundaries. All three look fine to a person
 * and fail to a scanner, and none of them is visible in a unit test.
 *
 * So: screenshot the QR as it is actually rendered, hand the pixels to jsQR, and
 * assert the URL it reads is the one this game lives at.
 *
 * ## What it checks
 *
 * 1. The create screen offers field, time control, colour and handicap (6.1.1),
 *    and the choices survive into the created game.
 * 2. The code is shown large and grouped as `ABC 123` (6.1.2).
 * 3. The rendered QR decodes, and decodes to `<origin>/j/CODE` (6.1.3).
 * 4. Copy-link puts the invite URL on the clipboard (6.1.4's last tier).
 * 5. The share sheet is offered where the platform has one, and the fallback
 *    otherwise — headless Chromium on Linux has no `navigator.share`, so this
 *    run exercises the fallback and stubs the sheet to check the other path.
 * 6. The invite is reachable again from the board, since the moment you want
 *    the QR back is when your opponent's camera has just refused to focus.
 */

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
let jsQR;
try {
  jsQR = require('jsqr').default ?? require('jsqr');
} catch {
  console.error('jsqr is not installed. Run:  npm install --no-save jsqr');
  process.exit(2);
}

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);
const ORIGIN = args.get('origin') ?? 'http://127.0.0.1:8799';
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-invite-'));

/** See `drive-game.mjs`: the bundled browser revision is usually not the one on disk. */
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

const A1 = { lat: 51.4779, lng: -0.0015 };
const M_PER_DEG_LAT = (6378137 * Math.PI) / 180;
const SQUARE_M = 8;

const field = (id, name) => ({
  id,
  name,
  a1: A1,
  h8: {
    lat: A1.lat + (7 * SQUARE_M) / M_PER_DEG_LAT,
    lng: A1.lng + (7 * SQUARE_M) / (M_PER_DEG_LAT * Math.cos((A1.lat * Math.PI) / 180)),
  },
  version: 1,
  createdAt: 0,
  // Newest first, so `The common` is the default and choosing the other one is
  // a real change rather than a no-op.
  updatedAt: id === 'common' ? 2 : 1,
});

const FIELDS = [field('common', 'The common'), field('park', 'The park')];

let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ executablePath: findChromium() });
const context = await browser.newContext({
  viewport: { width: 480, height: 900 },
  // Chromium needs the permission granted or `writeText` rejects, which would
  // make the clipboard tier look broken when it is only unasked.
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.addInitScript(
  ({ fields }) => {
    localStorage.setItem('satchess.player_id', 'sim-invite-driver');
    // Record what the share sheet was offered, and stand in for a platform that
    // has one — headless Chromium on Linux does not.
    window.__shared = [];
    window.__installShare = () => {
      navigator.share = (data) => {
        window.__shared.push(data);
        return Promise.resolve();
      };
    };
    const req = indexedDB.open('satellite-chess', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('fields')) {
        db.createObjectStore('fields', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const store = req.result.transaction('fields', 'readwrite').objectStore('fields');
      for (const f of fields) store.put(f);
    };
  },
  { fields: FIELDS },
);

try {
  console.log(`screenshots -> ${OUT}`);

  console.log('\n1. The create screen');
  await page.goto(`${ORIGIN}/?sim=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-new]', { timeout: 15_000 });
  await page.click('[data-new]');
  await page.waitForSelector('[data-create]', { timeout: 15_000 });

  check(await page.isVisible('[data-field]'), 'offers a field');
  check(await page.isVisible('[data-time]'), 'offers a time control');
  check((await page.locator('[data-colour]').count()) === 3, 'offers White, Black and random');
  check((await page.locator('[data-handicap]').count()) === 3, 'offers a handicap');
  check(
    (await page.textContent('[data-field-size]'))?.includes('m squares'),
    'says how big the chosen field is',
  );

  // The stepper only exists once somebody is being handicapped, because "+0 m
  // to nobody" is a control with nothing behind it.
  check(!(await page.isVisible('[data-stepper]')), 'hides the metres until a handicap is chosen');

  console.log('\n2. Choosing something other than the defaults');
  await page.selectOption('[data-field]', 'park');
  await page.selectOption('[data-time]', '0'); // 10 min + 10s
  await page.click('[data-colour="b"]');
  await page.click('[data-handicap="opponent"]');
  check(
    (await page.textContent('[data-handicap-note]'))?.includes('Your opponent'),
    'reads the handicap back the way it was asked',
  );
  // Switched to "me" so the effect is visible on *this* phone's reach readout in
  // step 6 — which is the only end-to-end evidence that the handicap survived
  // the trip to the Durable Object and back.
  await page.click('[data-handicap="me"]');
  await page.click('[data-metres="1"]'); // 1 m -> 2 m

  check(
    (await page.getAttribute('[data-colour="b"]', 'aria-pressed')) === 'true',
    'marks the chosen colour',
  );
  check(
    (await page.textContent('[data-colour-note]'))?.includes('a8–h8'),
    'says which end of the field Black walks to',
  );
  check((await page.textContent('[data-handicap-m]'))?.trim() === '+2 m', 'steps the metres');
  await page.screenshot({ path: `${OUT}/1-create.png`, fullPage: true });

  console.log('\n3. The invite screen');
  await page.click('[data-create]');
  await page.waitForSelector('[data-join-code]', { timeout: 15_000 });
  const code = await page.getAttribute('[data-join-code]', 'data-join-code');
  const shown = (await page.textContent('[data-code]')).trim();
  console.log(`   join code ${code}`);

  check(/^[0-9A-Z]{6}$/.test(code ?? ''), 'has a six-character code', code ?? '(none)');
  check(shown === `${code.slice(0, 3)} ${code.slice(3)}`, 'shows it grouped', shown);
  // Read the rendered size rather than the stylesheet: the point is that it is
  // the biggest thing on the screen, and a rule that does not apply says nothing.
  const codeSize = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('[data-code]')).fontSize),
  );
  check(codeSize >= 32, 'shows it large', `${codeSize}px`);
  await page.screenshot({ path: `${OUT}/2-invite.png`, fullPage: true });

  console.log('\n4. Reading the QR code off the screen');
  const box = await page.locator('[data-qr] svg').boundingBox();
  check(box !== null && box.width > 120, 'draws a QR big enough to scan', `${box?.width}px wide`);
  // Photographed with the page's own background behind it, which is the whole
  // point: a transparent symbol over dark chrome decodes as nothing.
  const shot = await page.locator('[data-qr]').screenshot({ path: `${OUT}/3-qr.png` });
  const decoded = await decode(shot);

  check(decoded !== null, 'the rendered QR decodes at all');
  if (decoded !== null) {
    check(decoded === `${ORIGIN}/j/${code}`, 'points at this game', decoded);
  }

  console.log('\n5. Sharing');
  // The mailto tier is not driven here: clicking it would hand a `mailto:` to
  // the browser, which in a headless Linux container does nothing observable.
  // `test/share.test.ts` covers the ladder itself; what this run can only check
  // here is that the two tiers reachable in a browser do what they say.
  await page.click('[data-copy]');
  await page.waitForFunction(
    () => document.querySelector('[data-share-note]')?.textContent?.includes('copied'),
    { timeout: 5_000 },
  );
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  check(clipboard === `${ORIGIN}/j/${code}`, 'copy-link copies the invite URL', clipboard);

  // Now stand in a share sheet and check the payload it is handed.
  await page.evaluate(() => window.__installShare());
  await page.click('[data-share]');
  await page.waitForFunction(() => window.__shared.length > 0, { timeout: 5_000 });
  const shared = (await page.evaluate(() => window.__shared))[0];
  check(shared.url === `${ORIGIN}/j/${code}`, 'the share sheet gets the link', shared.url);
  check(
    shared.text.includes(`${code.slice(0, 3)} ${code.slice(3)}`),
    'and the code, for targets that keep only the text',
  );
  check(shared.text.includes('The park'), 'and names the field', shared.text);

  console.log('\n6. The choices reached the server, not just the screen');
  // The field the game snapshotted is the one that was picked, read back from
  // the Durable Object rather than from the client's own memory of it.
  const peek = await (await fetch(`${ORIGIN}/api/game/${code}`)).json();
  check(peek.field?.name === 'The park', 'the game snapshotted the chosen field', peek.field?.name);

  await page.click('[data-open]');
  await page.waitForSelector('[data-board]', { timeout: 15_000 });
  // Reach is base (5 m) + reported accuracy (5 m in the simulator) + the 2 m
  // handicap. Without the bonus this reads 10.0 m, so the number *is* the test.
  await page.waitForFunction(
    () => /\d/.test(document.querySelector('[data-reach]')?.textContent ?? ''),
    { timeout: 15_000 },
  );
  const reach = await page.textContent('[data-reach]');
  check(reach?.startsWith('12.0 m'), 'the 2 m handicap survived the round trip', reach ?? '');

  check(await page.isVisible('[data-join-code]'), 'the board still shows the code');
  await page.screenshot({ path: `${OUT}/4-board.png`, fullPage: true });

  console.log('\n7. Getting back to the invite from the board');
  await page.click('[data-join-code]');
  await page.waitForSelector('[data-qr]', { timeout: 15_000 });
  check(await page.isVisible('[data-qr]'), 'tapping it brings the QR back');
  const again = await decode(await page.locator('[data-qr]').screenshot());
  check(again === `${ORIGIN}/j/${code}`, 'and it is still the same game', again ?? '(no decode)');

  console.log('');
  check(consoleErrors.length === 0, 'no console errors', consoleErrors.join(' | '));
} finally {
  await browser.close();
}

/** Decode a PNG screenshot with jsQR, via the browser's own image decoder. */
async function decode(png) {
  const helper = await context.newPage();
  await helper.setContent('<canvas id="c"></canvas>');
  const raw = await helper.evaluate(async (base64) => {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.getElementById('c');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: [...image.data], width: image.width, height: image.height };
  }, png.toString('base64'));
  await helper.close();
  const result = jsQR(new Uint8ClampedArray(raw.data), raw.width, raw.height);
  return result === null ? null : result.data;
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
