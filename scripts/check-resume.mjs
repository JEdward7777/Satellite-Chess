/**
 * The back-rank handshake, driven end to end (phase 7).
 *
 * Two simulated phones start a game, lose one of them completely, and get it
 * back — the whole of decision 0005 as players meet it. What this proves that
 * the unit and Durable Object tests cannot:
 *
 * - **The phone says `ready` on its own (7.2.1)**, and says it *once*. White's
 *   outbound `pos` frames are dropped by the page, so the relay can never tell
 *   the server where white is standing; the only thing that can start the game
 *   is the client noticing it is on its back rank. Every outbound frame is
 *   counted, so "once, not per fix" is a number rather than an impression.
 * - **The wait is legible (7.2.2)** — white's screen names how far black still
 *   has to walk, and the number shrinks as black walks.
 * - **A cold start resumes (7.3.3).** White's page is closed outright — a killed
 *   app, not a dropped socket — and a new one is opened at `/`, with nothing
 *   carried over except what a real phone keeps: cookies and storage. The game
 *   is found through the game index on home (which is why `7.3.1` was dropped;
 *   decision 0038), and the returning phone's `ready` resumes it.
 *
 * ## Running it
 *
 * Needs a server from an empty state (O-19) and the dev seam:
 *
 *     npm run build:client
 *     npx wrangler dev --port 8799 --var DEV_AUTH_SECRET:local-dev-secret \
 *       --persist-to "$(mktemp -d)" &
 *     node scripts/check-resume.mjs [--base=http://127.0.0.1:8799/?sim=1]
 *
 * Takes about a minute, most of it the 20 s disconnect grace running out.
 */

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

import { signIn } from './driver-signin.mjs';

const args = new Map(
  process.argv.slice(2).map((a) => {
    // Split at the first `=` only: the base URL carries `?sim=1`, and losing
    // its `=1` silently turns the simulator off.
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length > 0 ? rest.join('=') : 'true'];
  }),
);
const BASE = args.get('base') ?? 'http://127.0.0.1:8799/?sim=1';
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-resume-'));

function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  for (const dir of readdirSync(root)) {
    if (!dir.startsWith('chromium-')) continue;
    // Both layouts: playwright moved from `chrome-linux` to `chrome-linux64`.
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

let failures = 0;
function check(ok, what, detail = '') {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const step = (n, msg) => console.log(`\n${n}. ${msg}`);

/**
 * Every page in a context counts its own outbound frames and, when told to,
 * swallows its `pos` relays. Installed as an init script so a *new* page — the
 * cold start — gets the same instrument without being asked.
 */
async function instrument(context, { dropPos }) {
  await context.addInitScript(
    ({ field, dropPos }) => {
      window.__sent = [];
      window.__dropPos = dropPos;
      const Native = window.WebSocket;
      const send = Native.prototype.send;
      Native.prototype.send = function (data) {
        let t = 'raw';
        try {
          t = JSON.parse(String(data)).t ?? 'raw';
        } catch {
          // The keepalive is a bare string.
        }
        if (t === 'pos' && window.__dropPos) return undefined;
        window.__sent.push(t);
        return send.call(this, data);
      };

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
    { field: FIELD, dropPos },
  );
}

async function openPage(context, name) {
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [${name}] console error: ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`  [${name}] page error: ${e.message}`));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-calibrate]', { timeout: 15_000 });
  return page;
}

async function newPhone(browser, name, opts) {
  const context = await browser.newContext({ viewport: { width: 480, height: 900 } });
  await signIn(context, `sim-resume-${name}-${Date.now()}`, new URL(BASE).origin, name);
  await instrument(context, opts);
  return { context, page: await openPage(context, name), name };
}

async function walkTo(page, file, rank) {
  await page.evaluate((pos) => globalThis.satchess.me.moveTo(pos), squareLatLng(file, rank));
  await page.waitForFunction(
    (sq) => document.querySelector('[data-square]')?.textContent === sq,
    FILES[file] + String(rank + 1),
    { timeout: 10_000 },
  );
}

const text = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    return !el || el.hidden ? null : el.textContent;
  }, sel);
const sent = (page, t) => page.evaluate((k) => window.__sent.filter((x) => x === k).length, t);
const metresIn = (line) => {
  const m = /about ([\d.]+) m away/.exec(line ?? '');
  return m ? Number(m[1]) : null;
};
const waitText = (page, sel, pattern, timeout = 15_000) =>
  page.waitForFunction(
    ({ s, p }) => new RegExp(p).test(document.querySelector(s)?.textContent ?? ''),
    { s: sel, p: pattern.source },
    { timeout },
  );

const browser = await chromium.launch({ executablePath: findChromium() });

try {
  console.log(`screenshots -> ${OUT}`);

  step(1, 'Two phones; white’s relay is cut, so only `ready` can say where white is');
  const white = await newPhone(browser, 'white', { dropPos: true });
  const black = await newPhone(browser, 'black', { dropPos: false });

  step(2, 'White creates and opens the board, standing on a1 — its own back rank');
  await white.page.click('[data-new]');
  await white.page.waitForSelector('[data-create]', { timeout: 15_000 });
  await white.page.click('[data-create]');
  await white.page.waitForSelector('[data-join-code]', { timeout: 15_000 });
  const code = await white.page.getAttribute('[data-join-code]', 'data-join-code');
  console.log(`   join code ${code}`);
  await white.page.click('[data-open]');
  await white.page.waitForSelector('[data-board]', { timeout: 15_000 });
  await white.page.waitForTimeout(1_500);
  check((await sent(white.page, 'ready')) === 0, 'no `ready` while nobody else has joined');

  step(3, 'Black joins, standing on a1 as well — the wrong end for black');
  await black.page.fill('[data-code]', code);
  await black.page.click('[data-join]');
  await black.page.waitForSelector('[data-board]', { timeout: 15_000 });

  // 7.2.1: the staging snapshot arrives, white is on its back rank, and says so.
  await white.page.waitForFunction(() => window.__sent.includes('ready'), null, { timeout: 10_000 });
  check(true, 'white sent `ready` unasked when the game went to staging');
  await waitText(white.page, '[data-prompt]', /You are on your back rank/);
  check(true, 'white’s screen says the server agrees', await text(white.page, '[data-prompt]'));

  // 7.2.2: the wait has a number on it.
  await waitText(white.page, '[data-handshake]', /about [\d.]+ m away/);
  const before = metresIn(await text(white.page, '[data-handshake]'));
  check(before !== null && before > 30, 'white is told how far black has to walk', `${before} m`);
  const blackPrompt = await text(black.page, '[data-prompt]');
  check(/Walk to your own back rank — [\d.]+ m to go/.test(blackPrompt ?? ''), 'black is told its own distance', blackPrompt);
  // 7.2.3: the manual button, from the wrong end of the board. The server
  // re-checks it and says how far off black is rather than simply refusing.
  await black.page.click('[data-ready]');
  await waitText(black.page, '[data-notice]', /m from your back rank/, 10_000);
  check(true, 'black’s tapped Ready is refused with a distance', await text(black.page, '[data-notice]'));
  const stillWaiting = await text(white.page, '[data-prompt]');
  check(/You are on your back rank/.test(stillWaiting ?? ''), 'and nothing starts', stillWaiting);
  await white.page.screenshot({ path: `${OUT}/1-white-waiting.png` });
  await black.page.screenshot({ path: `${OUT}/2-black-walking.png` });

  step(4, 'Standing still sends nothing: once on arrival, not once per fix');
  await white.page.waitForTimeout(6_000);
  const readies = await sent(white.page, 'ready');
  check(readies === 1, 'exactly one `ready` after six seconds of fixes', `${readies} sent`);

  step(5, 'Black walks towards the far end; white’s number shrinks');
  await walkTo(black.page, 4, 4); // e5
  await white.page.waitForFunction(
    (b) => {
      const m = /about ([\d.]+) m away/.exec(document.querySelector('[data-handshake]')?.textContent ?? '');
      return m !== null && Number(m[1]) < b - 10;
    },
    before,
    { timeout: 15_000 },
  );
  const midway = metresIn(await text(white.page, '[data-handshake]'));
  check(midway !== null && midway < before, 'the distance fell as black walked', `${before} → ${midway} m`);

  step(6, 'Black reaches e8: the game starts without anyone tapping Ready');
  await walkTo(black.page, 4, 7); // e8
  await waitText(white.page, '[data-prompt]', /Your move/, 20_000);
  check(true, 'white’s clock is running');
  check((await text(white.page, '[data-handshake]')) === null, 'the handshake line goes away once the game is on');
  check((await sent(white.page, 'ready')) === 1, 'still one `ready` from white in total');

  step(7, 'White’s phone is killed outright; the grace runs out and the game suspends');
  await white.page.close();
  await waitText(black.page, '[data-prompt]', /Paused|paused|claim/, 40_000);
  check(true, 'black sees the game paused', await text(black.page, '[data-prompt]'));
  const blackWait = await text(black.page, '[data-handshake]');
  check(/come back/.test(blackWait ?? ''), 'black is told who it is waiting for', blackWait);
  await black.page.screenshot({ path: `${OUT}/3-black-suspended.png` });

  step(8, 'A cold start: a new page at `/`, the game found on home, tapped once');
  const again = await openPage(white.context, 'white again');
  check((await again.evaluate(() => location.pathname)) === '/', 'the relaunch lands on home, not in the game');
  await again.waitForSelector(`[data-game="${code}"]`, { timeout: 15_000 });
  const line = await again.textContent(`[data-game="${code}"]`);
  check(/paused/.test(line ?? ''), 'home lists the game as paused', line?.replace(/\s+/g, ' ').trim());
  await again.screenshot({ path: `${OUT}/4-cold-start-home.png` });
  // The relay stays cut on the relaunch. The page believes each swallowed `pos`
  // was delivered, which is also what happens for real when the server drops
  // a relay inside its interval floor: sent, and counting for nothing. So the
  // new page's first relay is given a round trip to be confirmed, and when no
  // snapshot agrees, `ready` has to go anyway (`RELAY_CONFIRM_MS`).
  await again.click(`[data-game="${code}"]`);
  await again.waitForSelector('[data-board]', { timeout: 15_000 });

  step(9, 'The returning phone is on a1 again and says so; the game resumes without a tap');
  await waitText(again, '[data-prompt]', /Your opponent to move|Your move/, 20_000);
  check(true, 'resumed', await text(again, '[data-prompt]'));
  const againReadies = await sent(again, 'ready');
  check(againReadies === 1, 'one `ready` from the new page, and no tap', `${againReadies} sent`);
  await waitText(black.page, '[data-prompt]', /Your move|Your opponent to move/, 10_000);
  check(true, 'black sees it resume too');
  await again.screenshot({ path: `${OUT}/5-resumed.png` });
  // Informational: black's relay is live throughout, so whether black ever
  // needed a `ready` depends on whether its last relay landed inside the zone.
  console.log(`   black sent ${await sent(black.page, 'ready')} ready, ${await sent(black.page, 'pos')} pos in the whole run`);

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  console.log(`Screenshots in ${OUT}`);
} catch (error) {
  failures += 1;
  console.error(error);
  // What each screen was saying when it stopped, which is usually the answer.
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const said = await page
        .evaluate(() => ({
          url: location.pathname,
          sent: window.__sent,
          prompt: document.querySelector('[data-prompt]')?.textContent,
          handshake: document.querySelector('[data-handshake]')?.textContent,
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
