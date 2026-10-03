/**
 * Trying a field alone (O-49, stage 10.12, decision 0051).
 *
 * The verdict and the tap test are unit-tested in `test/preview.test.ts`.
 * What only a browser can say is that the screen shows them: the square
 * underfoot follows the dot, the verdict changes with the accuracy the phone
 * claims, a tapped square is tested against the reach the dial sets and is
 * marked on the board, distances come out in the player's units, and the
 * screen still works with the network gone.
 *
 * And the claim the whole design rests on: **the preview sends nothing.** From
 * the moment the board is up until Back is tapped, the driver counts every
 * request the browser context makes (the service worker's included) and every
 * WebSocket opened or written to, and fails on any.
 *
 *     node scripts/check-preview.mjs --base=http://127.0.0.1:8799/?sim=1 --out=/tmp/preview
 */

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

import { isRealConsoleError } from './driver-console.mjs';
import { signIn } from './driver-signin.mjs';

const args = new Map(
  process.argv.slice(2).map((a) => {
    // Split on the first `=` only, so `?sim=1` survives (O-24).
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length > 0 ? rest.join('=') : 'true'];
  }),
);
const BASE = args.get('base') ?? 'http://127.0.0.1:8799/?sim=1';
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-preview-'));

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
const SQUARE_M = 8;
const M_PER_DEG_LAT = (6378137 * Math.PI) / 180;
const FILES = 'abcdefgh';

/** A square's centre, offset by `dn` meters north. */
function squareLatLng(file, rank, dn = 0) {
  return {
    lat: A1.lat + (rank * SQUARE_M + dn) / M_PER_DEG_LAT,
    lng: A1.lng + (file * SQUARE_M) / (M_PER_DEG_LAT * Math.cos((A1.lat * Math.PI) / 180)),
  };
}

const FIELD = {
  id: 'sim-field',
  name: 'Sim Field',
  a1: A1,
  h8: squareLatLng(7, 7),
  version: 1,
  createdAt: 0,
  updatedAt: 0,
};

/** `projectionFor` from client/render.ts, replayed at 1x for white: a square's centre. */
function squareToPixel(file, rank, w, h) {
  const sizeM = 8 * SQUARE_M;
  const minU = -SQUARE_M / 2;
  const maxU = 7 * SQUARE_M + SQUARE_M / 2;
  const size = Math.min(w, h);
  const pad = size * 0.06;
  const scale = (size - 2 * pad) / sizeM;
  const offsetX = (w - sizeM * scale) / 2;
  const offsetY = (h - sizeM * scale) / 2;
  return { x: offsetX + (file * SQUARE_M - minU) * scale, y: offsetY + (maxU - rank * SQUARE_M) * scale };
}

let failures = 0;
function check(label, ok, detail) {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}
const step = (n, msg) => console.log(`\n${n}. ${msg}`);

async function openPhone(browser, locale, who) {
  const context = await browser.newContext({ viewport: { width: 480, height: 900 }, locale });
  await signIn(context, `sim-preview-${who}`, new URL(BASE).origin, who);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => isRealConsoleError(m) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(
    ({ field }) => {
      const req = indexedDB.open('satellite-chess', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('fields')) db.createObjectStore('fields', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        req.result.transaction('fields', 'readwrite').objectStore('fields').put(field);
      };
    },
    { field: FIELD },
  );
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-field]', { timeout: 15_000 });
  await page.click('[data-field]');
  await page.waitForSelector('[data-open]', { timeout: 15_000 });
  return { context, page, errors };
}

/** Counts everything the context sends while `on` is set. */
function watchTraffic(context, page) {
  const seen = { on: false, requests: [], sockets: 0, frames: 0 };
  context.on('request', (r) => {
    if (seen.on) seen.requests.push(`${r.method()} ${r.url()}`);
  });
  page.on('websocket', (ws) => {
    if (seen.on) seen.sockets += 1;
    ws.on('framesent', () => {
      if (seen.on) seen.frames += 1;
    });
  });
  return seen;
}

const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, sel);
const level = (page) => page.evaluate(() => document.querySelector('[data-verdict]')?.dataset.level ?? null);

/** Teleport, and wait for the readout to agree (the simulator emits once a second). */
async function standOn(page, file, rank, dn = 0) {
  await page.evaluate((pos) => globalThis.satchess.me.moveTo(pos), squareLatLng(file, rank, dn));
  const name = FILES[file] + String(rank + 1);
  const seen = await page
    .waitForFunction((sq) => document.querySelector('[data-square]')?.textContent === sq, name, { timeout: 10_000 })
    .then(() => name)
    .catch(() => text(page, '[data-square]'));
  return seen;
}

/** Set the claimed accuracy and wait for the verdict to land on `want`. */
async function claim(page, accuracyM, want) {
  await page.evaluate((a) => globalThis.satchess.me.setAccuracy(a), accuracyM);
  return page
    .waitForFunction((w) => document.querySelector('[data-verdict]')?.dataset.level === w, want, { timeout: 10_000 })
    .then(() => want)
    .catch(() => level(page));
}

/** A non-primary `pointerdown`/`pointerup` pair: a tap the simulator ignores. */
async function tapSquare(page, file, rank) {
  const box = await page.locator('[data-board]').boundingBox();
  const p = squareToPixel(file, rank, box.width, box.height);
  await page.evaluate(
    ({ x, y }) => {
      const canvas = document.querySelector('[data-board]');
      const rect = canvas.getBoundingClientRect();
      for (const type of ['pointerdown', 'pointerup']) {
        canvas.dispatchEvent(
          new PointerEvent(type, {
            clientX: rect.left + x,
            clientY: rect.top + y,
            bubbles: true,
            pointerId: 1,
            isPrimary: false,
          }),
        );
      }
    },
    { x: p.x, y: p.y },
  );
}

/** The tap test's answer, once it names `square` and agrees with `ok`. */
async function tested(page, square, ok) {
  await page
    .waitForFunction(
      ({ square, ok }) => {
        const el = document.querySelector('[data-test]');
        return el?.dataset.square === square && el?.dataset.ok === ok;
      },
      { square, ok },
      { timeout: 10_000 },
    )
    .catch(() => {});
  return page.evaluate(() => {
    const el = document.querySelector('[data-test]');
    return { square: el?.dataset.square ?? null, ok: el?.dataset.ok ?? null, words: el?.textContent?.trim() ?? '' };
  });
}

/** Is the large white "in reach" dot drawn at this square's centre? */
async function bigDotAt(page, file, rank) {
  const box = await page.locator('[data-board]').boundingBox();
  const p = squareToPixel(file, rank, box.width, box.height);
  return page.evaluate(
    ({ x, y }) => {
      const canvas = document.querySelector('[data-board]');
      const dpr = canvas.width / canvas.clientWidth;
      const { data } = canvas.getContext('2d').getImageData(Math.round(x * dpr) - 1, Math.round(y * dpr) - 1, 3, 3);
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 225 || data[i + 1] < 225 || data[i + 2] < 225) return false;
      }
      return true;
    },
    { x: p.x, y: p.y },
  );
}

/** A full-page screenshot without the simulator's panel, which is fixed over the page. */
async function shot(page, path) {
  await page.evaluate(() => {
    const panel = document.querySelector('.sim-panel');
    if (panel) panel.style.visibility = 'hidden';
  });
  await page.screenshot({ path, fullPage: true });
  await page.evaluate(() => {
    const panel = document.querySelector('.sim-panel');
    if (panel) panel.style.visibility = '';
  });
}

const browser = await chromium.launch({ executablePath: findChromium() });

try {
  console.log(`screenshots -> ${OUT}`);

  // ---------------------------------------------------------------- metric
  const metric = await openPhone(browser, 'en-GB', 'metric');
  const { page, context } = metric;
  const traffic = watchTraffic(context, page);

  step(1, 'The field screen offers the preview');
  check('the button says "Try it alone"', (await text(page, '[data-open]')) === 'Try it alone', await text(page, '[data-open]'));
  check('and says nothing is sent', /Nothing is\s+sent/.test((await text(page, '[data-open-note]')) ?? ''));
  await page.click('[data-open]');
  await page.waitForSelector('[data-board]', { timeout: 15_000 });
  // Let the screen settle (a sync begun on home may still be landing), then
  // count everything from here until Back.
  await page.waitForTimeout(1500);
  traffic.on = true;

  step(2, 'Walking the board, the square underfoot follows the dot');
  await page.evaluate(() => globalThis.satchess.me.setAccuracy(3));
  for (const [file, rank] of [
    [4, 1],
    [0, 0],
    [7, 7],
    [3, 4],
  ]) {
    const name = FILES[file] + String(rank + 1);
    check(`standing on ${name} reads ${name}`, (await standOn(page, file, rank)) === name);
  }
  await page.evaluate((pos) => globalThis.satchess.me.moveTo(pos), squareLatLng(-2, 3));
  await page
    .waitForFunction(() => document.querySelector('[data-square]')?.textContent === 'off the board', undefined, {
      timeout: 10_000,
    })
    .catch(() => {});
  check('off the side reads "off the board"', (await text(page, '[data-square]')) === 'off the board');

  step(3, 'The verdict follows the accuracy the phone claims');
  await standOn(page, 4, 1); // e2
  check('±3 m on 8 m squares: looks playable', (await claim(page, 3, 'good')) === 'good');
  check('reach is 3.2 m', (await text(page, '[data-reach]')) === '3.2 m', await text(page, '[data-reach]'));
  check('leeway is 7.2 m', (await text(page, '[data-leeway]')) === '7.2 m', await text(page, '[data-leeway]'));
  check('signal says ±3.0 m, to the sentence\'s decimal', /±3\.0 m/.test((await text(page, '[data-quality]')) ?? ''), await text(page, '[data-quality]'));
  await shot(page, `${OUT}/1-metric-good.png`);
  check('±6 m, inside the 7.2 m leeway: still playable', (await claim(page, 6, 'good')) === 'good');
  check('with no neighbor note on a yes', ((await text(page, '[data-verdict-notes]')) ?? '') === '');
  check('±10 m: playable, with the odd refusal', (await claim(page, 10, 'tight')) === 'tight');
  check('and warns the dot may name a neighbor', /neighbor/.test((await text(page, '[data-verdict-notes]')) ?? ''));
  check('±20 m, past twice the leeway: hard to play', (await claim(page, 20, 'poor')) === 'poor');
  await shot(page, `${OUT}/2-metric-poor.png`);
  check('±30 m: not playable', (await claim(page, 30, 'refused')) === 'refused');
  check('and reach reads "too vague"', (await text(page, '[data-reach]')) === 'too vague');
  check('and names the limit', /±25 m/.test((await text(page, '[data-verdict-why]')) ?? ''));

  step(4, 'Tap a square to test it');
  await tapSquare(page, 4, 1); // e2, standing on it, at ±30 m
  let t = await tested(page, 'e2', 'false');
  check('on a fix too vague, even my own square is refused', t.ok === 'false' && /accurate to ±30 m/.test(t.words), t);
  await claim(page, 3, 'good');
  t = await tested(page, 'e2', 'true');
  check('the same tap, re-tested on the next fix, counts', t.ok === 'true' && /You are on e2/.test(t.words), t);
  await tapSquare(page, 4, 2); // e3: 4 m from the edge, beyond 3.2 m of reach
  t = await tested(page, 'e3', 'false');
  check('e3 from the middle of e2 is refused', t.ok === 'false' && /Walk closer/.test(t.words), t);
  check('and its dot is the small "walk to it" one', !(await bigDotAt(page, 4, 2)));
  await page.click('[data-reach-step^="0"]'); // +0.05 squares
  await page.click('[data-reach-step^="0"]');
  await page.click('[data-reach-step^="0"]');
  await page.click('[data-reach-step^="0"]');
  check('the dial reads 0.6 squares', (await text(page, '[data-reach-squares]')) === '0.6 squares');
  t = await tested(page, 'e3', 'true');
  check('with 0.6 squares of reach (4.8 m), e3 counts', t.ok === 'true' && /4\.8 m reach/.test(t.words), t);
  check('and its dot is the large "in reach" one', await bigDotAt(page, 4, 2));
  check('the leeway grew with it', (await text(page, '[data-leeway]')) === '8.8 m', await text(page, '[data-leeway]'));
  await shot(page, `${OUT}/3-metric-tap-test.png`);
  for (let i = 0; i < 4; i++) await page.click('[data-reach-step^="-"]');
  check('back to 0.4 squares', (await text(page, '[data-reach-squares]')) === '0.4 squares');

  step(5, 'Both piece looks');
  await page.click('[data-look-toggle]');
  check('the switch says "On discs"', (await text(page, '[data-look-toggle]')) === 'On discs');
  await shot(page, `${OUT}/4-metric-discs.png`);
  await page.click('[data-look-toggle]');
  check('and back to "Standard"', (await text(page, '[data-look-toggle]')) === 'Standard');

  step(6, 'With the network gone, it still works');
  await context.setOffline(true);
  check('walking to g5 offline reads g5', (await standOn(page, 6, 4)) === 'g5');
  check('the verdict still answers', (await claim(page, 20, 'poor')) === 'poor');
  await tapSquare(page, 6, 4);
  t = await tested(page, 'g5', 'true');
  check('and a tap is still tested', t.ok === 'true', t);
  await context.setOffline(false);

  step(7, 'Nothing was sent');
  traffic.on = false;
  check('no requests during the preview', traffic.requests.length === 0, traffic.requests.slice(0, 5));
  check('no WebSocket opened', traffic.sockets === 0, traffic.sockets);
  check('no WebSocket frame sent', traffic.frames === 0, traffic.frames);
  // And the counter can see a request at all: one the driver makes itself.
  const control = { requests: [] };
  context.on('request', (r) => control.requests.push(r.url()));
  await page.evaluate(() => fetch('/api/me').then((r) => r.status));
  check('(the counter does see a request when one is made)', control.requests.some((u) => u.includes('/api/me')));

  step(8, 'Back goes to the field');
  await page.click('[data-back]');
  await page.waitForSelector('[data-field-name]', { timeout: 10_000 });
  check('the field screen is back', (await text(page, '[data-field-name]')) === 'Sim Field');
  check('no console errors', metric.errors.length === 0, metric.errors.slice(0, 3));
  await context.close();

  // -------------------------------------------------------------------- US
  // An account that never chose follows the locale, and headless Chromium's
  // default is en-US: feet for short lengths (decision 0049).
  const us = await openPhone(browser, 'en-US', 'us');
  step(9, 'In US units');
  await us.page.click('[data-open]');
  await us.page.waitForSelector('[data-board]', { timeout: 15_000 });
  await us.page.evaluate(() => globalThis.satchess.me.setAccuracy(3));
  await standOn(us.page, 4, 1);
  check('looks playable', (await claim(us.page, 3, 'good')) === 'good');
  check('reach in feet', (await text(us.page, '[data-reach]')) === '10 ft', await text(us.page, '[data-reach]'));
  check('leeway in feet', (await text(us.page, '[data-leeway]')) === '24 ft', await text(us.page, '[data-leeway]'));
  check('signal in feet', /±9\.8 ft/.test((await text(us.page, '[data-quality]')) ?? ''), await text(us.page, '[data-quality]'));
  check('the verdict says feet, not meters', !/\d m\b/.test((await text(us.page, '[data-verdict]')) ?? ''));
  await tapSquare(us.page, 4, 3); // e4
  t = await tested(us.page, 'e4', 'false');
  check('a refused tap says feet', t.ok === 'false' && /ft/.test(t.words) && !/\d m\b/.test(t.words), t);
  await shot(us.page, `${OUT}/5-us-good-tap.png`);
  check('±10 m (33 ft): playable, with the odd refusal', (await claim(us.page, 10, 'tight')) === 'tight');
  await shot(us.page, `${OUT}/6-us-tight.png`);
  check('no console errors', us.errors.length === 0, us.errors.slice(0, 3));
  await us.context.close();
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? 'all good' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
