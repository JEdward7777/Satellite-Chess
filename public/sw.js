/**
 * Service worker: make the game start with no signal.
 *
 * The premise of this project is two people standing in a field, which is
 * exactly where a phone has one bar and a captive-portal wifi it half-joined on
 * the way in. So the shell is cached and served **cache-first**: a resumable
 * game is worth more than a perfectly fresh asset, and a network round trip
 * before the board appears is a round trip that can hang.
 *
 * Freshness comes from revalidating in the background — the cached copy is
 * served immediately, and the update lands in time for the next launch. That
 * costs one launch of staleness after a deploy, which is the right side of the
 * trade for a game played outdoors.
 *
 * Saved fields are not cached here. They live in IndexedDB (decision 0013),
 * which needs no help from a service worker to survive.
 *
 * Every path below is absolute (O-06). They used to be `./…`, which happened to
 * resolve correctly because this file sits at the root — but the shell it caches
 * is served at `/j/CODE` and `/f/<blob>` as well as at `/`, and there the
 * distinction stops being cosmetic. Absolute everywhere means the precache list
 * and the cache-first lookups cannot disagree about what a key is.
 */

// v2: v1's cached `index.html` referenced its assets relatively, so a deep link
// served from it would have asked for `/j/app.js`. That copy has to go rather
// than be revalidated, because stale-while-revalidate would serve the broken
// shell once — and once is the scan that fails in a field.
const CACHE = 'satchess-shell-v2';

/**
 * Where the shell actually lives, and therefore the one key every navigation is
 * answered from.
 *
 * Not `/index.html`. The Worker's assets binding strips `index.html` and answers
 * it with a 307 to `/`, so `/index.html` is a redirect rather than a document —
 * it cannot be precached, and caching the followed response under that key would
 * store the right bytes under a name the server disagrees with.
 */
const SHELL = '/';

/**
 * Without these there is no app, so `install` fails rather than half-succeeds.
 * A failed install leaves the previous worker and its cache in place, which is
 * strictly better than activating over a cache that is missing the bundle.
 */
const CRITICAL = [SHELL, '/app.js', '/app.css'];

/**
 * Each game's art (decision 0056), installed with the critical files and as
 * critically. `app.js` fetches a game's pieces only when that game is shown,
 * and a chess board opened on a field with no signal would otherwise have
 * none. A game added to `scripts/build-client.mjs` that should play offline
 * from the first launch is added here as well.
 */
const GAME_ART = ['/games/chess.js'];

/** Nice to have offline; a 404 on one of these must not cost us the whole shell. */
const OPTIONAL = [
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        OPTIONAL.map((url) => cache.add(url).catch(() => undefined)),
      );
      // All-or-nothing, and last, so a rejection here leaves nothing activated.
      await cache.addAll([...CRITICAL, ...GAME_ART]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Safe to prune unconditionally: activate only runs after install
      // resolved, so the new cache already holds everything critical.
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The API is never cached. A stale game state served from disk would be worse
  // than an honest network error, and `/api/…/ws` is not a GET we can answer.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  // Sign-in is a server round trip, not a screen (decision 0030). `/auth/…` are
  // full-page navigations to the Worker — one redirects to Google, the other is
  // where Google sends the browser back with a code — so the navigation rule
  // below would answer both from the cached shell and sign-in would silently do
  // nothing for every returning visitor. This is O-10 with teeth: there the
  // divergence was benign, here it breaks the only way into the app.
  //
  // Unlike narrowing the rule to `shared/routes.ts`, which this file cannot
  // import, a prefix is all that is needed — so there is nothing to duplicate
  // and nothing to keep in step.
  if (url.pathname === '/auth' || url.pathname.startsWith('/auth/')) return;

  // A navigation to *any* in-scope URL is answered by the shell, so a deep link
  // opened with no signal still starts the app. The cache key is the shell, not
  // the URL that was navigated to — `/j/ABC123` and `/` are the same document,
  // and keying by URL would fill the cache with one copy per scanned code and
  // still miss the next one.
  //
  // "Any" is broader than the Worker, which 404s a path that is not a route.
  // Once this worker is installed it decides, so a returning visitor gets the
  // shell at `/nonsense` where a first-time visitor gets a 404. Deliberate for
  // now: offline there is no way to tell a real code from a typo, and the app
  // saying so is friendlier than a browser error page. Narrowing it would mean
  // duplicating `shared/routes.ts` here, because this file is served raw and
  // cannot import. Logged as O-10.
  if (request.mode === 'navigate') {
    event.respondWith(staleWhileRevalidate(new Request(SHELL), request));
    return;
  }

  // A game's art (decision 0056), asked for by `app.js` as
  // `/games/<game>.js?v=<hash of the file it was built with>`.
  if (url.pathname.startsWith('/games/')) {
    event.respondWith(gameArt(request, url));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, request));
});

/**
 * A game's art: the exact version asked for, never another one while the
 * network can be reached.
 *
 * Stale-while-revalidate is wrong here. `app.js` names the version it was
 * built with, and an older file under the same name could be missing what the
 * newer `app.js` calls. So a versioned request is answered from the cache only
 * if that version is there, and otherwise from the network, which then
 * replaces every older copy of the file. Only when the network cannot be
 * reached is the latest copy held answered instead, whatever its version —
 * the precached one, on a first launch with no signal — because pieces from
 * the last deploy beat a board of blanks in a field.
 */
async function gameArt(request, url) {
  const cache = await caches.open(CACHE);
  const exact = await cache.match(request);
  if (exact) return exact;
  try {
    const response = await fetch(request);
    if (response.ok) {
      for (const key of await cache.keys()) {
        const held = new URL(key.url);
        if (held.pathname === url.pathname && held.search !== '' && held.search !== url.search) {
          await cache.delete(key);
        }
      }
      // Under the version, and under the plain name the precache uses, which
      // is the copy an offline request falls back to.
      await cache.put(request, response.clone());
      await cache.put(new Request(url.pathname), response.clone());
      return response;
    }
    // The server answered, but not with the file (a 404 mid-deploy, a 5xx):
    // the copy held beats an error page where a module should be.
    const held = await cache.match(url.pathname);
    return held ?? response;
  } catch {
    const latest = await cache.match(url.pathname);
    if (latest) return latest;
    return new Response('Offline, and this has not been cached yet.', {
      status: 503,
      headers: { 'content-type': 'text/plain' },
    });
  }
}

/**
 * Serve the cached copy at once, and quietly replace it for next time.
 *
 * `cacheKey` and `fetchRequest` differ for navigations, where any URL in scope
 * is answered from the one cached shell.
 */
async function staleWhileRevalidate(cacheKey, fetchRequest) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(cacheKey);

  const network = fetch(fetchRequest)
    .then((response) => {
      if (response.ok) void cache.put(cacheKey, response.clone());
      return response;
    })
    .catch(() => undefined);

  if (cached) return cached;

  const response = await network;
  if (response) return response;
  return new Response('Offline, and this has not been cached yet.', {
    status: 503,
    headers: { 'content-type': 'text/plain' },
  });
}
