/**
 * Ending a game early, on two phones (stage 10.11, decision 0050, O-50).
 *
 * The owner's game sat on a field nobody could play, and the list kept it for
 * good. This drives every way out, from the buttons a player taps, in four
 * short games:
 *
 * 1. **Stuck in the handshake, alone.** Black joins and never reaches the back
 *    rank; black's phone goes away. White aborts alone — a confirmed tap, not
 *    one — and the game says "aborted", writes no record line, and is offered
 *    for tidying on home and removed.
 * 2. **Stuck mid-game, alone.** Two moves, then black's phone goes; the grace
 *    runs out and the game suspends. White resigns, confirmed, and the result
 *    lands in the record.
 * 3. **A draw offered, declined, lapsed, and accepted.** Both present. Accept
 *    is dead for a moment after the banner appears.
 * 4. **An abort offered after both have moved, and accepted.**
 *
 * Every inbound frame is counted, so "one tap, one message" is a number.
 *
 * ## Running it
 *
 *     npm run build:client
 *     npx wrangler dev --port 8799 --var DEV_AUTH_SECRET:local-dev-secret \
 *       --persist-to "$(mktemp -d)" &
 *     node scripts/check-endings.mjs [--base=http://127.0.0.1:8799/?sim=1] [--out=DIR]
 *
 * About a minute and a half, most of it scenario 2's 20 s disconnect grace.
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
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-endings-'));
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
  name: 'Broken Field',
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
  // The status sits under the board, below the fold of a 900 px screen, so
  // the part a picture is about is scrolled into view first.
  //
  // Retried, because home redraws itself when its sync answers: the element
  // found can be replaced between finding it and scrolling to it ("not
  // attached to the DOM"). Each attempt re-queries.
  for (let attempt = 1; focus !== null; attempt++) {
    try {
      await page.locator(focus).first().scrollIntoViewIfNeeded({ timeout: 2_000 });
      break;
    } catch (error) {
      if (attempt >= 5) throw error;
      await page.waitForTimeout(200);
    }
  }
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path });
  shots.push(path);
}

async function newPhone(browser, name) {
  // en-GB: this driver reads no distances, but every game driver pins a metric
  // locale so the screenshots read the same as the others (decision 0049).
  const context = await browser.newContext({ viewport: { width: 480, height: 900 }, locale: 'en-GB' });
  await signIn(context, `sim-endings-${name}-${RUN}`, new URL(BASE).origin, name);
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
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [${name}] console error: ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`  [${name}] page error: ${e.message}`));
  // A confirm() or alert() would be auto-dismissed by Playwright and pass
  // silently; the endings must not use one, so any dialog is a failure.
  page.on('dialog', async (d) => {
    check(false, `no browser dialog is used (${name})`, d.message());
    await d.dismiss();
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-new]', { timeout: 15_000 });
  return { context, page, name };
}

async function walkTo(page, file, rank) {
  await page.evaluate((pos) => globalThis.satchess.me.moveTo(pos), squareLatLng(file, rank));
  await page.waitForFunction(
    (sq) => document.querySelector('[data-square]')?.textContent === sq,
    FILES[file] + String(rank + 1),
    { timeout: 10_000 },
  );
  // One more fix, so the dot is on the square and not a step short (see
  // decision 0048's note on a driver tapping its own plate).
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

/** Lift, walk, place — and wait for the opponent's screen to say it is their move. */
async function play(mover, other, from, to) {
  const color = mover.color;
  await walkTo(mover.page, ...sq(from));
  await tapSquare(mover.page, ...sq(from), color);
  await waitText(mover.page, '[data-carry-text]', new RegExp(`^${from}`));
  await walkTo(mover.page, ...sq(to));
  await tapSquare(mover.page, ...sq(to), color);
  await waitText(other.page, '[data-prompt]', /Your move/);
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
const sentOf = (page, t) => page.evaluate((k) => window.__sent.filter((m) => m.t === k), t);
const record = (page) => page.evaluate(async () => (await (await fetch('/api/record')).json()).record);
/** Click with `HTMLElement.click()`, which a disabled button ignores — as a thumb's tap would. */
const rawClick = (page, sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel);
const choices = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-endings-choices] [data-ending]')].map((b) => ({
      kind: b.dataset.ending,
      label: b.textContent,
      disabled: b.disabled,
    })),
  );

/** White creates and opens the board; black joins by code. Both land on a board. */
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

async function start(white, black) {
  await walkTo(white.page, 4, 0);
  await walkTo(black.page, 4, 7);
  await waitText(white.page, '[data-prompt]', /Your move/, 20_000);
}

/** "End game…", then a choice; returns once the question (or nothing) is up. */
async function openEndings(page) {
  await page.click('[data-end]');
  await page.waitForSelector('[data-endings]:not([hidden])');
}

/** Answer a question that ends the game, checking it is not live at first. */
async function confirmEnding(page, name) {
  await page.waitForSelector('[data-endings-confirm]:not([hidden])');
  check(await disabled(page, '[data-confirm-yes]'), `${name}: the button that ends the game is dead at first`);
  const before = (await page.evaluate(() => window.__sent.length));
  await rawClick(page, '[data-confirm-yes]');
  await page.waitForTimeout(200);
  check((await page.evaluate(() => window.__sent.length)) === before, `${name}: a tap on it then sends nothing`);
  await page.waitForFunction(() => document.querySelector('[data-confirm-yes]')?.disabled === false, null, {
    timeout: 3_000,
  });
  await page.click('[data-confirm-yes]');
}

const browser = await chromium.launch({ executablePath: findChromium() });

try {
  console.log(`screenshots -> ${OUT}`);

  // -------------------------------------------------------------------------
  step(1, 'Stuck in the handshake: black never reaches the back rank, and leaves');
  {
    const { white, black, code } = await pair(browser, 's1');
    await walkTo(white.page, 4, 0);
    await waitText(white.page, '[data-prompt]', /back rank/);
    await black.context.close();
    await white.page.waitForTimeout(500);
    check(await visible(white.page, '[data-end]'), '"End game…" is on the board during the handshake');
    await openEndings(white.page);
    const offered = await choices(white.page);
    check(
      offered.length === 1 && offered[0].kind === 'abort' && offered[0].label === 'Abort game',
      'the only choice is to abort, alone',
      JSON.stringify(offered),
    );
    await shot(white.page, '1-handshake-choices');
    await white.page.click('[data-ending="abort"]');
    await white.page.waitForSelector('[data-endings-confirm]:not([hidden])');
    await shot(white.page, '2-abort-question');
    await confirmEnding(white.page, 'abort');
    await waitText(white.page, '[data-prompt]', /Game aborted — no result/);
    check(true, 'the board says aborted', await text(white.page, '[data-prompt]'));
    check(!(await visible(white.page, '[data-end]')), '"End game…" is gone');
    check(!(await visible(white.page, '[data-clocks]')), 'the clocks are gone');
    check(!(await visible(white.page, '[data-review-open]')), 'no "After the game" for a game with no result');
    const aborts = await sentOf(white.page, 'abort');
    check(aborts.length === 1, 'one abort frame was sent', JSON.stringify(aborts));
    await shot(white.page, '3-aborted-board', '[data-prompt]');

    const rec = await record(white.page);
    check(rec.recent.length === 0 && rec.totals.games === 0, 'nothing in the record', JSON.stringify(rec.totals));

    await white.page.click('[data-leave]');
    await white.page.waitForSelector(`[data-game="${code}"]`, { timeout: 15_000 });
    const line = (await white.page.textContent(`[data-game="${code}"]`)).replace(/\s+/g, ' ').trim();
    check(/aborted — no result/.test(line), 'home lists it as aborted', line);
    // Home draws the list, then redraws when its sync answers; let it settle.
    await white.page.waitForLoadState('networkidle');
    check(await visible(white.page, '[data-tidy]'), 'home offers to tidy up, for one aborted game');
    await shot(white.page, '4-home-aborted', '[data-tidy]');
    await white.page.click('[data-tidy]');
    await white.page.waitForSelector(`[data-pick="${code}"]`);
    await white.page.check(`[data-pick="${code}"]`);
    await white.page.click('[data-forget]');
    await white.page.waitForFunction((c) => !document.querySelector(`[data-pick="${c}"]`), code);
    await shot(white.page, '5-tidied');
    await white.page.click('[data-done]');
    await white.page.waitForSelector('[data-new]');
    check((await white.page.$(`[data-game="${code}"]`)) === null, 'and it is off the list');
    await white.context.close();
  }

  // -------------------------------------------------------------------------
  step(2, 'Stuck mid-game: two moves, black’s phone goes, the game suspends, white resigns alone');
  {
    const { white, black } = await pair(browser, 's2');
    await start(white, black);
    await play(white, black, 'e2', 'e4');
    await play(black, white, 'e7', 'e5');
    await black.context.close();
    await waitText(white.page, '[data-prompt]', /Paused|paused|claim/, 40_000);
    check(true, 'white sees the game suspended', await text(white.page, '[data-prompt]'));
    await openEndings(white.page);
    const offered = await choices(white.page);
    check(
      JSON.stringify(offered.map((c) => c.label)) === JSON.stringify(['Offer a draw', 'Offer to abort', 'Resign']),
      'after both have moved: a draw, an abort offer, or resign',
      JSON.stringify(offered.map((c) => c.label)),
    );
    await shot(white.page, '6-suspended-choices');
    await white.page.click('[data-ending="resign"]');
    await white.page.waitForSelector('[data-endings-confirm]:not([hidden])');
    await shot(white.page, '7-resign-question');
    // "Keep playing" backs out, and sends nothing.
    await white.page.click('[data-confirm-no]');
    check(!(await visible(white.page, '[data-endings]')), '"Keep playing" closes the question');
    check((await sentOf(white.page, 'resign')).length === 0, 'and nothing was sent');
    await openEndings(white.page);
    await white.page.click('[data-ending="resign"]');
    await confirmEnding(white.page, 'resign');
    await waitText(white.page, '[data-prompt]', /0-1 — resignation/);
    check(true, 'resigned, alone, with the opponent gone', await text(white.page, '[data-prompt]'));
    check(await visible(white.page, '[data-review-open]'), '"After the game" is offered');
    await shot(white.page, '8-resigned', '[data-prompt]');
    const rec = await record(white.page);
    check(rec.totals.losses === 1 && rec.recent.length === 1, 'one loss in the record', JSON.stringify(rec.totals));
    await white.context.close();
  }

  // -------------------------------------------------------------------------
  step(3, 'A draw: offered and declined, offered and lapsed, offered and accepted');
  {
    const { white, black } = await pair(browser, 's3');
    await start(white, black);
    await play(white, black, 'e2', 'e4');
    await play(black, white, 'e7', 'e5');

    await openEndings(white.page);
    await white.page.click('[data-ending="draw"]');
    await waitText(white.page, '[data-notice]', /Draw offered/);
    check(!(await visible(white.page, '[data-endings]')), 'an offer goes at once, with no question');
    await waitText(white.page, '[data-my-offer]', /You offered a draw/);
    await black.page.waitForSelector('[data-offer="draw"]:not([hidden])');
    check(await disabled(black.page, '[data-offer-accept="draw"]'), 'black’s Accept is dead the moment it appears');
    await shot(black.page, '9-draw-offer-banner', '[data-offer="draw"]');
    await black.page.click('[data-offer-decline="draw"]');
    await waitText(white.page, '[data-notice]', /Your opponent declined the draw/);
    check(true, 'white is told it was declined');
    await shot(white.page, '10-draw-declined', '[data-notice]');

    await openEndings(white.page);
    await white.page.click('[data-ending="draw"]');
    await black.page.waitForSelector('[data-offer="draw"]:not([hidden])');
    await play(white, black, 'g1', 'f3');
    await waitText(white.page, '[data-notice]', /Your draw offer lapsed with the move/);
    check(!(await visible(black.page, '[data-offer="draw"]')), 'the offer lapsed with white’s own move');

    await openEndings(black.page);
    await black.page.click('[data-ending="draw"]');
    await white.page.waitForSelector('[data-offer="draw"]:not([hidden])');
    await white.page.waitForFunction(() => document.querySelector('[data-offer-accept="draw"]')?.disabled === false);
    await white.page.click('[data-offer-accept="draw"]');
    await confirmEnding(white.page, 'accept draw');
    await waitText(white.page, '[data-prompt]', /1\/2-1\/2 — agreement/);
    await waitText(black.page, '[data-prompt]', /1\/2-1\/2 — agreement/);
    check(true, 'drawn by agreement on both phones');
    await shot(black.page, '11-drawn', '[data-prompt]');
    const draws = await sentOf(white.page, 'draw');
    check(
      JSON.stringify(draws.map((m) => m.action)) === JSON.stringify(['offer', 'offer', 'accept']),
      'white sent exactly offer, offer, accept',
      JSON.stringify(draws),
    );
    const rec = await record(black.page);
    check(rec.totals.draws === 1, 'a draw in black’s record', JSON.stringify(rec.totals));
    await white.context.close();
    await black.context.close();
  }

  // -------------------------------------------------------------------------
  step(4, 'An abort after both have moved: offered, then accepted');
  {
    const { white, black, code } = await pair(browser, 's4');
    await start(white, black);
    await play(white, black, 'd2', 'd4');
    await play(black, white, 'd7', 'd5');
    await openEndings(white.page);
    await white.page.click('[data-ending="abort"]');
    await waitText(white.page, '[data-notice]', /Abort offered/);
    await black.page.waitForSelector('[data-offer="abort"]:not([hidden])');
    check(true, 'black sees the offer', await text(black.page, '[data-offer="abort"] [data-offer-text]'));
    await shot(black.page, '12-abort-offer-banner', '[data-offer="abort"]');
    const whiteLine = await text(white.page, '[data-prompt]');
    check(/Your move|opponent to move/.test(whiteLine ?? ''), 'the game plays on while it is open', whiteLine);
    await black.page.waitForFunction(() => document.querySelector('[data-offer-accept="abort"]')?.disabled === false);
    await black.page.click('[data-offer-accept="abort"]');
    await confirmEnding(black.page, 'accept abort');
    await waitText(white.page, '[data-prompt]', /Game aborted/);
    await waitText(black.page, '[data-prompt]', /Game aborted/);
    check(true, 'aborted on both phones');
    await shot(white.page, '13-mutual-abort', '[data-prompt]');
    for (const phone of [white, black]) {
      const rec = await record(phone.page);
      check(rec.recent.length === 0, `nothing in ${phone.name}’s record`);
    }
    await black.page.click('[data-leave]');
    await black.page.waitForSelector(`[data-game="${code}"]`, { timeout: 15_000 });
    const line = (await black.page.textContent(`[data-game="${code}"]`)).replace(/\s+/g, ' ').trim();
    check(/aborted — no result/.test(line), 'black’s list says aborted', line);
    await white.context.close();
    await black.context.close();
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  console.log(`Screenshots:\n${shots.map((s) => `  ${s}`).join('\n')}`);
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
          sent: (window.__sent ?? []).map((m) => m.t).filter((t) => t !== 'pos'),
        }))
        .catch(() => null);
      console.error(`   screen: ${JSON.stringify(said)}`);
      await page.screenshot({ path: `${OUT}/failure-${Date.now()}.png` }).catch(() => undefined);
    }
  }
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
