/**
 * The carried piece travels with the carrier's dot (O-44, stage 10.10).
 *
 * The placement arithmetic is unit-tested (`inHandPlacement` in
 * `test/render.test.ts`, `carrierPosition` in `test/game.test.ts`). What only a
 * browser can say is that both phones actually draw it: my own carry on my own
 * dot, the opponent's on their relayed dot, gone again after a drop and a
 * place, from both seats and in both piece looks, **not** on a hollow dot
 * once the carrier has dropped off the air, and that a tap on the plate places
 * nothing.
 *
 * The check reads pixels: the plate a piece in hand sits on is `#f4efdc`, ringed
 * in the carrier's color (`#0d1117` for mine, `#ff4d6d` for theirs), and it
 * sits up and to the right of the dot. The ring is the same red as the opponent's dot, so
 * `drive-game.mjs`'s `opponentDot()` centroid would be pulled upward if it were
 * ever read mid-carry; this driver aims at squares instead.
 *
 *     node scripts/check-carry.mjs --base=http://127.0.0.1:8799/?sim=1 --out=/tmp/carry
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
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-carry-'));

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

/** `projectionFor` from client/render.ts, replayed at 1x: a square's centre and the scale. */
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
  return { x: offsetX + u * scale, y: offsetY + v * scale, scale };
}

/** `inHandPlacement` from client/render.ts, for a carrier standing on a square's centre. */
function plateOver(file, rank, orientation, w, h) {
  const p = squareToPixel(file, rank, orientation, w, h);
  const box = SQUARE_M * p.scale * 0.94; // pieceBoxPx on a square board
  const size = Math.max(22, Math.min(44, box * 0.85));
  const plateRadius = size * 0.62;
  const step = (7 + 2 + plateRadius) / Math.SQRT2;
  const up = p.y - step - plateRadius >= 0;
  const right = p.x + step + plateRadius <= w;
  return { x: right ? p.x + step : p.x - step, y: up ? p.y - step : p.y + step, size, plateRadius };
}

async function newPhone(browser, name) {
  const context = await browser.newContext({ viewport: { width: 480, height: 900 } });
  await signIn(context, `sim-carry-${name}`, new URL(BASE).origin, name);
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
  return { context, page, name };
}

/** Teleport, and wait for the app to believe it (the fix lags a second). */
async function walkTo(page, file, rank) {
  await page.evaluate((pos) => globalThis.satchess.me.moveTo(pos), squareLatLng(file, rank));
  await page.waitForFunction(
    (sq) => document.querySelector('[data-square]')?.textContent === sq,
    FILES[file] + String(rank + 1),
    { timeout: 10_000 },
  );
}

/** A non-primary `pointerdown`/`pointerup` pair: a tap the simulator ignores. */
async function tapSquare(page, file, rank, orientation) {
  const box = await page.locator('[data-board]').boundingBox();
  const p = squareToPixel(file, rank, orientation, box.width, box.height);
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

const carryText = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-carry]');
    return !el || el.hidden ? null : el.textContent;
  });

/**
 * Is there a plate over the carrier on `square`, ringed in `ring`?
 *
 * Samples the plate's cream just inside its rim (outside the piece's box) and
 * the ring on its rim, each over a small neighbourhood to forgive
 * antialiasing, on the left and right both.
 */
async function plateAt(page, file, rank, orientation, ring) {
  const box = await page.locator('[data-board]').boundingBox();
  const at = plateOver(file, rank, orientation, box.width, box.height);
  return page.evaluate(
    ({ at, ring }) => {
      const canvas = document.querySelector('[data-board]');
      const dpr = canvas.width / canvas.clientWidth;
      const ctx = canvas.getContext('2d');
      const near = (x, y, rgb, tol) => {
        const px = Math.round(x * dpr);
        const py = Math.round(y * dpr);
        const { data } = ctx.getImageData(px - 2, py - 2, 5, 5);
        for (let i = 0; i < data.length; i += 4) {
          if (
            Math.abs(data[i] - rgb[0]) <= tol &&
            Math.abs(data[i + 1] - rgb[1]) <= tol &&
            Math.abs(data[i + 2] - rgb[2]) <= tol
          )
            return true;
        }
        return false;
      };
      const cream = [244, 239, 220];
      const inside = at.size * 0.56;
      return {
        plate: near(at.x - inside, at.y, cream, 6) && near(at.x + inside, at.y, cream, 6),
        ring: near(at.x - at.plateRadius, at.y, ring, 30) && near(at.x + at.plateRadius, at.y, ring, 30),
      };
    },
    { at, ring },
  );
}

/** A plate, ringed in the expected color. */
const shown = (seen) => seen.plate && seen.ring;

const MINE = [13, 17, 23];
const THEIRS = [255, 77, 109];

let failures = 0;
function check(label, ok, detail) {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}
const step = (n, msg) => console.log(`\n${n}. ${msg}`);

/** Poll a plate check until it matches `want`, for a relay that takes seconds to land. */
async function waitForPlate(page, file, rank, orientation, ring, want, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  let seen;
  do {
    seen = await plateAt(page, file, rank, orientation, ring);
    if (shown(seen) === want) return seen;
    await page.waitForTimeout(250);
  } while (Date.now() < until);
  return seen;
}

const browser = await chromium.launch({ executablePath: findChromium() });

try {
  console.log(`screenshots -> ${OUT}`);

  step(1, 'Two phones start a game');
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
  await walkTo(white.page, 4, 0);
  await walkTo(black.page, 4, 7);
  await white.page.waitForFunction(
    () => document.querySelector('[data-prompt]')?.textContent?.includes('Your move'),
    { timeout: 20_000 },
  );
  check('no plate before anything is lifted', !(await plateAt(white.page, 4, 0, 'w', MINE)).plate);

  step(2, 'White lifts e2 and walks to e3: the pawn goes with the dot on both phones');
  await walkTo(white.page, 4, 1);
  await tapSquare(white.page, 4, 1, 'w');
  await white.page.waitForFunction(() => document.querySelector('[data-carry]')?.textContent?.startsWith('e2'), {
    timeout: 5_000,
  });
  await walkTo(white.page, 4, 2);
  check('white: my pawn is on a plate over my dot on e3', shown(await waitForPlate(white.page, 4, 2, 'w', MINE, true)));
  check(
    'black: white’s pawn is on a red-ringed plate over their dot on e3',
    shown(await waitForPlate(black.page, 4, 2, 'b', THEIRS, true)),
  );
  await white.page.waitForTimeout(300);
  await white.page.screenshot({ path: `${OUT}/1-white-own-carry.png` });
  await black.page.screenshot({ path: `${OUT}/2-black-sees-white-carry.png` });

  step(3, 'White taps the pawn on its plate: nothing is placed, and the phone says why');
  // The plate's centre is over e3 — a legal destination — so a tap that fell
  // through to the square underneath would play e2–e3.
  {
    const box = await white.page.locator('[data-board]').boundingBox();
    const at = plateOver(4, 2, 'w', box.width, box.height);
    await white.page.evaluate(
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
      { x: at.x, y: at.y },
    );
    await white.page.waitForTimeout(800);
    check('white: still carrying e2', (await carryText(white.page))?.startsWith('e2') ?? false);
    const notice = await white.page.evaluate(() => {
      const el = document.querySelector('[data-notice]');
      return !el || el.hidden ? null : el.textContent;
    });
    check('white: told it is the piece in hand', notice?.includes('piece in your hand') ?? false, notice);
    await white.page.screenshot({ path: `${OUT}/2b-white-tapped-plate.png` });
  }

  step(4, 'The same carry, on pieces as discs');
  for (const phone of [white, black]) await phone.page.click('[data-look="disc"]');
  await white.page.waitForTimeout(400);
  check('white, discs: still on the plate', shown(await plateAt(white.page, 4, 2, 'w', MINE)));
  check('black, discs: still on the plate', shown(await plateAt(black.page, 4, 2, 'b', THEIRS)));
  await white.page.screenshot({ path: `${OUT}/3-white-own-carry-discs.png` });
  await black.page.screenshot({ path: `${OUT}/4-black-sees-white-carry-discs.png` });
  for (const phone of [white, black]) await phone.page.click('[data-look="standard"]');

  step(5, 'White walks back and puts the pawn back: the plate goes on both phones');
  await walkTo(white.page, 4, 1);
  await tapSquare(white.page, 4, 1, 'w');
  await white.page.waitForFunction(() => document.querySelector('[data-carry]')?.hidden !== false, {
    timeout: 5_000,
  });
  check('white: nothing in hand', (await carryText(white.page)) === null);
  const after = await white.page.evaluate(() => {
    const el = document.querySelector('[data-notice]');
    return !el || el.hidden ? null : el.textContent;
  });
  check('white: the plate hint went with the carry', !(after ?? '').includes('piece in your hand'), after);
  check('white: no plate', (await waitForPlate(white.page, 4, 1, 'w', MINE, false)).plate === false);
  check('black: no plate', (await waitForPlate(black.page, 4, 1, 'b', THEIRS, false)).plate === false);

  step(6, 'White plays e2–e4; then Black lifts d7 and walks to d6');
  await tapSquare(white.page, 4, 1, 'w');
  await white.page.waitForFunction(() => document.querySelector('[data-carry]')?.textContent?.startsWith('e2'), {
    timeout: 5_000,
  });
  await walkTo(white.page, 4, 3);
  await white.page.waitForTimeout(600);
  await tapSquare(white.page, 4, 3, 'w');
  await black.page.waitForFunction(
    () => document.querySelector('[data-prompt]')?.textContent?.includes('Your move'),
    { timeout: 10_000 },
  );
  check('white: the plate went with the place', (await plateAt(white.page, 4, 3, 'w', MINE)).plate === false);
  await walkTo(black.page, 3, 6);
  await tapSquare(black.page, 3, 6, 'b');
  await black.page.waitForFunction(() => document.querySelector('[data-carry]')?.textContent?.startsWith('d7'), {
    timeout: 5_000,
  });
  await walkTo(black.page, 3, 5);
  check('black: my pawn is on my dot on d6', shown(await waitForPlate(black.page, 3, 5, 'b', MINE, true)));
  check('white: black’s pawn is on their dot on d6', shown(await waitForPlate(white.page, 3, 5, 'w', THEIRS, true)));
  await black.page.waitForTimeout(300);
  await black.page.screenshot({ path: `${OUT}/5-black-own-carry.png` });
  await white.page.screenshot({ path: `${OUT}/6-white-sees-black-carry.png` });

  step(7, 'Black drops off the air mid-carry: white keeps the pawn on d7, faint, and off the hollow dot');
  await black.context.close();
  const gone = await waitForPlate(white.page, 3, 5, 'w', THEIRS, false);
  check('white: no plate on the hollow dot', gone.plate === false, gone);
  check('white: the carry itself is still shown', (await carryText(white.page))?.startsWith('d7') ?? false);
  await white.page.screenshot({ path: `${OUT}/7-white-carrier-gone.png` });

  console.log(failures === 0 ? `\nAll checks passed. Screenshots in ${OUT}` : `\n${failures} check(s) FAILED.`);
} finally {
  await browser.close();
}
process.exitCode = failures === 0 ? 0 : 1;
