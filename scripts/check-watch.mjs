/**
 * Watching a game live, on two phones and a sofa (stage 10.14, decision 0055,
 * O-37).
 *
 * 1. **Both agree, then watch.** White asks from "Let people watch"; black
 *    sees the ask, whose Agree is dead for a moment, and agrees. Both boards
 *    say watching is on; white's panel shows the link, a QR that decodes to
 *    it, Share and Copy. A browser that has **never signed in** opens the
 *    link and sees the game: the handshake, then moves, both dots, the piece
 *    in hand, the last move and the clocks, live. It is never asked for its
 *    location and sends nothing but the keepalive. Every frame it receives is
 *    scanned for a coordinate, the field's name or the join code.
 * 2. **Either can turn it off.** Black turns watching off; the watcher's page
 *    says the link is not live, and a fresh load of the link says the same.
 * 3. **A second game: the cap, and the link dies at the end.** Watching on
 *    again; six watchers are let in and a seventh is told politely that too
 *    many are watching. Fool's mate: the watcher sees the result, then the
 *    link ends, and the other watchers are closed with it.
 *
 * Each player's `watch` frames are counted, so "one tap, one message" is a
 * number.
 *
 * ## Running it
 *
 *     npm run build:client
 *     npx wrangler dev --port 8799 --var DEV_AUTH_SECRET:local-dev-secret \
 *       --persist-to "$(mktemp -d)" &
 *     npm install --no-save playwright jsqr
 *     node scripts/check-watch.mjs [--base=http://127.0.0.1:8799/?sim=1] [--out=DIR]
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

import { signIn } from './driver-signin.mjs';

const require = createRequire(import.meta.url);
let jsQR;
try {
  jsQR = require('jsqr').default ?? require('jsqr');
} catch {
  console.error('jsqr is not installed. Run:  npm install --no-save playwright jsqr');
  process.exit(2);
}

const args = new Map(
  process.argv.slice(2).map((a) => {
    // Split at the first `=` only: the base URL carries `?sim=1` (O-24).
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length > 0 ? rest.join('=') : 'true'];
  }),
);
const BASE = args.get('base') ?? 'http://127.0.0.1:8799/?sim=1';
const ORIGIN = new URL(BASE).origin;
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-watch-'));
mkdirSync(OUT, { recursive: true });
const RUN = Date.now().toString(36);
/** `WATCH_MAX_WATCHERS` and the close codes in `shared/watch.ts`. */
const MAX_WATCHERS = 6;
const CLOSE = { notLive: 4001, over: 4002, full: 4003 };

function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  for (const dir of readdirSync(root)) {
    if (!dir.startsWith('chromium-')) continue;
    for (const sub of ['chrome-linux64', 'chrome-linux']) {
      const exe = join(root, dir, sub, 'chrome');
      if (existsSync(exe)) return exe;
    }
  }
  return undefined;
}

const A1 = { lat: 51.4779, lng: -0.0015 }; // `SIM_START` in client/main.ts
const SQUARE_M = 8;
const M_PER_DEG_LAT = (6378137 * Math.PI) / 180;
const FILES = 'abcdefgh';
const FIELD_NAME = 'Grandma Backyard';

function squareLatLng(file, rank) {
  return {
    lat: A1.lat + (rank * SQUARE_M) / M_PER_DEG_LAT,
    lng: A1.lng + (file * SQUARE_M) / (M_PER_DEG_LAT * Math.cos((A1.lat * Math.PI) / 180)),
  };
}

const FIELD = {
  id: 'sim-field',
  name: FIELD_NAME,
  a1: A1,
  h8: squareLatLng(7, 7),
  version: 1,
  createdAt: 0,
  updatedAt: 0,
};

/** `projectionFor` from client/render.ts, replayed so a tap can aim at a square. */
function squareToPixel(file, rank, orientation, w, h) {
  const sizeM = 8 * SQUARE_M;
  const minU = -SQUARE_M / 2;
  const maxU = 7 * SQUARE_M + SQUARE_M / 2;
  const size = Math.min(w, h);
  const pad = size * 0.06;
  const scale = (size - 2 * pad) / sizeM;
  const offsetX = (w - sizeM * scale) / 2;
  const offsetY = (h - sizeM * scale) / 2;
  const u = orientation === 'w' ? file * SQUARE_M - minU : maxU - file * SQUARE_M;
  const v = orientation === 'w' ? maxU - rank * SQUARE_M : rank * SQUARE_M - minU;
  return { x: offsetX + u * scale, y: offsetY + v * scale };
}

let failures = 0;
function check(ok, what, detail = '') {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const step = (n, msg) => console.log(`\n${n}. ${msg}`);
const shots = [];
async function shot(page, name, focus = null) {
  if (focus !== null) await page.locator(focus).first().scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path });
  shots.push(path);
}

async function newPhone(browser, name) {
  const context = await browser.newContext({ viewport: { width: 480, height: 900 }, locale: 'en-GB' });
  await signIn(context, `sim-watch-${name}-${RUN}`, ORIGIN, name);
  await context.addInitScript(
    ({ field }) => {
      window.__sent = [];
      const Native = window.WebSocket;
      const send = Native.prototype.send;
      Native.prototype.send = function (data) {
        try {
          window.__sent.push(JSON.parse(String(data)));
        } catch {
          // The keepalive is a bare string.
        }
        return send.call(this, data);
      };
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
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [${name}] page error: ${e.message}`));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-new]', { timeout: 15_000 });
  return { context, page, name };
}

/**
 * A browser that has never signed in, opening the link. Everything its
 * sockets send and receive is kept, and every call that would ask where it
 * is gets counted.
 */
async function newWatcher(browser, url, name) {
  // en-US, and no session: the locale's units, as a signed-out watcher gets.
  const context = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: 'en-US' });
  await context.addInitScript(() => {
    window.__wsSent = [];
    window.__wsGot = [];
    window.__geo = 0;
    const Native = window.WebSocket;
    const send = Native.prototype.send;
    Native.prototype.send = function (data) {
      window.__wsSent.push(String(data));
      return send.call(this, data);
    };
    window.WebSocket = function (...a) {
      const ws = new Native(...a);
      ws.addEventListener('message', (e) => window.__wsGot.push(String(e.data)));
      return ws;
    };
    window.WebSocket.prototype = Native.prototype;
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    if (navigator.geolocation) {
      for (const k of ['watchPosition', 'getCurrentPosition']) {
        const real = navigator.geolocation[k].bind(navigator.geolocation);
        navigator.geolocation[k] = (...b) => {
          window.__geo += 1;
          return real(...b);
        };
      }
    }
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [${name}] page error: ${e.message}`));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-watch-page]', { timeout: 15_000 });
  return { context, page, name };
}

async function walkTo(page, file, rank) {
  await page.evaluate((pos) => globalThis.satchess.me.moveTo(pos), squareLatLng(file, rank));
  await page.waitForFunction(
    (sq) => document.querySelector('[data-square]')?.textContent === sq,
    FILES[file] + String(rank + 1),
    { timeout: 10_000 },
  );
  await page.waitForTimeout(1_100);
}

async function tapSquare(page, file, rank, orientation) {
  const box = await page.locator('[data-board]').boundingBox();
  const p = squareToPixel(file, rank, orientation, box.width, box.height);
  await page.evaluate(
    ({ x, y }) => {
      const canvas = document.querySelector('[data-board]');
      const rect = canvas.getBoundingClientRect();
      for (const type of ['pointerdown', 'pointerup']) {
        canvas.dispatchEvent(
          new PointerEvent(type, { clientX: rect.left + x, clientY: rect.top + y, bubbles: true, pointerId: 1, isPrimary: false }),
        );
      }
    },
    { x: p.x, y: p.y },
  );
}

const sq = (name) => [FILES.indexOf(name[0]), Number(name[1]) - 1];

async function lift(mover, from) {
  await walkTo(mover.page, ...sq(from));
  await tapSquare(mover.page, ...sq(from), mover.color);
  await waitText(mover.page, '[data-carry-text]', new RegExp(`^${from}`));
}

async function place(mover, to) {
  await walkTo(mover.page, ...sq(to));
  await tapSquare(mover.page, ...sq(to), mover.color);
}

const text = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    return !el || el.hidden ? null : el.textContent;
  }, sel);
const visible = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    return el !== null && !el.hidden && el.closest('[hidden]') === null;
  }, sel);
const disabled = (page, sel) => page.evaluate((s) => document.querySelector(s)?.disabled === true, sel);
const waitText = (page, sel, pattern, timeout = 15_000) =>
  page.waitForFunction(
    ({ s, p }) => new RegExp(p).test(document.querySelector(s)?.textContent ?? ''),
    { s: sel, p: pattern.source },
    { timeout },
  );
const waitData = (page, key, pattern, timeout = 15_000) =>
  page.waitForFunction(
    ({ k, p }) => new RegExp(p).test(document.querySelector('[data-watch-page]')?.dataset[k] ?? ''),
    { k: key, p: pattern.source },
    { timeout },
  );
/** Wait until a player's dot is drawn within a third of a square of (file, rank). */
const waitDot = (page, color, file, rank, timeout = 15_000) =>
  page.waitForFunction(
    ({ c, f, r }) => {
      const dots = document.querySelector('[data-watch-page]')?.dataset.dots ?? '';
      const m = new RegExp(`${c}:(-?[\\d.]+),(-?[\\d.]+)(,away)?`).exec(dots);
      return m !== null && !m[3] && Math.abs(Number(m[1]) - f) < 0.34 && Math.abs(Number(m[2]) - r) < 0.34;
    },
    { c: color, f: file, r: rank },
    { timeout },
  );
const data = (page, key) => page.evaluate((k) => document.querySelector('[data-watch-page]')?.dataset[k], key);
const sentOf = (page, t) => page.evaluate((k) => window.__sent.filter((m) => m.t === k), t);
const rawClick = (page, sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel);

/** White creates and opens the board; black joins by code. */
async function pair(browser, label) {
  const white = { ...(await newPhone(browser, `${label}-white`)), color: 'w' };
  const black = { ...(await newPhone(browser, `${label}-black`)), color: 'b' };
  await white.page.click('[data-new]');
  await white.page.waitForSelector('[data-create]', { timeout: 15_000 });
  await white.page.click('[data-create]');
  await white.page.waitForSelector('[data-join-code]', { timeout: 15_000 });
  const code = await white.page.getAttribute('[data-join-code]', 'data-join-code');
  await white.page.click('[data-open]');
  await white.page.waitForSelector('[data-board]', { timeout: 15_000 });
  await black.page.fill('[data-code]', code);
  await black.page.click('[data-join]');
  await black.page.waitForSelector('[data-board]', { timeout: 15_000 });
  console.log(`   join code ${code}`);
  return { white, black, code };
}

/** White asks, black agrees through the banner; returns the link white's panel shows. */
async function agree(white, black, shoot) {
  await white.page.waitForSelector('[data-watch-open]:not([hidden])', { timeout: 15_000 });
  await white.page.click('[data-watch-open]');
  await white.page.waitForSelector('[data-watch-panel]:not([hidden])');
  if (shoot) await shot(white.page, '01-players-control-ask');
  await white.page.click('[data-watch-yes]');
  await waitText(white.page, '[data-watch-title]', /Waiting for your opponent/);
  if (shoot) await shot(white.page, '02-players-control-waiting');
  await white.page.click('[data-watch-close]');
  await black.page.waitForSelector('[data-watch-invite]:not([hidden])', { timeout: 10_000 });
  if (shoot) {
    check(await disabled(black.page, '[data-watch-agree]'), 'black: Agree is dead the instant the ask appears');
    await rawClick(black.page, '[data-watch-agree]');
    await black.page.waitForTimeout(150);
    check((await sentOf(black.page, 'watch')).length === 0, 'black: a tap on it then sends nothing');
    await shot(black.page, '03-players-ask-banner', '[data-watch-invite]');
  }
  await black.page.waitForFunction(() => document.querySelector('[data-watch-agree]')?.disabled === false, null, {
    timeout: 3_000,
  });
  await black.page.click('[data-watch-agree]');
  await waitText(white.page, '[data-watch-line]', /Watching is on/);
  await waitText(black.page, '[data-watch-line]', /Watching is on/);
  await white.page.click('[data-watch-open]');
  await white.page.waitForSelector('[data-watch-share]:not([hidden])');
  const link = await text(white.page, '[data-watch-link]');
  return link;
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

/**
 * Every coordinate-like thing in what a watcher received: a key that names a
 * position or the field, a number near the field's latitude or longitude, or
 * a string with the field's name or the join code in it.
 */
function leaks(frames, code) {
  const found = [];
  const badKey = /lat|lng|lon|acc|field|corner|bearing|origin|joincode|code|name|account|sub|reach|geo/i;
  const walk = (v, path) => {
    if (typeof v === 'number') {
      if (Math.abs(v - A1.lat) < 0.01 || Math.abs(v - A1.lng) < 0.0005) found.push(`${path}=${v}`);
    } else if (typeof v === 'string') {
      if (v.includes(FIELD_NAME) || v.includes(code) || /51\.47/.test(v)) found.push(`${path}=${v}`);
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (badKey.test(k)) found.push(`${path}.${k}`);
        walk(x, `${path}.${k}`);
      }
    }
  };
  frames.forEach((f, i) => {
    if (f === 'P' || f === 'p') return;
    if (f.includes(code) || f.includes(FIELD_NAME)) found.push(`#${i} raw text`);
    walk(JSON.parse(f), `#${i}`);
  });
  return found;
}

/** A bare socket on the link, from node, as an extra watcher. Resolves once it is open or refused. */
function nodeWatcher(link) {
  const url = `${ORIGIN.replace(/^http/, 'ws')}/api/watch/${link.replace(/^.*\/w\//, '')}/ws`;
  const ws = new WebSocket(url);
  const got = [];
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
  ws.addEventListener('message', (e) => got.push(String(e.data)));
  const ready = new Promise((resolve) => {
    ws.addEventListener('message', () => resolve('open'), { once: true });
    closed.then((c) => resolve(c));
  });
  return { ws, got, closed, ready };
}

const browser = await chromium.launch({ executablePath: findChromium() });

try {
  console.log(`screenshots -> ${OUT}`);

  // -------------------------------------------------------------------------
  step(1, 'Both agree, then a signed-out browser watches the game live');
  let firstLink;
  {
    const { white, black, code } = await pair(browser, 'g1');
    const link = await agree(white, black, true);
    firstLink = link;
    check(/^https?:\/\/[^/]+\/w\/[0-9a-f]{64}\.[A-Za-z0-9_-]{22}$/.test(link ?? ''), 'the link is a watch link', link);
    check(!(link ?? '').includes(code), 'and the join code is not in it');
    const qr = await white.page.locator('[data-watch-qr]').screenshot();
    const decoded = await decode(white.context, qr);
    check(decoded === link, 'the QR on the panel decodes to the link', decoded ?? '(no decode)');
    check(await visible(white.page, '[data-watch-send]'), 'Share the link is offered');
    check(await visible(white.page, '[data-watch-copy]'), 'Copy the link is offered');
    await shot(white.page, '04-players-control-on');
    await white.page.click('[data-watch-close]');
    check((await sentOf(white.page, 'watch')).length === 1, 'white sent one watch frame for one tap');
    check((await sentOf(black.page, 'watch')).length === 1, 'black sent one watch frame for one tap');

    const sofa = await newWatcher(browser, link, 'sofa');
    await waitData(sofa.page, 'status', /^open$/);
    await waitText(sofa.page, '[data-watch-headline]', /back rank/);
    check(true, 'the watcher, signed out, sees the handshake', await text(sofa.page, '[data-watch-headline]'));
    await shot(sofa.page, '05-watcher-staging');

    await walkTo(white.page, 4, 0);
    await walkTo(black.page, 4, 7);
    await waitText(white.page, '[data-prompt]', /Your move/, 20_000);
    await waitText(sofa.page, '[data-watch-headline]', /White to move/);
    await waitDot(sofa.page, 'w', 4, 0);
    await waitDot(sofa.page, 'b', 4, 7);
    check(true, 'both dots, on their back ranks', await data(sofa.page, 'dots'));
    const c1 = await text(sofa.page, '[data-clock="w"]');
    await sofa.page.waitForTimeout(2_100);
    const c2 = await text(sofa.page, '[data-clock="w"]');
    check(c1 !== c2, "White's clock runs on the watcher's page", `${c1} → ${c2}`);

    await lift(white, 'e2');
    await waitText(sofa.page, '[data-watch-headline]', /White is carrying a pawn from e2/);
    await walkTo(white.page, 4, 2);
    await waitDot(sofa.page, 'w', 4, 2);
    check(true, 'the carrier walks, and the watcher sees the dot move', await data(sofa.page, 'dots'));
    await shot(sofa.page, '06-watcher-carrying');
    await place(white, 'e4');
    await waitText(black.page, '[data-prompt]', /Your move/);
    await waitData(sofa.page, 'moves', /^1$/);
    check((await text(sofa.page, '[data-watch-moves]')) === '1. e4', 'the move list', await text(sofa.page, '[data-watch-moves]'));
    const last = await text(sofa.page, '[data-watch-last]');
    check(/^Last move: e4 by White — carried \d+ ft\.$/.test(last ?? ''), 'the last move, in the locale\'s units (US)', last);
    check(/walked .* yd|walked .* mi/.test((await text(sofa.page, '[data-watch-walked]')) ?? ''), 'walked, in yards', await text(sofa.page, '[data-watch-walked]'));
    await lift(black, 'e7');
    await place(black, 'e5');
    await waitData(sofa.page, 'moves', /^2$/);
    await waitText(sofa.page, '[data-watch-headline]', /White to move/);
    await shot(sofa.page, '07-watcher-after-two-moves');

    const got = await sofa.page.evaluate(() => window.__wsGot);
    const sent = await sofa.page.evaluate(() => window.__wsSent);
    check(got.length >= 6, 'the watcher received the game as it went', `${got.length} frames`);
    check(sent.every((f) => f === 'p'), 'the watcher sent nothing but the keepalive', JSON.stringify(sent));
    check((await sofa.page.evaluate(() => window.__geo)) === 0, 'the watcher was never asked for its location');
    const types = [...new Set(got.filter((f) => f !== 'P').map((f) => JSON.parse(f).t))].sort();
    check(JSON.stringify(types) === JSON.stringify(['watch_pos', 'watch_state']), 'only the watcher\'s own message types', types.join(','));
    const found = leaks(got, code);
    check(found.length === 0, 'no coordinate, field name or join code in any frame', found.slice(0, 5).join(' | '));

    // -----------------------------------------------------------------------
    step(2, 'Black turns watching off: the watcher is closed, and the link is dead');
    await black.page.click('[data-watch-open]');
    await black.page.waitForSelector('[data-watch-panel]:not([hidden])');
    check((await text(black.page, '[data-watch-stop]')) === 'Turn watching off', 'black can turn it off', await text(black.page, '[data-watch-stop]'));
    await black.page.click('[data-watch-stop]');
    await waitData(sofa.page, 'ended', /^not_live$/);
    check(true, 'the watcher is told', await text(sofa.page, '[data-watch-ended]'));
    await shot(sofa.page, '08-watcher-turned-off');
    await waitText(white.page, '[data-watch-open]', /Let people watch/);
    check(!(await visible(white.page, '[data-watch-line]')), 'white\'s board no longer says watching is on');
    check((await sentOf(black.page, 'watch')).length === 2, 'black sent one more frame, for the one tap');
    await sofa.page.reload({ waitUntil: 'domcontentloaded' });
    await waitData(sofa.page, 'ended', /^not_live$/);
    check(true, 'reloading the link: still not live', await text(sofa.page, '[data-watch-ended]'));
    await sofa.context.close();
    await white.context.close();
    await black.context.close();
  }

  // -------------------------------------------------------------------------
  step(3, 'A second game: the cap, then the link dies at the mate');
  {
    const { white, black, code } = await pair(browser, 'g2');
    const link = await agree(white, black, false);
    check(link !== firstLink, 'a new game, a new link');
    await white.page.click('[data-watch-close]');
    const old = nodeWatcher(firstLink);
    check((await old.ready) === CLOSE.notLive, 'the first game\'s link stays dead', String(await old.ready));

    const sofa = await newWatcher(browser, link, 'sofa2');
    await waitData(sofa.page, 'status', /^open$/);
    const others = [];
    for (let i = 1; i < MAX_WATCHERS; i++) {
      const w = nodeWatcher(link);
      others.push(w);
      check((await w.ready) === 'open', `watcher ${i + 1} of ${MAX_WATCHERS} is let in`);
    }
    const seventh = await newWatcher(browser, link, 'seventh');
    await waitData(seventh.page, 'ended', /^full$/);
    check(true, 'the seventh is told, politely', await text(seventh.page, '[data-watch-ended]'));
    await shot(seventh.page, '09-watcher-full');
    check(others.every((w) => w.ws.readyState === 1), 'and nobody already watching was moved off');
    await seventh.context.close();

    await walkTo(white.page, 4, 0);
    await walkTo(black.page, 4, 7);
    await waitText(white.page, '[data-prompt]', /Your move/, 20_000);
    await lift(white, 'f2');
    await place(white, 'f3');
    await waitText(black.page, '[data-prompt]', /Your move/);
    await lift(black, 'e7');
    await place(black, 'e5');
    await waitText(white.page, '[data-prompt]', /Your move/);
    await lift(white, 'g2');
    await place(white, 'g4');
    await waitText(black.page, '[data-prompt]', /Your move/);
    await lift(black, 'd8');
    await waitText(sofa.page, '[data-watch-headline]', /Black is carrying a queen from d8/);
    await walkTo(black.page, 7, 3);
    await waitDot(sofa.page, 'b', 7, 3);
    await shot(sofa.page, '10-watcher-queen-in-hand');
    await place(black, 'h4');
    await waitText(sofa.page, '[data-watch-headline]', /Game over: Black won — checkmate/);
    await waitData(sofa.page, 'ended', /^over$/);
    check(true, 'the watcher sees the mate, then the link ends', await text(sofa.page, '[data-watch-ended]'));
    check((await text(sofa.page, '[data-watch-moves]')) === '1. f3 e5 2. g4 Qh4#', 'every move', await text(sofa.page, '[data-watch-moves]'));
    await shot(sofa.page, '11-watcher-game-over');
    const codes = await Promise.all(others.map((w) => w.closed));
    check(codes.every((c) => c === CLOSE.over), 'every other watcher was closed with it', codes.join(','));
    const after = nodeWatcher(link);
    check((await after.ready) === CLOSE.notLive, 'and the link no longer works', String(await after.ready));
    check(!(await visible(white.page, '[data-watch-open]')), 'the board no longer offers watching');

    const got = await sofa.page.evaluate(() => window.__wsGot);
    const found = leaks([...got, ...others.flatMap((w) => w.got)], code);
    check(found.length === 0, 'no coordinate in any frame of the second game either', found.slice(0, 5).join(' | '));
    await shot(white.page, '12-players-after-mate', '[data-prompt]');
    await sofa.context.close();
    await white.context.close();
    await black.context.close();
  }
} catch (error) {
  failures += 1;
  console.log(`\nFAIL: ${error.stack ?? error}`);
} finally {
  await browser.close();
}

console.log(`\nScreenshots:\n${shots.map((s) => `  ${s}`).join('\n')}`);
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
