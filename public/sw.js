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
 */

const CACHE = 'satchess-shell-v1';

const SHELL = [
  './',
  './index.html',
  './app.js',
  './app.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Individually, so one 404 on an icon cannot fail the whole install and
      // leave the game with no offline shell at all.
      await Promise.all(
        SHELL.map((url) => cache.add(url).catch(() => undefined)),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
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

  // A navigation to any in-scope URL is answered by the shell, so a deep link
  // opened with no signal still starts the app.
  if (request.mode === 'navigate') {
    event.respondWith(staleWhileRevalidate(new Request('./index.html'), request));
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
