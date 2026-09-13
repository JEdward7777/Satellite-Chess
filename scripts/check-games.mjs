#!/usr/bin/env node
/**
 * The game list on the home screen (stage 2.3.4), in a browser.
 *
 *     npm run build:client
 *     npx wrangler dev --port 8799 --var DEV_AUTH_SECRET:local-dev-secret &
 *     npm install --no-save playwright      # deliberately not a dependency
 *     PLAYWRIGHT_BROWSERS_PATH=~/.cache/satellite-chess/playwright \
 *       node scripts/check-games.mjs
 *
 * The ninth browser driver, and it exists because `2.3.4` shipped with its two
 * ends tested and the middle not: `test/game-list.test.ts` proves the words,
 * `test/worker/games.test.ts` proves the rows, and nothing at all proved that
 * tapping a line gets you back into a game. That gap was logged as O-14.
 *
 * ## What it checks
 *
 * 1. **A signed-out phone shows no list at all** — not an empty heading. This is
 *    the state every real browser is in until stage 2.5.1, so it is the first
 *    thing most people would see, and "Your games" over nothing would read as
 *    *your games have gone* to somebody who paused one last week.
 * 2. A game created on one phone appears on **another phone of the same
 *    account**, which is the stage's title and is impossible to check any other
 *    way — a second phone is a second browser context.
 * 3. The line says the right things: the ground it is played on, which colour
 *    you are, what state it is in, and the join code you read aloud.
 * 4. **Tapping the line gets you back into the game.** This is stage `3.5.2` as
 *    much as `2.3.4`: the second phone takes the *same seat* rather than being
 *    turned away as a third player, and that is the difference between a list
 *    you can act on and a list you can only read.
 * 5. A stranger sees none of it.
 * 6. The tidy-up offer appears only once the list has grown, starts with
 *    **nothing ticked**, and removes exactly what was chosen (stage 2.3.4.2).
 *
 * Creating the games goes through the API rather than the create screen. That
 * screen is `check-invite.mjs`'s subject and is covered there in detail; what is
 * new here is the list, and a driver that re-drove creation six times would be
 * slower and would fail for reasons that are not about this stage.
 */

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

import { isRealConsoleError } from './driver-console.mjs';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);
const ORIGIN = args.get('origin') ?? 'http://127.0.0.1:8799';
const SECRET = args.get('secret') ?? 'local-dev-secret';
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-games-'));
/** Fresh every run, so a re-run does not inherit the previous one's account. */
const PLAYER = `player-${Date.now().toString(36)}`;
const STRANGER = `stranger-${Date.now().toString(36)}`;

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
  // Undefined is fine, and is the common case: with PLAYWRIGHT_BROWSERS_PATH
  // set, playwright resolves the binary itself.
  return undefined;
}

const A1 = { lat: 51.4779, lng: -0.0015 }; // `SIM_START` in client/main.ts
const SQUARE_M = 8;
const M_PER_DEG_LAT = (6378137 * Math.PI) / 180;

function squareLatLng(file, rank) {
  return {
    lat: A1.lat + (rank * SQUARE_M) / M_PER_DEG_LAT,
    lng: A1.lng + (file * SQUARE_M) / (M_PER_DEG_LAT * Math.cos((A1.lat * Math.PI) / 180)),
  };
}

const FIELD = {
  id: 'check-games-field',
  name: 'Jubilee Park',
  a1: squareLatLng(0, 0),
  h8: squareLatLng(7, 7),
  version: 1,
  createdAt: 1000,
  updatedAt: 1000,
};

let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ executablePath: findChromium() });
const consoleErrors = [];

/** A phone: its own browser context, so its own storage and its own cookies. */
async function phone(label) {
  const context = await browser.newContext({ viewport: { width: 480, height: 900 } });
  const page = await context.newPage();
  page.on('console', (m) => isRealConsoleError(m) && consoleErrors.push(`${label}: ${m.text()}`));
  page.on('pageerror', (e) => consoleErrors.push(`${label}: ${e}`));
  return { label, context, page };
}

async function signIn({ context, label }, sub) {
  const response = await context.request.post(`${ORIGIN}/api/dev/session`, {
    headers: { 'x-dev-auth-secret': SECRET },
    data: { sub },
  });
  if (!response.ok()) {
    console.error(
      `${label}: could not mint a dev session (${response.status()}). ` +
        'Is wrangler dev running with DEV_AUTH_SECRET set?',
    );
    process.exit(2);
  }
}

/** Start a game as this phone's account, and return its join code. */
async function createGame({ context }, colour = 'w') {
  const response = await context.request.post(`${ORIGIN}/api/game`, {
    data: { playerId: 'driver-phone-0001', field: FIELD, color: colour },
  });
  if (!response.ok()) {
    console.error(`could not create a game (${response.status()})`);
    process.exit(2);
  }
  return (await response.json()).joinCode;
}

/** Open the home screen fresh, which is when the list is fetched. */
async function home({ page }) {
  await page.goto(`${ORIGIN}/?sim=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-calibrate]', { timeout: 15_000 });
}

/** The rendered game lines, as a reader would see them. */
async function lines({ page }) {
  return page.$$eval('[data-games] [data-game]', (items) =>
    items.map((li) => ({
      code: li.dataset.game,
      title: li.querySelector('strong')?.textContent?.trim() ?? '',
      text: li.textContent.replace(/\s+/g, ' ').trim(),
    })),
  );
}

async function waitForLine({ page }, joinCode) {
  try {
    await page.waitForSelector(`[data-game="${joinCode}"]`, { timeout: 15_000 });
    return true;
  } catch {
    console.log(`    (gave up waiting for a line for ${joinCode})`);
    return false;
  }
}

console.log(`screenshots -> ${OUT}\n`);

try {
  console.log('1. Signed out, there is no list — not an empty one');
  const stranger = await phone('stranger');
  await home(stranger);
  check((await stranger.page.$$('[data-games]')).length === 0, 'no games list is rendered');
  check(
    !(await stranger.page.textContent('body')).includes('Your games'),
    'and no heading over it, which would read as “your games have gone”',
  );
  await stranger.page.screenshot({ path: `${OUT}/1-signed-out.png`, fullPage: true });

  console.log('\n2. A game started on one phone reaches the other');
  const one = await phone('phone one');
  const two = await phone('phone two');
  await signIn(one, PLAYER);
  await signIn(two, PLAYER);
  const first = await createGame(one);
  await home(two);
  check(await waitForLine(two, first), 'the second phone lists a game it never started');
  await two.page.screenshot({ path: `${OUT}/2-listed.png`, fullPage: true });

  console.log('\n3. The line says what somebody deciding whether to walk there needs');
  const [line] = await lines(two);
  check(line?.title === 'Jubilee Park', 'leads with the ground', line?.title);
  check(/White/.test(line?.text ?? ''), 'says which colour you are');
  check(
    /waiting for an opponent/.test(line?.text ?? ''),
    'says what state the game is in',
  );
  check(
    new RegExp(`${first.slice(0, 3)} ${first.slice(3)}`).test(line?.text ?? ''),
    'and shows the code grouped, the way it is read aloud',
    `${first.slice(0, 3)} ${first.slice(3)}`,
  );

  console.log('\n4. Tapping it gets you back into the game (stage 3.5.2)');
  await two.page.click(`[data-game="${first}"]`);
  // The address bar is the real signal: `rememberGame` puts the code there, so a
  // reload — or a phone that ran out of battery — resumes rather than landing
  // back on the home screen.
  try {
    await two.page.waitForURL(`**/j/${first}**`, { timeout: 20_000 });
    check(true, 'the second phone took the same seat, on a game it did not start');
  } catch {
    check(false, 'the second phone took the same seat, on a game it did not start');
  }
  await two.page.screenshot({ path: `${OUT}/3-resumed.png`, fullPage: true });

  console.log('\n5. A stranger sees none of it (decision 0017)');
  await signIn(stranger, STRANGER);
  await home(stranger);
  await stranger.page.waitForTimeout(1000);
  check((await lines(stranger)).length === 0, 'a different account lists nothing');

  console.log('\n6. Tidying up is an offer, and only once the list has grown');
  await home(one);
  await one.page.waitForTimeout(1000);
  check(
    (await one.page.$$('[data-tidy]')).length === 0,
    'one game is not enough to be offered a tidy-up',
  );
  const codes = [first];
  for (let i = 0; i < 6; i++) codes.push(await createGame(one));
  await home(one);
  // The newest, not the first: the list is ordered most-wanted-first and capped,
  // so the earliest game is now one of the ones deliberately not drawn.
  check(await waitForLine(one, codes[6]), 'the games are listed');
  check((await one.page.$$('[data-tidy]')).length === 1, 'and now the offer appears');
  await one.page.screenshot({ path: `${OUT}/4-grown.png`, fullPage: true });

  // Home is the way into a game, not the game list. An uncapped list grows
  // without bound — a suspended game can never be tidied away — and pushes
  // everything below it, the fields and Calibrate and New game and the join
  // box, off the end of the page.
  //
  // The assertion is a **bound, not a fold**. "New game above the fold" is not
  // achievable by capping and never was: measured on a 480x900 phone, it sits at
  // y=542 with no games and crosses 900 at three, and the fields list above it
  // has the same shape with a limit of two hundred. That ordering question is
  // real, is older than this list, and is logged as O-16 rather than answered
  // here. What this checks is the thing the cap is actually for: seven games
  // must not cost more page than five.
  console.log('\n7. A long list does not grow without bound');
  check((await lines(one)).length === 5, 'only the first few games are drawn');
  const viewport = one.page.viewportSize();
  const height = await one.page.evaluate(() => document.body.scrollHeight);
  check(
    height < viewport.height * 2,
    'and the whole of home still fits in two screens with seven games',
    `${height}px against a ${viewport.height}px screen`,
  );
  check((await one.page.$$('[data-more]')).length === 1, 'the rest are one tap away');
  await one.page.click('[data-more]');
  await one.page.waitForFunction(
    () => document.querySelectorAll('[data-games] [data-game]').length === 7,
    undefined,
    { timeout: 15_000 },
  );
  check(true, 'and tapping shows all seven');
  await one.page.screenshot({ path: `${OUT}/6-expanded.png`, fullPage: true });

  await one.page.click('[data-tidy]');
  await one.page.waitForSelector('[data-candidates]', { timeout: 15_000 });
  const ticked = await one.page.$$eval('[data-pick]', (boxes) =>
    boxes.filter((b) => b.checked).length,
  );
  // Nothing pre-selected, deliberately: these are the only record of afternoons
  // somebody spent walking around a field, and nothing else ever deletes one.
  check(ticked === 0, 'nothing is ticked to begin with', `${ticked} ticked`);
  check(
    (await one.page.$$('[data-pick]')).length === 7,
    'every game is a candidate, because none of them ever started',
  );

  await one.page.check(`[data-pick="${codes[1]}"]`);
  await one.page.check(`[data-pick="${codes[2]}"]`);
  await one.page.screenshot({ path: `${OUT}/5-tidy.png`, fullPage: true });
  await one.page.click('[data-forget]');
  await one.page.waitForFunction(
    () => document.querySelectorAll('[data-pick]').length === 5,
    undefined,
    { timeout: 15_000 },
  );
  check(true, 'the two chosen games went');
  const left = await one.page.$$eval('[data-pick]', (b) => b.map((x) => x.dataset.pick));
  check(!left.includes(codes[1]) && !left.includes(codes[2]), 'and they were the chosen two');

  await one.page.click('[data-done]');
  await one.page.waitForSelector('[data-calibrate]', { timeout: 15_000 });
  check((await lines(one)).length === 5, 'and home agrees when you come back to it');

  console.log('\n8. Nothing threw');
  check(consoleErrors.length === 0, 'no console errors', consoleErrors.join(' | ').slice(0, 300));
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? 'all good' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
