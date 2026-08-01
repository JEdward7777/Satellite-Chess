#!/usr/bin/env node
/**
 * Drive the joining half of phase 6 — the scan-to-play flow, from the other end.
 *
 *     npm run build:client
 *     npx wrangler dev --port 8799 --local &
 *     npm install --no-save playwright              # deliberately not a dependency
 *     node scripts/check-join.mjs
 *
 * The fourth browser driver. `check-invite.mjs` proves the QR on the creator's
 * screen points at this game; this one proves that following it *arrives*. They
 * are two halves of the same claim and neither implies the other: stage 6.0 made
 * the shell load at `/j/CODE`, which looked like a working link and was in fact a
 * home screen with a code in the address bar that nothing read.
 *
 * Every phone here except the creator's has **never calibrated a field**, which
 * is the point of stage 6.3 and cannot be faked in a unit test — until the field
 * travelled back with the seat, `main.ts` would not even offer Join without a
 * saved field, and the game screen had no geometry to draw a board with.
 *
 * ## What it checks
 *
 * 1. A phone with no fields gets a home screen with a code box on it, rather
 *    than being marched into calibration with no way out (6.3).
 * 2. Opening `/j/CODE` cold lands in the game, on the creator's field, with the
 *    right colour (6.2.1).
 * 3. The board it draws is the *creator's* geometry: the far corner of the field
 *    reads as h8 on a phone that has never seen it.
 * 4. A typed code from a fieldless phone does the same thing (6.2.2).
 * 5. The failures say which failure it was — no such game, and game full (6.2.5).
 * 6. A reload resumes the game rather than starting over, because the join is
 *    idempotent and the address bar now names the game.
 * 7. Leaving takes the game back out of the address bar, so a reload of the home
 *    screen is a home screen.
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
const ORIGIN = args.get('origin') ?? 'http://127.0.0.1:8799';
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-join-'));

/** See `drive-game.mjs`: the bundled browser revision is rarely the one on disk. */
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

/** `fromLocal` from geo.ts, so the driver lands where the app thinks it landed. */
function squareLatLng(file, rank) {
  return {
    lat: A1.lat + (rank * SQUARE_M) / M_PER_DEG_LAT,
    lng: A1.lng + (file * SQUARE_M) / (M_PER_DEG_LAT * Math.cos((A1.lat * Math.PI) / 180)),
  };
}

/** The creator's field. Nobody else's phone has ever heard of it. */
const FIELD = {
  id: 'creator-field',
  name: 'The common',
  a1: A1,
  h8: squareLatLng(7, 7),
  version: 1,
  createdAt: 0,
  updatedAt: 0,
};

let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ executablePath: findChromium() });
const consoleErrors = [];

/**
 * A phone. `fields` is empty for everyone but the creator, and that is the whole
 * experiment — a joiner's storage stays empty from first load to last move.
 */
async function newPhone(name, { fields = [] } = {}) {
  const context = await browser.newContext({ viewport: { width: 480, height: 900 } });
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`[${name}] ${m.text()}`));
  page.on('pageerror', (e) => consoleErrors.push(`[${name}] ${e}`));
  await page.addInitScript(
    ({ seeded, playerId }) => {
      localStorage.setItem('satchess.player_id', playerId);
      if (seeded.length === 0) return;
      const req = indexedDB.open('satellite-chess', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('fields')) {
          db.createObjectStore('fields', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => {
        const store = req.result.transaction('fields', 'readwrite').objectStore('fields');
        for (const f of seeded) store.put(f);
      };
    },
    { seeded: fields, playerId: `sim-join-${name}` },
  );
  return { name, context, page };
}

/** Create a game on the creator's phone and come back with its code. */
async function createGame(page) {
  await page.goto(`${ORIGIN}/?sim=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-new]', { timeout: 15_000 });
  await page.click('[data-new]');
  await page.waitForSelector('[data-create]', { timeout: 15_000 });
  await page.click('[data-create]');
  await page.waitForSelector('[data-join-code]', { timeout: 15_000 });
  return page.getAttribute('[data-join-code]', 'data-join-code');
}

/** Teleport, then wait for the app to believe it — the simulator emits at 1 Hz. */
async function standOn(page, file, rank, expected) {
  await page.evaluate((pos) => globalThis.satchess.me.moveTo(pos), squareLatLng(file, rank));
  await page
    .waitForFunction(
      (sq) => document.querySelector('[data-square]')?.textContent === sq,
      expected,
      { timeout: 10_000 },
    )
    .catch(() => undefined);
  return page.textContent('[data-square]');
}

try {
  console.log(`screenshots -> ${OUT}`);

  const creator = await newPhone('creator', { fields: [FIELD] });
  const scanner = await newPhone('scanner');
  const typist = await newPhone('typist');
  const stranger = await newPhone('stranger');

  console.log('\n1. A phone that has never calibrated anything');
  await scanner.page.goto(`${ORIGIN}/?sim=1`, { waitUntil: 'domcontentloaded' });
  await scanner.page.waitForSelector('[data-join]', { timeout: 15_000 });
  check(await scanner.page.isVisible('[data-code]'), 'still offers a code box (6.3)');
  check(await scanner.page.isVisible('[data-no-fields]'), 'says why the field list is empty');
  check(
    !(await scanner.page.isVisible('[data-new]')),
    'does not offer a new game, which would need a field',
  );
  check(await scanner.page.isVisible('[data-calibrate]'), 'still offers to calibrate one');
  // Before 6.3 this screen did not exist: a phone with no fields was sent
  // straight into calibration, with no way back and so no way to join at all.
  await scanner.page.screenshot({ path: `${OUT}/1-empty-home.png`, fullPage: true });

  console.log('\n2. The creator makes a game');
  const code = await createGame(creator.page);
  console.log(`   join code ${code}`);
  check(/^[0-9A-Z]{6}$/.test(code ?? ''), 'has a six-character code', code ?? '(none)');
  await creator.page.click('[data-open]');
  await creator.page.waitForSelector('[data-board]', { timeout: 15_000 });

  console.log('\n3. Following the link, cold, on a phone with no field');
  await scanner.page.goto(`${ORIGIN}/j/${code}?sim=1`, { waitUntil: 'domcontentloaded' });
  await scanner.page.waitForSelector('[data-board]', { timeout: 20_000 });
  check(true, 'the deep link opens the board, not the home screen (6.2.1)');
  check(
    (await scanner.page.evaluate(() => localStorage.getItem('satchess.fields'))) === null,
    'and the phone still has no field of its own',
  );
  await scanner.page.waitForFunction(
    () => /\d/.test(document.querySelector('[data-reach]')?.textContent ?? ''),
    { timeout: 15_000 },
  );
  await scanner.page.screenshot({ path: `${OUT}/2-joined.png`, fullPage: true });

  console.log('\n4. The board it drew is the creator\'s field');
  // The simulator starts every phone at `SIM_START`, which is the creator's a1.
  const onA1 = await standOn(scanner.page, 0, 0, 'a1');
  check(onA1 === 'a1', 'the origin of the field reads as a1', onA1 ?? '(nothing)');
  // The far corner exercises the derived square size and bearing, not just the
  // anchor: a field with the right origin and the wrong scale still fails here.
  const onH8 = await standOn(scanner.page, 7, 7, 'h8');
  check(onH8 === 'h8', 'and the far corner reads as h8', onH8 ?? '(nothing)');
  // Black, because the creator took White by default. The colour decides which
  // end of the field this player walks to, so it is not cosmetic.
  const turn = await scanner.page.textContent('[data-turn]');
  check(turn === 'theirs', 'and it is White to move, so this phone is Black', turn ?? '');
  await scanner.page.screenshot({ path: `${OUT}/3-far-corner.png`, fullPage: true });

  console.log('\n5. A reload resumes rather than starting over');
  check(
    new URL(scanner.page.url()).pathname === `/j/${code}`,
    'the game is in the address bar',
    scanner.page.url(),
  );
  await scanner.page.reload({ waitUntil: 'domcontentloaded' });
  await scanner.page.waitForSelector('[data-board]', { timeout: 20_000 });
  check(true, 'and reloading it comes back to the same game');

  console.log('\n6. A typed code, also from a phone with no field');
  const second = await createGame(creator.page);
  console.log(`   join code ${second}`);
  await typist.page.goto(`${ORIGIN}/?sim=1`, { waitUntil: 'domcontentloaded' });
  await typist.page.waitForSelector('[data-join]', { timeout: 15_000 });
  // Typed the way it would be read aloud across a field: grouped, and lower case.
  await typist.page.fill('[data-code]', `${second.slice(0, 3)} ${second.slice(3)}`.toLowerCase());
  await typist.page.click('[data-join]');
  await typist.page.waitForSelector('[data-board]', { timeout: 20_000 });
  check(true, 'the typed code opens the board too (6.2.2)');
  check(
    new URL(typist.page.url()).pathname === `/j/${second}`,
    'and it lands in the address bar the same way',
    typist.page.url(),
  );

  console.log('\n7. Leaving takes the game back out of the address bar');
  await typist.page.click('[data-leave]');
  await typist.page.waitForSelector('[data-join]', { timeout: 15_000 });
  check(
    new URL(typist.page.url()).pathname === '/',
    'home is at / again',
    typist.page.url(),
  );
  check(
    new URL(typist.page.url()).searchParams.get('sim') === '1',
    'and ?sim=1 survived, which every browser check depends on',
  );

  console.log('\n8. The wait, on the phone with the worst signal in the game');
  // The round trip is instant against `wrangler dev` on the same machine, and it
  // is anything but on a phone in a park that has just been handed a link. Held
  // open on purpose, because without a screen for this moment the app shows a
  // blank page and the person scans the QR again.
  await stranger.page.route('**/api/game/*', async (route) => {
    await new Promise((r) => setTimeout(r, 1_500));
    await route.continue();
  });
  await stranger.page.goto(`${ORIGIN}/j/${code}?sim=1`, { waitUntil: 'domcontentloaded' });
  await stranger.page.waitForFunction(
    () => document.querySelector('[data-prompt]')?.textContent?.includes('Taking a seat'),
    { timeout: 15_000 },
  );
  check(true, 'says it is joining while the request is in flight');
  check(
    (await stranger.page.textContent('[data-code]'))?.trim() ===
      `${code.slice(0, 3)} ${code.slice(3)}`,
    'and shows the code it is joining with',
  );
  await stranger.page.screenshot({ path: `${OUT}/4-joining.png`, fullPage: true });

  // Cancelling has to stick. The request outlives the screen, so without a guard
  // the answer arrives a few seconds later and drops the player into the game on
  // top of whatever they had moved on to.
  await stranger.page.click('[data-cancel]');
  await stranger.page.waitForSelector('[data-join]', { timeout: 15_000 });
  await new Promise((r) => setTimeout(r, 2_500));
  check(
    await stranger.page.isVisible('[data-join]'),
    'cancelling a slow join stays cancelled once the answer arrives',
  );
  await stranger.page.unroute('**/api/game/*');

  console.log('\n9. The failures say which failure it was (6.2.5)');
  await stranger.page.goto(`${ORIGIN}/j/${code}?sim=1`, { waitUntil: 'domcontentloaded' });
  await stranger.page.waitForSelector('[data-reason]', { timeout: 20_000 });
  const full = await stranger.page.getAttribute('[data-reason]', 'data-reason');
  check(full === 'full', 'a third player is told the game is full', full ?? '');
  check(
    (await stranger.page.textContent('[data-hint]'))?.includes('joined from first'),
    'and what to do if one of those two is them',
  );
  check(
    (await stranger.page.textContent('[data-code]'))?.trim() ===
      `${code.slice(0, 3)} ${code.slice(3)}`,
    'with the code still on screen, since it is the fallback for everything here',
  );
  await stranger.page.screenshot({ path: `${OUT}/5-full.png`, fullPage: true });

  // A code that is shaped like a code but names no game. The Worker serves the
  // shell for it — it is a real route — and the client has to do the rest.
  await stranger.page.goto(`${ORIGIN}/j/ZZZZZZ?sim=1`, { waitUntil: 'domcontentloaded' });
  await stranger.page.waitForSelector('[data-reason]', { timeout: 20_000 });
  const missing = await stranger.page.getAttribute('[data-reason]', 'data-reason');
  check(missing === 'not_found', 'an unknown code is told there is no such game', missing ?? '');
  check(await stranger.page.isVisible('[data-retry]'), 'and is offered another go');
  await stranger.page.screenshot({ path: `${OUT}/6-not-found.png`, fullPage: true });

  await stranger.page.click('[data-home]');
  await stranger.page.waitForSelector('[data-join]', { timeout: 15_000 });
  check(
    new URL(stranger.page.url()).pathname === '/',
    'and getting out of a dead link leads somewhere useful',
    stranger.page.url(),
  );

  // A typed code that could not be a code gets the same screen as everything
  // else, rather than an `alert()`. It is refused on the phone, without a
  // request: the answer cannot differ, and this is the phone least likely to
  // have signal to spend on asking.
  await stranger.page.fill('[data-code]', 'nope');
  await stranger.page.click('[data-join]');
  await stranger.page.waitForSelector('[data-reason]', { timeout: 15_000 });
  const typo = await stranger.page.getAttribute('[data-reason]', 'data-reason');
  check(typo === 'bad_code', 'a typed code that cannot be one says so', typo ?? '');
  check(
    (await stranger.page.textContent('[data-code]'))?.trim() === 'nope',
    'and shows it back exactly as typed, ungrouped, to be compared against',
  );
  check(
    !(await stranger.page.isVisible('[data-retry]')),
    'with no Try again, which would send the same six characters to the same place',
  );
  await stranger.page.click('[data-home]');
  await stranger.page.waitForSelector('[data-join]', { timeout: 15_000 });

  // A path that could not be a code never reaches the client at all: the Worker
  // 404s it, deliberately, so a broken link looks broken rather than empty.
  const nonsense = await fetch(`${ORIGIN}/j/nonsense`, { redirect: 'manual' });
  check(nonsense.status === 404, 'a path that cannot be a code still 404s at the edge');

  console.log('');
  // Chromium logs every non-2xx fetch as a console error, and this run provokes a
  // 409 and two 404s deliberately — they are the checks above, not faults. Only
  // the app's own errors are interesting here.
  const unexpected = consoleErrors.filter((e) => !/Failed to load resource/.test(e));
  check(unexpected.length === 0, 'no console errors', unexpected.join(' | '));
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
