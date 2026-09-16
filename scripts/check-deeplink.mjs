#!/usr/bin/env node
/**
 * Prove that the app shell loads from a deep link, online and offline (O-06).
 *
 * The counterpart to `drive-game.mjs`: that one asks "does the game look right",
 * this one asks "does the app start at all when the browser arrived at
 * `/j/ABC123` instead of `/`". Neither question can be answered by a unit test —
 * relative asset resolution, service worker scope and offline navigation are all
 * browser behaviours, and all three fail *silently*. A phone that scanned a QR
 * and got a blank screen produces no error anyone will ever see.
 *
 * ## Running it
 *
 *     npm run build:client
 *     npx wrangler dev --port 8799 --var DEV_AUTH_SECRET:local-dev-secret &
 *     npm install --no-save playwright     # deliberately not a dependency
 *     node scripts/check-deeplink.mjs
 *
 * ## What it checks, and why each one bit
 *
 * 1. **A cold deep link renders.** `<script src="app.js">` at `/j/ABC123`
 *    resolves to `/j/app.js`. Nothing throws; the document just has no script.
 * 2. **No request goes to a path under `/j/`.** The symptom above, stated as the
 *    cause, so a regression names itself instead of showing a blank page.
 * 3. **The service worker registers from a deep link.** `register('sw.js')`
 *    resolves against the document too, so the phone most likely to be offline
 *    is the one that would end up with no offline shell.
 * 4. **The deep link still starts with the network cut.** This is the whole
 *    reason the service worker exists, and it is the case that was never once
 *    exercised: 1.5.2 verified offline from `/`.
 * 5. **No console errors and no 404s**, including the `/favicon.ico` guess that
 *    has been in every driver run since phase 1.
 * 6. **The service worker keeps its hands off `/auth/`.** Sign-in is a server
 *    route reached by a full-page navigation (stage 2.1), and the navigation
 *    rule in `sw.js` was broad enough to answer it from the cache — which would
 *    have broken the only way into the app, silently, for every returning
 *    visitor. Added after finding exactly that, unshipped, on 2026-09-16.
 *
 * Since stage 6.2.1 the client *reads* the path rather than merely loading at it,
 * so the well-formed-but-imaginary code below is now asked about: the app
 * requests `/api/game/ABC123`, is told there is no such game, and says so. The
 * resulting 404 is the app working, not a fault, and the checks below say which
 * ones are expected — a shell test that forbade all 404s would fail on the
 * feature it exists to support. `check-join.mjs` drives joining properly, with
 * games that exist; this file still only asks whether the app starts.
 */

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

import { isRealConsoleError } from './driver-console.mjs';
import { signIn } from './driver-signin.mjs';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);
const ORIGIN = args.get('origin') ?? 'http://127.0.0.1:8799';
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-deeplink-'));

/** A code that is well-formed but has no game behind it — this is a shell test. */
const DEEP = `${ORIGIN}/j/ABC123?sim=1`;

/** See `drive-game.mjs`: the bundled browser revision is usually not the one on disk. */
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

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ''}`);
};

/** Attach the listeners that turn a silent failure into a named one. */
function watch(page) {
  const log = { errors: [], notFound: [], requests: [] };
  page.on('console', (msg) => {
    if (isRealConsoleError(msg)) log.errors.push(msg.text());
  });
  page.on('pageerror', (error) => log.errors.push(String(error)));
  page.on('request', (req) => log.requests.push(new URL(req.url()).pathname));
  page.on('response', (res) => {
    if (res.status() === 404) log.notFound.push(new URL(res.url()).pathname);
  });
  page.on('requestfailed', (req) => {
    // Offline runs fail requests by design; the assertion is about the screen,
    // not about the network, so these are recorded rather than counted.
    log.requests.push(`${new URL(req.url()).pathname} (failed)`);
  });
  return log;
}

/**
 * The console errors that are the *app's*.
 *
 * Chromium logs every non-2xx and every failed fetch as a console error, and
 * both are provoked on purpose here: the code in the test URL names no game, and
 * the offline run has no network by definition. Those are checked directly
 * above; what is left is what nobody meant to happen.
 */
function appErrors(log) {
  return log.errors.filter((e) => !/Failed to load resource/.test(e));
}

/** Did `app.js` actually run? The shell's `#app` is empty until it does. */
async function appBooted(page) {
  await page.waitForFunction(() => document.querySelector('#app')?.children.length > 0, {
    timeout: 10_000,
  });
  return page.textContent('#app');
}

const browser = await chromium.launch({ executablePath: findChromium() });
const context = await browser.newContext({ permissions: ['geolocation'] });
// One context, shared by every page below, so one sign-in covers all of them.
//
// This driver is also the one that exercises the gate's offline rule for free:
// the "dark" page below reloads a deep link with the network cut, so `/api/me`
// throws rather than answering. That must open the app anyway — a phone in a
// field with a fortnight-old session being shown a sign-in screen it cannot
// complete is the failure the three-state design in `client/session.ts` exists
// to prevent, and this is where it would show up.
await signIn(context, 'sim-deeplink', ORIGIN);

try {
  // ---------------------------------------------------------------------
  // 1. A normal visit, so the service worker installs and precaches.
  // ---------------------------------------------------------------------
  console.log('\nroot visit, to install the service worker');
  const root = await context.newPage();
  const rootLog = watch(root);
  await root.goto(`${ORIGIN}/?sim=1`, { waitUntil: 'load' });
  await appBooted(root);

  const cached = await root.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    // `ready` resolves on activation; the precache finished during install.
    const names = await caches.keys();
    const cache = await caches.open(names[0]);
    return {
      scope: registration.scope,
      cacheName: names[0],
      keys: (await cache.keys()).map((r) => new URL(r.url).pathname).sort(),
    };
  });
  check(cached.scope === `${ORIGIN}/`, 'service worker scope is the origin', cached.scope);
  // `/`, not `/index.html`: the assets binding answers `/index.html` with a 307,
  // which is not a document and not something `cache.add` will store.
  for (const needed of ['/', '/app.js', '/app.css']) {
    check(cached.keys.includes(needed), `precached ${needed}`, cached.keys.join(' '));
  }
  check(rootLog.notFound.length === 0, 'no 404s on the root visit', rootLog.notFound.join(', '));
  check(rootLog.errors.length === 0, 'no console errors on the root visit', rootLog.errors.join(' | '));
  await root.screenshot({ path: join(OUT, '1-root.png'), fullPage: true });

  // ---------------------------------------------------------------------
  // 2. The deep link, online.
  // ---------------------------------------------------------------------
  console.log('\ndeep link, online');
  const deep = await context.newPage();
  const deepLog = watch(deep);
  const response = await deep.goto(DEEP, { waitUntil: 'load' });
  check(response.status() === 200, 'deep link returns 200', String(response.status()));
  const text = await appBooted(deep);
  check(Boolean(text?.trim()), 'the app rendered from the deep link');

  const underJ = deepLog.requests.filter((p) => p.startsWith('/j/') && p !== '/j/ABC123');
  check(underJ.length === 0, 'no asset resolved against /j/', underJ.join(', '));

  // The code in the URL is now acted on rather than ignored (6.2.1). Asking about
  // it is the feature; the 404 that comes back is the expected answer for a code
  // no game was ever created with, so only *other* 404s are faults.
  check(
    deepLog.requests.includes('/j/ABC123') && deepLog.requests.includes('/api/game/ABC123'),
    'the client asked the server about the code in the path',
    deepLog.requests.join(', '),
  );
  check(
    (await deep.getAttribute('[data-reason]', 'data-reason')) === 'not_found',
    'and says there is no such game, rather than showing an empty screen',
  );
  const unexpected404 = deepLog.notFound.filter((p) => p !== '/api/game/ABC123');
  check(unexpected404.length === 0, 'no unexpected 404s from the deep link', unexpected404.join(', '));
  check(
    appErrors(deepLog).length === 0,
    'no console errors from the deep link',
    appErrors(deepLog).join(' | '),
  );

  const deepSw = await deep.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    return registration ? registration.scope : null;
  });
  check(deepSw === `${ORIGIN}/`, 'the deep link is controlled by the root worker', String(deepSw));
  await deep.screenshot({ path: join(OUT, '2-deeplink-online.png'), fullPage: true });

  // ---------------------------------------------------------------------
  // 3. The deep link, offline. The point of the whole exercise.
  // ---------------------------------------------------------------------
  console.log('\ndeep link, offline');
  await context.setOffline(true);
  const dark = await context.newPage();
  const darkLog = watch(dark);
  const darkResponse = await dark.goto(DEEP, { waitUntil: 'load' });
  check(darkResponse !== null && darkResponse.status() === 200, 'offline deep link is served');
  const darkText = await appBooted(dark);
  check(Boolean(darkText?.trim()), 'the app rendered from the deep link with no network');
  // The shell comes out of the cache; the join cannot. Saying so is the whole
  // difference between "no signal" and a phone that appears to have broken.
  await dark.waitForSelector('[data-reason]', { timeout: 15_000 }).catch(() => undefined);
  check(
    (await dark.getAttribute('[data-reason]', 'data-reason')) === 'offline',
    'and blames the network rather than the code',
  );
  check(appErrors(darkLog).length === 0, 'no console errors offline', appErrors(darkLog).join(' | '));
  await dark.screenshot({ path: join(OUT, '3-deeplink-offline.png'), fullPage: true });

  // ---------------------------------------------------------------------
  // 4. What the *server* says, with no service worker in the way.
  // ---------------------------------------------------------------------
  //
  // This needs a fresh context. Once the worker is installed it answers every
  // navigation from the shell, so asking the first context about `/nonsense`
  // measures the service worker's policy (O-10) rather than the Worker's route
  // table, and the honest 404 is invisible.
  console.log('\nfirst-time visitor, no service worker');
  await context.setOffline(false);
  // `context.request` does not go through a service worker, which is precisely
  // what makes it the right instrument here. A `page.goto` to a 404 also throws
  // in Chromium when the body is empty, which this sidesteps.
  for (const [path, want] of [
    ['/nonsense', 404],
    ['/j/SHORT', 404],
    ['/j/ABC123', 200],
    ['/index.html', 200], // followed from the 307; the point is that we never ask for it
  ]) {
    const res = await context.request.get(`${ORIGIN}${path}`);
    check(res.status() === want, `${path} → ${want} from the server`, String(res.status()));
  }

  // And the known divergence, asserted rather than left to be rediscovered.
  const returning = await context.newPage();
  const viaSw = await returning.goto(`${ORIGIN}/nonsense`, { waitUntil: 'domcontentloaded' });
  check(
    viaSw.status() === 200,
    'a returning visitor gets the shell at an unknown path (O-10)',
    String(viaSw.status()),
  );

  // The one place that divergence must NOT happen (stage 2.1).
  //
  // Sign-in is a server route reached by a full-page navigation, so the service
  // worker has to stay out of its way — and its navigation rule is broad enough
  // to have swallowed it. If this regresses, tapping "Sign in" shows the cached
  // app shell, the redirect to Google never happens, and there is no error
  // anywhere: the only way into the app fails silently for every returning
  // visitor, which is precisely the class of bug this driver exists to catch.
  //
  // Locally there is no `GOOGLE_CLIENT_SECRET` (decision 0034), so the honest
  // answer from the Worker is a 503. That is the assertion: any 200 of HTML here
  // means the service worker answered instead.
  const signIn = await returning.goto(`${ORIGIN}/auth/google/login`, {
    waitUntil: 'domcontentloaded',
  });
  check(
    signIn.status() === 503 && (signIn.headers()['content-type'] ?? '').includes('json'),
    'the service worker does not answer /auth/ navigations (O-10)',
    `${signIn.status()} ${signIn.headers()['content-type'] ?? ''}`,
  );
} finally {
  await browser.close();
}

console.log(`\nscreenshots in ${OUT}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('all checks passed');
