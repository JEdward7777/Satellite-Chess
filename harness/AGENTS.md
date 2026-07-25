# Working agreement for Satellite-Chess

This file is the contract every coding assistant on this project follows —
Claude Code, Codex, Cursor, Copilot, or a human standing in for one. `CLAUDE.md`
and the root `AGENTS.md` are both thin pointers here so there is exactly one
copy of these rules.

Read this once at the start of a session. It is short on purpose.

---

## 1. What this project is

Real chess played on real ground. GPS maps a 64-square board onto a field. You
may only pick a piece up when you are physically near its square, you **carry it
while you walk**, and you may only put it down when you are near the
destination. A chess clock runs throughout. Two players, both physically present
on the same field, each on their own phone.

Stack: PWA + Cloudflare Workers + SQLite-backed Durable Objects + Workers KV.
Free tier throughout.

The full original design brief is preserved verbatim at
`harness/reference/brief-original.md`. It was a first draft and parts of it are
wrong — where it conflicts with `harness/decisions/`, the decision wins.

## 2. Orient yourself before doing anything

In this order:

1. **`harness/STATE.md`** — where the project is right now, and the active stage.
2. **The newest file in `harness/sessions/`** — what the previous thread actually
   did, what it left half-done, and what it recommends next. Pick up there.
3. **`harness/plan/`** — the stage tree. Run `npm run plan` for a status rollup
   rather than reading every file.
4. **`harness/observations/open.md`** — known problems that are real but not yet
   scoped into a stage. Check this before "discovering" something already logged.

A SessionStart hook prints a summary of 1, 2 and 4 automatically. If you did not
see that summary, the hook did not fire — read the files yourself, do not assume
the project is empty.

## 3. Stage numbering

Stages are dotted decimals of arbitrary depth: `3`, `3.2`, `3.2.4`. Depth is
logical nesting, so a phase can be subdivided as finely as the work demands
without renumbering its siblings.

The plan files under `harness/plan/` are the source of truth. One line per stage:

```
- `3.2.4` active: Persist a pending lift across hibernation
```

Status is one of `todo`, `active`, `done`, `blocked`, `dropped`. Indented prose
under a stage line is notes for humans and is ignored by the parser.

Rules:

- Adding detail means adding children, never renumbering siblings.
- A parent is `done` only when every child is `done` or `dropped`.
- Keep at most a couple of stages `active` at once. If more are in flight, the
  work was not decomposed finely enough.
- `npm run plan:check` validates numbering, parentage and status consistency.
  Run it after editing any plan file.

## 4. Where things go

| You have | Put it in |
|---|---|
| A choice with a lasting consequence | `harness/decisions/NNNN-slug.md` (new file, append-only) |
| A real problem, but out of scope right now | `harness/observations/open.md` |
| Work to do, understood well enough to scope | a stage in `harness/plan/` |
| A record of what you did this session | `harness/sessions/YYYY-MM-DD-NN.md` |
| Durable technical facts (wire format, geometry, budget) | `harness/reference/` |
| Current position and next step | `harness/STATE.md` (rewrite, keep it short) |

**Anything that will grow without bound is a folder, not a file.** Decisions,
sessions and observations are already folders. If a plan file or a reference file
gets long enough to be annoying, split it into a folder with a `README.md` index
and update the links. Do not let a file grow to a thousand lines.

Never edit a decision file after writing it. Supersede it with a new one and add
a `Superseded by` line to the old one.

## 5. Decisions

Write one when a choice would be expensive to reverse, or when a future session
would otherwise waste time re-deriving it or quietly undo it. Not for routine
implementation detail.

Format is in `harness/decisions/README.md`. Keep them to one screen. State what
was decided, why, what was rejected, and what would make you revisit it. Number
them sequentially with no gaps.

## 6. Engineering rules specific to this project

These come from platform constraints that have already been verified
(`harness/reference/platform-verified.md`). Breaking them breaks the deployment,
not just the design.

- **SQLite Durable Objects only.** The Wrangler migration must use
  `new_sqlite_classes`. `new_classes` is the legacy key-value backend and fails
  to deploy on the free plan with error 10097.
- **WebSocket Hibernation is mandatory.** Use `ctx.acceptWebSocket()`, never
  `server.accept()`. Consequence: **no clock state in memory, ever.** No
  `setTimeout`. Everything timing-related must be reconstructible from stored
  timestamps on wake. `src/shared/clock.ts` is pure functions for this reason.
- **Inbound WebSocket messages are billed as requests.** 100k/day on free. Never
  stream GPS to the server. The client computes reach for its own UI at full GPS
  rate for free; the server only needs positions at lift and place. Opponent
  position is relayed coarsely for atmosphere, rate-limited per
  `harness/reference/budget.md`.
- **The client is untrusted and also does all the per-frame work.** Run the same
  shared validation in both places. The Durable Object's answer is the only one
  that counts.
- **A Durable Object has exactly one alarm.** Multiple deadlines (flag-fall,
  disconnect grace, garbage collection) are multiplexed through a `timers` table;
  the alarm is always set to the earliest due row. Do not call `setAlarm`
  directly from feature code.
- **Games snapshot their field.** A saved field is mutable and versioned; a game
  in progress must never change shape because someone re-calibrated elsewhere.
- **Store raw tapped corners, never the derived projection**, so the geometry
  can be revised without invalidating saved fields.

## 7. Verification

Before you claim anything works:

```bash
npm test           # vitest, pure logic
npm run typecheck  # tsc --noEmit
npm run plan:check # plan tree integrity
```

The game cannot be tested by hand in a container, so there is a GPS simulator
(`?sim=1`) that fakes `watchPosition` and lets you drag a player around a field.
End-to-end checks drive two browser contexts against `wrangler dev`. A change to
game rules is not verified until it has been exercised through the simulator or
a DO integration test — not merely typechecked.

Report failures with the actual output. Never describe a step as done when it is
partial.

## 8. Session discipline

**At the end of every session, without being asked:**

1. Write `harness/sessions/YYYY-MM-DD-NN.md` (`NN` increments within a day).
   Follow the template in `harness/sessions/README.md`. Say what you actually
   did, what you learned, what is half-finished, and what the next thread should
   pick up. Be honest about dead ends — they are the most valuable part.
2. Update `harness/STATE.md` to match reality.
3. Update stage statuses in `harness/plan/`, and run `npm run plan:check`.
4. Log anything spotted-but-unscoped in `harness/observations/open.md`.
5. Commit everything and push to **`main`**, rebasing if the remote has moved:

   ```bash
   git add -A
   git commit -m "<what changed, and why>"
   git fetch origin main
   git pull --rebase origin main
   git push -u origin main
   ```

   On a network failure, retry the push up to four times with exponential
   backoff (2s, 4s, 8s, 16s). On a rebase conflict, resolve it — do not abandon
   the rebase and force-push over someone else's work.

   The container is ephemeral and gets reclaimed. Uncommitted work is lost work.

   **Work directly on `main`.** Earlier sessions used a
   `claude/satellite-chess-game-bigkb8` feature branch; the owner folded it into
   `main` on 2026-07-25 and asked for `main` from then on. There is one person on
   this repository and the assistant is the one writing the code, so a review
   branch was ceremony protecting nobody — and it meant `main` sat at the initial
   commit while everything real lived elsewhere. Do not create a feature branch
   again unless asked. The safety net is the harness and the test suite, not the
   branch: `npm run check` must be green before you push, because there is no
   longer a second chance to catch it in review.

**Then tell the operator it is a good moment to start a fresh thread**, and say
so explicitly, whenever all of these hold:

- the active stage is finished and its status is updated,
- tests, typecheck and `plan:check` are clean,
- the session file is written and `STATE.md` matches reality,
- everything is committed and pushed.

That is a session boundary: a new thread can pick up from the files alone with
nothing lost. Say something like *"Good point to start a new thread — stage 2.3
is done, everything is pushed, and the next thread will pick up at 2.4 from
STATE.md."* Do not suggest it mid-stage, with a dirty tree, or with a failing
test, because a new thread would then start by rediscovering your mess.

Also suggest it when the conversation has grown long enough that you are
noticeably re-reading things you already knew — but finish and push first.

## 9. Style

Match the surrounding code: same comment density, naming and idioms. Comments
explain *why*, especially where a platform constraint or a game-design decision
forced an unobvious shape. The shared modules under `src/shared/` are the
reference for tone — they are commented for a reader who has not read the brief.

British spelling in prose and identifiers (`normalise`, `centre`, `metres`),
matching what is already there.
