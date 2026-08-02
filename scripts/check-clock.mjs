/**
 * Drive the clock on the game screen, including the part nobody can wait for.
 *
 * The clock itself is covered by unit tests (`test/client-clock.test.ts`), but
 * this project has learned twice that a view bug is invisible to those and
 * obvious in a screenshot — the promotion overlay covered the board for a whole
 * game while every test passed (stage 4.3.5), because an author `display` rule
 * beats the user agent's `[hidden] { display: none }`. The clocks are a `display:
 * grid` element that starts hidden, so they are the same shape of hazard, and
 * `.clocks[hidden]` in `app.css` is the same shape of fix. This is what proves
 * it.
 *
 * **The reason this is a separate driver** is the low-time warning. The shortest
 * time control on offer is ten minutes (decision 0012, and deliberately so — the
 * clock has to pay for walking), and nothing in the app can wind one down. So
 * this script rewrites the clock inside inbound `state` frames before the client
 * sees them: the server keeps its real clock, and the screen is asked to render
 * a game that is nearly out of time. Everything downstream of the wire — the
 * readout, the low-time colour, the sound and the vibration — is the real code.
 *
 * ## Running it
 *
 *     npm run build:client
 *     npx wrangler dev --port 8799 --local &
 *     npm install --no-save playwright
 *     node scripts/check-clock.mjs
 *
 * The two traps in `drive-game.mjs` apply here too, and `walkTo` handles them.
 */

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);
const BASE = args.get('base') ?? 'http://127.0.0.1:8799/?sim=1';
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-clock-'));

/** As in `drive-game.mjs`: the bundled browser path is wrong in a cloud session. */
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
  const lat = A1.lat + (rank * SQUARE_M) / M_PER_DEG_LAT;
  const lng = A1.lng + (file * SQUARE_M) / (M_PER_DEG_LAT * Math.cos((A1.lat * Math.PI) / 180));
  return { lat, lng };
}

const FIELD = {
  id: 'sim-field',
  name: 'Sim field',
  a1: A1,
  h8: squareLatLng(7, 7),
  version: 1,
  createdAt: 0,
  updatedAt: 0,
};

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (n, text) => console.log(`\n${n}. ${text}`);

async function newPhone(browser, name) {
  const context = await browser.newContext({ viewport: { width: 480, height: 900 } });
  const page = await context.newPage();
  page.on('console', (m) => {
    // A driver that provokes failures on purpose has to ignore the browser's own
    // report of them; see `check-deeplink.mjs`.
    if (m.type() === 'error' && !m.text().includes('Failed to load resource')) {
      console.log(`  [${name}] console error: ${m.text()}`);
    }
  });

  await page.addInitScript(
    ({ field, playerId }) => {
      localStorage.setItem('satchess.player_id', playerId);

      /**
       * Rewrite the clock inside inbound snapshots.
       *
       * `window.__clock = { mineMs, theirsMs }` — in *this phone's* terms, since
       * that is how the question is asked ("what if I had ten seconds left?").
       * It is translated to white/black here using the snapshot's own `you`.
       *
       * `serverNow` and `startedAt` are left exactly as the server sent them, so
       * the client's own local-elapsed arithmetic (`client/clock.ts`) is still
       * the thing being exercised: the balance is a lie, the timebase is not.
       */
      window.__clock = null;
      const patch = (raw) => {
        const override = window.__clock;
        if (!override || typeof raw !== 'string' || !raw.includes('"t":"state"')) return raw;
        try {
          const msg = JSON.parse(raw);
          if (msg.t !== 'state' || !msg.game?.clock) return raw;
          const me = msg.game.you;
          const them = me === 'w' ? 'b' : 'w';
          msg.game.clock[me === 'w' ? 'whiteMs' : 'blackMs'] = override.mineMs;
          msg.game.clock[them === 'w' ? 'whiteMs' : 'blackMs'] = override.theirsMs;
          return JSON.stringify(msg);
        } catch {
          return raw; // Leave the frame alone rather than breaking the game.
        }
      };

      /**
       * Re-deliver the last snapshot with the current override applied.
       *
       * Needed because mid-game there is no cheap way to make the server send
       * one: `onPos` broadcasts a bare `opp_pos` to the *other* phone and only
       * broadcasts state when the start-zone handshake changes something, so
       * simply walking around produces no new snapshot for the phone doing the
       * walking. Replaying is also the more honest instrument — it changes one
       * number in a frame the server really sent, and leaves the rest of the
       * client's timebase arithmetic untouched.
       */
      window.__replay = () => {
        const last = window.__lastState;
        if (!last || !last.handler) return false;
        last.handler({ data: patch(last.raw) });
        return true;
      };

      const Native = window.WebSocket;
      function Patched(...a) {
        const ws = new Native(...a);
        let handler = null;
        ws.addEventListener('message', (ev) => {
          if (!handler) return;
          if (typeof ev.data === 'string' && ev.data.includes('"t":"state"')) {
            window.__lastState = { raw: ev.data, handler };
          }
          handler({ ...ev, data: patch(ev.data) });
        });
        Object.defineProperty(ws, 'onmessage', {
          get: () => handler,
          set: (fn) => {
            handler = fn;
          },
          configurable: true,
        });
        return ws;
      }
      Patched.prototype = Native.prototype;
      for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Patched[k] = Native[k];
      window.WebSocket = Patched;

      // Record what the low-time warning actually does, since neither a buzz nor
      // a beep leaves a mark on a screenshot.
      window.__buzzes = [];
      navigator.vibrate = (pattern) => {
        window.__buzzes.push(pattern);
        return true;
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
    { field: FIELD, playerId: `sim-${name}` },
  );

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
}

/** Everything visible about the clocks, including how they are being styled. */
const clocks = (page) =>
  page.evaluate(() => {
    const box = document.querySelector('[data-clocks]');
    if (!box) return { present: false };
    const el = (side) => document.querySelector(`.clock[data-clock-side="${side}"]`);
    const readSide = (side) => {
      const node = el(side);
      if (!node) return null;
      const time = node.querySelector('.clock-time');
      return {
        text: time?.textContent ?? null,
        running: node.classList.contains('clock-running'),
        low: node.classList.contains('clock-low'),
        colour: time ? getComputedStyle(time).color : null,
      };
    };
    return {
      present: true,
      hidden: box.hidden,
      // The trap: `[hidden]` loses to an author `display`, so ask what the
      // browser actually decided rather than trusting the attribute.
      displayed: getComputedStyle(box).display !== 'none',
      mine: readSide('mine'),
      theirs: readSide('theirs'),
    };
  });

/** Pretend the server said this, and hand the client the snapshot again. */
const setClock = (page, mineMs, theirsMs) =>
  page.evaluate(
    ([m, t]) => {
      window.__clock = { mineMs: m, theirsMs: t };
      return window.__replay();
    },
    [mineMs, theirsMs],
  );

const buzzes = (page) => page.evaluate(() => window.__buzzes.slice());

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium() });
  console.log(`screenshots -> ${OUT}`);

  step(1, 'Two phones on the same field, one game between them');
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

  step(2, 'Before the game starts, the clocks are visible and still');
  const staging = await clocks(white.page);
  check('the clocks are on screen at all', staging.displayed === true, JSON.stringify(staging.mine));
  check('neither is running while staging', staging.mine?.running === false && staging.theirs?.running === false);
  check('both show the full 30 minutes', staging.mine?.text === '30:00', staging.mine?.text ?? '');
  await white.page.screenshot({ path: `${OUT}/1-staging.png` });

  step(3, 'Both walk to their back rank; white’s clock starts and only white’s');
  await walkTo(white.page, 4, 0); // e1
  await walkTo(black.page, 4, 7); // e8
  await white.page.waitForFunction(
    () => document.querySelector('[data-prompt]')?.textContent?.includes('Your move'),
    { timeout: 20_000 },
  );
  await white.page.waitForTimeout(1_500);
  const running = await clocks(white.page);
  check('white’s own clock is marked running', running.mine?.running === true);
  check('black’s is not', running.theirs?.running === false);
  check('white’s is counting down', running.mine?.text !== '30:00', running.mine?.text ?? '');
  check('black’s is not', running.theirs?.text === '30:00', running.theirs?.text ?? '');

  step(4, 'The same clock, seen from the other phone, with mine and theirs swapped');
  const fromBlack = await clocks(black.page);
  check('black sees its own clock still', fromBlack.mine?.text === '30:00', fromBlack.mine?.text ?? '');
  check('black sees white’s running', fromBlack.theirs?.running === true);
  await black.page.screenshot({ path: `${OUT}/2-black-view.png` });

  step(5, 'Under a minute: the clock turns red and the phone buzzes');
  check('nothing has buzzed yet', (await buzzes(white.page)).length === 0);
  check('the last snapshot can be replayed', await setClock(white.page, 45_000, 1_800_000));
  await white.page.waitForFunction(
    () => document.querySelector('.clock[data-clock-side="mine"]')?.classList.contains('clock-low'),
    { timeout: 20_000 },
  );
  const low = await clocks(white.page);
  check('my clock is flagged low', low.mine?.low === true);
  check('and drawn in the warning colour', low.mine?.colour === 'rgb(248, 81, 73)', low.mine?.colour ?? '');
  check('the opponent’s is not', low.theirs?.low === false);
  const afterLow = await buzzes(white.page);
  check('the phone buzzed once', afterLow.length === 1, JSON.stringify(afterLow));
  await white.page.screenshot({ path: `${OUT}/3-low-time.png` });

  step(6, 'It stays quiet while it sits there, rather than buzzing every frame');
  await white.page.waitForTimeout(3_000);
  check('still one buzz after three seconds', (await buzzes(white.page)).length === 1);

  step(7, 'Under fifteen seconds it escalates, and under ten it counts in tenths');
  // Below ten seconds on purpose: that is where `formatClock` switches to
  // tenths, which is what step 8 is about.
  await setClock(white.page, 8_000, 1_800_000);
  await white.page.waitForFunction(() => window.__buzzes.length > 1, { timeout: 20_000 });
  const critical = await clocks(white.page);
  check('two buzzes now', (await buzzes(white.page)).length === 2);
  check(
    'and the second is the more urgent pattern',
    (await buzzes(white.page))[1].length > (await buzzes(white.page))[0].length,
    JSON.stringify(await buzzes(white.page)),
  );
  check(
    'counting in tenths under ten seconds',
    /^\d\.\d$/.test(critical.mine?.text ?? ''),
    critical.mine?.text ?? '',
  );
  await white.page.screenshot({ path: `${OUT}/4-critical.png` });

  step(8, 'The tenths actually move, rather than stepping once a second');
  const samples = [];
  for (let i = 0; i < 6; i++) {
    await white.page.waitForTimeout(180);
    samples.push((await clocks(white.page)).mine?.text);
  }
  check(
    'six samples at 180 ms show more than two distinct values',
    new Set(samples).size > 2,
    JSON.stringify(samples),
  );

  step(9, 'Climbing back over a minute re-arms the warning');
  await setClock(white.page, 300_000, 1_800_000);
  await white.page.waitForFunction(
    () => !document.querySelector('.clock[data-clock-side="mine"]')?.classList.contains('clock-low'),
    { timeout: 20_000 },
  );
  check('no longer low', (await clocks(white.page)).mine?.low === false);
  await setClock(white.page, 30_000, 1_800_000);
  await white.page.waitForFunction(() => window.__buzzes.length > 2, { timeout: 20_000 });
  check('and it buzzes again on the way back down', (await buzzes(white.page)).length === 3);

  await browser.close();
  console.log(`\n${failures === 0 ? 'All clock checks passed.' : `${failures} check(s) FAILED.`}`);
  console.log(`Screenshots in ${OUT}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
