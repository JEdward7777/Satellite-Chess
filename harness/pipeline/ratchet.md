# The ratchet — pipeline mode

**Opt-in. This is not how work is normally done here.** It exists so that when the
operator says *"run the pipeline"*, *"ratchet"*, *"do these phases pipeline-style"*,
or names this file, an assistant knows exactly what is being asked for without being
told again. Called the ratchet because each phase only ever moves forward: nothing is
committed until a fresh reviewer finds nothing left to fix. Nothing else in the harness depends on it. A session that is never asked for
the pipeline should follow `AGENTS.md` and ignore this file.

Written up on 2026-09-23, after the run described in
[`../sessions/2026-09-23-01.md`](../sessions/2026-09-23-01.md). First asked for on
2026-09-17. Moved here from `reference/pipeline.md` on 2026-09-24 and extended with
the second run (`2026-09-23-02`, `2026-09-24-01`: phases `8.1`/`8.2` in five rounds,
`8.4`/`3.6.2` in two).

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

## Who does what

**The operator's own session is the coordinator and never implements.** It reads the
harness, picks or confirms the batch, writes the prompts, relays each report to the
operator in a few plain lines, chooses which optional items to take, takes second
opinions, and decides when a phase is done. It keeps its own context small: it does
not read subagent transcripts, only their final reports. It does its own small
checks where a claim is cheap to verify — `git log` after a push, a glance at a
change made after a clean review.

**A fresh implementer per phase.** One implementer carries a phase through all its
rounds and its FINALIZE; the next phase gets a new one, because a phase's context is
spent by the end of it.

**Changes after a clean review are the exception, and must be small.** Taking an
optional item from a clean review's list without another round is acceptable only
when it is small, tested and mirrors already-reviewed code — and the coordinator
reads that diff itself before FINALIZE. Anything larger gets another review round.

## What the second run added

- **Round N usually finds a bug next to round N−1's fix.** Crediting the final carry
  exposed a headline below a carrying total; removing that total exposed the headline
  below a single carry; flooring the figure exposed that a finished game's distance
  could still be rewritten. Four of five rounds in phase 4 found something real, and
  the last one would have corrupted the operator's own record. Do not stop because a
  fix "obviously" closed the problem.
- **Ask each reviewer specific questions**, not just "review this": the doubts the
  implementer reported, the risk the last fix introduced, the worst outcome for a
  player (for this project: a game stranded in the field), and a definite ruling on
  anything the coordinator is unsure of. A reviewer given the question *"can this
  wrongly declare a live game gone?"* killed the server mid-game to answer it.
- **Tell every reviewer the earlier rounds in a paragraph** — what was verified and
  what was fixed — so it spends its time on new ground.
- **Keep a list of ports already used** by earlier agents and hand it to each new
  one; stale `wrangler dev` servers from other sessions may still hold them.
- **A reviewer's suggested fix can contradict an earlier round's.** Round 2 of phase
  4 rejected a display-only floor; round 3 proposed one. When that happens, take the
  second opinion and pick a fix that satisfies both rounds' reasons (there: floor at
  the source, so every surface agrees).
- **If the run is interrupted, commit what exists with a resume checklist** in the
  session file — what is done, what is not, the settled design, and the next items in
  order. That is what let this run resume twice after machine restarts with nothing
  re-derived. A new thread resumes by reading that checklist and continuing the loop.

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
- **The next free observation and decision numbers**, so parallel additions do not collide. The
  operator adds observations to `open.md` while phases run; tell the implementer
  where to start numbering, and re-tell it if the number moves.

**Reviewer prompts additionally carry**: what the implementer claims (marked *do not
trust — verify*), the earlier rounds in brief, the specific questions to answer, the
ports not to use, the instruction never to edit source or touch git, and the exact
verdict-line format.

**The FINALIZE message carries**: the session file's name (`YYYY-MM-DD-NN`), what the
review rounds found in plain terms so the session file records it, the plan stages to
close, the next free observation number, files that must not be committed (anything
untracked the operator left in the tree), the commit trailer, and *do not deploy*.

## Reporting back

The operator reads a terminal, often on a phone, often at a glance. Relay what a
review found in plain terms — what would have gone wrong for a player, not which
function changed. Say when a claim was unverified, and say when an earlier summary
turns out to have been wrong: in the first run a reviewer's "small under-count" had
the wrong sign, was repeated upward, and had to be corrected twice.

**Outward-facing steps stay with the operator.** The first run deliberately left
`npm run deploy` undone across four finished phases. Committing and pushing to
`main` is already authorized by `AGENTS.md` §8; deploying to the live Worker is not.
