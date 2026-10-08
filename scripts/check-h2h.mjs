/**
 * The head-to-head record, on three phones (stage 8.5.4, decision 0054).
 *
 * Two players, A and B, play four games against each other on one field, every
 * piece carried at a jog so both phones' distance counters run:
 *
 * 1. A creates and is White; B wins by Fool's mate.
 * 2. B creates and is White; two moves, then B resigns, so A wins.
 * 3. A creates and is White; two moves, then a draw offered and accepted.
 * 4. A creates; aborted before anyone moves. No result, so no record line.
 *
 * Then:
 * - **Both accounts show one opponent, with the same tally**: the same meters
 *   walked between them to the character, the same games, the wins and losses
 *   mirrored, and the same figures underneath from `/api/record`.
 * - The aborted game is in neither record and opens no head-to-head.
 * - **A names B**; A's screens show the name and B's never do.
 * - B reaches the same head-to-head from a game's review ("Your record against
 *   this player").
 * - **A third account, C, sees nothing**: no list, a 404 for A and B's pair id,
 *   for their game codes, and for naming them, and nothing from any other way
 *   of asking.
 *
 * ## Running it
 *
 *     npm run build:client
 *     npx wrangler dev --port 8799 --var DEV_AUTH_SECRET:local-dev-secret \
 *       --persist-to "$(mktemp -d)" &
 *     node scripts/check-h2h.mjs [--base=http://127.0.0.1:8799/?sim=1] [--out=DIR]
 *
 * About two minutes: the pieces are carried at a jog.
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
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-h2h-'));
mkdirSync(OUT, { recursive: true });
const RUN = Date.now().toString(36);

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
  // Metric, because this reads meters off the screen (decision 0049).
  const context = await browser.newContext({ viewport: { width: 480, height: 900 }, locale: 'en-GB' });
  const sub = `sim-h2h-${name}-${RUN}`;
  await signIn(context, sub, ORIGIN, name);
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
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [${name}] console error: ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`  [${name}] page error: ${e.message}`));
  await home({ page });
  return { context, page, name, sub };
}

async function home(phone) {
  await phone.page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await phone.page.waitForSelector('[data-calibrate]', { timeout: 15_000 });
}

/** Walk — not teleport — so the phone's distance counter sees every meter. */
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
  // One more fix, so the dot is on the square and not a step short.
  await page.waitForTimeout(1_100);
}

/** A tap, as a `pointerdown`/`pointerup` pair (decision 0046), not primary so the simulator stays put. */
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

const text = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    return !el || el.hidden ? null : el.textContent.replace(/\s+/g, ' ').trim();
  }, sel);
const waitText = (page, sel, pattern, timeout = 15_000) =>
  page.waitForFunction(
    ({ s, p }) => new RegExp(p).test(document.querySelector(s)?.textContent ?? ''),
    { s: sel, p: pattern.source },
    { timeout },
  );

/** Lift at `from`, carry at a jog, place at `to`, and wait for the server's word on the other phone. */
async function play(mover, other, from, to) {
  await walk(mover.page, ...sq(from));
  await tap(mover.page, ...sq(from), mover.color);
  await mover.page.waitForFunction(() => {
    const el = document.querySelector('[data-carry]');
    return el !== null && !el.hidden;
  }, null, { timeout: 10_000 });
  await walk(mover.page, ...sq(to));
  await tap(mover.page, ...sq(to), mover.color);
  await other.page.waitForFunction(
    () => /Your move|won|lost|drawn|checkmate/i.test(document.querySelector('[data-prompt]')?.textContent ?? ''),
    null,
    { timeout: 15_000 },
  );
  console.log(`   ${mover.name} played ${from}-${to}`);
}

/** `creator` makes a game and is White; `joiner` joins by code. Both stand on their back ranks. */
async function newGame(creator, joiner, { start = true } = {}) {
  await home(creator);
  await home(joiner);
  await creator.page.click('[data-new]');
  await creator.page.waitForSelector('[data-create]', { timeout: 15_000 });
  await creator.page.click('[data-create]');
  await creator.page.waitForSelector('[data-join-code]', { timeout: 15_000 });
  const code = await creator.page.getAttribute('[data-join-code]', 'data-join-code');
  await creator.page.click('[data-open]');
  await creator.page.waitForSelector('[data-board]', { timeout: 15_000 });
  await joiner.page.fill('[data-code]', code);
  await joiner.page.click('[data-join]');
  await joiner.page.waitForSelector('[data-board]', { timeout: 15_000 });
  creator.color = 'w';
  joiner.color = 'b';
  console.log(`   ${creator.name} created ${code} as White; ${joiner.name} joined`);
  if (start) {
    await walk(creator.page, 4, 0);
    await walk(joiner.page, 4, 7);
    await waitText(creator.page, '[data-prompt]', /Your move/, 20_000);
  }
  return code;
}

async function openEndings(page) {
  await page.click('[data-end]');
  await page.waitForSelector('[data-endings]:not([hidden])');
}

/** The confirm button is dead for a second (decision 0050); wait it out, then press. */
async function confirmEnding(page) {
  await page.waitForSelector('[data-endings-confirm]:not([hidden])');
  await page.waitForFunction(() => document.querySelector('[data-confirm-yes]')?.disabled === false, null, {
    timeout: 3_000,
  });
  await page.click('[data-confirm-yes]');
}

/** GET as this phone: its own cookie, nothing else. */
const api = (phone, path) =>
  phone.page.evaluate(async (p) => {
    const response = await fetch(p, { headers: { accept: 'application/json' } });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  }, path);

async function openAccount(phone) {
  await home(phone);
  await phone.page.click('[data-account]');
  await phone.page.waitForSelector('[data-record]', { timeout: 15_000 });
  await phone.page.waitForFunction(() => document.querySelector('[data-record-loading]') === null, null, {
    timeout: 15_000,
  });
}

/** Every opponent line on the account screen, as read. */
const listed = (phone) =>
  phone.page.evaluate(() =>
    [...document.querySelectorAll('[data-opponent]')].map((b) => ({
      id: b.dataset.opponent,
      name: b.querySelector('[data-h2h-name]')?.textContent.trim(),
      summary: b.querySelector('[data-h2h-summary]')?.textContent.trim(),
      since: b.querySelector('[data-h2h-since]')?.textContent.trim(),
    })),
  );

/** The opponent screen, as read. */
const opponentScreen = (phone) =>
  phone.page.evaluate(() => {
    const t = (s) => document.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() ?? null;
    return {
      name: t('[data-opponent-name]'),
      together: t('[data-opponent-together]'),
      split: t('[data-opponent-split]'),
      results: t('[data-opponent-results]'),
      games: [...document.querySelectorAll('[data-opponent-game]')].map((li) => li.dataset.opponentGame),
    };
  });

const browser = await chromium.launch({ executablePath: findChromium() });

try {
  console.log(`screenshots -> ${OUT}`);
  const a = await newPhone(browser, 'A');
  const b = await newPhone(browser, 'B');
  const c = await newPhone(browser, 'C');

  step(1, 'Game 1: A creates and is White; B mates with Fool’s mate');
  const g1 = await newGame(a, b);
  await play(a, b, 'f2', 'f3');
  await play(b, a, 'e7', 'e5');
  await play(a, b, 'g2', 'g4');
  await play(b, a, 'd8', 'h4');
  await waitText(a.page, '[data-prompt]', /checkmate/i);
  check(true, 'B won', await text(a.page, '[data-prompt]'));

  step(2, 'Game 2: B creates and is White; two moves, then B resigns');
  const g2 = await newGame(b, a);
  await play(b, a, 'e2', 'e3');
  await play(a, b, 'e7', 'e6');
  await openEndings(b.page);
  await b.page.click('[data-ending="resign"]');
  await confirmEnding(b.page);
  await waitText(a.page, '[data-prompt]', /resign/i);
  check(true, 'A won', await text(a.page, '[data-prompt]'));

  step(3, 'Game 3: A creates; two moves, then a draw offered and accepted');
  const g3 = await newGame(a, b);
  await play(a, b, 'd2', 'd3');
  await play(b, a, 'd7', 'd6');
  await openEndings(a.page);
  await a.page.click('[data-ending="draw"]');
  await b.page.waitForSelector('[data-offer="draw"]:not([hidden])');
  await b.page.waitForFunction(() => document.querySelector('[data-offer-accept="draw"]')?.disabled === false);
  await b.page.click('[data-offer-accept="draw"]');
  await confirmEnding(b.page);
  await waitText(a.page, '[data-prompt]', /1\/2-1\/2/);
  check(true, 'drawn', await text(a.page, '[data-prompt]'));

  step(4, 'Game 4: A creates; aborted before anyone moves');
  const g4 = await newGame(a, b);
  await openEndings(a.page);
  await a.page.click('[data-ending="abort"]');
  await confirmEnding(a.page);
  await waitText(a.page, '[data-prompt]', /abort/i);
  check(true, 'aborted', await text(a.page, '[data-prompt]'));

  step(5, 'Both accounts: one opponent, the same tally, sides swapped');
  const ra = await api(a, '/api/record');
  const rb = await api(b, '/api/record');
  const [xa] = ra.body.headToHead.opponents;
  const [xb] = rb.body.headToHead.opponents;
  check(ra.body.headToHead.opponents.length === 1 && rb.body.headToHead.opponents.length === 1, 'one opponent each');
  check(xa.id === xb.id, 'the same pair id on both accounts', xa.id);
  check(xa.games === 3 && xb.games === 3, 'three counted games each — the aborted one is not there', `${xa.games}, ${xb.games}`);
  check(xa.wins === 1 && xa.losses === 1 && xa.draws === 1, 'A: one each', JSON.stringify([xa.wins, xa.draws, xa.losses]));
  check(xb.wins === xa.losses && xb.losses === xa.wins && xb.draws === xa.draws, 'B: mirrored');
  check(xa.togetherM === xb.togetherM && xa.togetherM > 0, 'meters between them, identical to the bit', String(xa.togetherM));
  check(xa.youM === xb.themM && xa.themM === xb.youM, 'each one’s share, swapped');
  check(ra.body.record.totals.games === 3 && rb.body.record.totals.games === 3, 'the record itself has the three games, not the abort');

  await openAccount(a);
  await openAccount(b);
  const la = await listed(a);
  const lb = await listed(b);
  check(la.length === 1 && lb.length === 1, 'one line on each account screen');
  check(la[0].summary === lb[0].summary.replace(/(\d+) won · (\d+) drawn · (\d+) lost/, (_, w, d, l) => `${l} won · ${d} drawn · ${w} lost`), 'the same line, read from each side', `${la[0].summary} | ${lb[0].summary}`);
  check(/^\d+ m between you · /.test(la[0].summary), 'meters first, then results', la[0].summary);
  check(la[0].name === 'Unnamed opponent' && lb[0].name === 'Unnamed opponent', 'nobody is named until a player names them');
  check(/^First played .* at Sim Field$/.test(la[0].since), 'told apart by the first game', la[0].since);
  const order = await a.page.evaluate(() => {
    const all = [...document.querySelectorAll('[data-record] *')];
    return { record: all.indexOf(document.querySelector('[data-record-distance]')), h2h: all.indexOf(document.querySelector('[data-h2h]')) };
  });
  check(order.record >= 0 && order.h2h > order.record, 'below the player’s own record');
  await a.page.locator('[data-h2h]').scrollIntoViewIfNeeded();
  await a.page.screenshot({ path: `${OUT}/1-a-account-list.png`, fullPage: true });

  step(6, 'The aborted game opens no head-to-head');
  const aborted = await api(a, `/api/record/opponent?game=${g4}`);
  check(aborted.status === 404, 'a 404 for the aborted game', JSON.stringify(aborted.body));

  step(7, 'A opens B, names them; B never sees the name');
  await a.page.click('[data-opponent]');
  await a.page.waitForSelector('[data-opponent-together]', { timeout: 15_000 });
  const sa = await opponentScreen(a);
  check(sa.together === la[0].summary.split(' between')[0], 'the headline is the list’s figure', sa.together);
  check(JSON.stringify(sa.games) === JSON.stringify([g3, g2, g1]), 'every game together, newest first, and not the abort', sa.games.join(','));
  await a.page.fill('[data-opponent-input]', '  Bea   from the club ');
  await a.page.click('[data-opponent-save]');
  await waitText(a.page, '[data-opponent-said]', /Saved/);
  check((await text(a.page, '[data-opponent-name]')) === 'Bea from the club', 'A’s name for B', await text(a.page, '[data-opponent-name]'));
  await a.page.screenshot({ path: `${OUT}/2-a-opponent-named.png`, fullPage: true });
  await a.page.click('[data-opponent-back]');
  await a.page.waitForSelector('[data-opponent]', { timeout: 15_000 });
  check((await listed(a))[0].name === 'Bea from the club', 'and on A’s list');
  await openAccount(b);
  check((await listed(b))[0].name === 'Unnamed opponent', 'B’s list does not have it');
  const rb2 = await api(b, '/api/record');
  check(!JSON.stringify(rb2.body).includes('Bea'), 'nor does anything B can read');

  step(8, 'B reaches the same head-to-head from game 1’s review');
  await home(b);
  await b.page.fill('[data-code]', g1);
  await b.page.click('[data-join]');
  // A finished game still on the server opens on its board, with "After the game".
  await b.page.waitForSelector('[data-review-open]:not([hidden]), [data-review-h2h]', { timeout: 20_000 });
  if ((await b.page.$('[data-review-h2h]')) === null) await b.page.click('[data-review-open]');
  await b.page.waitForSelector('[data-review-h2h]', { timeout: 20_000 });
  await b.page.locator('[data-review-h2h]').scrollIntoViewIfNeeded();
  await b.page.screenshot({ path: `${OUT}/3-b-review-link.png` });
  await b.page.click('[data-review-h2h]');
  await b.page.waitForSelector('[data-opponent-together]', { timeout: 15_000 });
  const sb = await opponentScreen(b);
  check(sb.together === sa.together, 'the same meters between them on B’s screen', `${sb.together} = ${sa.together}`);
  const swap = (s) => s.replace(/^You (.+) · They (.+)$/, 'You $2 · They $1');
  check(sb.split === swap(sa.split), 'the shares swapped', `${sb.split} | ${sa.split}`);
  check(JSON.stringify(sb.games) === JSON.stringify(sa.games), 'the same games');
  check(sb.results === '1 won · 1 drawn · 1 lost, across 3 games.', 'the results', sb.results);
  await b.page.screenshot({ path: `${OUT}/4-b-opponent-from-review.png`, fullPage: true });
  await b.page.click('[data-opponent-back]');
  await b.page.waitForSelector('[data-review-h2h]', { timeout: 15_000 });
  check(true, 'Back returns to the review');

  step(9, 'A third account sees nothing, however it asks');
  await openAccount(c);
  check((await c.page.$('[data-h2h]')) === null, 'no head-to-head section on C’s account');
  const rc = await api(c, '/api/record');
  check(rc.body.headToHead.opponents.length === 0 && rc.body.headToHead.earlierGames === 0, 'an empty list from the server');
  for (const path of [
    `/api/record/opponent?id=${xa.id}`,
    `/api/record/opponent?game=${g1}`,
    `/api/record/opponent?game=${g3}`,
    `/api/record/opponent?id=${xa.id}&game=${g1}`,
  ]) {
    const r = await api(c, path);
    check(r.status === 404 && r.body?.error === 'not_found', `${path} is the plain 404`, `${r.status} ${r.body?.error}`);
  }
  const fake = await api(c, `/api/record/opponent?id=${'0'.repeat(32)}`);
  check(fake.status === 404 && fake.body?.error === 'not_found', 'and so is an id that does not exist: nothing to tell them apart');
  const named = await c.page.evaluate(async (id) => {
    const r = await fetch('/api/record/opponent/name', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: 'snoop' }),
    });
    return r.status;
  }, xa.id);
  check(named === 404, 'C cannot name A and B’s pair', String(named));
  for (const path of [
    `/api/record?sub=${encodeURIComponent(a.sub)}`,
    `/api/record/opponents`,
    `/api/record/opponent/${xa.id}`,
    `/api/users/${encodeURIComponent(a.sub)}`,
    `/api/opponents?sub=${encodeURIComponent(a.sub)}`,
  ]) {
    const r = await api(c, path);
    const leaked = JSON.stringify(r.body ?? '').includes(xa.id) || (r.body?.headToHead?.opponents?.length ?? 0) > 0;
    check(!leaked, `${path} lists nobody’s opponents`, String(r.status));
  }
  const ra2 = await api(a, '/api/record');
  check(!JSON.stringify(ra2.body).includes(b.sub) && !JSON.stringify(rb2.body).includes(a.sub), 'neither account’s answer names the other account');
  await c.page.screenshot({ path: `${OUT}/5-c-account.png`, fullPage: true });

  step(10, 'In US units, the same tally reads in yards');
  await openAccount(a);
  await a.page.click('[data-units="us"]');
  await a.page.waitForFunction(() => /yd between you/.test(document.querySelector('[data-h2h-summary]')?.textContent ?? ''), null, { timeout: 10_000 });
  check(true, 'the list redraws in yards', (await listed(a))[0].summary);
  await a.page.click('[data-units="metric"]');

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
        }))
        .catch(() => null);
      console.error(`   screen: ${JSON.stringify(said)}`);
    }
  }
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
