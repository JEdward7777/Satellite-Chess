# Resolved observations

Moved here once promoted to a stage, fixed, or dismissed. Keep the outcome — a
dismissed observation is as valuable as a fixed one, because it stops the next
session re-raising it.

### O-05 — `@cloudflare/workers-types` shadows DOM globals in client code
**Resolved:** 2026-07-25, stage 1.7 (decision 0021)
**Outcome:** Fixed. One `tsconfig.json` covering both halves is now four: a
`tsconfig.base.json` of shared settings that deliberately names no `lib` or `types`,
then `tsconfig.client.json` (DOM only, `types: []`), `tsconfig.worker.json`
(Workers only, no DOM) and `tsconfig.tools.json` (both, for tests and scripts). The
root is a solution file of references so an editor resolves each file to its owning
project. `npm run typecheck` runs the three with `-p`.

Verified by deleting the workaround rather than by asserting the fix: the
`appendChild`/`getElementsByTagName` dance in `views/sim-panel.ts` is now plain
`document.body.append(panel)` and compiles. A stray `document` in worker code is now
a compile error too, which is the half of the benefit the observation did not
anticipate.


### O-06 — Shell asset paths are relative, so deep links will break
**Resolved:** 2026-08-01, stage 6.0
**Outcome:** Fixed, and the observation understated it. Every `href`/`src` in
`index.html`, the manifest's `start_url` and `scope`, and the service worker's
precache list are now absolute; `navigator.serviceWorker.register('sw.js')` is now
`/sw.js`, which was the worst of the four — it resolves against the *document*, so
the phone that arrived by scanning a QR was exactly the one that would have ended
up with no offline shell, silently.

Two things the observation did not anticipate, both found by running it rather than
by reading it:

- **The Worker had to learn the routes at all.** `/j/CODE` was a 404 from the
  assets binding, so no amount of path-fixing would have helped. `src/shared/routes.ts`
  is now the one table the Worker and the client both read.
- **`env.ASSETS.fetch('/index.html')` answers with a 307 to `/`.** The assets
  binding's default `html_handling` strips `index.html`. A browser follows it, so a
  scanned invite would have landed on the home screen with the code gone from the
  URL — which reads as the client failing to parse the code, with nothing wrong in
  the Worker. `SELF.fetch` follows redirects too, so the first version of the test
  passed against the bug. The shell is now fetched and cached as `/`, and the test
  asserts `redirect: 'manual'`.

Verified in Chromium by `scripts/check-deeplink.mjs`: a cold `/j/ABC123` renders
with no request under `/j/`, and the same URL renders again with the network cut.
