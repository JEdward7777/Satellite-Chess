# The pipeline

**Opt-in. This is not how work is normally done here.** It exists so that when the
operator says *"run the pipeline"*, or *"do these phases pipeline-style"*, or names
this file, an assistant knows exactly what is being asked for without being told
again. Nothing else in the harness depends on it. A session that is never asked for
the pipeline should follow `AGENTS.md` and ignore this file.

Written up on 2026-09-23, after the run described in
[`../sessions/2026-09-23-01.md`](../sessions/2026-09-23-01.md). First asked for on
2026-09-17.

## What it is

The operator names a batch of work — or asks for a batch to be chosen — and then
goes away. The session drives it to completion without waking them, using
subagents, and does not ask permission for judgement calls it can make itself.

```
for each phase, one at a time:
    launch a subagent to implement it
    loop:
        launch a NEW subagent to review the uncommitted diff
        if the review lists must-fix items:
            send them back to the SAME implementer, which keeps its context
        else:
            break
    tell the implementer to FINALIZE: session file, STATE.md, plan statuses,
    observations, then commit and push
```

## The rules that make it work

**One agent touches the tree at a time.** Every session on this machine shares one
working copy (`container.md`). Two implementers in parallel would edit each other's
files. Phases are sequential; only the operator's own session and the running
subagent are ever live.

**A new reviewer every round.** A reviewer that has already blessed a diff is the
wrong one to ask again. Fresh context each time, with the earlier rounds' findings
passed in as background so it does not re-derive them.

**The same implementer for fixes.** It holds the reasoning behind the code, so a
fix costs a message rather than a re-read. Address it by its agent name.

**A reviewer must end with a verdict line** — `VERDICT: CLEAN` or `VERDICT: FIX`
followed by numbered must-fix items, each with file:line, a concrete failure
scenario, and a suggested fix. Optional nits go in a separate section and are *not*
fed back automatically; the loop needs a definite stopping point or it runs forever
on style. Pick from the optional list deliberately, and say why.

**Reviewers run things, they do not only read.** This is the single highest-value
rule. Every finding that mattered in the first run came from a reviewer that
started its own `wrangler dev`, ran the browser driver, ran the flaky file five
times, or re-measured a number the docs asserted. Tell each reviewer to run
`npm run check` and the relevant driver *itself*, on its own port with an empty
`--persist-to`, and never to trust the implementer's report of a green run.
**The `--persist-to` directory must be new and uniquely named for each server
start** (e.g. `persist-r3-review`), never a reused one: a scratchpad is shared
across rounds, old persist directories accumulate in it, and a driver run
against one of them fails in exactly the O-19 way — phantom regressions in
drivers nothing touched.

**Nothing is committed until a review comes back clean.** The implementer holds the
diff uncommitted across every round. `FINALIZE` is a separate instruction and is
the only point at which the session file, `STATE.md`, plan statuses, observations
and the push happen. Keeping the harness bookkeeping out of the review rounds stops
reviewers flagging a `STATE.md` that is deliberately stale.

**Judgement calls get a second opinion first.** When a call is the operator's to
make and they are asleep — is this optional item worth doing, which of three
migrations is honest, is this loop going nowhere — launch one more subagent for an
independent read *before* deciding. In the first run this changed three decisions
and caught one trap that would have shipped a worse bug than the one being fixed.
A cheap model is fine for these; give it the options and a word limit.

**No round cap in practice.** The first run took two, three and four rounds for its
three finished phases, and the fourth round of phase 3 was the one that produced the
measurement that mattered. Stop when a review is clean, not when a counter runs out
— but if rounds start repeating themselves rather than converging, take a second
opinion on whether to stop.

## What to put in a subagent prompt

Subagents start cold. Each prompt carries, at minimum:

- **Read first**: `harness/AGENTS.md`, `STATE.md`, the newest session file,
  `gotchas.md`, `container.md`, and the decisions and observations that bear on the
  stage.
- **The stage numbers**, and what is explicitly *out* of scope.
- **The platform rules** that a cold agent will otherwise break: hibernation safety
  and no `setTimeout`, no new inbound WebSocket traffic, the KV and request budgets,
  American English in player-facing text, metric units.
- **How to verify**: `npm run check`, `npm test` twice, the browser drivers with
  `PLAYWRIGHT_BROWSERS_PATH=~/.cache/satellite-chess/playwright`, its own
  `wrangler dev` on an unused port with a distinct inspector port and an empty
  `--persist-to` in its scratchpad (O-19), and O-24 on `--base` parsing.
- **Do not commit yet**, and what `FINALIZE` will mean when it comes.
- **Never move `HEAD`, stash, reset or clean** — the tree is shared.
- **The operator is asleep; make the call yourself and never stop to ask.**
- **The next free observation number**, so parallel additions do not collide. The
  operator adds observations to `open.md` while phases run; tell the implementer
  where to start numbering, and re-tell it if the number moves.

## Reporting back

The operator reads a terminal, often on a phone, often at a glance. Relay what a
review found in plain terms — what would have gone wrong for a player, not which
function changed. Say when a claim was unverified, and say when an earlier summary
turns out to have been wrong: in the first run a reviewer's "small under-count" had
the wrong sign, was repeated upward, and had to be corrected twice.

**Outward-facing steps stay with the operator.** The first run deliberately left
`npm run deploy` undone across four finished phases. Committing and pushing to
`main` is already authorized by `AGENTS.md` §8; deploying to the live Worker is not.
