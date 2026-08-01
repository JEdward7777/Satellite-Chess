/**
 * Drive two simulated phones through a real game, and photograph the result.
 *
 * Every view bug this project has had was invisible to a unit test and obvious
 * in a screenshot, so `harness/AGENTS.md` asks for a browser check on anything
 * that changes the game screen. Three separate sessions have now written this
 * driver from scratch and thrown it away, each rediscovering the same two traps
 * (see below). This is that script, kept.
 *
 * ## Running it
 *
 *     npm run build:client
 *     npx wrangler dev --port 8799 --local &
 *     npm install --no-save playwright     # deliberately not a dependency
 *     node scripts/drive-game.mjs
 *
 * Playwright is left out of `package.json` on purpose: it is a large install
 * that only matters when someone is looking at pixels, and CI does not run it.
 *
 * ## The two traps
 *
 * **Clicking the board teleports *and* taps.** `attachSimDrag` moves the player
 * on `pointerdown`; the game view taps on `pointerup`. A plain `page.mouse.click`
 * therefore places the piece wherever you already were.
 *
 * **The simulator only emits a fix once a second.** So a tap dispatched straight
 * after a teleport still carries the *old* position, and the server rejects it
 * with a reach error that looks like a bug in the reach code. `walkTo` waits for
 * the on-screen square readout to catch up before `tapSquare` fires.
 *
 * ## Why the WebSocket is slowed down
 *
 * Against a local `wrangler dev` the round trip is about a millisecond, so the
 * optimistic window of stage 4.3.6 is far too short to see. `window.__wsDelay`
 * holds inbound frames for that many milliseconds, which leaves the screen
 * showing nothing but the client's own prediction for as long as is useful.
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
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-drive-'));

/**
 * The pre-installed browsers in a cloud session are a different revision from
 * whatever `npm install playwright` just fetched, so the bundled default path is
 * usually wrong. Look for what is actually on disk before giving up.
 */
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
const M_PER_DEG_LAT = (6378137 * Math.PI) / 180; // as in shared/geo.ts
const FILES = 'abcdefgh';

/** `fromLocal` from geo.ts, so the driver lands where the app thinks it landed. */
function squareLatLng(file, rank) {
  return {
    lat: A1.lat + (rank * SQUARE_M) / M_PER_DEG_LAT,
    lng: A1.lng + (file * SQUARE_M) / (M_PER_DEG_LAT * Math.cos((A1.lat * Math.PI) / 180)),
  };
}

/** The field the app would have saved after a calibration walk. */
const FIELD = {
  id: 'sim-field',
  name: 'Sim Field',
  a1: A1,
  h8: squareLatLng(7, 7),
  version: 1,
  createdAt: 0,
  updatedAt: 0,
};

/** `projectionFor` from client/render.ts, replayed so a test can aim at a square. */
function squareToPixel(file, rank, orientation, w, h) {
  const sizeM = 8 * SQUARE_M;
  const minU = -SQUARE_M / 2;
  const maxU = 7 * SQUARE_M + SQUARE_M / 2;
  const size = Math.min(w, h);
  const pad = size * 0.06; // PADDING
  const scale = (size - 2 * pad) / sizeM;
  const offsetX = (w - sizeM * scale) / 2;
  const offsetY = (h - sizeM * scale) / 2;
  const bp = { u: file * SQUARE_M, v: rank * SQUARE_M };
  const u = orientation === 'w' ? bp.u - minU : maxU - bp.u;
  const v = orientation === 'w' ? maxU - bp.v : bp.v - minU;
  return { x: offsetX + u * scale, y: offsetY + v * scale };
}

async function newPhone(browser, name) {
  const context = await browser.newContext({ viewport: { width: 480, height: 900 } });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [${name}] console error: ${m.text()}`);
  });

  await page.addInitScript(
    ({ field, playerId }) => {
      localStorage.setItem('satchess.player_id', playerId);

      // A delay knob for inbound frames, so a prediction can be photographed.
      window.__wsDelay = 0;
      const Native = window.WebSocket;
      function Delayed(...a) {
        const ws = new Native(...a);
        let handler = null;
        ws.addEventListener('message', (ev) => {
          const d = window.__wsDelay | 0;
          if (d > 0) setTimeout(() => handler && handler(ev), d);
          else if (handler) handler(ev);
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
      Delayed.prototype = Native.prototype;
      for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Delayed[k] = Native[k];
      window.WebSocket = Delayed;

      // Seed the saved field, so a run starts past calibration.
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
  await page.waitForSelector('[data-start]', { timeout: 15_000 });
  return { context, page, name };
}

/** Teleport, and wait for the app to believe it — see "the two traps" above. */
async function walkTo(page, file, rank) {
  await page.evaluate((pos) => globalThis.satchess.me.moveTo(pos), squareLatLng(file, rank));
  await page.waitForFunction(
    (sq) => document.querySelector('[data-square]')?.textContent === sq,
    FILES[file] + String(rank + 1),
    { timeout: 10_000 },
  );
}

/** Tap without moving: a bare `pointerup`, which `attachSimDrag` ignores. */
async function tapSquare(page, file, rank, orientation) {
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

const walkAndTap = async (page, file, rank, orientation) => {
  await walkTo(page, file, rank);
  await tapSquare(page, file, rank, orientation);
};

const readout = (page) =>
  page.evaluate(() => {
    const text = (sel) => {
      const el = document.querySelector(sel);
      return !el || el.hidden ? null : el.textContent;
    };
    return {
      square: text('[data-square]'),
      turn: text('[data-turn]'),
      carry: text('[data-carry]'),
      prompt: text('[data-prompt]'),
      notice: text('[data-notice]'),
    };
  });

const setDelay = (page, ms) => page.evaluate((d) => (window.__wsDelay = d), ms);

/**
 * Find the opponent's dot by its colour, in canvas pixels.
 *
 * The dot is the one thing on this screen that moves without the phone holding
 * it moving, so a screenshot alone cannot say whether it is being interpolated
 * or merely jumping. Reading its centre out once a second can.
 */
const opponentDot = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector('[data-board]');
    const ctx = canvas.getContext('2d');
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      // OPPONENT_DOT is #ff4d6d and nothing else on the board is near it.
      if (data[i] > 220 && data[i + 1] > 40 && data[i + 1] < 110 && data[i + 2] > 80 && data[i + 2] < 140) {
        const p = i / 4;
        sx += p % width;
        sy += Math.floor(p / width);
        n += 1;
      }
    }
    return n === 0 ? null : { x: Math.round(sx / n), y: Math.round(sy / n), px: n, height };
  });
const step = (n, msg) => console.log(`\n${n}. ${msg}`);
const show = (label, state) => console.log(`   ${label}: ${JSON.stringify(state)}`);

const browser = await chromium.launch({ executablePath: findChromium() });

try {
  console.log(`screenshots -> ${OUT}`);

  step(1, 'Open two phones on the same field');
  const white = await newPhone(browser, 'white');
  const black = await newPhone(browser, 'black');

  step(2, 'White creates a game');
  await white.page.click('[data-start]');
  await white.page.waitForSelector('[data-join-code]', { timeout: 15_000 });
  const code = (await white.page.textContent('[data-join-code]')).replace('Join code: ', '').trim();
  console.log(`   join code ${code}`);

  step(3, 'Black joins by code');
  await black.page.fill('[data-code]', code);
  await black.page.click('[data-join]');
  await black.page.waitForSelector('[data-board]', { timeout: 15_000 });

  step(4, 'Both walk to their own back rank, which starts the game');
  await walkTo(white.page, 4, 0); // e1
  await walkTo(black.page, 4, 7); // e8
  await white.page.waitForFunction(
    () => document.querySelector('[data-prompt]')?.textContent?.includes('Your move'),
    { timeout: 20_000 },
  );
  show('active', await readout(white.page));

  step(5, 'Hold white’s inbound frames, then lift a pawn (stage 4.3.6)');
  await setDelay(white.page, 1_500);
  await walkAndTap(white.page, 4, 1, 'w'); // e2
  await white.page.waitForTimeout(150);
  show('server still silent', await readout(white.page));
  await white.page.screenshot({ path: `${OUT}/1-optimistic-lift.png` });

  step(6, 'Let the answer through: the destinations replace the guess');
  await white.page.waitForTimeout(2_000);
  show('confirmed', await readout(white.page));
  await white.page.screenshot({ path: `${OUT}/2-confirmed-lift.png` });

  step(7, 'Walk to e4 and place, still held');
  await setDelay(white.page, 1_500);
  await walkAndTap(white.page, 4, 3, 'w'); // e4
  await white.page.waitForTimeout(150);
  show('server still silent', await readout(white.page));
  await white.page.screenshot({ path: `${OUT}/3-optimistic-place.png` });
  await white.page.waitForTimeout(2_500);
  show('confirmed', await readout(white.page));

  step(8, 'The opponent sees the move');
  await black.page.waitForTimeout(500);
  show('black', await readout(black.page));
  await black.page.screenshot({ path: `${OUT}/4-black-view.png` });

  step(9, 'An action the server would refuse is never predicted');
  await setDelay(white.page, 1_500);
  await walkAndTap(white.page, 3, 1, 'w'); // d2, on black's turn
  await white.page.waitForTimeout(150);
  show('right after the tap', await readout(white.page));
  await white.page.waitForTimeout(2_000);
  show('once the refusal lands', await readout(white.page));
  await white.page.screenshot({ path: `${OUT}/5-refused.png` });

  step(10, 'Black walks across the field; white watches the dot (stage 3.4.3)');
  await setDelay(white.page, 0);
  // Walked rather than teleported: a jump no one could have walked is snapped on
  // purpose, so a teleport would prove nothing about the interpolation.
  await black.page.evaluate((pos) => globalThis.satchess.me.walkTo(pos, { speedMps: 1.4 }), squareLatLng(4, 4));
  const track = [];
  for (let i = 0; i < 8; i++) {
    await white.page.waitForTimeout(1_000);
    track.push(await opponentDot(white.page));
  }
  console.log(`   dot, once a second: ${JSON.stringify(track)}`);
  await white.page.screenshot({ path: `${OUT}/6-opponent-dot.png` });

  step(11, 'Black drops off the air; the dot goes hollow rather than vanishing');
  // Not aged out on silence: under the send policy a player who is standing
  // still relays once and then says nothing, so only the connection can say
  // whether the dot is still live.
  await black.context.close();
  await white.page.waitForFunction(
    () => document.querySelector('[data-prompt]') !== null,
    { timeout: 5_000 },
  );
  await white.page.waitForTimeout(1_500);
  console.log(`   dot after the drop: ${JSON.stringify(await opponentDot(white.page))}`);
  await white.page.screenshot({ path: `${OUT}/7-opponent-gone.png` });

  console.log(`\nDone. Screenshots in ${OUT}`);
} finally {
  await browser.close();
}
