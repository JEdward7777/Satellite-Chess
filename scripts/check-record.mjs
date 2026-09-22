/**
 * The permanent record, after a real game (stage 2.3.5).
 *
 * Two simulated phones play Fool's mate — four moves, every one of them walked
 * rather than teleported, so the phones' own distance counters are running —
 * and then each opens the account screen and reads its record. What this proves
 * that the unit and Durable Object tests cannot:
 *
 * - **The whole chain is connected.** A distance measured by the page, relayed
 *   with its counter's label, credited by the game, carried to the account when
 *   the game ends, and drawn on the account screen. Each link is tested alone
 *   elsewhere; this is the only place they are tested together.
 * - **Only walking during play counts** (decision 0040). Black walks the length
 *   of the board to reach its back rank before the game starts, so black's
 *   phone has counted far more than black's record may show.
 * - **The headline is distance** (decision 0019): it comes before the count of
 *   games on the screen, and the honesty sentences (O-03, O-12) are there.
 * - **The privacy statement opens** and says what an opponent sees.
 * - **No signal is a sentence, not a blank**: the record offline, then again
 *   with a connection through "Try again".
 *
 * ## Running it
 *
 * Needs a server from an empty state (O-19) and the dev seam:
 *
 *     npm run build:client
 *     npx wrangler dev --port 8799 --var DEV_AUTH_SECRET:local-dev-secret \
 *       --persist-to "$(mktemp -d)" &
 *     node scripts/check-record.mjs [--base=http://127.0.0.1:8799/?sim=1]
 *
 * Takes about a minute: the pieces are carried at a jog.
 */

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

import { signIn } from './driver-signin.mjs';

const args = new Map(
  process.argv.slice(2).map((a) => {
    // Split at the first `=` only: the base URL carries `?sim=1` (O-24).
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length > 0 ? rest.join('=') : 'true'];
  }),
);
const BASE = args.get('base') ?? 'http://127.0.0.1:8799/?sim=1';
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-record-'));

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
const M_PER_DEG_LAT = (6378137 * Math.PI) / 180; // as in shared/geo.ts
const FILES = 'abcdefgh';
/** A jog: fast enough to keep the run short, slow enough to be a plausible carry. */
const JOG_MPS = 4;

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

/** Board pixels for a square, as `render.ts` lays the board out. */
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

async function newPhone(browser, name) {
  const context = await browser.newContext({ viewport: { width: 480, height: 900 } });
  await signIn(context, `sim-record-${name}-${Date.now()}`, new URL(BASE).origin, name);
  await context.addInitScript(
    ({ field }) => {
      const req = indexedDB.open('satellite-chess', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('fields')) {
          db.createObjectStore('fields', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => {
        req.result.transaction('fields', 'readwrite').objectStore('fields').put(field);
      };
    },
    { field: FIELD },
  );
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [${name}] console error: ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`  [${name}] page error: ${e.message}`));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-calibrate]', { timeout: 15_000 });
  return { context, page, name };
}

/** Walk — not teleport — so the phone's distance counter sees every meter. */
async function walk(page, file, rank) {
  await page.evaluate(
    ({ pos, speedMps }) => globalThis.satchess.me.walkTo(pos, { speedMps }),
    { pos: squareLatLng(file, rank), speedMps: JOG_MPS },
  );
  await page.waitForFunction(
    (sq) =>
      !globalThis.satchess.me.walking &&
      document.querySelector('[data-square]')?.textContent === sq,
    FILES[file] + String(rank + 1),
    { timeout: 40_000 },
  );
}

/** Tap without moving: a bare `pointerup`, which `attachSimDrag` ignores. */
async function tap(page, file, rank, orientation) {
  const box = await page.locator('[data-board]').boundingBox();
  const p = squareToPixel(file, rank, orientation, box.width, box.height);
  await page.evaluate(
    ({ x, y }) => {
      const canvas = document.querySelector('[data-board]');
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new PointerEvent('pointerup', {
          clientX: rect.left + x,
          clientY: rect.top + y,
          bubbles: true,
          pointerId: 1,
        }),
      );
    },
    { x: p.x, y: p.y },
  );
}

const sq = (name) => [FILES.indexOf(name[0]), Number(name[1]) - 1];

/** Lift at `from`, carry at a jog, place at `to`, and wait for the server. */
async function play(phone, orientation, from, to, san, other) {
  await walk(phone.page, ...sq(from));
  await tap(phone.page, ...sq(from), orientation);
  await phone.page.waitForFunction(() => {
    const el = document.querySelector('[data-carry]');
    return el !== null && !el.hidden;
  }, null, { timeout: 10_000 });
  await walk(phone.page, ...sq(to));
  await tap(phone.page, ...sq(to), orientation);
  // The opponent's screen hears about it only from the server, so this is
  // the server's word that the move was played rather than the page's hope.
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

/** "840 m" or "2.4 km", in meters. */
function metersIn(words) {
  const m = /([\d.]+)\s*(km|m)\b/.exec(words ?? '');
  if (!m) return null;
  return Number(m[1]) * (m[2] === 'km' ? 1000 : 1);
}

async function openRecord(page) {
  await page.click('[data-leave]').catch(() => undefined);
  await page.waitForSelector('[data-account]', { timeout: 15_000 });
  await page.click('[data-account]');
  await page.waitForSelector('[data-record]', { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector('[data-record-loading]') === null, null, {
    timeout: 15_000,
  });
}

const browser = await chromium.launch({ executablePath: findChromium() });

try {
  console.log(`screenshots -> ${OUT}`);

  step(1, 'Two phones; white creates a game on an 8 m field, black joins');
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

  step(2, 'Black walks the length of the board to e8 before the start — which must not count');
  await walk(black.page, 4, 7);
  await white.page.waitForFunction(
    () => /Your move/.test(document.querySelector('[data-prompt]')?.textContent ?? ''),
    null,
    { timeout: 20_000 },
  );
  const blackBeforeStart = await black.page.evaluate(() => globalThis.satchess.me.state.distanceM);
  check(blackBeforeStart > 40, 'black’s phone counted the walk to its back rank', `${Math.round(blackBeforeStart)} m`);

  step(3, 'Fool’s mate, every piece carried: 1. f3 e5 2. g4 Qh4#');
  await play(white, 'w', 'f2', 'f3', 'f3', black);
  await play(black, 'b', 'e7', 'e5', 'e5', white);
  await play(white, 'w', 'g2', 'g4', 'g4', black);
  await play(black, 'b', 'd8', 'h4', 'Qh4#', white);
  await white.page.waitForFunction(
    () => /checkmate/i.test(document.querySelector('[data-prompt]')?.textContent ?? ''),
    null,
    { timeout: 15_000 },
  );
  check(true, 'the game is over', await text(white.page, '[data-prompt]'));
  const blackPhoneTotal = await black.page.evaluate(() => globalThis.satchess.me.state.distanceM);
  const whitePhoneTotal = await white.page.evaluate(() => globalThis.satchess.me.state.distanceM);
  console.log(`   phone counters: white ${Math.round(whitePhoneTotal)} m, black ${Math.round(blackPhoneTotal)} m`);
  await white.page.screenshot({ path: `${OUT}/1-mated.png` });

  step(4, 'Black opens its record: a win, led by distance, without the walk to e8');
  await openRecord(black.page);
  const blackHeadline = await text(black.page, '[data-record-distance]');
  const blackRecordM = metersIn(blackHeadline);
  check(blackRecordM !== null && blackRecordM > 0, 'black’s record shows meters walked', blackHeadline);
  check(
    blackRecordM !== null && blackRecordM < blackPhoneTotal - 30,
    'and less than the phone counted, by at least the walk before the start',
    `record ${blackRecordM} m, phone ${Math.round(blackPhoneTotal)} m`,
  );
  check(/1 won · 0 drawn · 0 lost/.test((await text(black.page, '[data-record-results]')) ?? ''), 'one win', await text(black.page, '[data-record-results]'));
  const carry = metersIn(await text(black.page, '[data-record-carry]'));
  check(carry !== null && carry > 30, 'the queen’s carry is the longest', `${carry} m`);
  const coverage = await text(black.page, '[data-record-coverage]');
  check(/Walked across 1 game/.test(coverage ?? ''), 'the count of games is the sentence under it', coverage);
  // What the credit rule leaks or loses against the phone's own counter for the
  // same stretch: the smoothing lag either side of the start, and the walking
  // after the last relay. Informational — it is the number `gotchas.md` quotes.
  // Read the record's own number rather than the rounded headline, so the
  // residue is not a difference between two roundings.
  const creditedM = await black.page.evaluate(async () => {
    const body = await (await fetch('/api/record')).json();
    return body.record.totals.travelM;
  });
  const phoneSinceStart = blackPhoneTotal - blackBeforeStart;
  console.log(
    `   credited ${creditedM.toFixed(1)} m against ${phoneSinceStart.toFixed(1)} m counted by ` +
      `the phone since the start: ${(creditedM - phoneSinceStart).toFixed(1)} m`,
  );
  const order = await black.page.evaluate(() => {
    const all = [...document.querySelectorAll('[data-record] *')];
    return {
      distance: all.indexOf(document.querySelector('[data-record-distance]')),
      coverage: all.indexOf(document.querySelector('[data-record-coverage]')),
      fontPx: Number.parseFloat(getComputedStyle(document.querySelector('[data-record-distance]')).fontSize),
      bodyPx: Number.parseFloat(getComputedStyle(document.querySelector('[data-record-coverage]')).fontSize),
    };
  });
  check(order.distance >= 0 && order.distance < order.coverage, 'distance comes first');
  check(order.fontPx > 2 * order.bodyPx, 'and is the largest thing there', `${order.fontPx}px vs ${order.bodyPx}px`);
  const game = await text(black.page, `[data-record-game="${code}"]`);
  check(/Sim Field/.test(game ?? '') && /Won — checkmate/.test(game ?? ''), 'the game is listed', game);
  const honesty = await text(black.page, '[data-record-honesty]');
  check(/taken on trust/.test(honesty ?? '') && /leans short/.test(honesty ?? ''), 'it says how far to trust the number (O-03, O-12)');
  await black.page.screenshot({ path: `${OUT}/2-black-record.png`, fullPage: true });

  step(5, 'White’s record: a loss, and its own distance');
  await openRecord(white.page);
  const whiteHeadline = await text(white.page, '[data-record-distance]');
  const whiteRecordM = metersIn(whiteHeadline);
  check(whiteRecordM !== null && whiteRecordM > 0 && whiteRecordM <= whitePhoneTotal + 1, 'white’s meters walked', `${whiteHeadline}, phone ${Math.round(whitePhoneTotal)} m`);
  check(/0 won · 0 drawn · 1 lost/.test((await text(white.page, '[data-record-results]')) ?? ''), 'one loss');

  step(6, 'The privacy statement opens and says what an opponent sees');
  await white.page.click('[data-privacy] summary');
  const privacy = await text(white.page, '[data-privacy]');
  check(/Your opponent sees where you are/.test(privacy ?? ''), 'what an opponent sees');
  check(/no coordinates/.test(privacy ?? ''), 'what the record holds');
  check(/Not possible yet/.test(privacy ?? ''), 'and what cannot be done yet');
  await white.page.screenshot({ path: `${OUT}/3-white-record-privacy.png`, fullPage: true });

  step(7, 'Offline, the record says so; back online, "Try again" fetches it');
  await white.page.click('[data-back]');
  await white.page.waitForSelector('[data-account]', { timeout: 15_000 });
  await white.context.setOffline(true);
  await white.page.click('[data-account]');
  await white.page.waitForSelector('[data-record-unavailable="offline"]', { timeout: 15_000 });
  check(true, 'no signal is a sentence', await text(white.page, '[data-record-unavailable]'));
  await white.page.screenshot({ path: `${OUT}/4-offline.png` });
  await white.context.setOffline(false);
  await white.page.click('[data-record-retry]');
  await white.page.waitForSelector('[data-record-distance]', { timeout: 15_000 });
  check(metersIn(await text(white.page, '[data-record-distance]')) === whiteRecordM, 'and the same record comes back');

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  console.log(`Screenshots in ${OUT}`);
} catch (error) {
  failures += 1;
  console.error(error);
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const said = await page
        .evaluate(() => ({
          url: location.pathname,
          prompt: document.querySelector('[data-prompt]')?.textContent,
          notice: document.querySelector('[data-notice]')?.textContent,
          square: document.querySelector('[data-square]')?.textContent,
          carry: document.querySelector('[data-carry]')?.textContent,
          record: document.querySelector('[data-record]')?.textContent?.replace(/\s+/g, ' '),
        }))
        .catch(() => null);
      console.error(`   screen: ${JSON.stringify(said)}`);
    }
  }
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
