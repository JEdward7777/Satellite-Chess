#!/usr/bin/env node
/**
 * A saved field following the account to a second phone (stage 2.3.3.2).
 *
 *     npm run build:client
 *     npx wrangler dev --port 8799 --var DEV_AUTH_SECRET:local-dev-secret &
 *     npm install --no-save playwright      # deliberately not a dependency
 *     node scripts/check-fields.mjs
 *
 * The eighth browser driver, and the first that needs a **session**: the dev
 * identity seam (stage 2.5.2) mints one for any named `sub`, so two browser
 * contexts can be two phones belonging to one person. That is the experiment
 * here, and it cannot be run any other way — a second phone is a second store,
 * and every unit test in the suite shares one.
 *
 * ## What it checks
 *
 * 1. A field calibrated **while signed out** is still saved. Decision 0013 is
 *    the rule the whole feature is built under: the phone is the primary store
 *    and the account is a replica, so nothing here may put a login in front of
 *    ground somebody walked.
 * 2. Signing in and reloading pushes it to the account.
 * 3. A second phone, signed in as the same person and having calibrated
 *    **nothing**, lists it. This is the stage in one assertion.
 * 4. A rename on the second phone reaches the first *without a reload* — the
 *    home screen redraws when a sync changes what the phone holds.
 * 5. A delete on the second phone removes it from the first. This is the case
 *    the sync journal exists for: without it the first phone would push the
 *    field straight back and the delete would never stick.
 * 6. A different account sees none of it. A field is a precise geolocation, so
 *    the quiet version of this failure is one player reading where another
 *    person stands on a Sunday morning (decision 0017).
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
const SECRET = args.get('secret') ?? 'local-dev-secret';
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-fields-'));
/** Fresh every run, so a re-run does not inherit the previous one's account. */
const WALKER = `walker-${Date.now().toString(36)}`;
const STRANGER = `stranger-${Date.now().toString(36)}`;

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

function squareLatLng(file, rank) {
  return {
    lat: A1.lat + (rank * SQUARE_M) / M_PER_DEG_LAT,
    lng: A1.lng + (file * SQUARE_M) / (M_PER_DEG_LAT * Math.cos((A1.lat * Math.PI) / 180)),
  };
}

const CORNERS = [
  ['a1', 0, 0],
  ['h1', 7, 0],
  ['h8', 7, 7],
  ['a8', 0, 7],
];

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
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${label}: ${m.text()}`));
  page.on('pageerror', (e) => consoleErrors.push(`${label}: ${e}`));
  return { label, context, page };
}

/**
 * Sign this phone in as `sub`, through the dev seam.
 *
 * `context.request` shares the context's cookie jar, so the cookie this sets is
 * the one the page will send — which is the only reason a driver can establish
 * an identity at all before stage 2.1 exists.
 */
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

/** What the *account* holds, asked directly rather than through a screen. */
async function accountFields({ context }) {
  const response = await context.request.post(`${ORIGIN}/api/fields/sync`, { data: {} });
  return response.ok() ? (await response.json()).fields : [];
}

/** The names on a home screen's field list, now. */
async function listed({ page }) {
  return page.$$eval('[data-fields] [data-field]', (nodes) =>
    nodes.map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
  );
}

/**
 * Nudge a phone into syncing without reloading it.
 *
 * The app syncs on `online` because the ordinary case is a walk that started
 * out of signal and ended in it. Dispatching it here is what makes checks 4 and
 * 5 about the *live* screen rather than about what a reload would have drawn.
 */
async function nudge({ page }) {
  await page.evaluate(() => dispatchEvent(new Event('online')));
}

/**
 * Wait for the home screen's field list to say something.
 *
 * `want` is data rather than a function because it crosses into the page, where
 * a closure would not survive: `{ includes }` for a name that must appear,
 * `{ empty: true }` for a list that must go away.
 */
async function waitForFields({ page }, want) {
  try {
    await page.waitForFunction(
      (wanted) => {
        const names = [...document.querySelectorAll('[data-fields] [data-field]')].map((n) =>
          n.textContent.replace(/\s+/g, ' ').trim(),
        );
        return wanted.empty ? names.length === 0 : names.some((n) => n.includes(wanted.includes));
      },
      want,
      { timeout: 15_000 },
    );
    return true;
  } catch {
    console.log(`    (gave up waiting for ${JSON.stringify(want)})`);
    return false;
  }
}

try {
  console.log(`screenshots -> ${OUT}`);
  const one = await phone('phone one');
  const two = await phone('phone two');

  console.log('\n1. Signed out, a calibrated field is still saved (decision 0013)');
  await one.page.goto(`${ORIGIN}/?sim=1`, { waitUntil: 'domcontentloaded' });
  await one.page.waitForSelector('[data-calibrate]', { timeout: 15_000 });
  await one.page.click('[data-calibrate]');
  await one.page.waitForSelector('[data-tap]', { timeout: 15_000 });
  for (const [, file, rank] of CORNERS) {
    await one.page.evaluate((pos) => globalThis.satchess.me.moveTo(pos), squareLatLng(file, rank));
    // The simulator emits at 1 Hz and a tap carries whatever fix it has, so a
    // tap dispatched too early records the previous corner.
    await one.page.waitForTimeout(1400);
    await one.page.waitForFunction(
      () => document.querySelector('[data-tap]')?.hasAttribute('disabled') === false,
      undefined,
      { timeout: 15_000 },
    );
    await one.page.click('[data-tap]');
    await one.page.waitForTimeout(150);
  }
  await one.page.waitForSelector('[data-save]', { timeout: 15_000 });
  await one.page.fill('[data-name]', 'Riverside Park');
  await one.page.click('[data-save]');
  await one.page.waitForSelector('[data-field]', { timeout: 15_000 });
  check(
    (await listed(one)).some((n) => n.includes('Riverside Park')),
    'the field is on the home screen with nobody signed in',
  );
  check(
    (await accountFields(one)).length === 0,
    'and no account has it, because there is no account',
  );
  await one.page.screenshot({ path: `${OUT}/1-signed-out.png`, fullPage: true });

  console.log('\n2. Signing in sends it up');
  await signIn(one, WALKER);
  await one.page.reload({ waitUntil: 'domcontentloaded' });
  await one.page.waitForSelector('[data-fields]', { timeout: 15_000 });
  // The push is background work, so poll the account rather than the screen.
  let held = [];
  for (let i = 0; i < 30 && held.length === 0; i++) {
    held = await accountFields(one);
    if (held.length === 0) await one.page.waitForTimeout(300);
  }
  check(held.length === 1 && held[0].name === 'Riverside Park', 'the account holds the field');
  check(
    (await listed(one)).some((n) => n.includes('Riverside Park')),
    'and the phone still shows it — the sync added nothing to the screen',
  );

  console.log('\n3. A second phone, same person, having calibrated nothing');
  await signIn(two, WALKER);
  await two.page.goto(`${ORIGIN}/?sim=1`, { waitUntil: 'domcontentloaded' });
  await two.page.waitForSelector('[data-fields]', { timeout: 15_000 });
  check(
    await waitForFields(two, { includes: 'Riverside Park' }),
    'the field arrived on a phone that never walked it',
  );
  await two.page.screenshot({ path: `${OUT}/2-second-phone.png`, fullPage: true });

  console.log('\n4. A rename on one reaches the other, with no reload');
  await two.page.click('[data-field]');
  await two.page.waitForSelector('[data-rename]', { timeout: 15_000 });
  await two.page.fill('[data-name]', 'Riverside, north end');
  await two.page.click('[data-rename]');
  await two.page.waitForSelector('[data-rename]', { timeout: 15_000 });
  await nudge(one);
  check(
    await waitForFields(one, { includes: 'north end' }),
    'the first phone redrew itself with the new name',
  );
  await one.page.screenshot({ path: `${OUT}/3-renamed.png`, fullPage: true });

  console.log('\n5. A delete on one removes it from the other, and stays deleted');
  await two.page.click('[data-delete]');
  await two.page.waitForSelector('[data-calibrate]', { timeout: 15_000 });
  await nudge(one);
  check(
    await waitForFields(one, { empty: true }),
    'the first phone let it go',
  );
  // The journal's whole purpose. Sync again from the phone that did not delete
  // it: without a record of what the account had already acknowledged, this is
  // the pass that pushes the field straight back.
  await nudge(one);
  await one.page.waitForTimeout(1000);
  check((await accountFields(one)).length === 0, 'and did not push it back');
  check((await listed(one)).length === 0, 'nor resurrect it locally');

  console.log('\n6. A different account sees none of it (decision 0017)');
  const stranger = await phone('stranger');
  await signIn(stranger, STRANGER);
  // Put something back on the walker's account, so "sees nothing" is a real
  // answer rather than the answer an empty account gives for free.
  await two.context.request.post(`${ORIGIN}/api/fields/sync`, {
    data: {
      push: [
        {
          id: 'stranger-must-not-see-this',
          name: 'Riverside Park',
          a1: A1,
          h8: squareLatLng(7, 7),
          version: 1,
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
    },
  });
  check((await accountFields(two)).length === 1, 'the walker has a field again');
  await stranger.page.goto(`${ORIGIN}/?sim=1`, { waitUntil: 'domcontentloaded' });
  await stranger.page.waitForSelector('[data-fields]', { timeout: 15_000 });
  await stranger.page.waitForTimeout(1500);
  check((await accountFields(stranger)).length === 0, 'the stranger’s account is empty');
  check((await listed(stranger)).length === 0, 'and so is their home screen');

  console.log('\n7. Nothing threw');
  check(consoleErrors.length === 0, 'no console errors', consoleErrors.join(' | ').slice(0, 300));
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? 'all good' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
