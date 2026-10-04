/**
 * The replay, after a real game and after its archive (stage 8.3, decision 0052).
 *
 * Two simulated phones play Fool's mate, every piece walked rather than
 * teleported, so the relays the phones already send while moving become each
 * player's walk. Then "After the game" is scrubbed, and the same again once the
 * game has been archived and its object deleted. What this proves that the
 * model and Durable Object tests cannot:
 *
 * - **The board at each step is the game's position**, reached by Back, Next,
 *   the scrubber and a tap on a move in the list.
 * - **The carry is drawn and said**: where the piece was picked up and put
 *   down (read off the canvas as the orange ring and disc), and the distance,
 *   which must be the move list's own figure.
 * - **The walks are kept, as squares only**: the report carries both players'
 *   tracks, tagged by move and by piece in hand, with nothing in them that
 *   could be a latitude; the PGN carries none of it.
 * - **Scrubbing sends nothing**: once loaded, it works offline.
 * - **An archived game replays the same**, with the same walks, and a stranger
 *   still gets 404.
 * - Both piece looks, and the pinch zoom, on the replay board.
 *
 * ## Running it
 *
 *     npm run build:client
 *     npx wrangler dev --port 8799 --var DEV_AUTH_SECRET:local-dev-secret \
 *       --persist-to "$(mktemp -d)" &
 *     node scripts/check-replay.mjs [--base=http://127.0.0.1:8799/?sim=1] [--out=DIR]
 *
 * Takes about two minutes.
 */

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

import { DEV_SECRET, signIn } from './driver-signin.mjs';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length > 0 ? rest.join('=') : 'true'];
  }),
);
const BASE = args.get('base') ?? 'http://127.0.0.1:8799/?sim=1';
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-replay-'));

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

/** The game board's pixels for a square (`render.ts`), on the 8 m field. */
function boardPixel(file, rank, orientation, w, h, squareM = SQUARE_M) {
  const sizeM = 8 * squareM;
  const minU = -squareM / 2;
  const maxU = 7 * squareM + squareM / 2;
  const size = Math.min(w, h);
  const pad = size * 0.06;
  const scale = (size - 2 * pad) / sizeM;
  const offsetX = (w - sizeM * scale) / 2;
  const offsetY = (h - sizeM * scale) / 2;
  const u = orientation === 'w' ? file * squareM - minU : maxU - file * squareM;
  const v = orientation === 'w' ? maxU - rank * squareM : rank * squareM - minU;
  return { x: offsetX + u * scale, y: offsetY + v * scale };
}

/** The replay board is the same layout on one-meter squares. */
const replayPixel = (file, rank, orientation, w, h) => boardPixel(file, rank, orientation, w, h, 1);

/** Placements after each step of Fool's mate. */
const PLACEMENTS = [
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',
  'rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR',
  'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR',
  'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR',
  'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR',
];
const MOVES = [
  { san: 'f3', from: 'f2', to: 'f3', head: 'Step 1 of 4 · 1. f3', who: 'White moved f2 to f3' },
  { san: 'e5', from: 'e7', to: 'e5', head: 'Step 2 of 4 · 1… e5', who: 'Black moved e7 to e5' },
  { san: 'g4', from: 'g2', to: 'g4', head: 'Step 3 of 4 · 2. g4', who: 'White moved g2 to g4' },
  { san: 'Qh4#', from: 'd8', to: 'h4', head: 'Step 4 of 4 · 2… Qh4#', who: 'Black moved d8 to h4' },
];

let failures = 0;
function check(ok, what, detail = '') {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const step = (n, msg) => console.log(`\n${n}. ${msg}`);

async function newPhone(browser, name) {
  // Metric, because this reads meters off the screen (decision 0049). Touch,
  // so the replay board can be pinched the way a phone would.
  const context = await browser.newContext({
    viewport: { width: 480, height: 900 },
    locale: 'en-GB',
    hasTouch: true,
  });
  await signIn(context, `sim-replay-${name}-${Date.now()}`, new URL(BASE).origin, name);
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
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-calibrate]', { timeout: 15_000 });
  const cdp = await context.newCDPSession(page);
  return { context, page, name, cdp };
}

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
  // The simulator stops before its last fix lands: give it one more fix
  // interval (`DEFAULT_FIX_INTERVAL_MS`, 1 s) so the lift or place that
  // follows is sent from where the walk ended, not a third of a square short.
  await page.waitForTimeout(1_200);
}

/** A tap on the game board: a matched pointerdown/pointerup pair (decision 0046). */
async function tap(page, file, rank, orientation) {
  const box = await page.locator('[data-board]').boundingBox();
  const p = boardPixel(file, rank, orientation, box.width, box.height);
  await page.evaluate(
    ({ x, y }) => {
      const canvas = document.querySelector('[data-board]');
      const rect = canvas.getBoundingClientRect();
      for (const type of ['pointerdown', 'pointerup']) {
        canvas.dispatchEvent(
          new PointerEvent(type, { clientX: rect.left + x, clientY: rect.top + y, bubbles: true, pointerId: 1, isPrimary: false }),
        );
      }
    },
    { x: p.x, y: p.y },
  );
}

const sq = (name) => [FILES.indexOf(name[0]), Number(name[1]) - 1];

async function play(phone, orientation, from, to, san, other) {
  await walk(phone.page, ...sq(from));
  await tap(phone.page, ...sq(from), orientation);
  await phone.page.waitForFunction(() => {
    const el = document.querySelector('[data-carry]');
    return el !== null && !el.hidden;
  }, null, { timeout: 10_000 });
  await walk(phone.page, ...sq(to));
  await tap(phone.page, ...sq(to), orientation);
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

async function openReview(page) {
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-review-open]');
    return b !== null && !b.hidden;
  }, null, { timeout: 15_000 });
  await page.click('[data-review-open]');
  await page.waitForSelector('[data-replay]', { timeout: 15_000 });
}

/** What the replay shows now: the step, the placement, and the words. */
function replayState(page) {
  return page.evaluate(() => {
    const section = document.querySelector('[data-replay]');
    const said = (s) => section.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() ?? null;
    return {
      ply: Number(section.dataset.ply),
      fen: section.dataset.fen,
      head: said('[data-replay-head]'),
      carry: said('[data-replay-carry]'),
      lift: said('[data-replay-lift]'),
      carried: said('[data-replay-carried]'),
      place: said('[data-replay-place]'),
      prevDisabled: section.querySelector('[data-replay-prev]').disabled,
      nextDisabled: section.querySelector('[data-replay-next]').disabled,
      scrub: section.querySelector('[data-replay-scrub]').value,
      current: section.ownerDocument.querySelector('[data-replay-to][aria-current="step"]')?.dataset.replayTo ?? null,
    };
  });
}

/**
 * Orange pixels (the carry's ring and disc, `#ff8c1a`) within `radius` of a
 * place on the replay board: a square's centre, or a `{file, rank}` from the
 * report — where the ring and disc are actually drawn, which is the fix the
 * phone sent, not the centre of the square it named.
 */
async function orangeNear(page, where, orientation, radius = 16) {
  const box = await page.locator('[data-replay] [data-board]').boundingBox();
  const [file, rank] = typeof where === 'string' ? sq(where) : [where.file, where.rank];
  const p = replayPixel(file, rank, orientation, box.width, box.height);
  return page.evaluate(
    ({ x, y, r }) => {
      const canvas = document.querySelector('[data-replay] [data-board]');
      const dpr = canvas.width / canvas.getBoundingClientRect().width;
      const data = canvas
        .getContext('2d')
        .getImageData(Math.round((x - r) * dpr), Math.round((y - r) * dpr), Math.round(2 * r * dpr), Math.round(2 * r * dpr)).data;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 225 && data[i + 1] > 110 && data[i + 1] < 170 && data[i + 2] < 70) n += 1;
      }
      return n;
    },
    { x: p.x, y: p.y, r: radius },
  );
}

/** Pixels that are not the carry's orange, inside a circle of `radius` CSS px at a place. */
async function notOrangeWithin(page, where, orientation, radius) {
  const box = await page.locator('[data-replay] [data-board]').boundingBox();
  const p = replayPixel(where.file, where.rank, orientation, box.width, box.height);
  return page.evaluate(
    ({ x, y, r }) => {
      const canvas = document.querySelector('[data-replay] [data-board]');
      const dpr = canvas.width / canvas.getBoundingClientRect().width;
      const R = r * dpr;
      const cx = x * dpr;
      const cy = y * dpr;
      const x0 = Math.floor(cx - R);
      const y0 = Math.floor(cy - R);
      const size = Math.ceil(2 * R) + 1;
      const data = canvas.getContext('2d').getImageData(x0, y0, size, size).data;
      let n = 0;
      for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
          if (Math.hypot(x0 + i + 0.5 - cx, y0 + j + 0.5 - cy) > R) continue;
          const k = (j * size + i) * 4;
          const orange = data[k] > 225 && data[k + 1] > 110 && data[k + 1] < 170 && data[k + 2] < 70;
          if (!orange) n += 1;
        }
      }
      return n;
    },
    { x: p.x, y: p.y, r: radius },
  );
}

/** The step a scrubber, a button or a list tap left the replay on, once painted. */
async function waitForPly(page, ply) {
  await page.waitForFunction((n) => document.querySelector('[data-replay]')?.dataset.ply === String(n), ply, { timeout: 5_000 });
}

async function touch(phone, type, points) {
  await phone.cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i })),
  });
}

async function pinchReplay(phone) {
  const box = await phone.page.locator('[data-replay] [data-board]').boundingBox();
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const pts = (d) => [
    { x: at.x - d / 2, y: at.y },
    { x: at.x + d / 2, y: at.y },
  ];
  await touch(phone, 'touchStart', pts(60));
  for (let i = 1; i <= 10; i++) await touch(phone, 'touchMove', pts(60 + 18 * i));
  await touch(phone, 'touchEnd', []);
  await phone.page.waitForTimeout(150);
}

/** The steps and words a reader sees at every step, for comparing two reads. */
async function walkThrough(page) {
  const seen = [];
  await page.click('[data-replay-to="1"]');
  await waitForPly(page, 1);
  for (let ply = 1; ply <= 4; ply++) {
    if (ply > 1) {
      await page.click('[data-replay-next]');
      await waitForPly(page, ply);
    }
    seen.push(await replayState(page));
  }
  return seen;
}

const browser = await chromium.launch({ executablePath: findChromium() });

try {
  console.log(`screenshots -> ${OUT}`);
  const origin = new URL(BASE).origin;

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

  step(2, 'Fool’s mate, every piece walked to and carried');
  await play(white, 'w', 'f2', 'f3', 'f3', black);
  await play(black, 'b', 'e7', 'e5', 'e5', white);
  await play(white, 'w', 'g2', 'g4', 'g4', black);
  await play(black, 'b', 'd8', 'h4', 'Qh4#', white);
  await white.page.waitForFunction(
    () => /checkmate/i.test(document.querySelector('[data-prompt]')?.textContent ?? ''),
    null,
    { timeout: 15_000 },
  );
  check(true, 'the game is over');

  step(3, 'The report carries both walks, as squares, and the file carries neither');
  const live = await black.page.evaluate(async (c) => (await fetch(`/api/game/${c}/review`)).json(), code);
  const tracks = live.report.tracks;
  check(tracks && Array.isArray(tracks.w) && Array.isArray(tracks.b), 'a track for each player', JSON.stringify(tracks)?.slice(0, 160));
  const all = [...(tracks?.w ?? []), ...(tracks?.b ?? [])];
  check(all.length >= 8, 'with the lifts, the places and the relays between', `${tracks?.w.length} white, ${tracks?.b.length} black`);
  check(
    all.every((f) => f.length === 3 && Number.isInteger(f[0]) && Math.abs(f[1]) <= 12 && Math.abs(f[2]) <= 12),
    'every fix three numbers, a tag and a place within a few squares of the board',
  );
  check(!/51\.4|-0\.00|lat|lng/i.test(JSON.stringify(tracks)), 'nothing in them that could be a latitude');
  const tagged = (list, ply, carrying) => list.filter(([t]) => (t >> 1) === ply - 1 && (t & 1) === (carrying ? 1 : 0));
  check(tagged(tracks.b, 4, true).length >= 2, 'the queen’s carry has fixes in hand', String(tagged(tracks.b, 4, true).length));
  check(tagged(tracks.b, 4, false).length >= 1, 'and black’s walk to her', String(tagged(tracks.b, 4, false).length));
  const pgn = await black.page.evaluate(async (c) => (await fetch(`/api/game/${c}/pgn`)).text(), code);
  // A lift and a place per move are the only positions the file has ever
  // held (decision 0041): four moves, eight. A walk would add more.
  const pairs = pgn.match(/-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/g) ?? [];
  check(pairs.length === 8, 'the PGN carries no walk: a lift and a place a move, nothing more', `${pairs.length} positions`);

  step(4, 'Black opens the review: the replay is on the last step, the mate');
  await openReview(black.page);
  let s = await replayState(black.page);
  check(s.ply === 4 && s.fen === PLACEMENTS[4], 'step 4, the final position', `${s.ply} ${s.fen}`);
  check(s.head === MOVES[3].head, 'headed as the move list reads it', s.head);
  check(s.nextDisabled && !s.prevDisabled, 'Next is off at the end, Back is on');
  check(/^Black moved d8 to h4/.test(s.carry ?? ''), 'the carry says who moved what', s.carry);
  check(s.lift === 'Picked up standing on d8' && s.place === 'Put down standing on h4', 'where it was picked up and put down', `${s.lift} / ${s.place}`);
  const listRow = await black.page.evaluate(
    () => document.querySelectorAll('[data-review-moves] li')[3].textContent.replace(/\s+/g, ' ').trim(),
  );
  const listCarry = /carried ([^·]+)$/.exec(listRow)?.[1]?.trim();
  check(
    listCarry !== undefined && s.carried?.toLowerCase() === `carried ${listCarry}`.toLowerCase(),
    'the carry figure is the move list’s own',
    `${s.carried} / ${listRow}`,
  );
  check(s.current === '4', 'the move is marked in the list');
  const fixes = live.report.moves.map((m) => ({ lift: m.lift, place: m.place }));
  check(
    fixes.length === 4 && fixes.every((f) => f.lift && f.place),
    'the report holds a lift and a place for every move',
    JSON.stringify(fixes[3]),
  );
  check((await orangeNear(black.page, fixes[3].lift, 'b')) > 20, 'a ring where the queen was picked up');
  check((await orangeNear(black.page, fixes[3].place, 'b')) > 40, 'a disc where she was put down');
  // Told apart by shape: inside a small circle at its middle a disc is all
  // orange, and a ring is hollow — the carry line and its dark edge cross it,
  // and the board shows beside them — so a swap of the two fails here.
  const liftGap = await notOrangeWithin(black.page, fixes[3].lift, 'b', 3.5);
  const placeGap = await notOrangeWithin(black.page, fixes[3].place, 'b', 3.5);
  check(
    placeGap <= 2 && liftGap >= 6 && liftGap > placeGap,
    'the lift is the hollow one, the place the filled one',
    `${liftGap} vs ${placeGap} pixels not orange at the middle`,
  );
  check((await orangeNear(black.page, 'a1', 'b')) === 0, 'and no carry anywhere else (a1)');
  const note = await text(black.page, '[data-replay-note]');
  check(/^Solid: the carry/.test(note ?? ''), 'the note says what the lines are', note);
  await black.page.locator('[data-replay]').screenshot({ path: `${OUT}/1-black-replay-mate.png` });

  step(5, 'Back, the scrubber and a tap on a move all step through it');
  await black.page.click('[data-replay-prev]');
  await waitForPly(black.page, 3);
  s = await replayState(black.page);
  check(s.fen === PLACEMENTS[3] && s.head === MOVES[2].head, 'Back: step 3, g4', `${s.head}`);
  check((await orangeNear(black.page, fixes[2].lift, 'b')) > 20 && (await orangeNear(black.page, fixes[2].place, 'b')) > 40, 'g4’s carry, g2 to g4');
  check((await orangeNear(black.page, fixes[3].place, 'b')) === 0, 'and the queen’s is gone');
  await black.page.evaluate(() => {
    const r = document.querySelector('[data-replay-scrub]');
    r.value = '1';
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitForPly(black.page, 1);
  s = await replayState(black.page);
  check(s.fen === PLACEMENTS[1] && /^White moved f2 to f3/.test(s.carry ?? ''), 'the scrubber: step 1, f3', s.head);
  await black.page.locator('[data-replay]').screenshot({ path: `${OUT}/2-black-replay-step1.png` });
  await black.page.click('[data-replay-to="2"]');
  await waitForPly(black.page, 2);
  s = await replayState(black.page);
  check(s.fen === PLACEMENTS[2] && s.current === '2', 'a tap on 1… e5 in the list: step 2', s.head);
  await black.page.evaluate(() => {
    const r = document.querySelector('[data-replay-scrub]');
    r.value = '0';
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitForPly(black.page, 0);
  s = await replayState(black.page);
  check(s.fen === PLACEMENTS[0] && s.prevDisabled && !s.nextDisabled, 'and the start, with Back off', s.head);
  check((await orangeNear(black.page, 'e4', 'b', 200)) === 0, 'with no carry drawn on it');
  const liveSeen = await walkThrough(black.page);
  check(liveSeen.map((x) => x.fen).join() === PLACEMENTS.slice(1).join(), 'Next walks the whole game in order');

  step(6, 'Scrubbing sends nothing, and works with no signal');
  let requests = 0;
  const count = () => {
    requests += 1;
  };
  black.page.on('request', count);
  await black.context.setOffline(true);
  await black.page.click('[data-replay-prev]');
  await waitForPly(black.page, 3);
  await black.page.click('[data-replay-to="1"]');
  await waitForPly(black.page, 1);
  await black.page.click('[data-replay-next]');
  await waitForPly(black.page, 2);
  s = await replayState(black.page);
  check(s.fen === PLACEMENTS[2], 'offline, it still steps', s.head);
  black.page.off('request', count);
  await black.context.setOffline(false);
  check(requests === 0, 'and not one request was made', String(requests));

  step(7, 'The replay board zooms like the game’s');
  await black.page.locator('[data-replay]').scrollIntoViewIfNeeded();
  const before = await black.page.getAttribute('[data-replay] [data-board]', 'data-zoom');
  await pinchReplay(black);
  const after = await black.page.getAttribute('[data-replay] [data-board]', 'data-zoom');
  const k = Number((after ?? '1').split(' ')[0]);
  check(k > 1.2, 'a pinch zooms it in', `${before} → ${after}`);
  const resetShown = await black.page.evaluate(() => !document.querySelector('[data-replay] [data-zoom-controls]').hidden);
  check(resetShown, 'and "Whole board" appears');
  check((await black.page.evaluate(() => document.querySelector('[data-replay] [data-board]').style.touchAction)) === 'none', 'and a finger now pans the board, not the page');
  await black.page.locator('[data-replay]').screenshot({ path: `${OUT}/3-black-replay-zoomed.png` });
  await black.page.click('[data-replay] [data-zoom-reset]');
  check((await black.page.evaluate(() => document.querySelector('[data-replay] [data-board]').style.touchAction)) === 'pan-y', 'Whole board puts it back, and the page scrolls again');

  step(8, 'Both phones leave; a day later the game is archived and its object deleted');
  await black.page.click('[data-review-home]');
  await black.page.waitForSelector('[data-new]', { timeout: 15_000 });
  await white.page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await white.page.waitForSelector('[data-new]', { timeout: 15_000 });
  await new Promise((r) => setTimeout(r, 2_000));
  const hastened = await white.context.request.post(`${origin}/api/dev/game/${code}/collect`, {
    headers: { 'x-dev-auth-secret': DEV_SECRET },
    data: { afterMs: 0 },
  });
  check(hastened.status() === 200, 'collection hastened through the dev seam', String(hastened.status()));
  let archived = null;
  for (let i = 0; i < 90 && archived?.archived !== true; i++) {
    await new Promise((r) => setTimeout(r, 500));
    archived = await white.page.evaluate(async (c) => (await fetch(`/api/game/${c}`)).json(), code);
  }
  check(archived?.archived === true, 'the game reads as archived', JSON.stringify(archived));

  step(9, 'White opens the archived game from "Your games": the same replay');
  await white.page.reload({ waitUntil: 'domcontentloaded' });
  await white.page.waitForSelector(`[data-game="${code}"]`, { timeout: 15_000 });
  await white.page.click(`[data-game="${code}"]`);
  await white.page.waitForSelector('[data-replay]', { timeout: 15_000 });
  const fromArchive = await white.page.evaluate(async (c) => (await fetch(`/api/game/${c}/review`)).json(), code);
  check(JSON.stringify(fromArchive.report.tracks) === JSON.stringify(tracks), 'the archive kept both walks, fix for fix');
  s = await replayState(white.page);
  check(s.ply === 4 && s.fen === PLACEMENTS[4], 'it opens on the mate', s.head);
  check((await orangeNear(white.page, fixes[3].lift, 'w')) > 20 && (await orangeNear(white.page, fixes[3].place, 'w')) > 40, 'with the queen’s carry, from white’s side of the board');
  await white.page.locator('[data-replay]').screenshot({ path: `${OUT}/4-white-replay-archived.png` });
  const archivedSeen = await walkThrough(white.page);
  check(
    archivedSeen.every((x, i) => x.fen === PLACEMENTS[i + 1] && x.head === MOVES[i].head && x.carry?.startsWith(MOVES[i].who)),
    'every step the same position and the same carry',
  );
  check(
    archivedSeen.map((x) => x.carry).join('|') === liveSeen.map((x) => x.carry).join('|'),
    'word for word what the live game said',
  );

  step(10, 'On discs, the other piece look');
  await white.page.evaluate(() => localStorage.setItem('satchess.pieceLook', 'disc'));
  await white.page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await white.page.waitForSelector(`[data-game="${code}"]`, { timeout: 15_000 });
  await white.page.click(`[data-game="${code}"]`);
  await white.page.waitForSelector('[data-replay]', { timeout: 15_000 });
  await white.page.click('[data-replay-to="3"]');
  await waitForPly(white.page, 3);
  await white.page.locator('[data-replay]').screenshot({ path: `${OUT}/5-white-replay-discs.png` });
  check(true, 'drawn (see the screenshot)');
  await white.page.screenshot({ path: `${OUT}/6-white-review-archived-full.png`, fullPage: true });

  step(11, 'Nobody else can read it');
  const stranger = await browser.newContext();
  await signIn(stranger, `sim-replay-stranger-${Date.now()}`, origin, 'stranger');
  for (const suffix of ['/review', '/pgn']) {
    const r = await stranger.request.get(`${origin}/api/game/${code}${suffix}`);
    check(r.status() === 404, `a stranger gets 404 from ${suffix}`, String(r.status()));
  }
  await stranger.close();
  const nobody = await browser.newContext();
  const signedOut = await nobody.request.get(`${origin}/api/game/${code}/review`);
  check(signedOut.status() === 401, 'and no session gets 401', String(signedOut.status()));
  await nobody.close();

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  console.log(`Screenshots in ${OUT}`);
} catch (error) {
  failures += 1;
  console.error(error);
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
