# harness/

Development state for Satellite-Chess, kept in files so that any thread — of any
assistant — can pick up where the last one stopped. The container is ephemeral;
this folder is the memory.

**Start with [`AGENTS.md`](AGENTS.md).** It is the working agreement, and it is
short.

| Path | What it holds | Lifecycle |
|---|---|---|
| [`AGENTS.md`](AGENTS.md) | The rules every assistant follows | Edited rarely, deliberately |
| [`STATE.md`](STATE.md) | Where the project is right now | Rewritten every session |
| [`plan/`](plan/) | The stage tree — source of truth for what is done | Statuses updated constantly |
| [`decisions/`](decisions/) | Numbered decision records | Append-only, never edited |
| [`observations/`](observations/) | Real problems, not yet scoped into a stage | Churns |
| [`sessions/`](sessions/) | One file per session: done, learned, left | Immutable once written |
| [`reference/`](reference/) | Durable technical facts | Grows slowly |

Root `CLAUDE.md` and root `AGENTS.md` are thin pointers to `AGENTS.md` here, so
there is exactly one copy of the rules to keep current.

## Why it is split this way

The kinds of information have different lifecycles, and mixing them means the
permanent things get edited by accident. Decisions are append-only and outlive
everything. State is rewritten constantly. Session files are immutable the moment
they are written. Observations churn. See
[`decisions/0010-harness-layout.md`](decisions/0010-harness-layout.md).

Anything that will grow without bound is a folder, not a file. If a plan or
reference file gets long enough to be annoying, split it into a folder with a
`README.md` index.

## Tools

```bash
npm run plan         # the stage tree with statuses and a rollup
npm run plan:check   # validate numbering, parentage, status consistency
```
