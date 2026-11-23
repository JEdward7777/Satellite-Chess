/**
 * Recalibrating your own field in a pause of a remote game (stage 12.3,
 * decisions 0060 and 0063), on two phones on two fields.
 *
 * White's field is 10 m squares and Black's 6 m, two and a half kilometers
 * apart, so the shared square starts at 6 m with White's board shrunk inside
 * its dashed outline. After 1. f3 White pauses, and:
 *
 * 1. Black recalibrates: walks the corners of a field of 8 m squares. The
 *    shared square goes to 8 m with nobody asked; White's board grows inside
 *    the same outline, and both phones say so.
 * 2. White recalibrates to 7 m squares, smaller than Black's now: White plays
 *    her field whole and Black's board is shrunk inside its own outline.
 * 3. Both walk to the new back ranks and the game goes on: 1... e5.
 *
 * At every step it checks with numbers that **a player on a square is drawn
 * on that square on the other phone's board as it now is** (the opponent's
 * dot against the square's center replayed from `render.ts`), the squares
 * readout in each phone's units, the words that say who recalibrated, and
 * Black's saved field re-calibrated in place. The screenshots are for a
 * person to read as well.
 *
 *     node scripts/check-recalibrate.mjs --base=http://127.0.0.1:8799/?sim=1 --out=/tmp/recalibrate
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
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-recalibrate-'));
const ORIGIN = new URL(BASE).origin;
const RUN = Date.now().toString(36);

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

const M_PER_DEG_LAT = (6378137 * Math.PI) / 180; // as in shared/geo.ts
const FILES = 'abcdefgh';

/** `fromLocal` from geo.ts. */
function fromLocal(origin, e, n) {
  return {
    lat: origin.lat + n / M_PER_DEG_LAT,
    lng: origin.lng + e / (M_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180)),
  };
}

const WHITE_A1 = { lat: 51.4779, lng: -0.0015 }; // `SIM_START` in client/main.ts
const BLACK_A1 = fromLocal(WHITE_A1, 2500, 1200);
const BIG_M = 10;
const SMALL_M = 6;

/** A two-tap field: a1 and h8, the square board of that size, files running east. */
function field(id, name, a1, squareM, updatedAt) {
  return { id, name, a1, h8: fromLocal(a1, 7 * squareM, 7 * squareM), version: 1, createdAt: 0, updatedAt };
}

const BIG = field('big-field', 'Big Field', WHITE_A1, BIG_M, 1);
const SMALL = field('small-field', 'Small Field', BLACK_A1, SMALL_M, 1);

/**
 * A phone's board as `my-board.ts` makes it: its own field, shrunk about its
 * center to the shared square when it is the larger one. `squareM` is the
 * board's square; `inset` is how far its a1 has moved in from the field's.
 */
function boardOf(a1, fieldM, sharedM) {
  const squareM = Math.min(fieldM, sharedM);
  return { a1, fieldM, squareM, inset: 3.5 * (fieldM - squareM) };
}

function squareLatLng(board, file, rank) {
  return fromLocal(board.a1, board.inset + file * board.squareM, board.inset + rank * board.squareM);
}

/**
 * `projectionFor` from client/render.ts, replayed at 1x for a board whose
 * files run east: fitted to the board and, round a shrunk one, to the field
 * it came from. Board space has its origin at the board's own a1.
 */
function squareToPixel(board, file, rank, orientation, w, h) {
  const s = board.squareM;
  let minU = -s / 2;
  let maxU = 7.5 * s;
  if (board.inset > 0) {
    minU = Math.min(minU, -board.inset - board.fieldM / 2);
    maxU = Math.max(maxU, -board.inset + 7.5 * board.fieldM);
  }
  const minV = minU;
  const maxV = maxU;
  const sizeM = maxU - minU;
  const size = Math.min(w, h);
  const pad = size * 0.06;
  const scale = (size - 2 * pad) / sizeM;
  const offsetX = (w - sizeM * scale) / 2;
  const offsetY = (h - sizeM * scale) / 2;
  const bp = { u: file * s, v: rank * s };
  const u = orientation === 'w' ? bp.u - minU : maxU - bp.u;
  const v = orientation === 'w' ? maxV - bp.v : bp.v - minV;
  return { x: offsetX + u * scale, y: offsetY + v * scale, scale };
}

let failures = 0;
function check(ok, label, detail) {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}
const step = (n, msg) => console.log(`\n${n}. ${msg}`);

async function newPhone(browser, name, fields, locale) {
  // A phone's width; the board is as wide as the screen.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale });
  // A new account a run: the recalibrated fields are synced to the account,
  // and would come back down on the next run's phones (O-19).
  await signIn(context, `sim-recalibrate-${name}-${RUN}`, ORIGIN, name);
  const phone = { context, name, page: null, dropRecalibrate: false, loseRecalibrate: false, dropped: 0, sockets: 0, frames: [] };
  // Every game socket goes through here, so a step can lose the next
  // `recalibrate` frame as a dropped connection would: `dropRecalibrate`
  // closes the socket at once; `loseRecalibrate` swallows it and everything
  // after it, and closes the socket 12 s later — past the
  // 10 s between automatic readies (review, round 2). `frames` logs each
  // socket's traffic by type, with each snapshot's status and field version.
  await context.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const n = (phone.sockets += 1);
    let swallowing = false;
    const kind = (message) => {
      if (typeof message !== 'string' || !message.startsWith('{')) return String(message);
      const m = JSON.parse(message);
      return m.t === 'state' ? `state:${m.game.status}:v${m.game.field.version}` : m.t === 'error' ? `error:${m.code}` : m.t;
    };
    ws.onMessage((message) => {
      const isRecalibrate = typeof message === 'string' && message.includes('"t":"recalibrate"');
      if (phone.dropRecalibrate && isRecalibrate) {
        phone.dropRecalibrate = false;
        phone.dropped += 1;
        ws.close();
        server.close();
        return;
      }
      if (phone.loseRecalibrate && isRecalibrate) {
        phone.loseRecalibrate = false;
        phone.dropped += 1;
        swallowing = true;
        setTimeout(() => {
          ws.close();
          server.close();
        }, 12_000);
      }
      phone.frames.push(`${n} out ${kind(message)}${swallowing ? ' (lost)' : ''}`);
      if (!swallowing) server.send(message);
    });
    server.onMessage((message) => {
      phone.frames.push(`${n} in ${kind(message)}`);
      ws.send(message);
    });
  });
  const page = await context.newPage();
  phone.page = page;
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [${name}] console error: ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`  [${name}] page error: ${e.message}`));
  await page.addInitScript(
    ({ fields }) => {
      const req = indexedDB.open('satellite-chess', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('fields')) db.createObjectStore('fields', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const store = req.result.transaction('fields', 'readwrite').objectStore('fields');
        for (const f of fields) store.put(f);
      };
    },
    { fields },
  );
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-new]', { timeout: 15_000 });
  return phone;
}

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

/** Teleport, and wait for the app to believe it (the fix lags a second). */
async function walkTo(page, board, file, rank) {
  await page.evaluate((pos) => globalThis.satchess.me.moveTo(pos), squareLatLng(board, file, rank));
  const inside = file >= 0 && file <= 7 && rank >= 0 && rank <= 7;
  await page.waitForFunction(
    (sq) => document.querySelector('[data-square]')?.textContent === sq,
    inside ? FILES[file] + String(rank + 1) : 'off the board',
    { timeout: 10_000 },
  );
}

/** A non-primary `pointerdown`/`pointerup` pair: a tap the simulator ignores. */
async function tapSquare(page, board, file, rank, orientation) {
  const box = await page.locator('[data-board]').boundingBox();
  const p = squareToPixel(board, file, rank, orientation, box.width, box.height);
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

const square = (name) => [FILES.indexOf(name[0]), Number(name[1]) - 1];

/** Walk to a square and tap it, then wait for the server to agree. */
async function act(phone, board, name, orientation, expect) {
  const [f, r] = square(name);
  // A lift is tapped only once this phone knows it is its turn: the other
  // phone's place may not have reached it yet, and a tap during the
  // opponent's carry is ignored by the board.
  if (expect === carrying) await phone.page.waitForFunction(yourMove, null, { timeout: 10_000 });
  await walkTo(phone.page, board, f, r);
  await tapSquare(phone.page, board, f, r, orientation);
  try {
    await phone.page.waitForFunction(expect, null, { timeout: 10_000 });
  } catch (error) {
    // Say what the screen said, and keep a picture of it, before giving up.
    const said = await phone.page.evaluate(() =>
      ['[data-prompt]', '[data-notice]', '[data-carry]', '[data-square]'].map((s) => document.querySelector(s)?.textContent),
    );
    console.log(`   ${phone.name} at ${name}: ${JSON.stringify(said)}`);
    await shot(phone, `failed-${phone.name}-${name}`);
    throw error;
  }
}

/**
 * The opponent's dot (`#ff4d6d`), in CSS pixels of the canvas, or null. Not
 * to be read mid-carry: the ring of the opponent's piece-in-hand plate is the
 * same red (see `drive-game.mjs`).
 */
const opponentDot = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector('[data-board]');
    const dpr = canvas.width / canvas.clientWidth;
    const { data, width } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 220 && data[i + 1] > 40 && data[i + 1] < 110 && data[i + 2] > 80 && data[i + 2] < 140) {
        const p = i / 4;
        sx += p % width;
        sy += Math.floor(p / width);
        n += 1;
      }
    }
    return n === 0 ? null : { x: sx / n / dpr, y: sy / n / dpr, px: n };
  });

/** Is the opponent's dot drawn on this square of this phone's board? */
async function dotOn(phone, board, name, orientation) {
  const [f, r] = square(name);
  await dotAt(phone, board, f, r, orientation, name);
}

/**
 * Where a fix taken on one board falls on another, in squares: a player who
 * stood still while a recalibration reshaped their board under them.
 */
function reprojected(from, to, file, rank) {
  const e = from.inset + file * from.squareM;
  const n = from.inset + rank * from.squareM;
  return [(e - to.inset) / to.squareM, (n - to.inset) / to.squareM];
}

/** Is the opponent's dot drawn at this place in squares (fractions allowed) of this phone's board? */
async function dotAt(phone, board, f, r, orientation, name) {
  const box = await phone.page.locator('[data-board]').boundingBox();
  const want = squareToPixel(board, f, r, orientation, box.width, box.height);
  let got = null;
  // The dot glides between relays (`opponent.ts`), so give it time to land.
  for (let i = 0; i < 20; i++) {
    got = await opponentDot(phone.page);
    if (got && Math.hypot(got.x - want.x, got.y - want.y) < 3) break;
    await phone.page.waitForTimeout(500);
  }
  const off = got === null ? null : Math.round(Math.hypot(got.x - want.x, got.y - want.y) * 10) / 10;
  check(
    off !== null && off < 3,
    `${phone.name}: the opponent's dot is on ${name} of this board`,
    { want: { x: Math.round(want.x), y: Math.round(want.y) }, got: got && { x: Math.round(got.x), y: Math.round(got.y) }, off },
  );
}

/**
 * The whole page, with the simulator's panel out of the way: it is fixed to
 * the bottom of the viewport and would cover the prompt a picture is for.
 */
async function shot(phone, file) {
  await phone.page.addStyleTag({ content: '.sim-panel { display: none !important; }' }).catch(() => undefined);
  await phone.page.screenshot({ path: join(OUT, `${file}.png`), fullPage: true });
  await phone.page.evaluate(() => {
    for (const el of document.querySelectorAll('style')) {
      if (el.textContent?.includes('.sim-panel { display: none')) el.remove();
    }
  });
}

/** The fields on a phone, as its IndexedDB holds them. */
const fieldIds = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('satellite-chess');
        req.onsuccess = () => {
          const all = req.result.transaction('fields').objectStore('fields').getAll();
          all.onsuccess = () => resolve(all.result.map((f) => f.id).sort());
        };
      }),
  );

const yourMove = () => /Your move/.test(document.querySelector('[data-prompt]')?.textContent ?? '');
const theirMove = () => /Your opponent to move/.test(document.querySelector('[data-prompt]')?.textContent ?? '');
// My own carry, confirmed: not a prediction ("in hand") and not the opponent's
// last carry still on screen ("theirs") before their place has arrived here.
const carrying = () =>
  !document.querySelector('[data-carry]')?.hidden && !/in hand|theirs/.test(document.querySelector('[data-carry]')?.textContent ?? '');

/** Walk the four corners of a new calibration of `squareM` squares from `a1`, and save it. */
async function recalibrate(phone, a1, squareM, other) {
  await phone.page.click('[data-recalibrate]');
  await phone.page.waitForSelector('[data-tap]', { timeout: 15_000 });
  for (const [name, file, rank] of [['a1', 0, 0], ['h1', 7, 0], ['h8', 7, 7], ['a8', 0, 7]]) {
    const brief = (await phone.page.textContent('[data-brief]')) ?? '';
    check(brief.includes(name), `${phone.name}: asked for ${name}`);
    await phone.page.evaluate((pos) => globalThis.satchess.me.moveTo(pos), fromLocal(a1, file * squareM, rank * squareM));
    // The simulator emits at 1 Hz, and a tap carries whatever fix it has.
    await phone.page.waitForTimeout(1_400);
    await phone.page.waitForFunction(() => document.querySelector('[data-tap]')?.hasAttribute('disabled') === false, null, {
      timeout: 15_000,
    });
    if (name === 'a1') await shot(phone, `${phone.name}-recalibrate-a1`);
    await phone.page.click('[data-tap]');
    await phone.page.waitForTimeout(150);
    // The other phone while this one is away walking corners: its socket is
    // closed meanwhile, so the game cannot resume behind its back.
    if (name === 'h1') {
      await shot(other, `${other.name}-while-${phone.name}-recalibrates`);
      const said = await text(other.page, '[data-handshake]');
      check(/Waiting for your opponent to come back\./.test(said ?? ''), `${other.name}: waiting for ${phone.name} to come back`, said);
    }
  }
  await phone.page.waitForSelector('[data-save]', { timeout: 15_000 });
  await shot(phone, `${phone.name}-recalibrate-review`);
  check((await text(phone.page, '[data-save]')) === 'Save and play on it', `${phone.name}: the save button says what it is for`);
  await phone.page.click('[data-save]');
  await phone.page.waitForSelector('[data-board]', { timeout: 15_000 });
}

/** The saved fields on a phone, as its IndexedDB holds them. */
const savedFields = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('satellite-chess');
        req.onsuccess = () => {
          const all = req.result.transaction('fields').objectStore('fields').getAll();
          all.onsuccess = () => resolve(all.result);
        };
      }),
  );

const browser = await chromium.launch({ executablePath: findChromium() });

try {
  console.log(`server ${ORIGIN}; screenshots -> ${OUT}`);
  let whiteBoard = boardOf(WHITE_A1, BIG_M, SMALL_M);
  let blackBoard = boardOf(BLACK_A1, SMALL_M, SMALL_M);

  step(1, 'Two phones: White with a 10 m field, Black with a 6 m one far away');
  const white = await newPhone(browser, 'white', [BIG], 'en-GB');
  const black = await newPhone(browser, 'black', [SMALL], 'en-US');

  step(2, 'White creates a remote game; Black joins with Small Field');
  await white.page.click('[data-new]');
  await white.page.waitForSelector('[data-create]');
  await white.page.click('[data-where="remote"]');
  await white.page.check('[data-disclosure]');
  await white.page.click('[data-create]');
  await white.page.waitForSelector('[data-join-code]');
  const code = await white.page.getAttribute('[data-join-code]', 'data-join-code');
  console.log(`   join code ${code}`);
  await white.page.click('[data-open]');
  await white.page.waitForSelector('[data-board]');
  await black.page.fill('[data-code]', code);
  await black.page.click('[data-join]');
  await black.page.waitForSelector('[data-remote-intro]', { timeout: 15_000 });
  await black.page.selectOption('[data-field]', SMALL.id);
  await black.page.check('[data-disclosure]');
  await black.page.click('[data-join]');
  await black.page.waitForSelector('[data-board]', { timeout: 15_000 });
  await waitText(white.page, '[data-squares]', /6\.0 m on both fields/);
  check(true, 'White: "6.0 m on both fields"');
  check((await text(white.page, '[data-recalibrate]')) === null, 'no Recalibrate before a pause');

  step(3, 'Both walk to their back ranks; 1. f3');
  await walkTo(black.page, blackBoard, 4, 7);
  await walkTo(white.page, whiteBoard, 4, 0);
  await white.page.waitForFunction(yourMove, null, { timeout: 20_000 });
  await act(white, whiteBoard, 'f2', 'w', carrying);
  await act(white, whiteBoard, 'f3', 'w', theirMove);
  check((await text(white.page, '[data-recalibrate]')) === null, 'no Recalibrate while the game is played');

  step(4, 'White pauses: both phones offer to recalibrate, and say which corners');
  await white.page.click('[data-pause]');
  await waitText(white.page, '[data-prompt]', /You paused this game/);
  await waitText(black.page, '[data-prompt]', /Paused/);
  check((await text(white.page, '[data-recalibrate]')) === 'Recalibrate my field', 'White: "Recalibrate my field"');
  check((await text(black.page, '[data-recalibrate]')) === 'Recalibrate my field', 'Black: "Recalibrate my field"');
  const whiteHint = await text(white.page, '[data-recalibrate-hint]');
  check(/dashed line/.test(whiteHint ?? ''), 'White, shrunk: the hint names the dashed line', whiteHint);
  const blackHint = await text(black.page, '[data-recalibrate-hint]');
  check(/walk its corners again/.test(blackHint ?? '') && !/dashed/.test(blackHint ?? ''), 'Black, whole: no dashed line to name', blackHint);
  await shot(white, '01-white-paused-shrunk-6m');
  await shot(black, '02-black-paused-whole-6m');

  step(5, 'Black recalibrates: their field is really 8 m squares');
  await black.page.click('[data-recalibrate]');
  await black.page.waitForSelector('[data-tap]', { timeout: 15_000 });
  check((await text(black.page, 'h1')) === 'Recalibrate your field', 'the title says recalibrate');
  const blackIntro = await text(black.page, '[data-purpose]');
  check(/Walk the corners of your field again/.test(blackIntro ?? '') && /may change size/.test(blackIntro ?? ''), 'Black: told the other board may change', blackIntro);
  // Back to the board and out again: Not now goes back to the game.
  await black.page.click('[data-cancel]');
  await black.page.waitForSelector('[data-board]', { timeout: 15_000 });
  await waitText(black.page, '[data-prompt]', /Paused/);
  check(true, 'Not now goes back to the paused board');
  // The first `recalibrate` frame is lost with its socket: the phone must
  // send it again on the next one (review, round 1). See `newPhone`.
  black.dropRecalibrate = true;
  await recalibrate(black, BLACK_A1, 8, white);
  whiteBoard = boardOf(WHITE_A1, BIG_M, 8);
  blackBoard = boardOf(BLACK_A1, 8, 8);
  await waitText(white.page, '[data-squares]', /8\.0 m on both fields/);
  check(black.dropped === 1, 'the first recalibrate frame was dropped with its socket, and it landed anyway', { dropped: black.dropped });
  check(true, 'White: "8.0 m on both fields", with nobody asked');
  await waitText(black.page, '[data-squares]', /26 ft on both fields/);
  check(true, 'Black: "26 ft on both fields"');
  const whiteTold = await text(white.page, '[data-rescaled]');
  check(whiteTold === 'Your opponent recalibrated their field. The squares are now 8.0 m on both fields.', 'White is told', whiteTold);
  await waitText(black.page, '[data-rescaled]', /Your field is recalibrated/);
  const blackTold = await text(black.page, '[data-rescaled]');
  check(blackTold === 'Your field is recalibrated. The squares are now 26 ft on both fields.', 'Black is told', blackTold);
  check(/Paused/.test((await text(black.page, '[data-prompt]')) ?? ''), 'still paused: nothing resumed it');
  const saved = await savedFields(black.page);
  const small = saved.find((f) => f.id === SMALL.id);
  check(saved.length === 1 && small?.version === 2 && small?.h1 !== undefined, 'Black: Small Field re-calibrated in place, version 2', saved.map((f) => [f.id, f.version]));
  // White stood still on f3 of her old board; her board grew under her, so
  // her fix is elsewhere on it now, and Black sees it there, not on f3.
  {
    const [f, r] = reprojected(boardOf(WHITE_A1, BIG_M, SMALL_M), whiteBoard, 5, 2);
    await dotAt(black, blackBoard, f, r, 'b', `White's still fix on her grown board (${f.toFixed(2)}, ${r.toFixed(2)})`);
  }

  step(6, 'Still paused: each dot on the same square of the other board as it now is');
  await walkTo(black.page, blackBoard, 3, 4);
  await dotOn(white, whiteBoard, 'd5', 'w');
  await walkTo(white.page, whiteBoard, 2, 2);
  await dotOn(black, blackBoard, 'c3', 'b');
  await shot(white, '04-white-after-black-recalibrated-8m');
  await shot(black, '05-black-after-own-recalibration-8m');

  step(7, 'White recalibrates to 7 m squares: now White plays whole, and Black is shrunk');
  const whiteIntroHint = await text(white.page, '[data-recalibrate-hint]');
  check(/dashed line/.test(whiteIntroHint ?? ''), 'White, still shrunk, is told the dashed line', whiteIntroHint);
  await white.page.click('[data-recalibrate]');
  await white.page.waitForSelector('[data-tap]', { timeout: 15_000 });
  const whiteIntro = await text(white.page, '[data-purpose]');
  check(/just inside the dashed line/.test(whiteIntro ?? ''), 'White: walk just inside the dashed line', whiteIntro);
  await white.page.click('[data-cancel]');
  await white.page.waitForSelector('[data-board]', { timeout: 15_000 });
  await recalibrate(white, WHITE_A1, 7, black);
  whiteBoard = boardOf(WHITE_A1, 7, 7);
  blackBoard = boardOf(BLACK_A1, 8, 7);
  await waitText(white.page, '[data-squares]', /7\.0 m on both fields/);
  await waitText(black.page, '[data-squares]', /23 ft on both fields/);
  check(true, 'both: 7.0 m, said as 23 ft to Black');
  const blackNote = await text(black.page, '[data-remote-note]');
  check(/dashed line is the field you marked out/.test(blackNote ?? ''), 'Black is shrunk now, and the note explains the outline', blackNote);
  const whiteNote = await text(white.page, '[data-remote-note]');
  check(!/dashed/.test(whiteNote ?? ''), 'White has no outline now', whiteNote);
  const blackTold2 = await text(black.page, '[data-rescaled]');
  check(/Your opponent recalibrated their field\. The squares are now 23 ft/.test(blackTold2 ?? ''), 'Black is told', blackTold2);
  // Black stood still on d5 while his board shrank under him.
  {
    const [f, r] = reprojected(boardOf(BLACK_A1, 8, 8), blackBoard, 3, 4);
    await dotAt(white, whiteBoard, f, r, 'w', `Black's still fix on his shrunk board (${f.toFixed(2)}, ${r.toFixed(2)})`);
    const own = await text(black.page, '[data-square]');
    check(own === FILES[Math.round(f)] + String(Math.round(r) + 1), "and it is the square Black's own phone says he is on", own);
  }
  await walkTo(white.page, whiteBoard, 5, 3);
  await dotOn(black, blackBoard, 'f4', 'b');
  await walkTo(black.page, blackBoard, 6, 5);
  await dotOn(white, whiteBoard, 'g6', 'w');
  await shot(white, '06-white-after-own-recalibration-7m-whole');
  await shot(black, '07-black-shrunk-to-7m');

  step(8, 'Both walk to the new back ranks, and the game goes on: 1... e5');
  await walkTo(white.page, whiteBoard, 4, 0);
  await walkTo(black.page, blackBoard, 4, 7);
  await black.page.waitForFunction(yourMove, null, { timeout: 20_000 });
  await white.page.waitForFunction(theirMove, null, { timeout: 20_000 });
  check(true, 'resumed by the ordinary handshake on the new boards');
  check((await text(white.page, '[data-rescaled]')) === null, 'the rescale line is gone once play resumes');
  check((await text(white.page, '[data-recalibrate]')) === null, 'and so is Recalibrate');
  await dotOn(white, whiteBoard, 'e8', 'w');
  await dotOn(black, blackBoard, 'e1', 'b');
  await act(black, blackBoard, 'e7', 'b', carrying);
  await act(black, blackBoard, 'e5', 'b', theirMove);
  await dotOn(white, whiteBoard, 'e5', 'w');
  await white.page.waitForFunction(yourMove, null, { timeout: 10_000 });
  check(true, '1... e5 played on the new boards');
  await shot(white, '08-white-resumed-after-e5');
  await shot(black, '09-black-resumed-after-e5');

  step(9, '2. g4 Qh4#, and the replay still has 1. f3 picked up on f2 and put down on f3');
  await act(white, whiteBoard, 'g2', 'w', carrying);
  await act(white, whiteBoard, 'g4', 'w', theirMove);
  await act(black, blackBoard, 'd8', 'b', carrying);
  // A walk, not a jump: the server refuses a carry faster than a sprint.
  await walkTo(black.page, blackBoard, 5, 5);
  await black.page.waitForTimeout(6_000);
  await act(black, blackBoard, 'h4', 'b', () => /checkmate/.test(document.querySelector('[data-prompt]')?.textContent ?? ''));
  await white.page.waitForFunction(() => /checkmate/.test(document.querySelector('[data-prompt]')?.textContent ?? ''), null, {
    timeout: 10_000,
  });
  await white.page.click('[data-review-open]');
  await white.page.waitForSelector('[data-replay]', { timeout: 15_000 });
  await white.page.click('[data-replay-to="1"]');
  await white.page.waitForFunction(() => /f2/.test(document.querySelector('[data-replay-lift]')?.textContent ?? ''), null, {
    timeout: 5_000,
  }).catch(() => undefined);
  const lift = await text(white.page, '[data-replay-lift]');
  const place = await text(white.page, '[data-replay-place]');
  check(/standing on f2/.test(lift ?? '') && /standing on f3/.test(place ?? ''), '1. f3, played before both recalibrations, is still on f2 and f3', { lift, place });
  await shot(white, '10-white-replay-move-1');

  step(10, 'A lost frame, a socket that dies 12 s later, a small correction, and the opponent waiting');
  // The case review round 2 found: Black corrects his field by a meter and
  // finishes the walk on a8, which is on his back rank on the old board as
  // well as the new; White waits on hers. The first recalibrate is lost and
  // its socket dies after the 10 s between automatic readies. On the next
  // socket nothing may claim Black's back rank before the recalibration is
  // applied, or the game resumes on the old field.
  const white2 = await newPhone(browser, 'white2', [BIG], 'en-GB');
  const black2 = await newPhone(browser, 'black2', [SMALL], 'en-GB');
  const whiteBoard2 = boardOf(WHITE_A1, BIG_M, SMALL_M);
  const blackBoard2 = boardOf(BLACK_A1, SMALL_M, SMALL_M);
  await white2.page.click('[data-new]');
  await white2.page.waitForSelector('[data-create]');
  await white2.page.click('[data-where="remote"]');
  await white2.page.check('[data-disclosure]');
  await white2.page.click('[data-create]');
  await white2.page.waitForSelector('[data-join-code]');
  const code2 = await white2.page.getAttribute('[data-join-code]', 'data-join-code');
  await white2.page.click('[data-open]');
  await white2.page.waitForSelector('[data-board]');
  await black2.page.fill('[data-code]', code2);
  await black2.page.click('[data-join]');
  await black2.page.waitForSelector('[data-remote-intro]', { timeout: 15_000 });
  await black2.page.selectOption('[data-field]', SMALL.id);
  await black2.page.check('[data-disclosure]');
  await black2.page.click('[data-join]');
  await black2.page.waitForSelector('[data-board]', { timeout: 15_000 });
  await walkTo(black2.page, blackBoard2, 4, 7);
  await walkTo(white2.page, whiteBoard2, 4, 0);
  await white2.page.waitForFunction(yourMove, null, { timeout: 20_000 });
  await act(white2, whiteBoard2, 'f2', 'w', carrying);
  await act(white2, whiteBoard2, 'f3', 'w', theirMove);
  await white2.page.click('[data-pause]');
  await waitText(black2.page, '[data-prompt]', /Paused/);
  await walkTo(black2.page, blackBoard2, 4, 4);
  await walkTo(white2.page, whiteBoard2, 4, 0);
  await waitText(white2.page, '[data-handshake]', /You are on your back rank/);
  check(true, 'White waits on her back rank; Black is off his');
  black2.loseRecalibrate = true;
  await recalibrate(black2, fromLocal(BLACK_A1, 1, 0), SMALL_M, white2);
  // Past the 12 s the first socket lives, the reconnect, and a resume.
  await black2.page.waitForTimeout(20_000);
  const sockets = [...new Set(black2.frames.map((f) => f.split(' ')[0]))];
  console.log(`   black's frames: ${black2.frames.join(' | ')}`);
  check(black2.dropped === 1 && sockets.length >= 3, 'the first recalibrate was lost, and its socket died', { dropped: black2.dropped, sockets });
  // Socket 1 is the game before the pause; 2 onwards come after the walk.
  const activeOld = black2.frames.filter((f) => Number(f.split(' ')[0]) > 1 && / in state:active:v1$/.test(f));
  check(activeOld.length === 0, 'the game never went on on the old field', activeOld);
  const last = sockets[sockets.length - 1];
  const out = black2.frames.filter((f) => f.startsWith(`${last} out`)).map((f) => f.split(' ')[2]);
  const firstClaim = out.findIndex((t) => t === 'ready' || t === 'pos');
  const sentAt = out.indexOf('recalibrate');
  check(sentAt >= 0 && (firstClaim < 0 || firstClaim > sentAt), 'on the next socket, recalibrate goes before any ready or relay', out);
  await waitText(black2.page, '[data-turn]', /yours/);
  await black2.page.waitForFunction(yourMove, null, { timeout: 20_000 });
  const ins = black2.frames.filter((f) => / in state:/.test(f));
  check(/ in state:active:v2$/.test(ins[ins.length - 1] ?? ''), 'and it resumed on the corrected field', ins.slice(-3));
  const errors = black2.frames.filter((f) => Number(f.split(' ')[0]) > 1 && / in error:/.test(f));
  check(errors.length === 0, 'with no refusal on the way', errors);
  await shot(black2, '11-black-resumed-after-lost-frame');
  await shot(white2, '12-white-resumed-after-lost-frame');

  /**
   * Pause, have Black recalibrate again by another meter, lose the frame, and
   * then `away` the board before anything lands: the recalibration must
   * survive it and the game go on on the new field (review, round 3).
   */
  async function loseThen(n, shiftM, label, away) {
    await white2.page.click('[data-pause]');
    await waitText(black2.page, '[data-prompt]', /Paused/);
    await waitText(white2.page, '[data-handshake]', /You are on your back rank/);
    const version = (await savedFields(black2.page)).find((f) => f.id === SMALL.id).version + 1;
    const lostBefore = black2.dropped;
    black2.loseRecalibrate = true;
    const mark = black2.frames.length;
    await recalibrate(black2, fromLocal(BLACK_A1, shiftM, 0), SMALL_M, white2);
    for (let i = 0; i < 40 && black2.dropped === lostBefore; i++) await black2.page.waitForTimeout(250);
    check(black2.dropped === lostBefore + 1, `${label}: the recalibrate frame was lost`);
    await away();
    await black2.page.waitForSelector('[data-board]', { timeout: 20_000 });
    // On a8 of the new board, a meter from a8 of the old: on both back ranks.
    await walkTo(black2.page, boardOf(fromLocal(BLACK_A1, shiftM, 0), SMALL_M, SMALL_M), 0, 7);
    await black2.page.waitForFunction(yourMove, null, { timeout: 30_000 });
    const after = black2.frames.slice(mark);
    const states = after.filter((f) => / in state:active:/.test(f));
    console.log(`   black's frames: ${after.join(' | ')}`);
    check(
      states.length > 0 && states.every((f) => f.endsWith(`:v${version}`)),
      `${label}: the game went on on the new field (v${version}), never the old`,
      states,
    );
    await shot(black2, `${n}-black-resumed-after-${label}`);
  }

  step(11, 'Lost again, and the board reloaded before it landed');
  await loseThen(13, 2, 'reload', () => black2.page.reload({ waitUntil: 'domcontentloaded' }));

  step(12, 'Lost again, and Leave, then back in by code');
  await loseThen(14, 3, 'leave', async () => {
    await black2.page.click('[data-leave]');
    await black2.page.waitForSelector('[data-code]', { timeout: 15_000 });
    await black2.page.fill('[data-code]', code2);
    await black2.page.click('[data-join]');
  });

  console.log(failures === 0 ? `\nAll checks passed. Screenshots in ${OUT}` : `\n${failures} check(s) FAILED. Screenshots in ${OUT}`);
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
