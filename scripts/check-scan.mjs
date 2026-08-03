#!/usr/bin/env node
/**
 * Drive camera scanning (stage 6.2.3) and the advice that stands in for it
 * (6.2.4, decision 0026).
 *
 *     npm run build:client
 *     npx wrangler dev --port 8799 --local &
 *     npm install --no-save playwright              # deliberately not a dependency
 *     node scripts/check-scan.mjs
 *
 * The sixth browser driver, and the one with the most fakery in it — for reasons
 * worth stating, because the fakes are what make the checks meaningful rather
 * than what makes them weak:
 *
 * - **`BarcodeDetector` is injected.** Chromium on Linux does not ship it, so
 *   without an injected one this driver could only ever test the *unsupported*
 *   path. Injecting one lets the same binary rehearse an Android phone. What is
 *   faked is the platform API; everything on our side of it is real.
 * - **The camera is Chrome's own fake device**, which produces a genuine
 *   `MediaStream` with genuine `MediaStreamTrack`s. That matters for the check
 *   this driver exists for: a track's `readyState` really does go to `ended`
 *   only if something really did call `stop()`.
 *
 * ## What it checks
 *
 * 1. An iPhone is not offered a scanner it cannot have, and is told about the
 *    Camera app instead — the whole of decision 0026 in one screen.
 * 2. A browser that can scan gets the button, and the viewfinder shows live
 *    frames rather than a black box.
 * 3. A QR that is not ours does not read as a failure, and does not stop the
 *    scan — a camera swept across a park sees posters.
 * 4. Our QR joins the game, through the same path a typed code takes.
 * 5. **The camera is released**, on both ways out: taking a code, and Backing
 *    out of the screen. This is the one that cannot be caught by reading the
 *    code, and the one that leaves a lens on if it regresses.
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
const OUT = args.get('out') ?? mkdtempSync(join(tmpdir(), 'satchess-scan-'));

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
const M_PER_DEG_LAT = (6378137 * Math.PI) / 180;

function squareLatLng(file, rank) {
  return {
    lat: A1.lat + (rank * SQUARE_M) / M_PER_DEG_LAT,
    lng: A1.lng + (file * SQUARE_M) / (M_PER_DEG_LAT * Math.cos((A1.lat * Math.PI) / 180)),
  };
}

const FIELD = {
  id: 'creator-field',
  name: 'The common',
  a1: A1,
  h8: squareLatLng(7, 7),
  version: 1,
  createdAt: 0,
  updatedAt: 0,
};

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: [
    // A real MediaStream with no hardware and no permission prompt.
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});
const consoleErrors = [];

/**
 * A phone.
 *
 * `detector` decides what the injected `BarcodeDetector` claims to see:
 * `null` for a browser that has none at all (every iPhone), or a list of QR
 * payloads it returns, one per frame, repeating the last forever.
 */
async function newPhone(name, { fields = [], detector = null, userAgent } = {}) {
  const context = await browser.newContext({
    viewport: { width: 480, height: 900 },
    permissions: ['camera'],
    ...(userAgent ? { userAgent } : {}),
  });
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`[${name}] ${m.text()}`));
  page.on('pageerror', (e) => consoleErrors.push(`[${name}] ${e}`));

  await page.addInitScript(
    ({ seeded, playerId, payloads }) => {
      localStorage.setItem('satchess.player_id', playerId);

      // Every track handed to the app, kept so the driver can ask afterwards
      // whether it was ever stopped. `readyState` is the browser's own answer.
      const probe = { tracks: [], frames: 0 };
      globalThis.__scan = probe;
      const realGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await realGum(constraints);
        probe.tracks.push(...stream.getTracks());
        return stream;
      };

      if (payloads === null) {
        // The iPhone case: make sure the absence is deterministic rather than a
        // property of whichever Chromium build is on this machine.
        delete globalThis.BarcodeDetector;
      } else {
        globalThis.BarcodeDetector = class {
          static async getSupportedFormats() {
            return ['qr_code', 'ean_13'];
          }
          async detect() {
            const value = payloads[Math.min(probe.frames, payloads.length - 1)];
            probe.frames += 1;
            return value === null ? [] : [{ rawValue: value }];
          }
        };
      }

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
    { seeded: fields, playerId: `sim-scan-${name}`, payloads: detector },
  );
  return { name, context, page };
}

/** Every camera track this page was ever handed, and whether it is still live. */
const trackStates = (page) =>
  page.evaluate(() => (globalThis.__scan?.tracks ?? []).map((t) => t.readyState));

try {
  console.log(`screenshots -> ${OUT}`);

  console.log('\n1. The creator makes a game to be scanned into');
  const creator = await newPhone('creator', { fields: [FIELD] });
  await creator.page.goto(`${ORIGIN}/?sim=1`, { waitUntil: 'domcontentloaded' });
  await creator.page.waitForSelector('[data-new]', { timeout: 15_000 });
  await creator.page.click('[data-new]');
  await creator.page.waitForSelector('[data-create]', { timeout: 15_000 });
  await creator.page.click('[data-create]');
  await creator.page.waitForSelector('[data-join-code]', { timeout: 15_000 });
  const code = await creator.page.getAttribute('[data-join-code]', 'data-join-code');
  console.log(`   join code ${code}`);
  check(/^[0-9A-Z]{6}$/.test(code ?? ''), 'a six-character code to aim at', code ?? '(none)');
  await creator.page.click('[data-open]');
  await creator.page.waitForSelector('[data-board]', { timeout: 15_000 });

  const inviteUrl = `${ORIGIN}/j/${code}`;

  console.log('\n2. An iPhone, which cannot scan and never will');
  const iphone = await newPhone('iphone', { detector: null, userAgent: IPHONE_UA });
  await iphone.page.goto(`${ORIGIN}/?sim=1`, { waitUntil: 'domcontentloaded' });
  await iphone.page.waitForSelector('[data-join]', { timeout: 15_000 });
  check(
    !(await iphone.page.isVisible('[data-scan]')),
    'is not offered a scanner it cannot have',
  );
  check(await iphone.page.isVisible('[data-scan-advice]'), 'is told what to do instead');
  const advice = (await iphone.page.textContent('[data-scan-advice]')) ?? '';
  check(/Camera app/.test(advice), 'and the advice names the Camera app', advice.slice(0, 60));
  check(await iphone.page.isVisible('[data-code]'), 'with the typed code still on screen');
  await iphone.page.screenshot({ path: `${OUT}/1-iphone-advice.png`, fullPage: true });

  console.log('\n3. A browser that can scan gets a viewfinder');
  const poster = await newPhone('poster', {
    // Nothing but other people's QR codes, forever.
    detector: ['https://example.com/menu', 'WIFI:S:TheCommon;T:WPA;P:hunter2;;'],
  });
  await poster.page.goto(`${ORIGIN}/?sim=1`, { waitUntil: 'domcontentloaded' });
  await poster.page.waitForSelector('[data-scan]', { timeout: 15_000 });
  check(true, 'the Scan button is offered');
  check(
    !(await poster.page.isVisible('[data-scan-advice]')),
    'and the fallback advice is not, since it would be noise',
  );
  await poster.page.click('[data-scan]');
  await poster.page.waitForSelector('[data-video]', { timeout: 15_000 });
  // A black box is what a broken viewfinder looks like, and in a screenshot it
  // looks much like a working one — Chrome's fake camera is a *dark* pattern, so
  // the first version of this screenshot read as broken and was not.
  //
  // `videoWidth > 0` is not enough either: it says the stream has dimensions,
  // not that anything is being painted. So read the pixels, as `drive-game.mjs`
  // does for the opponent's dot. A camera showing nothing has no variance.
  const live = await poster.page
    .waitForFunction(
      () => {
        const v = document.querySelector('[data-video]');
        if (!(v instanceof HTMLVideoElement) || v.videoWidth === 0 || v.paused) return false;
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        if (ctx === null) return false;
        ctx.drawImage(v, 0, 0, 64, 64);
        const { data } = ctx.getImageData(0, 0, 64, 64);
        let min = 255;
        let max = 0;
        for (let i = 0; i < data.length; i += 4) {
          const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
          if (lum < min) min = lum;
          if (lum > max) max = lum;
        }
        return max - min > 10;
      },
      undefined,
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false);
  check(live, 'the viewfinder is painting real frames, not a black box');
  await poster.page.screenshot({ path: `${OUT}/2-viewfinder.png`, fullPage: true });

  console.log('\n4. A QR that is not ours');
  const sawForeign = await poster.page
    .waitForFunction(
      () => /not an invitation/i.test(document.querySelector('[data-status]')?.textContent ?? ''),
      undefined,
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false);
  check(sawForeign, 'says so, in as many words');
  const status = (await poster.page.textContent('[data-status]')) ?? '';
  check(!/blocked|failed|error/i.test(status), 'and does not read as a failure', status.slice(0, 60));
  check(await poster.page.isVisible('[data-video]'), 'and keeps scanning');

  console.log('\n5. Backing out releases the camera');
  await poster.page.click('[data-cancel]');
  await poster.page.waitForSelector('[data-join]', { timeout: 15_000 });
  const afterCancel = await trackStates(poster.page);
  check(afterCancel.length > 0, 'the camera really was opened', JSON.stringify(afterCancel));
  check(
    afterCancel.every((s) => s === 'ended'),
    'and every track is stopped on the way out',
    JSON.stringify(afterCancel),
  );

  console.log('\n6. Our QR joins the game');
  const scanner = await newPhone('scanner', {
    // One poster first, so this also proves the scan survives a miss.
    detector: ['https://example.com/menu', inviteUrl],
  });
  await scanner.page.goto(`${ORIGIN}/?sim=1`, { waitUntil: 'domcontentloaded' });
  await scanner.page.waitForSelector('[data-scan]', { timeout: 15_000 });
  await scanner.page.click('[data-scan]');
  await scanner.page.waitForSelector('[data-board]', { timeout: 20_000 });
  check(true, 'scanning the invite lands on the board');
  check(
    (await scanner.page.evaluate(() => location.pathname)) === `/j/${code}`,
    'and the game is in the address bar, so a reload resumes',
    await scanner.page.evaluate(() => location.pathname),
  );
  const afterJoin = await trackStates(scanner.page);
  check(
    afterJoin.length > 0 && afterJoin.every((s) => s === 'ended'),
    'and the camera is off by the time the board is up',
    JSON.stringify(afterJoin),
  );
  await scanner.page.screenshot({ path: `${OUT}/3-joined-by-scan.png`, fullPage: true });

  console.log('\n7. Nothing threw');
  check(consoleErrors.length === 0, 'no console errors', consoleErrors.join(' | ').slice(0, 200));
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? 'all good' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
