/**
 * Pinch zoom on the game board (stage 10.8), driven with real touch input.
 *
 * The arithmetic is unit-tested in `test/board-zoom.test.ts`. What only a
 * browser can say is whether the pieces are wired together: that Chromium's
 * touch input reaches the canvas as pointer events rather than as a page zoom,
 * that a pan starting on a piece you can reach does **not** lift it, that a
 * tap on a zoomed board lifts the piece under the finger, and that "Whole
 * board" puts everything back.
 *
 * Touches go through the DevTools protocol (`Input.dispatchTouchEvent`), the
 * only way to put two fingers on the glass at once from Playwright. Every
 * touch is therefore a real touch sequence, with `pointerdown` first — which
 * is also why the simulator's drag, which teleports on `pointerdown` at 1x,
 * matters here. See step 2.
 *
 *     node scripts/check-zoom.mjs --base=http://127.0.0.1:8799/?sim=1 --out=/tmp/zoom
 */

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

import { signIn } from './driver-signin.mjs';

const args = new Map(
  process.argv.slice(2).map((a) => {
    // Split on the first `=` only, so `?sim=1` survives (O-24).
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length > 0 ? rest.join('=') : 'true'];
  }),
);
const BASE = args.get('base') ?? 'http://127.0.0.1:8799/?sim=1';
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-zoom-'));

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

function squareLatLng(file, rank) {
  return {
    lat: A1.lat + (rank * SQUARE_M) / M_PER_DEG_LAT,
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

/** `projectionFor` from client/render.ts, replayed: a square's centre at 1x. */
function squareToPixel(file, rank, orientation, w, h) {
  const sizeM = 8 * SQUARE_M;
  const minU = -SQUARE_M / 2;
  const maxU = 7 * SQUARE_M + SQUARE_M / 2;
  const size = Math.min(w, h);
  const pad = size * 0.06;
  const scale = (size - 2 * pad) / sizeM;
  const offsetX = (w - sizeM * scale) / 2;
  const offsetY = (h - sizeM * scale) / 2;
  const bp = { u: file * SQUARE_M, v: rank * SQUARE_M };
  const u = orientation === 'w' ? bp.u - minU : maxU - bp.u;
  const v = orientation === 'w' ? maxU - bp.v : bp.v - minU;
  return { x: offsetX + u * scale, y: offsetY + v * scale };
}

async function newPhone(browser, name) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });
  await signIn(context, `sim-zoom-${name}`, new URL(BASE).origin, name);
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [${name}] console error: ${m.text()}`);
  });
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
  await page.waitForSelector('[data-new]', { timeout: 15_000 });
  const cdp = await context.newCDPSession(page);
  return { context, page, cdp, name };
}

async function walkTo(page, file, rank) {
  await page.evaluate((pos) => globalThis.satchess.me.moveTo(pos), squareLatLng(file, rank));
  await page.waitForFunction(
    (sq) => document.querySelector('[data-square]')?.textContent === sq,
    FILES[file] + String(rank + 1),
    { timeout: 10_000 },
  );
}

const readout = (page) =>
  page.evaluate(() => {
    const text = (sel) => {
      const el = document.querySelector(sel);
      return !el || el.hidden ? null : el.textContent;
    };
    const canvas = document.querySelector('[data-board]');
    const [k, tx, ty] = (canvas?.dataset.zoom ?? '1 0 0').split(' ').map(Number);
    return {
      square: text('[data-square]'),
      carry: text('[data-carry]'),
      prompt: text('[data-prompt]'),
      notice: text('[data-notice]'),
      zoom: { k, tx, ty },
      controls: !document.querySelector('[data-zoom-controls]')?.hidden,
      followButton: !document.querySelector('[data-zoom-follow]')?.hidden,
      pageScale: window.visualViewport?.scale ?? 1,
      scrollY: Math.round(window.scrollY),
    };
  });

/** Canvas box in page pixels. */
const canvasBox = (page) => page.locator('[data-board]').boundingBox();

/**
 * A square's centre in page pixels, through the zoom the canvas reports.
 *
 * Scrolls to the top first. The page keeps the invite screen's scroll when
 * the board replaces it, and Chrome's scroll anchoring moves it again when
 * the readout grows a row, so a box measured once goes stale.
 */
async function squareOnPage(phone, file, rank, orientation) {
  await phone.page.evaluate(() => window.scrollTo(0, 0));
  const box = await canvasBox(phone.page);
  const { zoom } = await readout(phone.page);
  const p = squareToPixel(file, rank, orientation, box.width, box.height);
  return { x: box.x + zoom.k * p.x + zoom.tx, y: box.y + zoom.k * p.y + zoom.ty };
}

/**
 * One touch event. Every point must be on the canvas: a finger that lands on
 * the page beside it scrolls the page, and every later aim is then wrong —
 * the first version of this driver tapped "Leave" that way.
 */
async function touch(phone, type, points) {
  if (type === 'touchStart') {
    const hits = await phone.page.evaluate(
      (pts) => pts.map((p) => document.elementFromPoint(p.x, p.y)?.matches('[data-board]') ?? false),
      points,
    );
    if (hits.includes(false)) {
      const box = await canvasBox(phone.page);
      throw new Error(`touch at ${JSON.stringify(points)} is not all on the canvas ${JSON.stringify(box)}`);
    }
  }
  await phone.cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i })),
  });
}

/** One finger down, a few steps along a line, and up. */
async function drag(phone, from, to, steps = 8) {
  await touch(phone, 'touchStart', [from]);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await touch(phone, 'touchMove', [{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }]);
  }
  await touch(phone, 'touchEnd', []);
  await phone.page.waitForTimeout(100);
}

/** Two fingers about `at`, from `from` px apart to `to` px apart, horizontally. */
async function pinch(phone, at, from, to, steps = 10) {
  const pts = (d) => [
    { x: at.x - d / 2, y: at.y },
    { x: at.x + d / 2, y: at.y },
  ];
  await touch(phone, 'touchStart', pts(from));
  for (let i = 1; i <= steps; i++) await touch(phone, 'touchMove', pts(from + ((to - from) * i) / steps));
  await touch(phone, 'touchEnd', []);
  await phone.page.waitForTimeout(100);
}

async function tap(phone, at) {
  await touch(phone, 'touchStart', [at]);
  await touch(phone, 'touchEnd', []);
  await phone.page.waitForTimeout(100);
}

let failures = 0;
function check(label, ok, detail) {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}
const step = (n, msg) => console.log(`\n${n}. ${msg}`);

const browser = await chromium.launch({ executablePath: findChromium() });

try {
  console.log(`screenshots -> ${OUT}`);

  step(1, 'Two touch phones start a game');
  const white = await newPhone(browser, 'white');
  const black = await newPhone(browser, 'black');
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
  await walkTo(white.page, 4, 0); // e1
  await walkTo(black.page, 4, 7); // e8
  await white.page.waitForFunction(
    () => document.querySelector('[data-prompt]')?.textContent?.includes('Your move'),
    { timeout: 20_000 },
  );
  await walkTo(white.page, 4, 1); // stand on e2, in reach of the pawn
  const start = await readout(white.page);
  check('whole board, nothing in hand, no zoom buttons', start.zoom.k === 1 && !start.carry && !start.controls, start);
  await white.page.screenshot({ path: `${OUT}/1-whole-board.png` });

  step(2, 'Pinch out about e2: the board zooms, nothing is lifted, the page does not zoom');
  const e2 = await squareOnPage(white, 4, 1, 'w');
  await pinch(white, e2, 40, 160);
  // The first finger of a pinch at 1x is a simulator drag (it teleports on
  // `pointerdown`), so the player may have moved. Stand on e2 again.
  await walkTo(white.page, 4, 1);
  const zoomed = await readout(white.page);
  check('zoomed to about 4x', zoomed.zoom.k > 3.5 && zoomed.zoom.k <= 6, zoomed.zoom);
  check('the pinch lifted nothing', zoomed.carry === null, zoomed.carry);
  check('the page itself did not zoom', zoomed.pageScale === 1, zoomed.pageScale);
  check('"Whole board" is showing', zoomed.controls, zoomed.controls);
  await white.page.screenshot({ path: `${OUT}/2-pinched.png` });

  step(3, 'Pan with one finger that lands on e2, a pawn in reach: it must not lift');
  const onPawn = await squareOnPage(white, 4, 1, 'w');
  await drag(white, onPawn, { x: onPawn.x + 70, y: onPawn.y - 50 });
  await white.page.waitForTimeout(600);
  const panned = await readout(white.page);
  check('the view moved', panned.zoom.tx !== zoomed.zoom.tx || panned.zoom.ty !== zoomed.zoom.ty, panned.zoom);
  check('the pan lifted nothing', panned.carry === null, panned.carry);
  check('no refusal was provoked either', panned.notice === null, panned.notice);
  check('"Follow me" is offered once panned by hand', panned.followButton, panned.followButton);
  check('the simulator did not teleport under a zoomed pan', panned.square === 'e2', panned.square);
  await white.page.screenshot({ path: `${OUT}/3-panned.png` });

  step(4, 'Tap e2 on the zoomed board: the pawn is lifted');
  const e2Zoomed = await squareOnPage(white, 4, 1, 'w');
  await tap(white, e2Zoomed);
  await white.page.waitForFunction(
    () => document.querySelector('[data-carry]')?.textContent?.startsWith('e2'),
    { timeout: 5_000 },
  ).catch(() => {});
  const lifted = await readout(white.page);
  check('e2 is in hand', lifted.carry?.startsWith('e2') ?? false, lifted.carry);
  await white.page.waitForTimeout(500);
  await white.page.screenshot({ path: `${OUT}/4-lifted-zoomed.png` });

  step(5, 'Pinch again while carrying: nothing is placed or put back');
  await white.page.evaluate(() => window.scrollTo(0, 0));
  const box5 = await canvasBox(white.page);
  await pinch(white, { x: box5.x + box5.width / 2, y: box5.y + box5.height / 2 }, 120, 60);
  await white.page.waitForTimeout(600);
  const still = await readout(white.page);
  check('still carrying e2', still.carry?.startsWith('e2') ?? false, still.carry);
  check('zoomed out a little, not past 1x', still.zoom.k >= 1 && still.zoom.k < lifted.zoom.k, still.zoom);

  step(6, 'Walk to e4, tap "Follow me", and tap e4 on the zoomed board: the move is made');
  await walkTo(white.page, 4, 3);
  await white.page.locator('[data-zoom-follow]').tap();
  await white.page.waitForTimeout(200);
  const followed = await readout(white.page);
  const e4Centre = await squareOnPage(white, 4, 3, 'w');
  const box6 = await canvasBox(white.page);
  check(
    '"Follow me" puts you in the middle and hides itself',
    !followed.followButton &&
      Math.abs(e4Centre.x - (box6.x + box6.width / 2)) < box6.width * 0.3 &&
      Math.abs(e4Centre.y - (box6.y + box6.height / 2)) < box6.height * 0.3,
    { zoom: followed.zoom, e4: e4Centre, box: box6 },
  );
  const e4 = await squareOnPage(white, 4, 3, 'w');
  await tap(white, e4);
  await white.page.waitForFunction(
    () => document.querySelector('[data-prompt]')?.textContent?.includes('opponent'),
    { timeout: 5_000 },
  ).catch(() => {});
  const placed = await readout(white.page);
  check('placed, and it is Black’s turn', placed.carry === null && /opponent/.test(placed.prompt ?? ''), placed);
  await white.page.waitForTimeout(400);
  await white.page.screenshot({ path: `${OUT}/5-placed-zoomed.png` });

  step(7, '"Whole board" puts it back');
  await white.page.locator('[data-zoom-reset]').tap();
  await white.page.waitForTimeout(200);
  const reset = await readout(white.page);
  check('1x again', reset.zoom.k === 1 && reset.zoom.tx === 0 && reset.zoom.ty === 0, reset.zoom);
  check('the buttons are gone', !reset.controls, reset.controls);
  await white.page.screenshot({ path: `${OUT}/6-reset.png` });

  step(8, 'Black, the other way up, zooms in on itself, is followed as it walks, and lifts e7');
  await walkTo(black.page, 4, 6); // e7
  const e7b = await squareOnPage(black, 4, 6, 'b');
  await pinch(black, e7b, 40, 200);
  await walkTo(black.page, 4, 6); // the pinch's first finger was a simulator drag
  const bz = await readout(black.page);
  check('black zoomed, and still following', bz.zoom.k > 4 && !bz.followButton, bz);
  await walkTo(black.page, 4, 4); // e5, two squares away: off a 5x view
  await black.page.waitForTimeout(300);
  const e5 = await squareOnPage(black, 4, 4, 'b');
  const boxB = await canvasBox(black.page);
  check(
    'the view followed black to e5',
    e5.x > boxB.x && e5.x < boxB.x + boxB.width && e5.y > boxB.y && e5.y < boxB.y + boxB.height,
    { e5, box: boxB, zoom: (await readout(black.page)).zoom },
  );
  await black.page.screenshot({ path: `${OUT}/7-black-followed.png` });
  await walkTo(black.page, 4, 6);
  await black.page.waitForTimeout(300);
  const e7 = await squareOnPage(black, 4, 6, 'b');
  await tap(black, e7);
  await black.page.waitForFunction(
    () => document.querySelector('[data-carry]')?.textContent?.startsWith('e7'),
    { timeout: 5_000 },
  ).catch(() => {});
  const bl = await readout(black.page);
  check('black lifts e7 through its own zoomed view', bl.carry?.startsWith('e7') ?? false, bl.carry);
  await black.page.waitForTimeout(400);
  await black.page.screenshot({ path: `${OUT}/8-black-lifted.png` });

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  console.log(`Screenshots in ${OUT}`);
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
