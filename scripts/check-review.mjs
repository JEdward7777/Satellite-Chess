/**
 * The post-game screen and the PGN, after a real game (stages 8.1, 8.2).
 *
 * Two simulated phones play Fool's mate — four moves, every one walked rather
 * than teleported, so each carry has a real distance behind it — and then open
 * "After the game". What this proves that the model and Durable Object tests
 * cannot:
 *
 * - **The button is there when the game ends**, and the screen it opens is led
 *   by distance ("You covered …") with one row per carry underneath.
 * - **The file on the screen is the file the server serves.** The page builds
 *   its PGN at mount, so that Share has nothing to await (`gotchas.md`); the
 *   `/pgn` route is the bottom rung of the ladder. The two must be the same
 *   bytes, and both must parse as the game that was played.
 * - **No coordinates leave in either** (decision 0041), and the join code is
 *   not the file's name (O-34).
 * - **Share hands the sheet a `.pgn` file**, with nothing awaited in front of
 *   it — checked against a stand-in `navigator.share`, since headless Chromium
 *   has no sheet of its own.
 * - **The review survives the game's object** (stage 8.4, decision 0042). The
 *   game is archived and its Durable Object deleted — hastened from a day to
 *   seconds through the dev seam's `POST /api/dev/game/:code/collect`, which
 *   runs the real steps through the real alarm — and then "Your games" opens
 *   the review straight from the archive, with the same file, for the two
 *   players and nobody else.
 *
 * ## Running it
 *
 * Needs a server from an empty state (O-19) and the dev seam:
 *
 *     npm run build:client
 *     npx wrangler dev --port 8799 --var DEV_AUTH_SECRET:local-dev-secret \
 *       --persist-to "$(mktemp -d)" &
 *     node scripts/check-review.mjs [--base=http://127.0.0.1:8799/?sim=1]
 *
 * Takes about a minute: the pieces are carried at a jog.
 */

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

import { DEV_SECRET, signIn } from './driver-signin.mjs';

const args = new Map(
  process.argv.slice(2).map((a) => {
    // Split at the first `=` only: the base URL carries `?sim=1` (O-24).
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length > 0 ? rest.join('=') : 'true'];
  }),
);
const BASE = args.get('base') ?? 'http://127.0.0.1:8799/?sim=1';
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-review-'));

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
  await signIn(context, `sim-review-${name}-${Date.now()}`, new URL(BASE).origin, name);
  // A switch for this phone's game socket, so step 9 can put it to sleep the
  // way a pocket does: every upgrade refused while `severed`, live otherwise.
  const line = { severed: false, live: [] };
  await context.routeWebSocket(/\/ws$/, (ws) => {
    if (line.severed) {
      ws.close();
      return;
    }
    line.live.push({ ws, server: ws.connectToServer() });
  });
  context.line = line;
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

/**
 * A PGN, read back the way a chess program would: tag pairs, then movetext
 * with every `{}` comment and move number stripped. Deliberately small — it
 * checks this file's shape rather than the whole standard.
 */
function parsePgn(pgn) {
  const tags = {};
  const [head, ...rest] = pgn.split(/\n\n/);
  for (const line of head.split('\n')) {
    const m = /^\[(\w+) "((?:[^"\\]|\\.)*)"\]$/.exec(line);
    if (!m) return null;
    tags[m[1]] = m[2];
  }
  const movetext = rest.join('\n\n');
  const comments = [...movetext.matchAll(/\{([^}]*)\}/g)].map((m) => m[1].replace(/\s+/g, ' '));
  const tokens = movetext
    .replace(/\{[^}]*\}/g, ' ')
    .split(/\s+/)
    .filter((t) => t !== '' && !/^\d+\.(\.\.)?$/.test(t));
  const result = tokens.pop();
  return { tags, sans: tokens, comments, result };
}

/** Anything in a file that could put it back on a map. */
function coordinatesIn(pgn) {
  const found = [];
  if (/lat|lng|lon/i.test(pgn)) found.push('a lat/lng word');
  if (pgn.includes(String(A1.lat).slice(0, 5))) found.push(`the field's latitude ${A1.lat}`);
  // Board positions are written to a hundredth of a square; a number with more
  // places than that did not come from the board.
  const precise = /-?\d+\.\d{3,}/.exec(pgn);
  if (precise) found.push(`a number with ${precise[0].split('.')[1].length} places: ${precise[0]}`);
  return found;
}

async function openReview(page) {
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-review-open]');
    return b !== null && !b.hidden;
  }, null, { timeout: 15_000 });
  await page.click('[data-review-open]');
  await page.waitForSelector('section[data-review]', { timeout: 15_000 });
  await page.waitForSelector('[data-review-distance]', { timeout: 15_000 });
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
  await walk(black.page, 4, 7);
  await white.page.waitForFunction(
    () => /Your move/.test(document.querySelector('[data-prompt]')?.textContent ?? ''),
    null,
    { timeout: 20_000 },
  );
  const blackAtStart = await black.page.evaluate(() => globalThis.satchess.me.state.distanceM);
  const reviewHidden = await white.page.evaluate(() => document.querySelector('[data-review-open]')?.hidden);
  check(reviewHidden === true, 'no "After the game" while the game is being played');

  step(2, 'Fool’s mate, every piece carried: 1. f3 e5 2. g4 Qh4#');
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
  const blackPhoneM = await black.page.evaluate(() => globalThis.satchess.me.state.distanceM);

  step(3, 'Black opens "After the game": a win, led by distance, one row per carry');
  await openReview(black.page);
  const headline = await text(black.page, '[data-review-distance]');
  const headlineM = metersIn(headline);
  check(/^You covered /.test(headline ?? '') && headlineM !== null && headlineM > 0, 'the headline is the distance', headline);
  check(/You won — checkmate/.test((await text(black.page, '[data-review-result]')) ?? ''), 'and the result', await text(black.page, '[data-review-result]'));
  const rows = await black.page.evaluate(() =>
    [...document.querySelectorAll('[data-review-moves] li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
  );
  check(rows.length === 4, 'four moves listed', JSON.stringify(rows));
  const carries = rows.map((row) => metersIn(/carried ([\d.]+ (?:km|m))/.exec(row)?.[1]));
  check(carries.every((m) => m !== null && m > 0), 'each with the distance it was carried', carries.join(', '));
  check(/Qh4#/.test(rows[3] ?? '') && carries[3] > 30, 'the queen carried the length of a diagonal', rows[3]);
  // Informational, as in `check-record`: what the game credited against what
  // the phone's own counter added since the start. The gap is the server's
  // residue; any gap between the counter and the ground is O-38's.
  const creditedM = await black.page.evaluate(async (c) => {
    const body = await (await fetch(`/api/game/${c}/review`)).json();
    return body.report.travelM.b;
  }, code);
  console.log(
    `   credited ${creditedM.toFixed(1)} m against ${(blackPhoneM - blackAtStart).toFixed(1)} m ` +
      `counted by black's phone since the start`,
  );
  const walks = await text(black.page, '[data-review-walks]');
  check(/^You · Black/.test(walks ?? '') && /Them · White/.test(walks ?? ''), 'your walk first, the other named only by color', walks);
  // No total of the carries: it would only repeat the floor under the
  // headline (decision 0041).
  check(!/carrying/.test(walks ?? '') && /longest carry/.test(walks ?? ''), 'the longest carry, and no total of carries to contradict the headline');
  const longestM = metersIn(/longest carry ([\d.]+ (?:km|m))/.exec(walks ?? '')?.[1]);
  // The walk is floored by the carries it contains (decision 0041), so the
  // headline can never read less than one of them.
  check(
    headlineM !== null && longestM !== null && headlineM >= longestM,
    'the headline is at least the longest carry',
    `${headlineM} m ≥ ${longestM} m`,
  );
  const honesty = await text(black.page, '[data-review-honesty]');
  check(/taken on trust/.test(honesty ?? '') && /leans short/.test(honesty ?? ''), 'it says how far to trust the number (O-03, O-12)');
  const order = await black.page.evaluate(() => {
    const d = document.querySelector('[data-review-distance]');
    const c = document.querySelector('[data-review-coverage]');
    return {
      first: d.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING,
      fontPx: Number.parseFloat(getComputedStyle(d).fontSize),
      bodyPx: Number.parseFloat(getComputedStyle(c).fontSize),
    };
  });
  check(order.first !== 0 && order.fontPx > 2 * order.bodyPx, 'distance is first and the largest thing there', `${order.fontPx}px vs ${order.bodyPx}px`);
  await black.page.screenshot({ path: `${OUT}/1-black-review.png`, fullPage: true });

  step(4, 'The file: what the screen holds, and what the server serves');
  await black.page.click('[data-review-show]');
  const shown = await black.page.evaluate(() => {
    const t = document.querySelector('[data-review-text]');
    return { hidden: t.hidden, value: t.value };
  });
  check(!shown.hidden && shown.value.startsWith('[Event "Satellite Chess"]'), '"Show the file" shows the PGN');
  const served = await black.page.evaluate(async (c) => {
    const r = await fetch(`/api/game/${c}/pgn`);
    return {
      status: r.status,
      type: r.headers.get('content-type'),
      disposition: r.headers.get('content-disposition'),
      body: await r.text(),
    };
  }, code);
  check(served.status === 200, 'GET /api/game/CODE/pgn', `${served.status} ${served.type}`);
  check(/^application\/x-chess-pgn/.test(served.type ?? ''), 'served as a chess file');
  check(
    /^attachment; filename="satellite-chess-\d{4}-\d{2}-\d{2}-sim-field\.pgn"$/.test(served.disposition ?? ''),
    'as an attachment named for the day and the field',
    served.disposition,
  );
  check(!(served.disposition ?? '').includes(code) && !served.body.includes(code), 'with the join code in neither the name nor the file');
  check(served.body === shown.value, 'the same bytes the screen built');
  const parsed = parsePgn(served.body);
  check(parsed !== null, 'it parses');
  check(
    JSON.stringify(parsed?.sans) === JSON.stringify(['f3', 'e5', 'g4', 'Qh4#']),
    'as the game that was played',
    JSON.stringify(parsed?.sans),
  );
  check(parsed?.result === '0-1' && parsed?.tags.Result === '0-1', 'with its result', parsed?.result);
  check(parsed?.tags.White === '?' && parsed?.tags.Black === '?', 'and nobody named');
  check(parsed?.tags.Termination === 'normal' && parsed?.tags.SatelliteEnd === 'checkmate', 'ended by checkmate');
  check(/^\d+\+\d+$/.test(parsed?.tags.TimeControl ?? ''), 'with the time control it was created with', parsed?.tags.TimeControl);
  check(Number(parsed?.tags.SatelliteBlackWalkedM) > 0, 'and black’s walk', parsed?.tags.SatelliteBlackWalkedM);
  const carryComments = (parsed?.comments ?? []).filter((c) => /^carry /.test(c));
  check(carryComments.length === 4 && carryComments.every((c) => /lift -?[\d.]+,-?[\d.]+/.test(c) && /place -?[\d.]+,-?[\d.]+/.test(c)), 'each move carries its walk, in squares', carryComments[3]);
  const leaks = coordinatesIn(served.body);
  check(leaks.length === 0, 'no coordinates anywhere in it', leaks.join('; '));
  check(served.body.split('\n').every((line) => line.length <= 80), 'no line over 80 columns');

  step(5, 'Share hands the sheet a .pgn file');
  // Headless Chromium has no share sheet, so a stand-in records what it was
  // given. It is installed before the tap and never awaited, as a real one
  // would not be.
  await black.page.evaluate(() => {
    globalThis.__shared = null;
    navigator.canShare = (data) => Array.isArray(data?.files);
    navigator.share = async (data) => {
      const file = data.files?.[0];
      globalThis.__shared = {
        name: file?.name ?? null,
        type: file?.type ?? null,
        body: file ? await file.text() : null,
        text: data.text ?? null,
      };
    };
  });
  await black.page.click('[data-review-share]');
  await black.page.waitForFunction(() => globalThis.__shared !== null, null, { timeout: 10_000 });
  const shared = await black.page.evaluate(() => globalThis.__shared);
  check(/^satellite-chess-.*\.pgn$/.test(shared.name ?? '') && !shared.name.includes(code), 'a named .pgn', shared.name);
  check(shared.type === 'application/x-chess-pgn' && shared.body === served.body, 'holding the same file');
  check(/^You covered /.test(shared.text ?? ''), 'with a line worth sending', shared.text);
  await black.page.waitForFunction(() => document.querySelector('[data-review-said]')?.textContent === 'Sent.', null, { timeout: 5_000 });
  check(true, 'and the screen says it went');

  step(6, 'White’s screen: a loss, the same file');
  await openReview(white.page);
  check(/You lost — checkmate/.test((await text(white.page, '[data-review-result]')) ?? ''), 'you lost', await text(white.page, '[data-review-result]'));
  check(/^You · White/.test((await text(white.page, '[data-review-walks]')) ?? ''), 'white’s own walk first');
  const whiteFile = await white.page.evaluate(() => document.querySelector('[data-review-text]').value);
  check(whiteFile === served.body, 'one canonical file, whichever seat reads it');
  await white.page.screenshot({ path: `${OUT}/2-white-review.png`, fullPage: true });

  step(7, 'With no share sheet and no clipboard, the text is shown');
  await white.page.evaluate(() => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });
  await white.page.click('[data-review-share]');
  await white.page.waitForFunction(() => {
    const t = document.querySelector('[data-review-text]');
    return t !== null && !t.hidden;
  }, null, { timeout: 5_000 });
  check(true, 'the bottom rung is a visible text', await text(white.page, '[data-review-said]'));
  const href = await white.page.getAttribute('[data-review-download]', 'href');
  check(href === `/api/game/${code}/pgn`, 'beside a plain download link the server answers', href);

  step(8, 'Home leaves the review');
  await white.page.click('[data-review-home]');
  await white.page.waitForSelector('[data-new]', { timeout: 15_000 });
  check(true, 'home again');

  step(9, 'White leaves the board up and the phone sleeps; a day later the game is archived and deleted');
  const origin = new URL(BASE).origin;
  // Back to the board the ordinary way, so it is mounted with a live socket.
  await white.page.waitForSelector(`[data-game="${code}"]`, { timeout: 15_000 });
  await white.page.click(`[data-game="${code}"]`);
  await white.page.waitForSelector('[data-board]', { timeout: 15_000 });
  await white.page.waitForFunction(() => /checkmate/i.test(document.querySelector('[data-prompt]')?.textContent ?? ''), null, { timeout: 15_000 });
  // Asleep: the socket goes, and every attempt to bring it back is refused.
  white.context.line.severed = true;
  for (const { ws, server } of white.context.line.live.splice(0)) {
    try { server.close(); } catch {}
    try { ws.close(); } catch {}
  }
  await white.page.waitForFunction(() => /Reconnecting/.test(document.querySelector('[data-prompt]')?.textContent ?? ''), null, { timeout: 15_000 });
  check(true, 'the board says it is reconnecting');
  // Long enough for the object to see the close before anything is hastened.
  await new Promise((r) => setTimeout(r, 2_000));
  const hastened = await white.context.request.post(`${origin}/api/dev/game/${code}/collect`, {
    headers: { 'x-dev-auth-secret': DEV_SECRET },
    data: { afterMs: 0 },
  });
  check(hastened.status() === 200, 'collection hastened through the dev seam', String(hastened.status()));
  const peekAs = (page) =>
    page.evaluate(async (c) => (await fetch(`/api/game/${c}`)).json(), code);
  let archived = null;
  for (let i = 0; i < 60 && archived?.archived !== true; i++) {
    await new Promise((r) => setTimeout(r, 500));
    archived = await peekAs(white.page);
  }
  check(archived?.archived === true && archived?.status === 'finished', 'the game reads as archived to a player', JSON.stringify(archived));
  check(!('field' in (archived ?? {})), 'and hands out no field');

  step('9b', 'The phone wakes: the board notices its game has gone, opens the review, and stops retrying');
  let upgrades = 0;
  white.page.on('websocket', () => {
    upgrades += 1;
  });
  white.context.line.severed = false;
  await white.page.waitForSelector('section[data-review]', { timeout: 90_000 });
  await white.page.waitForSelector('[data-review-distance]', { timeout: 15_000 });
  check(/You lost — checkmate/.test((await text(white.page, '[data-review-result]')) ?? ''), 'the review opened by itself, from the archive', await text(white.page, '[data-review-result]'));
  const upgradesThen = upgrades;
  await new Promise((r) => setTimeout(r, 25_000));
  check(upgrades === upgradesThen, 'and no socket has been tried since', `${upgrades - upgradesThen} more after ${upgradesThen}`);
  await white.page.click('[data-review-home]');
  await white.page.waitForSelector('[data-new]', { timeout: 15_000 });

  step(10, '"Your games" opens the review straight from the archive');
  await white.page.reload({ waitUntil: 'domcontentloaded' });
  await white.page.waitForSelector(`[data-game="${code}"]`, { timeout: 15_000 });
  await white.page.click(`[data-game="${code}"]`);
  await white.page.waitForSelector('section[data-review]', { timeout: 15_000 });
  await white.page.waitForSelector('[data-review-distance]', { timeout: 15_000 });
  check(/You lost — checkmate/.test((await text(white.page, '[data-review-result]')) ?? ''), 'the same result', await text(white.page, '[data-review-result]'));
  const archivedRows = await white.page.evaluate(() => document.querySelectorAll('[data-review-moves] li').length);
  check(archivedRows === 4, 'the same four carries', String(archivedRows));
  const archivedFile = await white.page.evaluate(() => document.querySelector('[data-review-text]').value);
  check(archivedFile === served.body, 'the same file, byte for byte');
  const fromArchive = await white.page.evaluate(async (c) => {
    const r = await fetch(`/api/game/${c}/pgn`);
    return { status: r.status, disposition: r.headers.get('content-disposition'), body: await r.text() };
  }, code);
  check(fromArchive.status === 200 && fromArchive.body === served.body, 'and the server serves it from the archive');
  check(fromArchive.disposition === served.disposition, 'under the same name', fromArchive.disposition);
  await white.page.screenshot({ path: `${OUT}/3-white-review-archived.png`, fullPage: true });

  step(11, 'A deep link to the game on the other phone lands on the review too');
  await black.page.goto(new URL(`/j/${code}${new URL(BASE).search}`, origin).href, { waitUntil: 'domcontentloaded' });
  await black.page.waitForSelector('section[data-review]', { timeout: 15_000 });
  await black.page.waitForSelector('[data-review-distance]', { timeout: 15_000 });
  check(/You won — checkmate/.test((await text(black.page, '[data-review-result]')) ?? ''), 'black’s own review', await text(black.page, '[data-review-result]'));

  step(12, 'Nobody else can read it, and a code that was a game is nothing to them');
  const stranger = await browser.newContext();
  await signIn(stranger, `sim-review-stranger-${Date.now()}`, origin, 'stranger');
  for (const suffix of ['', '/review', '/pgn']) {
    const r = await stranger.request.get(`${origin}/api/game/${code}${suffix}`);
    const body = await r.text();
    if (suffix === '') {
      check(r.status() === 200 && JSON.parse(body).exists === false, 'a stranger’s peek finds no game', body);
    } else {
      check(r.status() === 404, `a stranger gets 404 from ${suffix}`, String(r.status()));
    }
  }
  const joinAttempt = await stranger.request.post(`${origin}/api/game/${code}`);
  check(joinAttempt.status() === 404, 'and cannot join it', String(joinAttempt.status()));
  await stranger.close();

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
          review: document.querySelector('section[data-review]')?.textContent?.replace(/\s+/g, ' '),
        }))
        .catch(() => null);
      console.error(`   screen: ${JSON.stringify(said)}`);
    }
  }
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
