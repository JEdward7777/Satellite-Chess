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

