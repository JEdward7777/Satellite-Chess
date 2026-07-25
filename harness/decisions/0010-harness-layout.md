# 0010 — Harness layout and dotted stage numbering

- **Date:** 2026-07-25
- **Status:** accepted
- **Stage:** 0.9

## Decision

Development state lives in `harness/`, so that a fresh thread — of any assistant —
can pick up from files alone. Structure:

| Path | Role |
|---|---|
| `harness/AGENTS.md` | The working agreement. The single copy of the rules. |
| `harness/STATE.md` | Where the project is right now. Short; rewritten each session. |
| `harness/plan/` | The stage tree, one file per top-level phase. Source of truth for status. |
| `harness/decisions/` | Append-only, one numbered file per decision. |
| `harness/observations/` | Real problems, spotted but not yet scoped into a stage. |
| `harness/sessions/` | One file per session: what was done, learned, and left. |
| `harness/reference/` | Durable technical facts — brief, protocol, budget, verified platform. |

Root `CLAUDE.md` and root `AGENTS.md` are thin pointers to `harness/AGENTS.md`, so
Claude Code, Codex, Cursor and anything else follow one set of rules with one copy
to keep current.

Stages are dotted decimals of arbitrary depth (`3`, `3.2`, `3.2.4`), parsed from
one canonical line format. `npm run plan` prints the tree with statuses;
`npm run plan:check` validates numbering, parentage and status consistency.

Anything that will grow without bound is a folder, not a file.

## Why

The container is ephemeral and threads are finite. Without durable state, every new
thread either re-derives decisions already made or, worse, quietly reverses them —
and the most valuable artefact of a session, the dead ends, is exactly what a
summary loses first.

Splitting by *kind of information* rather than by topic matters because the kinds
have different lifecycles. Decisions are append-only and permanent. State is
rewritten constantly. Session files are immutable once written. Observations churn.
Putting them in one file guarantees that the permanent things get edited by
accident.

Dotted decimals of arbitrary depth mean a phase can be subdivided as finely as the
work demands without renumbering siblings, so a stage id stays a stable reference
in a commit message or a decision file. Markdown stays the source of truth — a
generated file that can drift from a database is worse than a file a human can fix
in place — but the line format is strict enough to parse, which is what makes a
status rollup possible without a second system.

The per-thread task list that assistants have natively is ephemeral; it dies with
the conversation. The plan files are the durable equivalent, and each session loads
them into the ephemeral list rather than the other way round.

## Rejected

**A single large `CLAUDE.md` holding everything.** Simplest, impossible to have go
out of sync — and it grows past the point of being read, every session rewrites the
same file, and permanent content sits one careless edit away from the volatile kind.

**GitHub issues as the state store.** Survives outside the repo and is pleasant on a
phone. Rejected: a new thread needs a network round-trip to orient, and it is
invisible when working offline or from a fresh clone.

**A machine-readable plan file (YAML/JSON) with generated Markdown.** Cleaner to
parse. Rejected: two representations drift, and the human-editable one has to win.

## Revisit if

A plan or reference file grows long enough to be annoying, in which case split it
into a folder with an index — the rule already anticipates this and requires it.
