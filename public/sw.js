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
      await cache.addAll(CRITICAL);
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

  event.respondWith(staleWhileRevalidate(request, request));
});

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
