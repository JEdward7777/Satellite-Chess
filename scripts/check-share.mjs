/**
 * The share card, after a real game and after its archive (stages 8.5.1–8.5.3,
 * decisions 0018 and 0053).
 *
 * Two simulated phones play Fool's mate, every piece walked, on a field a
 * player named ("Sim Field"). Then each opens "Share a picture of this game"
 * from the review: black on the live game, white once it has been archived.
 * `navigator.share` is replaced by a recorder, so the file that would have
 * gone to the share sheet is caught and saved. What this proves that the
 * model tests cannot:
 *
 * - **The figures are the review's own**: walked and longest carry as the
 *   reader's row says them, the move count, the board size, the result.
 * - **The field's name is off until ticked**, and off again on the next open.
 * - **The picture is the card**: 1080 × 1350, with each carry's disc in the
 *   mover's ink where the report says the piece went down.
 * - **The PNG has nothing in it but the picture**: no text, EXIF or time
 *   chunk, and no join code, field name or coordinate anywhere in its bytes.
 * - **Making it and sharing it sends nothing**, with the phone offline, and
 *   the share carries a file and no link.
 * - **The download rung**, for a phone whose sheet takes no files.
 *
 * ## Running it
 *
 *     npm run build:client
 *     npx wrangler dev --port 8799 --var DEV_AUTH_SECRET:local-dev-secret \
 *       --persist-to "$(mktemp -d)" &
 *     node scripts/check-share.mjs [--base=http://127.0.0.1:8799/?sim=1] [--out=DIR]
 *
 * Takes about two minutes. The cards are saved in DIR.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

import { DEV_SECRET, signIn } from './driver-signin.mjs';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length > 0 ? rest.join('=') : 'true'];
  }),
);
const BASE = args.get('base') ?? 'http://127.0.0.1:8799/?sim=1';
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-share-'));
mkdirSync(OUT, { recursive: true });

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
const JOG_MPS = 4;
const FIELD_NAME = 'Sim Field';

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

/** The game board's pixels for a square (`render.ts`), on the 8 m field. */
function boardPixel(file, rank, orientation, w, h) {
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

/**
 * A place in squares, on the card: its board is a 1000 px canvas at
 * (40, 166) with the renderer's 6% padding (`share-card.ts`).
 */
function cardPixel(spot, orientation) {
  const pad = 60;
  const cell = (1000 - 2 * pad) / 8;
  const u = orientation === 'w' ? spot.file + 0.5 : 7.5 - spot.file;
  const v = orientation === 'w' ? 7.5 - spot.rank : spot.rank + 0.5;
  return { x: 40 + pad + u * cell, y: 166 + pad + v * cell };
}

let failures = 0;
function check(ok, what, detail = '') {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const step = (n, msg) => console.log(`\n${n}. ${msg}`);

/**
 * `navigator.share` and `canShare`, recorded. `__canShareFiles = false` makes
 * the sheet refuse files, which is the download rung's case.
 */
function stubShare() {
  globalThis.__shares = [];
  globalThis.__canShareFiles = true;
  Object.defineProperty(navigator, 'canShare', {
    configurable: true,
    value: (data) => (data?.files ? globalThis.__canShareFiles : true),
  });
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: async (data) => {
      const file = data?.files?.[0] ?? null;
      let b64 = null;
      if (file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        b64 = btoa(s);
      }
      globalThis.__shares.push({
        keys: Object.keys(data ?? {}).sort(),
        title: data?.title ?? null,
        text: data?.text ?? null,
        url: data?.url ?? null,
        files: data?.files?.length ?? 0,
        name: file?.name ?? null,
        type: file?.type ?? null,
        b64,
      });
    },
  });
}

async function newPhone(browser, name) {
  // Metric, because this reads meters off the screen (decision 0049).
  const context = await browser.newContext({
    viewport: { width: 480, height: 900 },
    locale: 'en-GB',
    acceptDownloads: true,
  });
  await signIn(context, `sim-share-${name}-${Date.now()}`, new URL(BASE).origin, name);
  await context.addInitScript(
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
  await context.addInitScript(stubShare);
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [${name}] console error: ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`  [${name}] page error: ${e.message}`));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-calibrate]', { timeout: 15_000 });
  return { context, page, name };
}

async function walk(page, file, rank) {
  await page.evaluate(
    ({ pos, speedMps }) => globalThis.satchess.me.walkTo(pos, { speedMps }),
    { pos: squareLatLng(file, rank), speedMps: JOG_MPS },
  );
  await page.waitForFunction(
    (sq) => !globalThis.satchess.me.walking && document.querySelector('[data-square]')?.textContent === sq,
    FILES[file] + String(rank + 1),
    { timeout: 40_000 },
  );
  await page.waitForTimeout(1_200);
}

async function tap(page, file, rank, orientation) {
  const box = await page.locator('[data-board]').boundingBox();
  const p = boardPixel(file, rank, orientation, box.width, box.height);
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

async function play(phone, orientation, from, to, san, other) {
  await walk(phone.page, ...sq(from));
  await tap(phone.page, ...sq(from), orientation);
  await phone.page.waitForFunction(() => {
    const el = document.querySelector('[data-carry]');
    return el !== null && !el.hidden;
  }, null, { timeout: 10_000 });
  await walk(phone.page, ...sq(to));
  await tap(phone.page, ...sq(to), orientation);
  await other.page.waitForFunction(
    () => /Your move|won|lost|drawn|checkmate/i.test(document.querySelector('[data-prompt]')?.textContent ?? ''),
    null,
    { timeout: 15_000 },
  );
  console.log(`   played ${san}`);
}

const text = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    return !el || el.hidden ? null : el.textContent.replace(/\s+/g, ' ').trim();
  }, sel);

/** Open the card's fold and wait for the picture, as named or unnamed. */
async function openCard(page, ready = 'unnamed') {
  await page.locator('[data-card] summary').scrollIntoViewIfNeeded();
  const open = await page.evaluate(() => document.querySelector('[data-card]').open);
  if (!open) await page.click('[data-card] summary');
  await waitReady(page, ready);
}

async function waitReady(page, ready) {
  await page.waitForFunction((r) => document.querySelector('[data-card]')?.dataset.cardReady === r, ready, {
    timeout: 10_000,
  });
}

/** What the review screen says, for the card's figures to be checked against. */
async function reviewSays(page) {
  const headline = await text(page, '[data-review-distance]');
  const firstRow = await page.evaluate(
    () => document.querySelector('[data-review-walks] > div')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
  );
  return {
    headline,
    walked: /You covered (.+)$/.exec(headline ?? '')?.[1] ?? null,
    longest: /longest carry ([\d.,]+ (?:m|km|yd|mi|ft))/.exec(firstRow)?.[1] ?? null,
    firstRow,
    where: await text(page, '[data-review-where]'),
    result: await text(page, '[data-review-result]'),
  };
}

/** PNG facts, from its bytes. */
function pngFacts(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  const isPng = sig.every((b, i) => bytes[i] === b);
  const chunks = [];
  let at = 8;
  while (isPng && at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    chunks.push(bytes.subarray(at + 4, at + 8).toString('latin1'));
    at += 12 + length;
  }
  return {
    isPng,
    chunks,
    width: isPng ? bytes.readUInt32BE(16) : 0,
    height: isPng ? bytes.readUInt32BE(20) : 0,
  };
}

const KEPT = new Set(['IHDR', 'PLTE', 'tRNS', 'gAMA', 'sRGB', 'IDAT', 'IEND']);

function checkPng(bytes, what, code) {
  const facts = pngFacts(bytes);
  check(facts.isPng, `${what}: a PNG`);
  check(facts.width === 1080 && facts.height === 1350, `${what}: 1080 × 1350`, `${facts.width} × ${facts.height}`);
  check(
    facts.chunks.every((c) => KEPT.has(c)) && facts.chunks[0] === 'IHDR' && facts.chunks.at(-1) === 'IEND',
    `${what}: only picture chunks — no text, EXIF or time`,
    facts.chunks.filter((c, i, a) => a.indexOf(c) === i).join(' '),
  );
  const latin = bytes.toString('latin1');
  check(
    !latin.includes(code) && !latin.includes(FIELD_NAME) && !/Exif|51\.47|GPS|tEXt|eXIf|tIME/.test(latin),
    `${what}: no code, field name, coordinate or metadata in its bytes`,
  );
}

/** The card's own pixel at a place in squares, read by drawing the PNG in the page. */
async function cardPixelColor(page, b64, spot, orientation) {
  const p = cardPixel(spot, orientation);
  return page.evaluate(
    async ({ b64, x, y }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const c = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const d = ctx.getImageData(Math.round(x) - 1, Math.round(y) - 1, 3, 3).data;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i];
        g += d[i + 1];
        b += d[i + 2];
      }
      return [r / 9, g / 9, b / 9].map(Math.round);
    },
    { b64, x: p.x, y: p.y },
  );
}

const isDark = ([r, g, b]) => r < 60 && g < 60 && b < 60;
const isLight = ([r, g, b]) => r > 220 && g > 220 && b > 220;

/** Requests that leave the page for the network (a blob: or data: URL does not). */
function countRequests(page) {
  const seen = [];
  const on = (request) => {
    if (/^https?:/.test(request.url())) seen.push(request.url());
  };
  page.on('request', on);
  return () => {
    page.off('request', on);
    return seen;
  };
}

const sharesOf = (page) => page.evaluate(() => globalThis.__shares);

const browser = await chromium.launch({ executablePath: findChromium() });

try {
  console.log(`cards -> ${OUT}`);
  const origin = new URL(BASE).origin;

  step(1, 'Two phones; white creates a game on "Sim Field", 8 m squares; black joins');
  const white = await newPhone(browser, 'white');
  const black = await newPhone(browser, 'black');
  await white.page.click('[data-new]');
  await white.page.waitForSelector('[data-create]', { timeout: 15_000 });
  await white.page.click('[data-create]');
  await white.page.waitForSelector('[data-join-code]', { timeout: 15_000 });
  const code = await white.page.getAttribute('[data-join-code]', 'data-join-code');
  console.log(`   join code ${code}`);
  await white.page.click('[data-open]');
  await white.page.waitForSelector('[data-board]', { timeout: 15_000 });
  await black.page.fill('[data-code]', code);
  await black.page.click('[data-join]');
  await black.page.waitForSelector('[data-board]', { timeout: 15_000 });
  await walk(black.page, 4, 7);
  await white.page.waitForFunction(
    () => /Your move/.test(document.querySelector('[data-prompt]')?.textContent ?? ''),
    null,
    { timeout: 20_000 },
  );

  step(2, 'Fool’s mate, every piece walked to and carried');
  await play(white, 'w', 'f2', 'f3', 'f3', black);
  await play(black, 'b', 'e7', 'e5', 'e5', white);
  await play(white, 'w', 'g2', 'g4', 'g4', black);
  await play(black, 'b', 'd8', 'h4', 'Qh4#', white);
  await white.page.waitForFunction(
    () => /checkmate/i.test(document.querySelector('[data-prompt]')?.textContent ?? ''),
    null,
    { timeout: 15_000 },
  );
  const live = await black.page.evaluate(async (c) => (await fetch(`/api/game/${c}/review`)).json(), code);
  const fixes = live.report.moves.map((m) => ({ color: m.color, lift: m.lift, place: m.place }));
  check(fixes.length === 4 && fixes.every((f) => f.lift && f.place), 'four moves, each with a lift and a place');

  step(3, 'Black opens the review; the card is folded shut and drawn only when opened');
  await black.page.click('[data-review-open]');
  await black.page.waitForSelector('[data-replay]', { timeout: 15_000 });
  const cardShut = await black.page.evaluate(() => {
    const card = document.querySelector('[data-card]');
    return card !== null && !card.open && card.querySelector('[data-card-image]').hidden;
  });
  check(cardShut, 'there is a card, shut, with no picture yet');
  const explain = await text(black.page, '[data-card-explain]');
  check(/Not your walks, no map, no date and no names/.test(explain ?? ''), 'it says what is not on it', explain);
  const nameBox = await black.page.evaluate(() => {
    const box = document.querySelector('[data-card-name]');
    return box === null ? null : { checked: box.checked, label: box.closest('label').textContent.replace(/\s+/g, ' ').trim() };
  });
  check(nameBox !== null && nameBox.checked === false, 'the field-name box is there, and off', JSON.stringify(nameBox));
  check(nameBox?.label.includes(FIELD_NAME), 'and names the field it would add', nameBox?.label);
  const says = await reviewSays(black.page);
  console.log(`   review: ${says.headline} | ${says.firstRow} | ${says.where} | ${says.result}`);

  step(4, 'Offline, black opens the card and shares it: nothing is sent');
  await black.context.setOffline(true);
  const stopBlack = countRequests(black.page);
  await openCard(black.page);
  const alt = await black.page.getAttribute('[data-card-image]', 'alt');
  console.log(`   card: ${alt}`);
  check(alt.startsWith('Won as Black — checkmate.'), 'the result, in black’s voice', alt.split('.')[0]);
  check(says.walked !== null && alt.includes(`walked: ${says.walked}`), 'walked is the review’s headline figure', says.walked);
  check(says.longest !== null && alt.includes(`longest carry: ${says.longest}`), 'longest carry is the review row’s figure', says.longest);
  check(alt.includes('moves: 2'), 'two moves, as Fool’s mate is counted');
  check(alt.includes('board: 64 m') && (says.where ?? '').includes('64 m'), 'a 64 m board, as the review says it');
  check(alt.includes('4 carries drawn'), 'four carries drawn');
  check(!alt.includes(FIELD_NAME) && !alt.includes(code), 'no field name and no join code');
  await black.page.click('[data-card-share]');
  await black.page.waitForFunction(() => globalThis.__shares.length === 1, null, { timeout: 5_000 });
  const said = await text(black.page, '[data-card-said]');
  check(said === 'Sent.', 'the phone says it went', said);
  const requests = stopBlack();
  await black.context.setOffline(false);
  check(requests.length === 0, 'and not one request was made, building or sharing', requests.join(' '));
  const [shared] = await sharesOf(black.page);
  check(shared.files === 1 && shared.type === 'image/png' && shared.name === 'satellite-chess.png', 'one PNG file, named with nothing in it', `${shared.name} ${shared.type}`);
  check(shared.url === null && !shared.keys.includes('url'), 'and no link: push only');
  check(
    /^Won as Black — checkmate, and walked .+\. A game of Satellite Chess\.$/.test(shared.text ?? '') && !shared.text.includes(FIELD_NAME),
    'the line beside it has no field name',
    shared.text,
  );
  const blackPng = Buffer.from(shared.b64, 'base64');
  writeFileSync(join(OUT, '1-card-black-live.png'), blackPng);
  checkPng(blackPng, 'black’s card', code);
  const queen = fixes[3];
  const g4 = fixes[2];
  check(isDark(await cardPixelColor(black.page, shared.b64, queen.place, 'b')), 'a black disc where the queen went down');
  check(isLight(await cardPixelColor(black.page, shared.b64, g4.place, 'b')), 'a white disc where g4 went down');
  await black.page.locator('[data-card]').screenshot({ path: join(OUT, '2-card-black-on-screen.png') });

  step(5, 'Black ticks the box: the card is drawn again with the field’s name');
  await black.page.check('[data-card-name]');
  await waitReady(black.page, 'named');
  const named = await black.page.getAttribute('[data-card-image]', 'alt');
  check(named.includes(`Field: ${FIELD_NAME}.`), 'the name is on it now', named);
  await black.page.click('[data-card-share]');
  await black.page.waitForFunction(() => globalThis.__shares.length === 2, null, { timeout: 5_000 });
  const namedShare = (await sharesOf(black.page))[1];
  const namedPng = Buffer.from(namedShare.b64, 'base64');
  writeFileSync(join(OUT, '3-card-black-named.png'), namedPng);
  check(!namedPng.equals(blackPng), 'a different picture');
  check(pngFacts(namedPng).chunks.every((c) => KEPT.has(c)), 'still only picture chunks');
  await black.page.uncheck('[data-card-name]');
  await waitReady(black.page, 'unnamed');
  check(!(await black.page.getAttribute('[data-card-image]', 'alt')).includes(FIELD_NAME), 'untick: gone again');
  await black.page.check('[data-card-name]');
  await waitReady(black.page, 'named');

  step(6, 'Leave and come back: the box is off again');
  await black.page.click('[data-review-home]');
  await black.page.waitForSelector('[data-new]', { timeout: 15_000 });
  await black.page.reload({ waitUntil: 'domcontentloaded' });
  await black.page.waitForSelector(`[data-game="${code}"]`, { timeout: 15_000 });
  await black.page.click(`[data-game="${code}"]`);
  // A finished game that is not yet archived opens on its board.
  await black.page.waitForSelector('[data-card], [data-review-open]:not([hidden])', { timeout: 15_000 });
  if ((await black.page.$('[data-card]')) === null) await black.page.click('[data-review-open]');
  await black.page.waitForSelector('[data-card]', { timeout: 15_000 });
  await openCard(black.page);
  check(
    (await black.page.evaluate(() => document.querySelector('[data-card-name]').checked)) === false &&
      !(await black.page.getAttribute('[data-card-image]', 'alt')).includes(FIELD_NAME),
    'the card opens unnamed',
  );
  await black.page.click('[data-review-home]');

  step(7, 'Both leave; a day later the game is archived and its object deleted');
  await white.page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await white.page.waitForSelector('[data-new]', { timeout: 15_000 });
  await new Promise((r) => setTimeout(r, 2_000));
  const hastened = await white.context.request.post(`${origin}/api/dev/game/${code}/collect`, {
    headers: { 'x-dev-auth-secret': DEV_SECRET },
    data: { afterMs: 0 },
  });
  check(hastened.status() === 200, 'collection hastened through the dev seam', String(hastened.status()));
  let archived = null;
  for (let i = 0; i < 90 && archived?.archived !== true; i++) {
    await new Promise((r) => setTimeout(r, 500));
    archived = await white.page.evaluate(async (c) => (await fetch(`/api/game/${c}`)).json(), code);
  }
  check(archived?.archived === true, 'the game reads as archived', JSON.stringify(archived));

  step(8, 'White opens the archived game, offline once loaded: same card, from white’s side');
  await white.page.reload({ waitUntil: 'domcontentloaded' });
  await white.page.waitForSelector(`[data-game="${code}"]`, { timeout: 15_000 });
  await white.page.click(`[data-game="${code}"]`);
  await white.page.waitForSelector('[data-card]', { timeout: 15_000 });
  const whiteSays = await reviewSays(white.page);
  await white.context.setOffline(true);
  const stopWhite = countRequests(white.page);
  await openCard(white.page);
  const whiteAlt = await white.page.getAttribute('[data-card-image]', 'alt');
  console.log(`   card: ${whiteAlt}`);
  check(whiteAlt.startsWith('Lost as White — checkmate.'), 'the result, in white’s voice');
  check(whiteSays.walked !== null && whiteAlt.includes(`walked: ${whiteSays.walked}`), 'white’s own walked figure', whiteSays.walked);
  check(whiteSays.longest !== null && whiteAlt.includes(`longest carry: ${whiteSays.longest}`), 'white’s own longest carry', whiteSays.longest);
  check(whiteAlt.includes('moves: 2') && whiteAlt.includes('board: 64 m') && whiteAlt.includes('4 carries drawn'), 'the game’s figures, the same');
  await white.page.click('[data-card-share]');
  await white.page.waitForFunction(() => globalThis.__shares.length === 1, null, { timeout: 5_000 });
  const whiteRequests = stopWhite();
  await white.context.setOffline(false);
  check(whiteRequests.length === 0, 'not one request, building or sharing', whiteRequests.join(' '));
  const [whiteShared] = await sharesOf(white.page);
  const whitePng = Buffer.from(whiteShared.b64, 'base64');
  writeFileSync(join(OUT, '4-card-white-archived.png'), whitePng);
  checkPng(whitePng, 'white’s card', code);
  check(isDark(await cardPixelColor(white.page, whiteShared.b64, queen.place, 'w')), 'the queen’s disc, from white’s side of the board');

  step(9, 'A sheet that takes no files: the card is downloaded instead');
  await white.page.evaluate(() => {
    globalThis.__canShareFiles = false;
  });
  const [download] = await Promise.all([
    white.page.waitForEvent('download', { timeout: 10_000 }),
    white.page.click('[data-card-share]'),
  ]);
  const downloadPath = join(OUT, '5-card-white-download.png');
  await download.saveAs(downloadPath);
  check(download.suggestedFilename() === 'satellite-chess.png', 'saved as satellite-chess.png', download.suggestedFilename());
  checkPng(readFileSync(downloadPath), 'the downloaded card', code);
  await white.page.waitForFunction(() => document.querySelector('[data-card-said]')?.textContent === 'Downloaded.', null, { timeout: 5_000 });
  check((await sharesOf(white.page)).length === 1, 'and the sheet was not asked');

  step(10, 'Disc pieces, for the look');
  await white.page.evaluate(() => {
    localStorage.setItem('satchess.pieceLook', 'disc');
    globalThis.__canShareFiles = true;
  });
  await white.page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await white.page.waitForSelector(`[data-game="${code}"]`, { timeout: 15_000 });
  await white.page.click(`[data-game="${code}"]`);
  await white.page.waitForSelector('[data-card]', { timeout: 15_000 });
  await openCard(white.page);
  await white.page.click('[data-card-share]');
  await white.page.waitForFunction(() => globalThis.__shares.length === 1, null, { timeout: 5_000 });
  writeFileSync(join(OUT, '6-card-white-discs.png'), Buffer.from((await sharesOf(white.page))[0].b64, 'base64'));
  check(true, 'drawn (see the picture)');
  await white.page.screenshot({ path: join(OUT, '7-white-review-full.png'), fullPage: true });

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  console.log(`Cards in ${OUT}`);
} catch (error) {
  failures += 1;
  console.error(error);
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
