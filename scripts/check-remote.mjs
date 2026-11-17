/**
 * A remote game on two phones, on two fields of different sizes (stage 12.2,
 * decisions 0060 and 0061).
 *
 * White's field is a 10 m board here; Black's is a 6 m board two and a half
 * kilometers away. The shared square is the smaller, 6 m, so White's board
 * is shrunk about its own center to 6 m squares and drawn inside the field
 * that was tapped out, and Black's is played whole. The driver goes through
 * everything a player does: "Remote" and the disclosure on New game, the
 * invitation, the creator waiting alone, the join that asks for a field and
 * the disclosure again, the walk to both back ranks, and Fool's mate with
 * two carries each seen by the other phone. Then the watcher's page, the
 * replay and the share card, which are board space and should not notice.
 *
 * What it checks with numbers rather than pictures: **a player on a square is
 * drawn on that square on the other phone** (the opponent's dot, found by its
 * color, against the square's center replayed from `render.ts`), the dot
 * going when the opponent is relayed as off their board, the shared square
 * in each phone's units, the prompt while waiting, the joiner keeping no copy
 * of anybody's field, and every word of the disclosure. The screenshots are
 * for a person to read as well.
 *
 *     node scripts/check-remote.mjs --base=http://127.0.0.1:8799/?sim=1 --out=/tmp/remote
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
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-remote-'));
const ORIGIN = new URL(BASE).origin;

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
const SHARED_M = Math.min(BIG_M, SMALL_M);

/** A two-tap field: a1 and h8, the square board of that size, files running east. */
function field(id, name, a1, squareM, updatedAt) {
  return { id, name, a1, h8: fromLocal(a1, 7 * squareM, 7 * squareM), version: 1, createdAt: 0, updatedAt };
}

const BIG = field('big-field', 'Big Field', WHITE_A1, BIG_M, 1);
const SMALL = field('small-field', 'Small Field', BLACK_A1, SMALL_M, 1);
// Black's newest field, so the picker starts on it and Black has to choose.
const OTHER = field('other-field', 'Other Field', fromLocal(BLACK_A1, -900, 0), 8, 2);

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
  await signIn(context, `sim-remote-${name}`, ORIGIN, name);
  const page = await context.newPage();
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
  return { context, page, name };
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

const browser = await chromium.launch({ executablePath: findChromium() });

try {
  console.log(`server ${ORIGIN}; screenshots -> ${OUT}`);
  const whiteBoard = boardOf(WHITE_A1, BIG_M, SHARED_M);
  const blackBoard = boardOf(BLACK_A1, SMALL_M, SHARED_M);
  // Before anyone joins, White's board is the whole of their field.
  const whiteAlone = boardOf(WHITE_A1, BIG_M, BIG_M);

  step(1, 'Two phones: White with a 10 m field, Black with a 6 m one (and another) far away');
  // White reads meters, Black feet: the shared square is said in each player's units.
  const white = await newPhone(browser, 'white', [BIG], 'en-GB');
  const black = await newPhone(browser, 'black', [SMALL, OTHER], 'en-US');

  step(2, 'White: New game, Remote, and the disclosure');
  await white.page.click('[data-new]');
  await white.page.waitForSelector('[data-create]');
  check((await text(white.page, '[data-disclosure-note]')) === null, 'same field by default: no disclosure');
  await white.page.click('[data-where="remote"]');
  await white.page.waitForSelector('[data-disclosure]');
  const note = await text(white.page, '[data-disclosure-note]');
  check(/an opponent with the right tools could work out where you are/.test(note ?? ''), 'the disclosure says it plainly', note);
  check(await white.page.isDisabled('[data-create]'), 'Create waits on the box');
  check(/Accept the note/.test((await text(white.page, '[data-create-hint]')) ?? ''), 'and says why beside it');
  check((await text(white.page, '[data-notice]')) === null, 'no red notice at the top for it');
  await shot(white, '01-white-create-remote');
  await white.page.check('[data-disclosure]');
  check(!(await white.page.isDisabled('[data-create]')), 'checked, Create is live');
  // Switching away and back asks again.
  await white.page.click('[data-where="same"]');
  await white.page.click('[data-where="remote"]');
  check(!(await white.page.isChecked('[data-disclosure]')), 'switching away and back unchecks the box');
  await white.page.check('[data-disclosure]');
  const created = white.page.waitForRequest((r) => r.url().endsWith('/api/game') && r.method() === 'POST');
  await white.page.click('[data-create]');
  const body = JSON.parse((await created).postData() ?? '{}');
  check(body.remote === true && body.disclosureAccepted === true, 'the create body says remote and accepted, as booleans', {
    remote: body.remote,
    disclosureAccepted: body.disclosureAccepted,
  });

  step(3, 'White: the invitation names no field, and the board waits alone');
  await white.page.waitForSelector('[data-join-code]');
  const code = await white.page.getAttribute('[data-join-code]', 'data-join-code');
  console.log(`   join code ${code}`);
  const start = await text(white.page, '[data-start-note]');
  check(/field of their own/.test(start ?? ''), 'the start note says the opponent plays on their own field', start);
  await shot(white, '02-white-invite');
  await white.page.click('[data-open]');
  await white.page.waitForSelector('[data-board]');
  await waitText(white.page, '[data-prompt]', /Waiting for your opponent to join/);
  check(true, 'waiting alone: "Waiting for your opponent to join."');
  check((await text(white.page, '[data-turn]')) === '—', "and it is nobody's turn yet", await text(white.page, '[data-turn]'));
  await waitText(white.page, '[data-squares]', /10\.0 m for now/);
  check(true, 'the square is 10.0 m "for now"');
  const waitingNote = await text(white.page, '[data-remote-note]');
  check(/shrinks to match/.test(waitingNote ?? ''), 'and the note says the board may shrink', waitingNote);
  await walkTo(white.page, whiteAlone, 3, 3);
  await shot(white, '03-white-waiting-alone');

  step(4, 'Black joins by code: asked for a field and the disclosure');
  await black.page.fill('[data-code]', code);
  await black.page.click('[data-join]');
  await black.page.waitForSelector('[data-remote-intro]', { timeout: 15_000 });
  check(true, 'the join screen asks for a field');
  const joinNote = await text(black.page, '[data-disclosure-note]');
  check(joinNote === note, 'the same disclosure as on New game', joinNote);
  check(await black.page.isDisabled('[data-join]'), 'Join waits on the box');
  check((await black.page.inputValue('[data-field]')) === OTHER.id, 'the picker starts on the newest field');
  await shot(black, '04-black-remote-join');
  // Calibrate a new one is there, and backing out of it comes back here.
  await black.page.click('[data-calibrate]');
  await black.page.waitForSelector('[data-cancel]');
  await black.page.click('[data-cancel]');
  await black.page.waitForSelector('[data-remote-intro]');
  check(true, 'Calibrate a new field, then Not now, comes back to this screen');
  await black.page.selectOption('[data-field]', SMALL.id);
  await black.page.check('[data-disclosure]');
  const joined = black.page.waitForRequest(
    (r) => r.url().includes(`/api/game/${code}`) && r.method() === 'POST' && (r.postData() ?? '') !== '',
  );
  await black.page.click('[data-join]');
  const joinBody = JSON.parse((await joined).postData() ?? '{}');
  check(joinBody.disclosureAccepted === true && joinBody.field?.id === SMALL.id, 'the join sends Small Field and the acceptance', {
    field: joinBody.field?.id,
    disclosureAccepted: joinBody.disclosureAccepted,
  });
  await black.page.waitForSelector('[data-board]', { timeout: 15_000 });
  await black.page.waitForTimeout(1_000);
  check(
    JSON.stringify(await fieldIds(black.page)) === JSON.stringify([OTHER.id, SMALL.id].sort()),
    'Black kept no copy of any field: still only their own two',
    await fieldIds(black.page),
  );

  step(5, 'The boards: White shrunk to 6 m squares inside their field, Black whole');
  await waitText(white.page, '[data-squares]', /6\.0 m on both fields/);
  check(true, 'White: "6.0 m on both fields"');
  const whiteNote = await text(white.page, '[data-remote-note]');
  check(/dashed line is the field you marked out/.test(whiteNote ?? ''), 'White: the note explains the dashed line', whiteNote);
  const blackSquares = await text(black.page, '[data-squares]');
  check(/ft on both fields/.test(blackSquares ?? ''), 'Black: the shared square in feet', blackSquares);
  const blackNote = await text(black.page, '[data-remote-note]');
  check(!/dashed/.test(blackNote ?? ''), 'Black: no outline to explain', blackNote);

  step(6, 'Black is relayed off their board: no dot for White; then on e8');
  // Black's simulator starts near White's field, kilometers from Black's own.
  await walkTo(black.page, blackBoard, 4, 13);
  await white.page.waitForTimeout(4_000);
  check((await opponentDot(white.page)) === null, 'White: no dot while Black is far off their board');
  await walkTo(black.page, blackBoard, 4, 7);
  await dotOn(white, whiteBoard, 'e8', 'w');
  await shot(white, '04b-white-staging-shrunk');
  await shot(black, '04c-black-staging-whole');

  step(7, 'White walks to e1 of the shrunk board; both phones see each other on the right squares');
  await walkTo(white.page, whiteBoard, 4, 0);
  await white.page.waitForFunction(yourMove, null, { timeout: 20_000 });
  await black.page.waitForFunction(theirMove, null, { timeout: 20_000 });
  check(true, 'the handshake on the shrunk board starts the game');
  await dotOn(black, blackBoard, 'e1', 'b');
  await dotOn(white, whiteBoard, 'e8', 'w');
  await shot(white, '05-white-active-shrunk');
  await shot(black, '06-black-active-whole');

  step(8, '1. f3: White lifts f2 and places f3');
  await act(white, whiteBoard, 'f2', 'w', carrying);
  await act(white, whiteBoard, 'f3', 'w', theirMove);
  await dotOn(black, blackBoard, 'f3', 'b');

  step(9, '1... e5, then let people watch');
  await act(black, blackBoard, 'e7', 'b', carrying);
  await act(black, blackBoard, 'e5', 'b', theirMove);
  await dotOn(white, whiteBoard, 'e5', 'w');
  await white.page.click('[data-watch-open]');
  await white.page.waitForSelector('[data-watch-panel]:not([hidden])');
  await white.page.click('[data-watch-yes]');
  await white.page.click('[data-watch-close]');
  await black.page.waitForSelector('[data-watch-invite]:not([hidden])', { timeout: 10_000 });
  await black.page.waitForFunction(() => document.querySelector('[data-watch-agree]')?.disabled === false);
  await black.page.click('[data-watch-agree]');
  await waitText(white.page, '[data-watch-line]', /Watching is on/);
  await white.page.click('[data-watch-open]');
  await white.page.waitForSelector('[data-watch-share]:not([hidden])');
  const link = await text(white.page, '[data-watch-link]');
  await white.page.click('[data-watch-close]');
  const sofa = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const watcher = await sofa.newPage();
  await watcher.goto(link);
  await watcher.waitForSelector('[data-watch-page]', { timeout: 15_000 });
  check(true, 'a watcher opens the link');

  step(10, '2. g4: White carries g2 towards g4; Black sees the pawn beside White on g3');
  await act(white, whiteBoard, 'g2', 'w', carrying);
  await walkTo(white.page, whiteBoard, 6, 2);
  // A relay goes at most every 2.5 s; give it two.
  await black.page.waitForTimeout(6_000);
  const seen = await text(black.page, '[data-carry]');
  check(/theirs/.test(seen ?? ''), "Black: White's carry is shown as theirs", seen);
  await shot(black, '07-black-sees-white-carry-on-g3');
  await act(white, whiteBoard, 'g4', 'w', theirMove);

  step(11, "2... Qh4#: Black carries the queen; White sees it beside Black's dot on f6");
  await act(black, blackBoard, 'd8', 'b', carrying);
  await walkTo(black.page, blackBoard, 5, 5);
  await white.page.waitForTimeout(6_000);
  await shot(black, '08b-black-own-queen-carry');
  await shot(white, '08-white-sees-black-queen-on-f6');
  await watcher.screenshot({ path: join(OUT, '09-watcher-mid-carry.png'), fullPage: true });
  const watchedDots = await watcher.evaluate(() => document.querySelector('[data-watch-page]')?.dataset.dots ?? '');
  console.log(`   watcher's dots: ${watchedDots}`);
  await act(black, blackBoard, 'h4', 'b', () => /checkmate/.test(document.querySelector('[data-prompt]')?.textContent ?? ''));
  await white.page.waitForFunction(() => /checkmate/.test(document.querySelector('[data-prompt]')?.textContent ?? ''), null, {
    timeout: 10_000,
  });
  check(true, 'mate, on both phones');
  await shot(white, '10-white-mated');
  await watcher.waitForTimeout(1_500);
  await watcher.screenshot({ path: join(OUT, '11-watcher-after-mate.png'), fullPage: true });

  step(12, 'After the game: the replay and the share card, in board space');
  await black.page.click('[data-review-open]');
  await black.page.waitForSelector('[data-review-result]', { timeout: 15_000 });
  const where = await text(black.page, '[data-review-where]');
  check(!/Big Field|Small Field/.test(where ?? ''), 'the review names neither field', where);
  await shot(black, '12-black-review');
  await black.page.locator('[data-card] summary').scrollIntoViewIfNeeded();
  await black.page.click('[data-card] summary');
  await black.page.waitForFunction(() => document.querySelector('[data-card]')?.dataset.cardReady === 'unnamed', null, {
    timeout: 15_000,
  });
  await black.page.locator('[data-card]').screenshot({ path: join(OUT, '13-black-share-card.png') });
  check(true, 'the share card is drawn');
  await white.page.click('[data-review-open]');
  await white.page.waitForSelector('[data-review-result]', { timeout: 15_000 });
  await shot(white, '14-white-review');

  console.log(failures === 0 ? `\nAll checks passed. Screenshots in ${OUT}` : `\n${failures} check(s) FAILED. Screenshots in ${OUT}`);
} finally {
  await browser.close();
}
process.exit(failures === 0 ? 0 : 1);
