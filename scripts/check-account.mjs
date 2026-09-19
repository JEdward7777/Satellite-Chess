/**
 * Sessions that survive a walk to the park, driven in a browser (stages 2.2.3–2.2.5).
 *
 * What this proves that the unit and Worker tests cannot:
 *
 * - **An offline launch knows who it is (2.2.4).** The page is reloaded with the
 *   network cut, the shell comes out of the service worker, `/api/me` fails, and
 *   home still says *who* is signed in — from the identity the last confirmed
 *   launch wrote down — rather than nothing.
 * - **The gate still has three states.** After signing out, an offline launch
 *   *opens the app* (decision 0035, rule 2): the phone cannot ask, so it does not
 *   assume. Only the online relaunch, which meets a real 401, shows the gate.
 * - **Signing out works, and says so when it cannot (2.2.5).** Offline, the
 *   account screen refuses with a reason and changes nothing; online, the
 *   session ends at the server, the phone forgets the identity and the field
 *   journal, and the relaunch lands on the gate.
 * - **A session ended elsewhere is forgotten the same way** (decision 0039,
 *   rule 4). A seeded journal survives into a launch that meets a 401, and must
 *   come out of it empty — the route where the app's own sign-out never ran.
 *   And the third route: a phone that remembers one account launching confirmed
 *   as another, as "Sign in again" through Google's chooser can do.
 * - **The pre-flight warning renders (2.2.3)**, with a "sign in again" link that
 *   carries `?sim=1` home. The server's half of that — a session that did not
 *   slide — cannot be produced on demand against `wrangler dev`, so this one
 *   phone's `/api/me` answer is substituted by the driver; the Worker's half is
 *   `test/worker/session-lifecycle.test.ts`. The lapsed-and-offline notice is
 *   produced by aging the stored identity, which is exactly what a month does.
 *
 * ## Running it
 *
 *     npm run build:client
 *     npx wrangler dev --port 8799 --var DEV_AUTH_SECRET:local-dev-secret \
 *       --persist-to "$(mktemp -d)" &
 *     node scripts/check-account.mjs [--base=http://127.0.0.1:8799/?sim=1]
 */

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

import { signIn } from './driver-signin.mjs';

const args = new Map(
  process.argv.slice(2).map((a) => {
    // Split at the first `=` only (O-24): the base URL carries `?sim=1`.
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length > 0 ? rest.join('=') : 'true'];
  }),
);
const BASE = args.get('base') ?? 'http://127.0.0.1:8799/?sim=1';
const ORIGIN = new URL(BASE).origin;
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-account-'));

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

let failures = 0;
function check(ok, what, detail = '') {
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const step = (n, msg) => console.log(`\n${n}. ${msg}`);
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });

const DAY = 24 * 60 * 60 * 1000;

function watch(page, name) {
  page.on('pageerror', (e) => console.log(`  [${name}] page error: ${e.message}`));
}

async function text(page, selector) {
  return ((await page.textContent(selector)) ?? '').replace(/\s+/g, ' ').trim();
}

const browser = await chromium.launch({ executablePath: findChromium() });
try {
  step(1, 'A signed-in phone opens home with a connection');
  const context = await browser.newContext();
  await signIn(context, 'white-player', ORIGIN);
  const page = await context.newPage();
  watch(page, 'phone');
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('[data-account-line]');
  const line = await text(page, '[data-account-line]');
  check(line.includes('test account “white-player”'), 'home names the account', line);
  check(!line.includes('no connection'), 'and does not claim to be offline');
  check((await page.$('[data-session-notice]')) === null, 'no pre-flight warning for a dev session');
  const cached = await page.evaluate(() => localStorage.getItem('satchess.identity'));
  check(cached !== null && JSON.parse(cached).sub === 'white-player', 'the identity was written down');
  await shot(page, '1-home-online');

  // The shell has to be in the cache before the network can be cut.
  await page.evaluate(() => navigator.serviceWorker.ready);

  step(2, 'The same phone relaunches with no signal (2.2.4)');
  await context.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('[data-account-line]', { timeout: 15_000 });
  check((await page.$('[data-signin]')) === null, 'the app opened — no gate');
  const offlineLine = await text(page, '[data-account-line]');
  check(offlineLine.includes('white-player'), 'and still knows who it is', offlineLine);
  check(offlineLine.includes('no connection'), 'and says it could not check');
  await shot(page, '2-home-offline');

  step(3, 'The account screen, offline; signing out needs the server (2.2.5)');
  await page.click('[data-account]');
  await page.waitForSelector('[data-signout]');
  check((await text(page, '[data-who]')).includes('white-player'), 'the screen names the account');
  const checked = await text(page, '[data-checked]');
  check(checked.startsWith('Not checked — no connection.'), 'says it is remembered, not checked', checked);
  await page.click('[data-signout]');
  await page.waitForSelector('[data-signout-failed]:not([hidden])');
  check(
    (await page.getAttribute('[data-signout-failed]', 'data-signout-failed')) === 'offline',
    'refuses offline, and says why',
    await text(page, '[data-signout-failed]'),
  );
  check(
    (await page.evaluate(() => localStorage.getItem('satchess.identity'))) !== null,
    'and nothing changed on the phone',
  );
  await shot(page, '3-account-offline');

  step(4, 'Back online: the account screen, then sign out for real');
  await context.setOffline(false);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('[data-account]');
  // A field journal to be forgotten, as a signed-in phone would have one.
  await page.evaluate(() =>
    localStorage.setItem('satchess.field_sync', JSON.stringify({ acked: { f1: 1 }, removed: {} })),
  );
  await page.click('[data-account]');
  await page.waitForSelector('[data-signout]');
  const checkedOnline = await text(page, '[data-checked]');
  check(checkedOnline === 'Checked with the server just now.', 'checked just now', checkedOnline);
  const expiry = await text(page, '[data-expiry]');
  check(expiry.includes('never renewed'), 'a dev account says it is not renewed', expiry);
  await shot(page, '4-account-online');
  await Promise.all([page.waitForURL(`${ORIGIN}/**`), page.click('[data-signout]')]);
  await page.waitForSelector('[data-signin]', { timeout: 15_000 });
  check(true, 'the relaunch met a 401 and shows the gate');
  const after = await page.evaluate(() => ({
    identity: localStorage.getItem('satchess.identity'),
    journal: localStorage.getItem('satchess.field_sync'),
  }));
  check(after.identity === null, 'the identity is forgotten');
  check(
    after.journal !== null && JSON.stringify(JSON.parse(after.journal).acked) === '{}',
    'the field journal is emptied',
    String(after.journal),
  );
  check(new URL(page.url()).search === '?sim=1', 'the simulator survived the trip', page.url());
  const me = await context.request.get(`${ORIGIN}/api/me`);
  check(me.status() === 401, 'the server agrees: /api/me is 401', String(me.status()));
  await shot(page, '5-gate-after-signout');

  step(5, 'Signed out and offline: the app still opens (decision 0035, rule 2)');
  await context.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('[data-account-line]', { timeout: 15_000 });
  check((await page.$('[data-signin]')) === null, 'no gate without a 401');
  const unknownLine = await text(page, '[data-account-line]');
  check(unknownLine.includes('Sign-in not checked'), 'and no name it cannot vouch for', unknownLine);
  await shot(page, '6-home-offline-unknown');
  await context.close();

  step(6, 'A session ended elsewhere: the 401 launch forgets the account too (decision 0039)');
  // The other route to the gate. Not the account screen's button: the session
  // ends behind the app's back — another tab, or an expiry — and the next launch
  // meets a 401. Whoever signs in next must not inherit this account's journal.
  const elsewhere = await browser.newContext();
  await signIn(elsewhere, 'white-player', ORIGIN);
  const tab = await elsewhere.newPage();
  watch(tab, 'elsewhere');
  await tab.goto(BASE, { waitUntil: 'load' });
  await tab.waitForSelector('[data-account-line]');
  // Let the launch's own field sync finish, so it cannot rewrite what is seeded.
  await tab.waitForLoadState('networkidle');
  await tab.evaluate(() =>
    localStorage.setItem(
      'satchess.field_sync',
      JSON.stringify({ acked: { f1: 1, f2: 2 }, removed: { f3: 3 } }),
    ),
  );
  const ended = await elsewhere.request.post(`${ORIGIN}/api/signout`);
  check(ended.ok(), 'the session was ended outside the app', String(ended.status()));
  await tab.reload({ waitUntil: 'load' });
  await tab.waitForSelector('[data-signin]', { timeout: 15_000 });
  const forgotten = await tab.evaluate(() => ({
    identity: localStorage.getItem('satchess.identity'),
    journal: localStorage.getItem('satchess.field_sync'),
  }));
  check(forgotten.identity === null, 'the identity is forgotten on a 401');
  check(
    forgotten.journal !== null &&
      JSON.stringify(JSON.parse(forgotten.journal)) === '{"acked":{},"removed":{}}',
    'and the field journal is emptied',
    String(forgotten.journal),
  );
  await shot(tab, '7-gate-after-401');
  await elsewhere.close();

  step(7, 'Signed in as somebody else with no sign-out between (decision 0039)');
  // "Sign in again" can come back from Google's chooser as a different account.
  // Staged here as a phone that remembers alice, holds her journal, and then
  // launches confirmed as bob.
  const switched = await browser.newContext();
  await switched.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem(
      'satchess.identity',
      JSON.stringify({ sub: 'alice-player', via: 'dev', email: null, expiresAt: null, confirmedAt: 1 }),
    );
    localStorage.setItem(
      'satchess.field_sync',
      JSON.stringify({ acked: { f1: 1, f2: 2 }, removed: { f3: 3 } }),
    );
  });
  await signIn(switched, 'bob-player', ORIGIN);
  const bob = await switched.newPage();
  watch(bob, 'switched');
  // Read before the launch's own sync can rewrite the journal from the server.
  await switched.route('**/api/fields/sync', (route) => route.abort('failed'));
  await bob.goto(BASE, { waitUntil: 'load' });
  await bob.waitForSelector('[data-account-line]');
  const afterSwitch = await bob.evaluate(() => ({
    identity: JSON.parse(localStorage.getItem('satchess.identity') ?? 'null'),
    journal: localStorage.getItem('satchess.field_sync'),
  }));
  check(afterSwitch.identity?.sub === 'bob-player', 'the new account is remembered');
  check(
    afterSwitch.journal !== null &&
      JSON.stringify(JSON.parse(afterSwitch.journal)) === '{"acked":{},"removed":{}}',
    'and the old account’s field journal is emptied',
    String(afterSwitch.journal),
  );
  await switched.close();

  step(8, 'The pre-flight warning, with a connection (2.2.3)');
  // No service worker here, so the substituted answer cannot be bypassed by it.
  const warned = await browser.newContext({ serviceWorkers: 'block' });
  await signIn(warned, 'black-player', ORIGIN);
  await warned.route('**/api/me', async (route) => {
    const serverNow = Date.now() + 365 * DAY; // a server clock the phone does not share
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sub: '117554968855954827048',
        via: 'google',
        email: 'black@example.com',
        expiresAt: serverNow + 2 * DAY + 60 * 60 * 1000,
        serverNow,
      }),
    });
  });
  const phone = await warned.newPage();
  watch(phone, 'warned');
  await phone.goto(BASE, { waitUntil: 'load' });
  await phone.waitForSelector('[data-session-notice]');
  const notice = await text(phone, '[data-session-notice]');
  check(
    (await phone.getAttribute('[data-session-notice]', 'data-session-notice')) === 'warning',
    'a warning, not an error',
  );
  check(notice.includes('runs out in 2 days'), 'counted on the phone’s own clock', notice);
  const href = await phone.getAttribute('[data-signin-again]', 'href');
  check(href === '/auth/google/login?next=%2F%3Fsim%3D1', 'with a way to sign in again', String(href));
  check((await text(phone, '[data-account-line]')).includes('black@example.com'), 'home names the address');
  await shot(phone, '8-home-preflight');
  await phone.click('[data-account]');
  await phone.waitForSelector('[data-expiry]');
  const until = await text(phone, '[data-expiry]');
  check(/until [A-Z][a-z]+ \d+\./.test(until), 'the account screen gives a date', until);
  check((await phone.$('[data-session-notice]')) !== null, 'and repeats the warning');
  await shot(phone, '9-account-preflight');

  step(9, 'A month later, offline: the remembered session has lapsed');
  await phone.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('satchess.identity'));
    stored.expiresAt = Date.now() - 60 * 60 * 1000;
    localStorage.setItem('satchess.identity', JSON.stringify(stored));
  });
  await warned.unroute('**/api/me');
  await warned.route('**/api/me', (route) => route.abort('internetdisconnected'));
  await phone.reload({ waitUntil: 'load' });
  await phone.waitForSelector('[data-session-notice]');
  check((await phone.$('[data-signin]')) === null, 'still no gate');
  check(
    (await phone.getAttribute('[data-session-notice]', 'data-session-notice')) === 'notice',
    'a notice that it has probably run out',
    await text(phone, '[data-session-notice]'),
  );
  check((await phone.$('[data-signin-again]')) === null, 'with no link that needs a connection');
  await shot(phone, '10-home-lapsed-offline');
  await warned.close();
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nAll account checks passed.' : `\n${failures} check(s) FAILED.`);
console.log(`Screenshots in ${OUT}`);
process.exit(failures === 0 ? 0 : 1);
