#!/usr/bin/env node
/**
 * Drive sharing a field, and keeping one (stage 6.4, decisions 0016 and 0027).
 *
 *     npm run build:client
 *     npx wrangler dev --port 8799 --local &
 *     npm install --no-save playwright jsqr      # deliberately not dependencies
 *     node scripts/check-field.mjs
 *
 * The seventh browser driver. It is the only one where **both ends of a share
 * are real**: the symbol is decoded out of a screenshot of the sender's screen,
 * and the URL that comes back out of jsQR is the one the receiver's browser is
 * then pointed at. Nothing in between is constructed by the test, which is the
 * only way to catch the class of bug `check-invite.mjs` was written for — a QR
 * that is mathematically perfect and physically unreadable.
 *
 * Every phone here except the sender's has **never calibrated a field**, and
 * that is the experiment. A shared field either arrives or it does not, and a
 * unit test cannot tell the difference between the two.
 *
 * ## What it checks
 *
 * 1. Tapping a field opens a screen that can share, rename, re-calibrate and
 *    delete it — decision 0016 promises a recipient owns their copy outright,
 *    and until this screen existed none of those four was reachable.
 * 2. The rendered QR decodes, and decodes to `<origin>/f/<blob>`.
 * 3. Opening that on a phone with nothing saved offers the field by name, with
 *    its real geometry, and adds it on request.
 * 4. Opening the *same* link again says so instead of adding a second copy.
 * 5. A newer calibration of the same field arrives as an update, in place.
 * 6. A joiner keeps the field they played on, without being asked, and joining
 *    twice does not leave two of them (decision 0027).
 * 7. Deleting one removes it — a field that arrives with no way to be rid of it
 *    is not a gift.
 * 8. A mangled link says it is a mangled link.
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
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-field-'));

/** See `drive-game.mjs`: the bundled browser revision is rarely the one on disk. */
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
const M_PER_DEG_LAT = (6378137 * Math.PI) / 180; // as in shared/geo.ts

/** `fromLocal` from geo.ts, so the driver lands where the app thinks it landed. */
function offset(metresEast, metresNorth) {
  return {
    lat: A1.lat + metresNorth / M_PER_DEG_LAT,
    lng: A1.lng + metresEast / (M_PER_DEG_LAT * Math.cos((A1.lat * Math.PI) / 180)),
  };
}

/**
 * The sender's field, and the same field after they re-calibrated it.
 *
 * The same `id`, because that is what the lineage key is derived from — the
 * update path turns on the two links being recognisably the same ground. The
 * corners move enough to change the square size by a metre, so "did the update
 * land?" is a number on screen rather than a matter of opinion.
 */
const FIELD = {
  id: 'sender-field',
  name: 'The common',
  a1: A1,
  h8: offset(7 * 8, 7 * 8),
  version: 1,
  createdAt: 0,
  updatedAt: 10,
};
const RECALIBRATED = { ...FIELD, h8: offset(7 * 9, 7 * 9), version: 2, updatedAt: 20 };

let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ executablePath: findChromium() });
const consoleErrors = [];

/** A phone. `fields` is empty for everyone but the sender. */
async function newPhone(name, { fields = [] } = {}) {
  const context = await browser.newContext({
    viewport: { width: 480, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`[${name}] ${m.text()}`));
  page.on('pageerror', (e) => consoleErrors.push(`[${name}] ${e}`));
  await page.addInitScript(
    ({ seeded, playerId }) => {
      localStorage.setItem('satchess.player_id', playerId);
      window.__shared = [];
      window.__installShare = () => {
        navigator.share = (data) => {
          window.__shared.push(data);
          return Promise.resolve();
        };
      };
      if (seeded.length === 0) return;
      const req = indexedDB.open('satellite-chess', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('fields')) {
          db.createObjectStore('fields', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => {
        const store = req.result.transaction('fields', 'readwrite').objectStore('fields');
        for (const f of seeded) store.put(f);
      };
    },
    { seeded: fields, playerId: `sim-field-${name}` },
  );
  return { name, context, page };
}

/** Home, then the first field on it. */
async function openField(page) {
  await page.goto(`${ORIGIN}/?sim=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-field]', { timeout: 15_000 });
  await page.click('[data-field]');
  await page.waitForSelector('[data-field-name]', { timeout: 15_000 });
}

/** The link the sender's screen is actually showing, read out of the pixels. */
async function readLink(phone) {
  const shot = await phone.page.locator('[data-qr]').screenshot();
  return decode(phone.context, shot);
}

try {
  console.log(`screenshots -> ${OUT}`);

  const sender = await newPhone('sender', { fields: [FIELD] });
  const receiver = await newPhone('receiver');
  const player = await newPhone('player');

  console.log('\n1. A field of your own is a thing you can do something with');
  await openField(sender.page);
  check(
    (await sender.page.textContent('[data-field-name]'))?.trim() === 'The common',
    'names the field',
  );
  const squares = await sender.page.textContent('[data-square]');
  check(squares?.startsWith('8.0 m'), 'says how big its squares are', squares ?? '');
  for (const control of ['[data-share]', '[data-rename]', '[data-recalibrate]', '[data-delete]']) {
    check(await sender.page.isVisible(control), `offers ${control}`);
  }
  check(await sender.page.isVisible('[data-open]'), 'and still opens the board in one tap');
  await sender.page.screenshot({ path: `${OUT}/1-field.png`, fullPage: true });

  console.log('\n2. Reading the field off the screen');
  const box = await sender.page.locator('[data-qr] svg').boundingBox();
  check(box !== null && box.width > 120, 'draws a QR big enough to scan', `${box?.width}px wide`);
  await sender.page.locator('[data-qr]').screenshot({ path: `${OUT}/2-qr.png` });
  const link = await readLink(sender);
  check(link !== null, 'the rendered QR decodes at all');
  check(link?.startsWith(`${ORIGIN}/f/`), 'and it is a field link', link ?? '(no decode)');
  // The whole field is in the path. Nothing at the far end knows it exists,
  // which is why it works on a sign and on a phone with no signal.
  console.log(`   ${link}`);

  await sender.page.click('[data-copy]');
  await sender.page.waitForFunction(
    () => document.querySelector('[data-share-note]')?.textContent?.includes('copied'),
    { timeout: 5_000 },
  );
  const clipboard = await sender.page.evaluate(() => navigator.clipboard.readText());
  check(clipboard === link, 'copy-link copies the same link the QR encodes');

  await sender.page.evaluate(() => window.__installShare());
  await sender.page.click('[data-share]');
  await sender.page.waitForFunction(() => window.__shared.length > 0, { timeout: 5_000 });
  const shared = (await sender.page.evaluate(() => window.__shared))[0];
  check(shared.url === link, 'the share sheet gets the link');
  check(
    shared.text.includes('The common'),
    'and names the place, since the link itself cannot be read',
    shared.text,
  );

  console.log('\n3. Following it on a phone that has calibrated nothing');
  await receiver.page.goto(`${link}?sim=1`, { waitUntil: 'domcontentloaded' });
  await receiver.page.waitForSelector('[data-field-offer]', { timeout: 20_000 });
  check(
    (await receiver.page.getAttribute('[data-field-offer]', 'data-field-offer')) === 'new',
    'offers it as a field they do not have',
  );
  check((await receiver.page.textContent('[data-name]'))?.trim() === 'The common', 'by name');
  const theirSquares = await receiver.page.textContent('[data-square]');
  check(theirSquares?.startsWith('8.0 m'), 'with the sender\'s geometry', theirSquares ?? '');
  await receiver.page.screenshot({ path: `${OUT}/3-offer.png`, fullPage: true });

  await receiver.page.click('[data-accept]');
  await receiver.page.waitForSelector('[data-field-name]', { timeout: 15_000 });
  check(
    (await receiver.page.getAttribute('[data-origin]', 'data-origin')) === 'link',
    'accepting lands on the copy, marked as shared with them',
  );
  check(
    new URL(receiver.page.url()).pathname === '/',
    'and the blob comes out of the address bar, so a reload is not a re-offer',
    receiver.page.url(),
  );
  await receiver.page.click('[data-back]');
  await receiver.page.waitForSelector('[data-fields]', { timeout: 15_000 });
  check((await receiver.page.locator('[data-field]').count()) === 1, 'the field list has it');
  check(
    (await receiver.page.textContent('[data-field]'))?.includes('shared with you'),
    'labelled as ground they have never walked',
  );
  // New game needs a field, and now there is one — which is the point of the
  // whole exercise rather than a detail of the list.
  check(await receiver.page.isVisible('[data-new]'), 'and they can now start a game on it');
  await receiver.page.screenshot({ path: `${OUT}/4-received.png`, fullPage: true });

  console.log('\n4. Following the same link again');
  await receiver.page.goto(`${link}?sim=1`, { waitUntil: 'domcontentloaded' });
  await receiver.page.waitForSelector('[data-field-offer]', { timeout: 20_000 });
  check(
    (await receiver.page.getAttribute('[data-field-offer]', 'data-field-offer')) === 'have',
    'says they already have it rather than adding a second copy',
  );
  check(
    !(await receiver.page.isVisible('[data-accept]')),
    'with nothing to accept, since there is nothing to do',
  );
  await receiver.page.click('[data-decline]');
  await receiver.page.waitForSelector('[data-fields]', { timeout: 15_000 });
  check((await receiver.page.locator('[data-field]').count()) === 1, 'still one field');

  console.log('\n5. The sender re-calibrates and shares again');
  const sender2 = await newPhone('sender-again', { fields: [RECALIBRATED] });
  await openField(sender2.page);
  const link2 = await readLink(sender2);
  check(link2 !== null && link2 !== link, 'the new calibration makes a different link');

  await receiver.page.goto(`${link2}?sim=1`, { waitUntil: 'domcontentloaded' });
  await receiver.page.waitForSelector('[data-field-offer]', { timeout: 20_000 });
  check(
    (await receiver.page.getAttribute('[data-field-offer]', 'data-field-offer')) === 'update',
    'arrives as a newer version of the field they have',
  );
  await receiver.page.screenshot({ path: `${OUT}/5-update.png`, fullPage: true });
  await receiver.page.click('[data-accept]');
  await receiver.page.waitForSelector('[data-field-name]', { timeout: 15_000 });
  const updated = await receiver.page.textContent('[data-square]');
  check(updated?.startsWith('9.0 m'), 'and replaces the corners in place', updated ?? '');
  await receiver.page.click('[data-back]');
  await receiver.page.waitForSelector('[data-fields]', { timeout: 15_000 });
  check(
    (await receiver.page.locator('[data-field]').count()) === 1,
    'without leaving the old one beside it',
  );

  console.log('\n6. A joiner keeps the field they played on (decision 0027)');
  await sender.page.goto(`${ORIGIN}/?sim=1`, { waitUntil: 'domcontentloaded' });
  await sender.page.waitForSelector('[data-new]', { timeout: 15_000 });
  await sender.page.click('[data-new]');
  await sender.page.waitForSelector('[data-create]', { timeout: 15_000 });
  await sender.page.click('[data-create]');
  await sender.page.waitForSelector('[data-join-code]', { timeout: 15_000 });
  const code = await sender.page.getAttribute('[data-join-code]', 'data-join-code');
  console.log(`   join code ${code}`);

  await player.page.goto(`${ORIGIN}/j/${code}?sim=1`, { waitUntil: 'domcontentloaded' });
  await player.page.waitForSelector('[data-board]', { timeout: 20_000 });
  await player.page.click('[data-leave]');
  await player.page.waitForSelector('[data-fields]', { timeout: 15_000 });
  check(
    (await player.page.locator('[data-field]').count()) === 1,
    'a phone that had nothing now has the ground it played on',
  );
  check(
    (await player.page.textContent('[data-field]'))?.includes('from a game'),
    'marked as kept from a game rather than walked out',
  );
  await player.page.screenshot({ path: `${OUT}/6-kept.png`, fullPage: true });

  // The case that would be noticed in practice: a weekly fixture on the same
  // common, leaving a list of identical entries nobody can tell apart.
  await sender.page.click('[data-leave]');
  await sender.page.waitForSelector('[data-new]', { timeout: 15_000 });
  await sender.page.click('[data-new]');
  await sender.page.waitForSelector('[data-create]', { timeout: 15_000 });
  await sender.page.click('[data-create]');
  await sender.page.waitForSelector('[data-join-code]', { timeout: 15_000 });
  const second = await sender.page.getAttribute('[data-join-code]', 'data-join-code');
  await player.page.goto(`${ORIGIN}/j/${second}?sim=1`, { waitUntil: 'domcontentloaded' });
  await player.page.waitForSelector('[data-board]', { timeout: 20_000 });
  await player.page.click('[data-leave]');
  await player.page.waitForSelector('[data-fields]', { timeout: 15_000 });
  check(
    (await player.page.locator('[data-field]').count()) === 1,
    'and a second game on the same field does not leave a second field',
  );

  console.log('\n7. Getting rid of one');
  await player.page.click('[data-field]');
  await player.page.waitForSelector('[data-delete]', { timeout: 15_000 });
  // Two taps rather than a `confirm()`: the dialog is suppressed outright in
  // some embeddings, and a delete that silently does nothing is worse.
  await player.page.click('[data-delete]');
  check(
    (await player.page.textContent('[data-delete]'))?.includes('Really'),
    'the first tap asks rather than deletes',
  );
  await player.page.click('[data-delete]');
  // Not `[data-fields]`: an empty `<ul>` has no height, so Playwright calls it
  // hidden and waits for something that is already there.
  await player.page.waitForSelector('[data-calibrate]', { timeout: 15_000 });
  check(
    (await player.page.locator('[data-field]').count()) === 0,
    'the second tap deletes it',
  );
  check(
    await player.page.isVisible('[data-no-fields]'),
    'and the phone is back where it started',
  );

  console.log('\n8. A link that got cut in half');
  // Twenty characters of blob: still a legal base64url path, so the Worker
  // serves the shell for it and the client is the one that has to explain. A
  // blob short enough to be missing its geometry rather than merely its name —
  // truncating the name alone would decode into a perfectly good field.
  const cut = link.slice(0, link.indexOf('/f/') + 3 + 20);
  await receiver.page.goto(`${cut}?sim=1`, { waitUntil: 'domcontentloaded' });
  await receiver.page.waitForSelector('[data-reason]', { timeout: 20_000 });
  check(
    (await receiver.page.getAttribute('[data-reason]', 'data-reason')) === 'bad_field',
    'says the link is not a field, rather than showing an empty screen',
  );
  check(
    (await receiver.page.textContent('[data-hint]'))?.includes('pasted into a chat'),
    'and names the commonest way that happens',
  );
  await receiver.page.click('[data-home]');
  await receiver.page.waitForSelector('[data-fields]', { timeout: 15_000 });
  check(new URL(receiver.page.url()).pathname === '/', 'and leads somewhere useful');

  console.log('');
  // Chromium logs every non-2xx fetch as a console error; this run provokes none
  // deliberately, so anything here is the app's own.
  const unexpected = consoleErrors.filter((e) => !/Failed to load resource/.test(e));
  check(unexpected.length === 0, 'no console errors', unexpected.join(' | '));
} finally {
  await browser.close();
}

/** Decode a PNG screenshot with jsQR, via the browser's own image decoder. */
async function decode(context, png) {
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
