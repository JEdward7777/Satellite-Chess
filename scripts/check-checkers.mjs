/**
 * Checkers on the phone (stage 11.3, decisions 0057 and 0058), driven end to
 * end in the simulator: two phones, each game made from New game.
 *
 * 1. **Jumps not required** (the default). Six real opening moves, then the
 *    `w` seat — Black, the dark pieces, which moves first — lifts g3 and
 *    walks the first hop of a double jump to e5. e5 is both a landing that
 *    goes on and a place, so the phone asks "stop here, or keep jumping?";
 *    the player stops, and one piece is taken, not two.
 * 2. **Jumps required.** A whole 25-move game, found by a search over the
 *    server's own rules: a lift refused because another piece must jump (and
 *    the phone says so), every hop of every multi-jump walked and tapped, a
 *    man crowned, a king's double jump, and the side to move left with no
 *    moves, so Black wins. Then the review: the result in checkers' names,
 *    the replay's steps, Share PDN and the `.pdn` download, and the card.
 *
 * Both piece looks are photographed at phone width.
 *
 *     node scripts/check-checkers.mjs --base=http://127.0.0.1:8799/?sim=1 --out=/tmp/checkers
 */

import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
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
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-checkers-'));
/** Each run's accounts are new, so a reused `--persist-to` cannot confuse the record. */
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
  name: 'Sim Field',
  a1: A1,
  h8: squareLatLng(7, 7),
  version: 1,
  createdAt: 0,
  updatedAt: 0,
};

const fr = (sq) => ({ file: FILES.indexOf(sq[0]), rank: Number(sq[1]) - 1 });

/** `projectionFor` from client/render.ts, replayed at 1x: a square's centre. */
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

async function newPhone(browser, name, seat) {
  // Phone width: the board and the readout as a player holds them.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await signIn(context, `sim-checkers-${RUN}-${name}`, new URL(BASE).origin, name);
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`  [${name}] console error: ${m.text()}`);
  });
  await page.addInitScript(
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
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-new]', { timeout: 15_000 });
  return { context, page, name, seat };
}

/** Teleport, and wait for the app to believe it (the fix lags a second). */
async function walkTo(page, sq) {
  const { file, rank } = fr(sq);
  await page.evaluate((pos) => globalThis.satchess.me.moveTo(pos), squareLatLng(file, rank));
  await page.waitForFunction((want) => document.querySelector('[data-square]')?.textContent === want, sq, {
    timeout: 10_000,
  });
}

/** A non-primary `pointerdown`/`pointerup` pair: a tap the simulator ignores. */
async function tapSquare(phone, sq) {
  const { file, rank } = fr(sq);
  const box = await phone.page.locator('[data-board]').boundingBox();
  const p = squareToPixel(file, rank, phone.seat, box.width, box.height);
  await phone.page.evaluate(
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

const text = (page, selector) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    return !el || el.hidden ? null : el.textContent;
  }, selector);

let failures = 0;
function check(label, ok, detail) {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}
const step = (n, msg) => console.log(`\n${n}. ${msg}`);

/** How long a walk of `squares` diagonal steps must take to be believed (12 m/s, with slack). */
const walkMs = (from, to) => {
  const a = fr(from);
  const b = fr(to);
  const m = Math.hypot(a.file - b.file, a.rank - b.rank) * SQUARE_M;
  return Math.ceil((m / 9) * 1000);
};

/** The server's own carry, as the snapshot has it (the debug hook reads the decorated view). */
const serverCarry = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-carry]');
    const prompt = document.querySelector('[data-prompt]')?.textContent ?? '';
    return { carry: el && !el.hidden ? el.textContent : null, prompt };
  });

/** Lift `sq`: walk there, tap, and wait for the carry. */
async function lift(phone, sq) {
  await walkTo(phone.page, sq);
  await tapSquare(phone, sq);
  await phone.page.waitForFunction(
    (want) => {
      const el = document.querySelector('[data-carry]');
      const prompt = document.querySelector('[data-prompt]')?.textContent ?? '';
      return el && !el.hidden && el.textContent?.startsWith(want) && !prompt.startsWith('Picked up');
    },
    sq,
    { timeout: 10_000 },
  );
}

/**
 * Walk one move given as every square stood on (`c3e5g7`): lift, each hop a
 * waypoint (confirmed by the server before the next), then the place.
 */
async function play(mover, waiter, uci) {
  const squares = uci.match(/[a-h][1-8]/g);
  await lift(mover, squares[0]);
  for (let i = 1; i < squares.length; i++) {
    const sq = squares[i];
    await walkTo(mover.page, sq);
    await mover.page.waitForTimeout(walkMs(squares[i - 1], sq));
    await tapSquare(mover, sq);
    if (i < squares.length - 1) {
      // A hop: the readout shows it, and the server has answered with where next.
      await mover.page.waitForFunction(
        (path) => {
          const carry = document.querySelector('[data-carry]')?.textContent ?? '';
          const prompt = document.querySelector('[data-prompt]')?.textContent ?? '';
          return carry.startsWith(path) && !prompt.includes('Hold on');
        },
        squares.slice(0, i + 1).join(' → '),
        { timeout: 10_000 },
      );
    }
  }
  await mover.page.waitForFunction(() => document.querySelector('[data-carry]')?.hidden !== false, { timeout: 10_000 });
  // The other phone has the move: its turn now, or the game is over.
  await waiter.page.waitForFunction(
    () => {
      const prompt = document.querySelector('[data-prompt]')?.textContent ?? '';
      return prompt.includes('Your move') || prompt.includes('won') || prompt.includes('Drawn');
    },
    { timeout: 10_000 },
  );
}

/** Make a checkers game from New game and seat both phones on their back ranks. */
async function startGame(black, white, { jumpsRequired }) {
  await black.page.click('[data-new]');
  await black.page.waitForSelector('[data-create]', { timeout: 15_000 });
  await black.page.click('[data-game="checkers"]');
  await black.page.waitForSelector('[data-jumps-required]', { timeout: 5_000 });
  const defaultOff = await black.page.isChecked('[data-jumps-required]');
  const labels = await black.page.$$eval('[data-colour]', (els) => els.map((e) => e.textContent?.trim()));
  if (jumpsRequired) await black.page.check('[data-jumps-required]');
  await black.page.click('[data-colour="w"]');
  await black.page.screenshot({ path: `${OUT}/${jumpsRequired ? 'b' : 'a'}0-new-game.png`, fullPage: true });
  await black.page.click('[data-create]');
  await black.page.waitForSelector('[data-join-code]', { timeout: 15_000 });
  const code = await black.page.getAttribute('[data-join-code]', 'data-join-code');
  await black.page.click('[data-open]');
  await black.page.waitForSelector('[data-board]', { timeout: 15_000 });
  await white.page.fill('[data-code]', code);
  await white.page.click('[data-join]');
  await white.page.waitForSelector('[data-board]', { timeout: 15_000 });
  await walkTo(black.page, 'e1');
  await walkTo(white.page, 'e8');
  await black.page.waitForFunction(() => document.querySelector('[data-prompt]')?.textContent?.includes('Your move'), {
    timeout: 20_000,
  });
  return { code, defaultOff, labels };
}

async function home(phone) {
  await phone.page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await phone.page.waitForSelector('[data-new]', { timeout: 15_000 });
}

const browser = await chromium.launch({ executablePath: findChromium() });

try {
  console.log(`screenshots -> ${OUT}`);
  // The `w` seat plays the dark pieces and moves first: checkers' Black.
  const black = await newPhone(browser, 'black', 'w');
  const white = await newPhone(browser, 'white', 'b');

  step(1, 'New game: Checkers, jumps not required (the default)');
  const a = await startGame(black, white, { jumpsRequired: false });
  check('the switch is off by default', a.defaultOff === false);
  check('the first seat is called Black in checkers', a.labels[0] === 'Black' && a.labels[1] === 'White', a.labels);
  check('the board says jumps are optional', (await text(black.page, '[data-jumps]')) === 'optional');
  check('the prompt says it is Black’s move', (await text(black.page, '[data-prompt]'))?.includes('Your move') ?? false);
  await black.page.screenshot({ path: `${OUT}/a1-black-start-standard.png` });
  await white.page.screenshot({ path: `${OUT}/a2-white-start-standard.png` });

  step(2, 'Six real opening moves, setting up a double jump for Black');
  const opening = ['g3h4', 'h6g5', 'h2g3', 'g5f4', 'g1h2', 'g7h6'];
  for (const [i, uci] of opening.entries()) {
    const [mover, waiter] = i % 2 === 0 ? [black, white] : [white, black];
    await play(mover, waiter, uci);
  }
  check('Black to move after six plies', (await text(black.page, '[data-prompt]'))?.includes('Your move') ?? false);

  step(3, 'Black jumps g3 to e5, keeps jumping, then puts it all back mid-jump');
  await lift(black, 'g3');
  await walkTo(black.page, 'e5');
  await black.page.waitForTimeout(walkMs('g3', 'e5'));
  await tapSquare(black, 'e5');
  await black.page.waitForSelector('[data-hop-choice]:not([hidden])', { timeout: 5_000 });
  await black.page.click('[data-hop-on]');
  await black.page.waitForFunction(
    () => {
      const carry = document.querySelector('[data-carry]')?.textContent ?? '';
      const prompt = document.querySelector('[data-prompt]')?.textContent ?? '';
      return carry.startsWith('g3 → e5') && !prompt.includes('Hold on');
    },
    { timeout: 10_000 },
  );
  check('keep jumping: the hop is walked', true);
  const hopPrompt = await text(black.page, '[data-prompt]');
  check('the prompt offers the next landing and stopping on e5', (hopPrompt ?? '').includes('Tap e5 to stop there'), hopPrompt);
  await black.page.screenshot({ path: `${OUT}/a3b-black-hopped-e5.png` });
  await white.page.screenshot({ path: `${OUT}/a3c-white-sees-hop.png` });
  await black.page.click('[data-drop]');
  await black.page.waitForFunction(() => document.querySelector('[data-carry]')?.hidden !== false, { timeout: 10_000 });
  check('put back mid-jump: still Black’s move', (await text(black.page, '[data-prompt]'))?.includes('Your move') ?? false);

  step(4, 'Black jumps g3 to e5 again; the phone asks; this time Black stops there');
  await lift(black, 'g3');
  await black.page.screenshot({ path: `${OUT}/a3-black-lifted-g3.png` });
  await walkTo(black.page, 'e5');
  await black.page.waitForTimeout(walkMs('g3', 'e5'));
  await tapSquare(black, 'e5');
  await black.page.waitForSelector('[data-hop-choice]:not([hidden])', { timeout: 5_000 });
  check('asked "stop here, or keep jumping?"', ((await text(black.page, '[data-hop-title]')) ?? '').includes('stop here'));
  await black.page.screenshot({ path: `${OUT}/a4-black-asked.png` });
  await black.page.click('[data-hop-stop]');
  await black.page.waitForFunction(() => document.querySelector('[data-carry]')?.hidden !== false, { timeout: 10_000 });
  await white.page.waitForFunction(() => document.querySelector('[data-prompt]')?.textContent?.includes('Your move'), {
    timeout: 10_000,
  });
  check('White to move: the jump stopped after one hop', true);
  await black.page.screenshot({ path: `${OUT}/a5-black-stopped-on-e5.png` });

  step(5, 'Both piece looks, on both phones');
  for (const phone of [black, white]) await phone.page.click('[data-look="disc"]');
  await black.page.waitForTimeout(400);
  await black.page.screenshot({ path: `${OUT}/a6-black-discs.png` });
  await white.page.screenshot({ path: `${OUT}/a7-white-discs.png` });
  for (const phone of [black, white]) await phone.page.click('[data-look="standard"]');

  step(6, 'A games list line says Checkers and the seat');
  await home(black);
  await black.page.waitForSelector('li[data-game]', { timeout: 15_000 });
  const line = await black.page.evaluate(() => document.querySelector('li[data-game]')?.textContent ?? '');
  check('home lists the game as Checkers · Black', /Checkers · Black/.test(line), line.replace(/\s+/g, ' ').trim());
  await home(white);

  step(7, 'New game: Checkers, jumps required');
  const b = await startGame(black, white, { jumpsRequired: true });
  check('the board says jumps are required', (await text(black.page, '[data-jumps]')) === 'required');

  // Found by a search over the server's own rules (decision 0057's engine):
  // a double jump, a crowning, a king's double jump, and no moves left.
  const game = (
    'c3b4 d6c5 b4d6 e7c5 g3h4 f6e5 h2g3 h6g5 h4f6 d8e7 f6d8 f8e7 d8f6d4 b6a5 ' +
    'd4b6d8 a5b4 a3c5 b8c7 d8b6 g7f6 b2c3 f6g5 g3f4 h8g7 f4h6f8'
  ).split(' ');

  step(8, 'A lift refused because another piece must jump, said in words');
  await play(black, white, game[0]);
  await play(white, black, game[1]);
  await walkTo(black.page, 'e3');
  await tapSquare(black, 'e3');
  await black.page.waitForFunction(() => document.querySelector('[data-notice]')?.hidden === false, { timeout: 10_000 });
  const refusal = await text(black.page, '[data-notice]');
  check('told a jump is required elsewhere', (refusal ?? '').startsWith('Jumps are required, and another of your pieces can jump'), refusal);
  await black.page.screenshot({ path: `${OUT}/b1-black-must-jump.png` });

  step(9, 'The rest of the game, every hop walked: a crowning, a king’s double jump, no moves left');
  let crowned = false;
  for (let i = 2; i < game.length; i++) {
    const [mover, waiter] = i % 2 === 0 ? [black, white] : [white, black];
    await play(mover, waiter, game[i]);
    if (game[i] === 'f6d8') {
      crowned = true;
      await black.page.screenshot({ path: `${OUT}/b2-black-crowned-d8.png` });
      await black.page.click('[data-look="disc"]');
      await black.page.waitForTimeout(300);
      await black.page.screenshot({ path: `${OUT}/b3-black-crowned-d8-discs.png` });
      await black.page.click('[data-look="standard"]');
    }
    if (game[i] === 'd8f6d4') await white.page.screenshot({ path: `${OUT}/b4-white-after-king-double-jump.png` });
  }
  check('a man was crowned on the way', crowned);
  await black.page.waitForFunction(() => document.querySelector('[data-prompt]')?.textContent?.includes('won'), {
    timeout: 10_000,
  });
  const endBlack = await text(black.page, '[data-prompt]');
  const endWhite = await text(white.page, '[data-prompt]');
  check('the board says Black won — no moves left', endBlack === 'Black won — no moves left.', endBlack);
  check('the other phone says the same', endWhite === 'Black won — no moves left.', endWhite);
  await black.page.screenshot({ path: `${OUT}/b5-black-end.png` });
  await walkTo(black.page, 'h4');
  await black.page.screenshot({ path: `${OUT}/b5a-black-end-kings.png` });
  await black.page.click('[data-look="disc"]');
  await black.page.waitForTimeout(300);
  await black.page.screenshot({ path: `${OUT}/b5b-black-end-kings-discs.png` });
  await black.page.click('[data-look="standard"]');
  await white.page.screenshot({ path: `${OUT}/b6-white-end.png` });

  step(10, 'After the game: the result in checkers’ names, the replay, the PDN, the card');
  await black.page.click('[data-review-open]');
  await black.page.waitForSelector('[data-review-result]', { timeout: 15_000 });
  check('review: "You won — no moves left"', (await text(black.page, '[data-review-result]')) === 'You won — no moves left');
  const walks = await black.page.$$eval('[data-review-walks] dt', (els) => els.map((e) => e.textContent));
  check('review: the rows name Black and White', walks.join('|') === 'You · Black|Them · White', walks);
  check('review: Share PDN', (await text(black.page, '[data-review-share]')) === 'Share PDN');
  const download = await black.page.getAttribute('[data-review-download]', 'download');
  check('review: the download is a .pdn', /^satellite-checkers-.*\.pdn$/.test(download ?? ''), download);
  const fileText = await black.page.$eval('[data-review-text]', (el) => el.value);
  check('review: the file is PDN, Black first, 1-0', fileText.includes('[GameType "21"]') && fileText.includes('[Result "1-0"]'));
  check('review: the file says jumps were required', fileText.includes('[SatelliteJumpsRequired "true"]') || fileText.includes('JumpsRequired'));
  const plies = await black.page.getAttribute('[data-replay]', 'data-ply');
  check('replay: every move is a step', plies === String(game.length), plies);
  check('replay: the last step is the double jump', ((await text(black.page, '[data-replay-head]')) ?? '').includes('x'));
  check('replay: the carry names its hops', ((await text(black.page, '[data-replay-carry]')) ?? '').includes('Black jumped f4 to h6 to f8'));
  await black.page.screenshot({ path: `${OUT}/b7-review.png`, fullPage: true });
  await black.page.click('[data-card] summary');
  await black.page.waitForFunction(() => {
    const ready = document.querySelector('[data-card]')?.getAttribute('data-card-ready');
    return ready === 'unnamed' || ready === 'named';
  }, { timeout: 15_000 });
  const alt = await black.page.getAttribute('[data-card-image]', 'alt');
  check('card: "Won as Black — no moves left"', (alt ?? '').startsWith('Won as Black — no moves left'), alt);
  // The PNG itself, as it would be shared.
  const b64 = await black.page.evaluate(async () => {
    const src = document.querySelector('[data-card-image]').src;
    const bytes = new Uint8Array(await (await fetch(src)).arrayBuffer());
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  });
  writeFileSync(`${OUT}/b8-card.png`, Buffer.from(b64, 'base64'));

  console.log(failures === 0 ? `\nAll checks passed. Screenshots in ${OUT}` : `\n${failures} check(s) FAILED.`);
} finally {
  await browser.close();
}
process.exitCode = failures === 0 ? 0 : 1;
