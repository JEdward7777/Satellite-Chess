#!/usr/bin/env node
/**
 * Bundle the client into `public/`, which is what Wrangler serves as assets.
 *
 * No framework, on purpose. The whole client is a canvas, a few buttons and a
 * WebSocket; a framework would be more bytes over a phone's last bar of signal
 * than the thing it is bundling.
 *
 *   node scripts/build-client.mjs            one production build
 *   node scripts/build-client.mjs --watch    rebuild on change
 *   node scripts/build-client.mjs --serve    rebuild and serve public/ on :8788
 *
 * `--serve` exists because the client is worth running long before there is a
 * worker to serve it. `wrangler dev` needs `src/worker/index.ts`, which does not
 * exist until phase 3; a static server plus `?sim=1` exercises everything in
 * phase 1 without one. localhost counts as a secure context, so real geolocation
 * works there too.
 *
 * ## Each game's art is its own file (decision 0056)
 *
 * `app.js` holds everything every game shares. Each game's pieces and record
 * writer are built apart, as `public/games/<game>.js`, and fetched by
 * `src/client/games/registry.ts` with a dynamic `import()` only when that game
 * is on screen — the owner's rule that a phone must not download many engines.
 *
 * Two bundles rather than esbuild's code splitting, because splitting names
 * its shared chunks by content hash and `app.js` would import them statically:
 * the service worker, which is a static file, could not precache names it
 * cannot know, and a game opened offline would fail on a missing chunk. Here
 * each file has a fixed name the service worker precaches (`/games/chess.js`),
 * and whatever a game's file shares with `app.js` is a second, stateless copy
 * (`client/games/chess/index.ts` says so).
 *
 * The import in the registry is rewritten to `/games/<game>.js?v=<hash>`, a
 * hash of the file this build wrote, so a phone holding the new `app.js` never
 * runs the old art: the service worker answers a versioned request only with
 * that version, and falls back to the precached copy only when offline.
 *
 * Every build checks that `app.js` contains no game's art and that no client
 * file contains chess.js, and fails if one does.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { build, context } from 'esbuild';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const serve = args.has('--serve');
const dev = watch || serve;

/** Each game's art, by the name its file is served under. */
const GAMES = {
  chess: 'src/client/games/chess/index.ts',
};

/** The hash of each game file as last written, for the versioned import. */
const versions = {};

/** @type {import('esbuild').BuildOptions} */
const common = {
  absWorkingDir: ROOT,
  bundle: true,
  format: 'esm',
  // Matches the tsconfig target. Every phone that can run a PWA has this.
  target: ['es2022'],
  // Kept even in production: a stack trace from someone's phone in a field is
  // the only debugging signal this project is ever going to get.
  sourcemap: true,
  minify: !dev,
  logLevel: 'info',
  metafile: true,
};

/** Fail a build whose output holds what the phone must never download in it. */
function guard(name, metafile, forbidden) {
  for (const output of Object.values(metafile.outputs)) {
    for (const input of Object.keys(output.inputs)) {
      const hit = forbidden.find((pattern) => input.includes(pattern));
      if (hit !== undefined) {
        throw new Error(`${name} must not contain ${hit}, but bundles ${input}`);
      }
    }
  }
}

/** A game's art: one standalone file, hashed after it is written. */
function gameOptions(game) {
  const outfile = `public/games/${game}.js`;
  return {
    ...common,
    entryPoints: [GAMES[game]],
    outfile,
    plugins: [
      {
        name: 'game-version',
        setup(b) {
          b.onEnd((result) => {
            if (result.errors.length > 0 || !result.metafile) return;
            guard(`games/${game}.js`, result.metafile, ['node_modules/chess.js']);
            versions[game] = createHash('sha256')
              .update(readFileSync(join(ROOT, outfile)))
              .digest('hex')
              .slice(0, 12);
          });
        },
      },
    ],
  };
}

/** `app.js`, with each game's dynamic import pointed at that game's file. */
/** @type {import('esbuild').BuildOptions} */
const appOptions = {
  ...common,
  entryPoints: ['src/client/main.ts'],
  outfile: 'public/app.js',
  plugins: [
    {
      name: 'game-art',
      setup(b) {
        b.onResolve({ filter: /^\.\/[a-z]+\/index\.js$/ }, (args) => {
          if (args.kind !== 'dynamic-import' || !args.importer.endsWith(join('src', 'client', 'games', 'registry.ts'))) {
            return undefined;
          }
          const game = args.path.split('/')[1];
          if (!(game in GAMES)) throw new Error(`no game art is built for ${game}`);
          return { path: `/games/${game}.js?v=${versions[game] ?? 'dev'}`, external: true };
        });
        b.onEnd((result) => {
          if (result.errors.length > 0 || !result.metafile) return;
          guard('app.js', result.metafile, ['node_modules/chess.js', 'src/client/games/chess/']);
        });
      },
    },
  ],
};

if (serve || watch) {
  const app = await context(appOptions);
  // A game's file changing changes its hash, so `app.js` is rebuilt to ask for
  // the new one.
  for (const game of Object.keys(GAMES)) {
    const options = gameOptions(game);
    options.plugins.push({
      name: 'rebuild-app',
      setup(b) {
        b.onEnd(() => {
          void app.rebuild().catch(() => undefined);
        });
      },
    });
    const ctx = await context(options);
    await ctx.rebuild();
    await ctx.watch();
  }
  await app.rebuild();
  await app.watch();
  if (serve) {
    const { hosts, port } = await app.serve({ servedir: 'public', host: '127.0.0.1', port: 8788 });
    const origin = `http://${hosts[0] ?? '127.0.0.1'}:${port}`;
    console.log(`\n  serving  ${origin}/`);
    console.log(`  simulator  ${origin}/?sim=1\n`);
  } else {
    console.log('  watching src/client/');
  }
} else {
  // The games first: `app.js` names each by the hash of what was written.
  for (const game of Object.keys(GAMES)) await build(gameOptions(game));
  await build(appOptions);
}
