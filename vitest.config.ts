import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

/**
 * Two test projects, because this codebase has two runtimes.
 *
 * - **model** runs in node. The pure, platform-independent logic in
 *   `src/shared/` and the model halves of the client views. Fast, and the
 *   overwhelming majority of the suite.
 * - **worker** runs inside the real `workerd` runtime via Miniflare, with the
 *   actual bindings from `wrangler.jsonc`. Durable Objects, SQLite storage,
 *   hibernating WebSockets and alarms cannot be faked convincingly — the whole
 *   point of testing them is that the runtime behaves in ways a mock would not,
 *   which is what `harness/reference/platform-verified.md` records.
 *
 * Client DOM code is verified by driving Chromium against `?sim=1`, not here.
 * Every view bug in phase 1 was invisible to unit tests and obvious in a
 * screenshot.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'model',
          include: ['test/**/*.test.ts'],
          exclude: ['test/worker/**'],
          environment: 'node',
        },
      },
      {
        plugins: [
          cloudflareTest({
            // Running the real entrypoint means `SELF` and the Durable Object
            // bindings are the same module instance the tests import, so a test
            // exercises the code that actually deploys.
            main: './src/worker/index.ts',
            wrangler: { configPath: './wrangler.jsonc' },
          }),
        ],
        test: {
          name: 'worker',
          include: ['test/worker/**/*.test.ts'],
        },
      },
    ],
  },
});
