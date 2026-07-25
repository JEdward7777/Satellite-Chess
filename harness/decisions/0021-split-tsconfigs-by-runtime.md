# 0021 — One tsconfig per runtime, not one for the repo

- **Date:** 2026-07-25
- **Status:** accepted
- **Stage:** 1.7
- **Resolves:** O-05

## Decision

Four configs instead of one:

| File | Globals | Covers |
|---|---|---|
| `tsconfig.base.json` | none named | shared settings only |
| `tsconfig.client.json` | DOM (`types: []`) | `src/client`, `src/shared` |
| `tsconfig.worker.json` | `@cloudflare/workers-types`, no DOM | `src/worker`, `src/shared` |
| `tsconfig.tools.json` | both, plus `node` | `test`, `scripts` |

`tsconfig.json` is a solution file containing only references, so an editor
resolves any file to the project that owns it. `npm run typecheck` invokes the
three with `-p` rather than `tsc --build`, because they are all `noEmit` and have
no outputs to sequence.

`src/shared` is deliberately compiled **twice**, once under each set of globals.
That is a feature: shared code runs in both places, so it must typecheck against
both, and anything reaching for a global that exists in only one runtime fails
where it should.

## Why

A single config loading `@cloudflare/workers-types` globally puts Workers globals
in scope for browser code, where several shadow their DOM namesakes. The symptoms
are worse than the cause: `document.body` types as the Fetch API's `Body`, and
`.append()` resolves to `HTMLRewriter`'s, whose parameter is
`string | ReadableStream | Response`. The compiler then reports a type error naming
`ReadableStream` about a line of ordinary DOM code, which reads as nonsense and
costs half an hour before you suspect the config rather than your own code.

The benefit the original observation did not anticipate is symmetric: with DOM
removed from the worker project, a stray `document` or `localStorage` in server
code is now a **compile error** rather than a crash in production. Given that this
project's whole architecture depends on the same `src/shared` modules running on
both sides, that guard is worth more than the confusion it removes.

Timing was deliberate. This was logged as O-05 during phase 1 and left alone while
`src/worker/` was empty, because half an hour of build plumbing would have
interrupted the work that proves the concept for no benefit. It is done now,
immediately before worker code starts existing, which is the point at which the
collision stops being merely confusing and starts risking code written against the
wrong type.

## Rejected

**Leaving it, and working around each collision.** What phase 1 did, with
`appendChild` and `getElementsByTagName` in `views/sim-panel.ts`. Rejected because
the workaround is invisible as a workaround — the next person hits a different
global and loses the same half hour. Reverting that line to
`document.body.append(panel)` is how the fix was verified.

**`skipLibCheck` or targeted `// @ts-expect-error`.** Suppresses the message
without fixing the wrong types being in scope, so the code still compiles against
`HTMLRewriter` and the mistake is merely silent.

**A single config with DOM only, casting in worker code.** Inverts the problem
onto the server, which is the half where a wrong global is a production incident
rather than a confusing message.

## Revisit if

A third runtime appears — a build-time renderer, or a native shell — in which case
it gets its own project rather than being folded into an existing one.
