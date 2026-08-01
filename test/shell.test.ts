import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The shell is served from three different paths — `/`, `/j/CODE` and
 * `/f/<blob>` — and one relative `src` is enough to make two of them fail
 * completely (O-06). Nothing in the type system or the build catches that: the
 * files are plain HTML, JSON and JS, and the failure only appears on a phone
 * that has just scanned a QR in a field.
 *
 * So these are string assertions over the real files, which is unglamorous but
 * is the only place the mistake can be caught before someone walks somewhere.
 */

const PUBLIC = join(import.meta.dirname, '..', 'public');
const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');

/** Every `href`/`src` attribute in the shell, in source order. */
function shellReferences(): string[] {
  const html = read('index.html');
  return [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
}

/**
 * The precache lists out of `sw.js`, read as source rather than imported.
 *
 * `SHELL` is spelled `/` in the worker because that is where the assets binding
 * serves the document; on disk it is `index.html`.
 */
function precacheList(name: 'CRITICAL' | 'OPTIONAL'): string[] {
  const sw = read('sw.js');
  const match = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(sw);
  expect(match, `${name} not found in sw.js`).not.toBeNull();
  return [...(match as RegExpExecArray)[1].matchAll(/'([^']+)'|\b(SHELL)\b/g)].map(
    (m) => m[1] ?? '/',
  );
}

/** What a served path is on disk. `/` is the shell. */
const onDisk = (path: string) => (path === '/' ? 'index.html' : path);

describe('the app shell loads from a deep link', () => {
  it('references every asset by an absolute path', () => {
    for (const ref of shellReferences()) {
      // A relative `app.js` resolves against the document, so at `/j/ABC123` the
      // browser asks for `/j/app.js` and the app never starts.
      expect(ref.startsWith('/'), `index.html references "${ref}" relatively`).toBe(true);
    }
  });

  it('references only assets that exist', () => {
    for (const ref of shellReferences()) {
      expect(existsSync(join(PUBLIC, ref)), `index.html references missing "${ref}"`).toBe(true);
    }
  });

  it('names a favicon, so the browser does not guess at /favicon.ico', () => {
    // Left implicit, every page load carries a 404 that shows up in the console
    // of anyone debugging something else.
    expect(shellReferences()).toContain('/icons/icon-192.png');
  });

  it('scopes the manifest to the origin, not to the document', () => {
    const manifest = JSON.parse(read('manifest.webmanifest')) as {
      start_url: string;
      scope: string;
      icons: { src: string }[];
    };
    // `"scope": "./"` resolved against `/j/CODE` would scope the installed app
    // to `/j/`, so the home-screen icon would launch into a stale invite.
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('/'), icon.src).toBe(true);
      expect(existsSync(join(PUBLIC, icon.src)), icon.src).toBe(true);
    }
  });
});

describe('the precache list agrees with what the shell needs', () => {
  const critical = precacheList('CRITICAL');
  const optional = precacheList('OPTIONAL');
  const precached = [...critical, ...optional];

  it('precaches only absolute paths', () => {
    for (const path of precached) {
      expect(path.startsWith('/'), path).toBe(true);
    }
  });

  it('precaches only files that exist', () => {
    for (const path of precached) {
      expect(existsSync(join(PUBLIC, onDisk(path))), `sw.js precaches missing "${path}"`).toBe(
        true,
      );
    }
  });

  it('precaches everything the shell references, and the shell itself', () => {
    // The whole point of the cache is that a cold launch with no signal works.
    // An asset the shell needs but the worker never cached turns "offline" into
    // a blank screen, which is indistinguishable from a crash.
    for (const ref of shellReferences()) {
      expect(precached, `sw.js does not precache "${ref}"`).toContain(ref);
    }
    expect(critical).toContain('/');
  });

  it('never precaches /index.html, which the assets binding answers with a 307', () => {
    // The obvious spelling, and it is a redirect rather than a document. Cached
    // under that key it would be a name the server disagrees with; fetched at
    // install time it is a redirect `cache.add` will not store.
    expect(precached).not.toContain('/index.html');
    expect(shellReferences()).not.toContain('/index.html');
  });

  it('treats the bundle and the shell as critical, and icons as optional', () => {
    // A missing icon must not cost the whole offline shell; a missing bundle
    // must fail the install rather than activate over a cache with no app in it.
    expect(critical).toEqual(['/', '/app.js', '/app.css']);
    for (const path of optional) {
      expect(path === '/manifest.webmanifest' || path.startsWith('/icons/'), path).toBe(true);
    }
  });

  it('answers navigations from the shell rather than from the navigated URL', () => {
    // `/j/ABC123` and `/` are the same document; caching one entry per scanned
    // code would fill the cache with copies and still miss the next code.
    expect(read('sw.js')).toContain('new Request(SHELL)');
  });

  it('never caches the API', () => {
    // A stale game state served from disk is worse than an honest network error.
    expect(read('sw.js')).toMatch(/pathname\.startsWith\('\/api\/'\)/);
  });
});
