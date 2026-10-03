/**
 * Feet, yards and miles, driven in a browser (O-21, stage 2.3.8, decision 0049).
 *
 * What this proves that the unit and Worker tests cannot:
 *
 * - **An account that has never chosen follows its browser.** Headless
 *   Chromium is `en-US`, so a fresh account reads feet without being asked;
 *   an `en-GB` one reads meters.
 * - **The choice is the account's, not the phone's.** Picked on one phone, it
 *   is what a second phone signed in as the same account shows, whatever that
 *   phone's own locale — and another account on the same server is untouched.
 * - **Every screen that shows a distance says it in the chosen units**: home,
 *   calibration (the size hint, the accuracy, the review), the create screen,
 *   the board's readout, a refusal the *server* wrote, the review after a game
 *   and the record. The server's refusal is the interesting one: it is sent in
 *   meters with the figures beside it, and the phone says it again in feet.
 * - **A choice made with no signal is kept and delivered.** Chosen offline it
 *   is shown at once and marked as not yet on the account; the next launch
 *   with a connection sends it, and the other phone then shows it.
 * - **Nothing underneath moves.** The PGN still says meters.
 *
 * ## Running it
 *
 *     npm run build:client
 *     npx wrangler dev --port 8799 --var DEV_AUTH_SECRET:local-dev-secret \
 *       --persist-to "$(mktemp -d)" &
 *     node scripts/check-units.mjs [--base=http://127.0.0.1:8799/?sim=1] [--out=DIR]
 *
 * Takes about a minute and a half: Fool's mate is carried at a jog.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
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
const ORIGIN = new URL(BASE).origin;
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-units-'));
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
const M_PER_DEG_LAT = (6378137 * Math.PI) / 180; // as in shared/geo.ts
const FILES = 'abcdefgh';
const JOG_MPS = 4;
/** Ten yards, the square an American would pace out (O-21's design note). */
const TEN_YARDS_M = 9.144;

function latLngAt(e, n) {
  return {
    lat: A1.lat + n / M_PER_DEG_LAT,
    lng: A1.lng + e / (M_PER_DEG_LAT * Math.cos((A1.lat * Math.PI) / 180)),
  };
}
const squareLatLng = (file, rank) => latLngAt(file * SQUARE_M, rank * SQUARE_M);

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
const shots = [];
async function shot(page, name) {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  shots.push(path);
}

/** Metric or US, as written on a screen: any of these units, after a digit. */
const FEET = /\d ?(ft|yd|mi)\b/;
const METRIC = /\d ?(m|km)\b/;

async function newPhone(browser, sub, locale, label) {
  const context = await browser.newContext({ viewport: { width: 480, height: 900 }, locale });
  await signIn(context, sub, ORIGIN, label);
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
    if (m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text())) {
      console.log(`  [${label}] console error: ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => {
    console.log(`  [${label}] page error: ${e.message}`);
    failures += 1;
  });
  await home(page);
  return { context, page, label };
}

async function home(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-calibrate]', { timeout: 15_000 });
  // The field list is drawn from the phone's store once the launch is done.
  await page.waitForSelector('[data-field]', { timeout: 15_000 });
}

const text = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    return !el || el.hidden ? null : el.textContent.replace(/\s+/g, ' ').trim();
  }, sel);

async function waitText(page, sel, pattern, timeout = 10_000) {
  await page
    .waitForFunction(
      ({ s, source }) => new RegExp(source).test(document.querySelector(s)?.textContent ?? ''),
      { s: sel, source: pattern.source },
      { timeout },
    )
    .catch(() => undefined);
  return text(page, sel);
}

async function openAccount(page) {
  await page.click('[data-account]');
  await page.waitForSelector('[data-units-status]', { timeout: 15_000 });
}

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
  // The simulator emits once a second, so the dot can still be a step short
  // of the centre when the square readout flips — and the piece in hand is
  // drawn up and to the right of the dot, where a tap on the square being
  // walked towards lands on the plate and is ignored (decision 0048). One
  // more fix puts the dot on the centre.
  await page.waitForTimeout(1_200);
}

async function tap(page, file, rank, orientation) {
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

const sq = (name) => [FILES.indexOf(name[0]), Number(name[1]) - 1];

async function play(phone, orientation, from, to, other) {
  await walk(phone.page, ...sq(from));
  await tap(phone.page, ...sq(from), orientation);
  await phone.page.waitForFunction(() => {
    const el = document.querySelector('[data-carry]');
    return el !== null && !el.hidden;
  }, null, { timeout: 10_000 });
  await walk(phone.page, ...sq(to));
  await tap(phone.page, ...sq(to), orientation);
  await other.page
    .waitForFunction(
      () => /Your move|won|lost|drawn|checkmate/i.test(document.querySelector('[data-prompt]')?.textContent ?? ''),
      null,
      { timeout: 15_000 },
    )
    .catch(async (error) => {
      for (const who of [phone, other]) {
        console.log(`   [${who.label}] prompt: ${await text(who.page, '[data-prompt]')} · notice: ${await text(who.page, '[data-notice]')}`);
        await shot(who.page, `fail-${who.label}`);
      }
      throw error;
    });
  console.log(`   played ${from}-${to}`);
}

async function openReview(page) {
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-review-open]');
    return b !== null && !b.hidden;
  }, null, { timeout: 15_000 });
  await page.click('[data-review-open]');
  await page.waitForSelector('[data-review-distance]', { timeout: 15_000 });
}

/**
 * Type a join code on home and join, surviving home redrawing itself.
 *
 * Home redraws when a field sync lands (`refreshHome` in `client/main.ts`),
 * and a redraw between the fill and the click wipes the typed code, so the
 * join goes nowhere and the board never appears. So: fill, check the box
 * still holds the code at the moment of the click, and if the board does not
 * come, go round again while home is still showing.
 */
async function joinByCode(page, code) {
  for (let attempt = 1; ; attempt++) {
    await page.waitForSelector('[data-code]', { timeout: 15_000 });
    await page.fill('[data-code]', code);
    const held = await page.inputValue('[data-code]');
    if (held.replace(/[^A-Za-z0-9]/g, '').toUpperCase() !== code.replace(/[^A-Za-z0-9]/g, '').toUpperCase()) {
      if (attempt >= 5) throw new Error(`the code box would not hold ${code} (it holds "${held}")`);
      continue;
    }
    await page.click('[data-join]');
    const joined = await page
      .waitForSelector('[data-board]', { timeout: attempt >= 5 ? 15_000 : 5_000 })
      .then(() => true)
      .catch(() => false);
    if (joined) return;
    if (attempt >= 5) throw new Error(`joining ${code} never reached the board`);
  }
}

const browser = await chromium.launch({ executablePath: findChromium() });
const stamp = Date.now();

try {
  console.log(`screenshots -> ${OUT}`);

  step(1, 'A fresh account in an en-US browser reads feet without being asked');
  const alice = await newPhone(browser, `sim-units-alice-${stamp}`, 'en-US', 'alice');
  const accuracy = await waitText(alice.page, '[data-accuracy]', /ft/);
  check(/^±\d+ ft$/.test(accuracy ?? ''), 'home: GPS accuracy in feet', accuracy);
  const fieldLine = await text(alice.page, '[data-field]');
  check(/26 ft squares · 70 yd a side/.test(fieldLine ?? ''), 'home: the field in feet and yards', fieldLine);
  check(/yd$/.test((await text(alice.page, '[data-distance]')) ?? ''), 'home: walked in yards', await text(alice.page, '[data-distance]'));
  await shot(alice.page, '1-home-us');

  await openAccount(alice.page);
  check(
    (await alice.page.getAttribute('[data-units-status]', 'data-units-status')) === 'default',
    'account: says it was picked from the language setting',
    await text(alice.page, '[data-units-status]'),
  );
  check(
    (await alice.page.getAttribute('[data-units="us"]', 'aria-pressed')) === 'true',
    'account: US is the one lit',
  );

  step(2, 'An en-GB account reads meters, and a different account is its own');
  const bob = await newPhone(browser, `sim-units-bob-${stamp}`, 'en-GB', 'bob');
  const bobAccuracy = await waitText(bob.page, '[data-accuracy]', /m$/);
  check(/^±\d+ m$/.test(bobAccuracy ?? ''), 'bob’s home: accuracy in meters', bobAccuracy);
  check(/8\.0 m squares · 64 m a side/.test((await text(bob.page, '[data-field]')) ?? ''), 'bob’s home: the field in meters', await text(bob.page, '[data-field]'));

  step(3, 'Alice switches to metric and back; the account keeps it');
  await alice.page.click('[data-units="metric"]');
  const savedMetric = await waitText(alice.page, '[data-units-status]', /Saved to your account/);
  check(/Saved to your account/.test(savedMetric ?? ''), 'metric is saved to the account', savedMetric);
  await alice.page.click('[data-back]');
  await alice.page.waitForSelector('[data-field]', { timeout: 15_000 });
  check(/8\.0 m squares/.test((await text(alice.page, '[data-field]')) ?? ''), 'home redraws in meters', await text(alice.page, '[data-field]'));
  await openAccount(alice.page);
  await alice.page.click('[data-units="us"]');
  const savedUs = await waitText(alice.page, '[data-units-status]', /Saved to your account/);
  check(
    (await alice.page.getAttribute('[data-units-status]', 'data-units-status')) === 'saved',
    'US is saved to the account',
    savedUs,
  );
  await shot(alice.page, '2-account-us');

  step(4, 'Alice’s second phone, in an en-GB browser, follows the account');
  const alice2 = await newPhone(browser, `sim-units-alice-${stamp}`, 'en-GB', 'alice-2');
  check(/26 ft squares/.test((await waitText(alice2.page, '[data-field]', /ft/)) ?? ''), 'the second phone shows feet', await text(alice2.page, '[data-field]'));
  const bobAgain = await (async () => {
    await home(bob.page);
    return text(bob.page, '[data-field]');
  })();
  check(/m squares/.test(bobAgain ?? ''), 'bob is still in meters', bobAgain);

  step(5, 'Calibration: the size hint in round yards, and the review in feet');
  await alice.page.click('[data-back]');
  await alice.page.waitForSelector('[data-calibrate]', { timeout: 15_000 });
  await alice.page.click('[data-calibrate]');
  await alice.page.waitForSelector('[data-tap]', { timeout: 15_000 });
  const hint = await text(alice.page, '[data-size-hint]');
  check(/5 to 10 yards/.test(hint ?? '') && /40 to 80 yards/.test(hint ?? ''), 'the hint offers round yards', hint);
  check(/ft$/.test((await waitText(alice.page, '[data-accuracy]', /ft/)) ?? ''), 'accuracy in feet', await text(alice.page, '[data-accuracy]'));
  await shot(alice.page, '3-calibrate-us');
  // Ten-yard squares, walked corner by corner.
  for (const [file, rank] of [[0, 0], [7, 0], [7, 7], [0, 7]]) {
    await alice.page.evaluate((pos) => globalThis.satchess.me.moveTo(pos), latLngAt(file * TEN_YARDS_M, rank * TEN_YARDS_M));
    await alice.page.waitForTimeout(1400);
    await alice.page.waitForFunction(
      () => document.querySelector('[data-tap]')?.hasAttribute('disabled') === false,
      undefined,
      { timeout: 15_000 },
    );
    await alice.page.click('[data-tap]');
    await alice.page.waitForTimeout(150);
  }
  await alice.page.waitForSelector('[data-save]', { timeout: 15_000 });
  const squares = await text(alice.page, '[data-square]');
  const boardSize = await text(alice.page, '[data-board]');
  check(/^30 ft across$/.test(squares ?? ''), 'ten-yard squares read as 30 ft', squares);
  check(/^80 yd across$/.test(boardSize ?? ''), 'and the board as 80 yd', boardSize);
  check(/ft$/.test((await text(alice.page, '[data-residual]')) ?? ''), 'the corner fit in feet', await text(alice.page, '[data-residual]'));
  await shot(alice.page, '4-calibrate-review-us');
  await alice.page.click('[data-cancel]');
  await alice.page.waitForSelector('[data-new]', { timeout: 15_000 });

  step(6, 'The create screen says the field and the reach in feet');
  await alice.page.click('[data-new]');
  await alice.page.waitForSelector('[data-create]', { timeout: 15_000 });
  const size = await text(alice.page, '[data-field-size]');
  check(/26 ft squares · 70 yd a side/.test(size ?? ''), 'the field', size);
  const reachNote = await text(alice.page, '[data-reach-note]');
  check(/about 10 ft on this field/.test(reachNote ?? ''), 'the reach', reachNote);
  await shot(alice.page, '5-create-us');
  await alice.page.click('[data-create]');
  await alice.page.waitForSelector('[data-join-code]', { timeout: 15_000 });
  const code = await alice.page.getAttribute('[data-join-code]', 'data-join-code');
  console.log(`   join code ${code}`);
  await alice.page.click('[data-open]');
  await alice.page.waitForSelector('[data-board]', { timeout: 15_000 });
  await joinByCode(bob.page, code);

  step(7, 'A refusal the server wrote in meters reaches each player in their own units');
  await walk(alice.page, 3, 3); // d4, nowhere near the back rank
  await walk(bob.page, 3, 4); // d5
  await alice.page.click('[data-ready]');
  const aliceRefusal = await waitText(alice.page, '[data-notice]', /from your back rank/);
  check(/You are \d+(\.\d)? ft from your back rank and your reach is 10 ft\./.test(aliceRefusal ?? ''), 'alice reads feet', aliceRefusal);
  await shot(alice.page, '6-refusal-us');
  await bob.page.click('[data-ready]');
  const bobRefusal = await waitText(bob.page, '[data-notice]', /from your back rank/);
  check(/You are \d+(\.\d)? m from your back rank and your reach is 3\.2 m\./.test(bobRefusal ?? ''), 'bob reads meters', bobRefusal);
  const reach = await text(alice.page, '[data-reach]');
  check(/^10 ft · /.test(reach ?? ''), 'the board’s reach readout in feet', reach);

  step(8, 'Fool’s mate, carried: 1. f3 e5 2. g4 Qh4#');
  await walk(alice.page, 4, 0);
  await walk(bob.page, 4, 7);
  await alice.page.waitForFunction(
    () => /Your move/.test(document.querySelector('[data-prompt]')?.textContent ?? ''),
    null,
    { timeout: 20_000 },
  );
  await play(alice, 'w', 'f2', 'f3', bob);
  await play(bob, 'b', 'e7', 'e5', alice);
  // Mid-carry, the walk to the destination is in feet.
  await walk(alice.page, ...sq('g2'));
  await tap(alice.page, ...sq('g2'), 'w');
  await alice.page.waitForFunction(() => !document.querySelector('[data-carry]')?.hidden, null, { timeout: 10_000 });
  const carrying = await waitText(alice.page, '[data-prompt]', /ft to g/);
  check(/Walk [\d.]+ ft to g[34]/.test(carrying ?? '') || /in reach/.test(carrying ?? ''), 'the walk to a square is in feet', carrying);
  await shot(alice.page, '7-carry-us');
  await walk(alice.page, ...sq('g4'));
  await tap(alice.page, ...sq('g4'), 'w');
  await bob.page.waitForFunction(
    () => /Your move/.test(document.querySelector('[data-prompt]')?.textContent ?? ''),
    null,
    { timeout: 15_000 },
  );
  await play(bob, 'b', 'd8', 'h4', alice);
  await alice.page.waitForFunction(
    () => /checkmate/i.test(document.querySelector('[data-prompt]')?.textContent ?? ''),
    null,
    { timeout: 15_000 },
  );

  step(9, 'After the game: alice in yards, bob in meters, the file in meters');
  await openReview(alice.page);
  const headline = await text(alice.page, '[data-review-distance]');
  check(/^You covered [\d,.]+ (yd|mi)$/.test(headline ?? ''), 'alice’s headline', headline);
  const where = await text(alice.page, '[data-review-where]');
  check(/an? 70 yd board/.test(where ?? ''), 'the board in yards', where);
  const moves = await alice.page.evaluate(() =>
    [...document.querySelectorAll('[data-review-moves] li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
  );
  check(moves.length === 4 && moves.every((m) => /carried [\d,]+ yd/.test(m)), 'every carry in yards', JSON.stringify(moves));
  const pgn = await alice.page.$eval('[data-review-text]', (el) => el.value);
  check(/SatelliteBoardM "64"/.test(pgn) && /carry [\d.]+ m in/.test(pgn) && !/\b(ft|yd|mi)\b/.test(pgn), 'the PGN is still in meters (decision 0041)');
  await shot(alice.page, '8-review-us');
  await openReview(bob.page);
  check(/^You covered [\d.]+ (m|km)$/.test((await text(bob.page, '[data-review-distance]')) ?? ''), 'bob’s headline in meters', await text(bob.page, '[data-review-distance]'));

  step(10, 'The record, in yards');
  await home(alice.page);
  await openAccount(alice.page);
  const recordHeadline = await waitText(alice.page, '[data-record-distance]', /yd|mi/, 15_000);
  check(FEET.test(recordHeadline ?? '') && !METRIC.test(recordHeadline ?? ''), 'the headline', recordHeadline);
  check(/^70 yd/.test((await text(alice.page, '[data-record-biggest]')) ?? ''), 'the biggest board', await text(alice.page, '[data-record-biggest]'));
  check(/yd$/.test((await text(alice.page, '[data-record-carry]')) ?? ''), 'the longest carry', await text(alice.page, '[data-record-carry]'));
  await shot(alice.page, '9-record-us');
  // Switched on this screen, the record redraws in place without a reload.
  await alice.page.click('[data-units="metric"]');
  const redrawn = await waitText(alice.page, '[data-record-distance]', /\d ?(m|km)$/);
  check(METRIC.test(redrawn ?? ''), 'and redraws in meters when switched', redrawn);

  step(11, 'Chosen with no signal: shown at once, kept, and delivered later');
  await alice.context.setOffline(true);
  await alice.page.click('[data-units="us"]');
  const pending = await waitText(alice.page, '[data-units-status]', /next time you open the app/);
  check(
    (await alice.page.getAttribute('[data-units-status]', 'data-units-status')) === 'pending',
    'offline, the choice waits for the account',
    pending,
  );
  check(FEET.test((await text(alice.page, '[data-record-distance]')) ?? ''), 'but the screen has already switched', await text(alice.page, '[data-record-distance]'));
  // The other phone still has the account's older answer.
  await home(alice2.page);
  check(/8\.0 m squares/.test((await text(alice2.page, '[data-field]')) ?? ''), 'the other phone still reads the account’s metric', await text(alice2.page, '[data-field]'));
  await alice.context.setOffline(false);
  await home(alice.page); // a launch with signal sends the pending choice
  await openAccount(alice.page);
  const delivered = await waitText(alice.page, '[data-units-status]', /Saved to your account/);
  check(/Saved to your account/.test(delivered ?? ''), 'the next launch delivers it', delivered);
  await home(alice2.page);
  check(/26 ft squares/.test((await text(alice2.page, '[data-field]')) ?? ''), 'and the other phone follows', await text(alice2.page, '[data-field]'));
} finally {
  await browser.close();
}

console.log(`\nscreenshots:\n${shots.map((p) => `  ${p}`).join('\n')}`);
console.log(`\n${failures === 0 ? 'all good' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
