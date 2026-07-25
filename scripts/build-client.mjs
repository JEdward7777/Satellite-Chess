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
 */

import { build, context } from 'esbuild';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const serve = args.has('--serve');
const dev = watch || serve;

/** @type {import('esbuild').BuildOptions} */
const options = {
  absWorkingDir: ROOT,
  entryPoints: ['src/client/main.ts'],
  outfile: 'public/app.js',
  bundle: true,
  format: 'esm',
  // Matches the tsconfig target. Every phone that can run a PWA has this.
  target: ['es2022'],
  // Kept even in production: a stack trace from someone's phone in a field is
  // the only debugging signal this project is ever going to get.
  sourcemap: true,
  minify: !dev,
  logLevel: 'info',
};

if (serve) {
  const ctx = await context(options);
  await ctx.watch();
  const { hosts, port } = await ctx.serve({ servedir: 'public', host: '127.0.0.1', port: 8788 });
  const origin = `http://${hosts[0] ?? '127.0.0.1'}:${port}`;
  console.log(`\n  serving  ${origin}/`);
  console.log(`  simulator  ${origin}/?sim=1\n`);
} else if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('  watching src/client/');
} else {
  await build(options);
}
