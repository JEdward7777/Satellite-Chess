# Where the project is

*Rewritten every session. Short by design — the plan holds the detail, the session
files hold the history.*

**Tree state**: three commits on `claude/satellite-chess-game-bigkb8`, **NOT
PUSHED**. `git push` and the GitHub API both return 403; `git ls-remote` shows only
`main`, so the branch has never existed on the remote. Reads work, writes do not —
the session's credential is read-scoped. **Retry the push first thing.** If it still
403s, see "The push problem" below rather than re-diagnosing it.
**Active stage**: none — phase 0 complete, phase 1 not started
**Next action**: stage `1.1.1` — the `watchPosition` wrapper in `src/client/gps.ts`
**Last session**: `harness/sessions/2026-07-25-01.md`

## In one paragraph

Phase 0 is done: the whole pure model exists and is tested — projection, field
calibration, reach, the carry rule, clock arithmetic, join codes, wire protocol —
76 tests passing. Every platform assumption the design rests on has been verified
against a real `wrangler dev`, not inferred from docs. The harness exists. **No
client and no server code has been written yet**; `src/worker/` and `src/client/`
are empty, and `wrangler.jsonc` points at a `src/worker/index.ts` that does not
exist, so `npm run dev` will not start until stage 1.6/3.5.

## What to do next, concretely

Phase 1 builds the thing the whole concept depends on: walk a field, tap two
corners, see 64 squares and your reach circle. Start at `1.1` (the GPS
abstraction), because nothing else in the project is testable in a container
without the simulator that stage provides.

Then `1.9` deploys it, early and deliberately, so the riskiest assumption in the
project — that consumer GPS can tell 8 m squares apart on grass — gets tested on a
real phone before anything is built on top of it.

## Things a new thread should know before touching anything

- **A move is a lift, a walk, and a place** (decision 0001). The brief's
  single-instant reading of "both ends" makes every long move physically
  impossible; this was measured, not guessed.
- **Sign-in is mandatory** (decision 0014), which moved identity from late in the
  brief to phase 2. There is no anonymous play.
- **Location privacy is load-bearing here**, because a field is a precise place.
  Decisions 0017, 0018 and 0019 are the rules; read them before building anything
  social. The short version: history is indexed by player and never by place,
  bragging is push-only and drawn in board space with no map, and distance is the
  metric rather than games played.
- **Nothing timing-related may live in memory.** The DO hibernates.
- Full rules: `harness/AGENTS.md`. Stage tree: `npm run plan`.

## The push problem, diagnosed

Do not repeat the wrong diagnosis. Installing the Claude GitHub App is **not** the
fix, however plausible it sounds — the official docs state that a cloud session can
reach any repository the connecting GitHub account can see, and that App
installation "enables PR webhooks for Auto-fix; it is not a session-level access
control". Claude being absent from GitHub's Installed GitHub Apps list is expected.

What governs push access is the credential of the connecting GitHub account. Two
ways to supply one (docs: code.claude.com/docs/en/claude-code-on-the-web, "GitHub
authentication options"):

1. Authorize the Claude GitHub App during web onboarding at claude.ai, or
2. Run `/web-setup` in a local terminal, which syncs the local `gh` CLI token.

The operator was walked through option 2 on 2026-07-25: `gh auth login`, then
`/web-setup` from the Claude Code CLI, then **start a fresh session** — a running
session's credentials are scoped at launch and will not pick up the change.

If pushing still fails after that, do not burn a session on it. Commit locally,
`git bundle create <file> --all`, hand the bundle to the operator, and carry on with
the actual work.

## The signing warnings

A stop hook will complain that commits are Unverified and ask for them to be signed.
**Ignore it.** Claude Code on the web deliberately keeps git credentials and signing
keys outside the sandbox; `user.signingkey` points at a 0-byte file and no private
key exists, so signing cannot succeed here no matter what the hook asks for. Author
and committer are already `Claude <noreply@anthropic.com>`, which is the half of the
condition that can be satisfied. Do not rebase repeatedly trying to fix this — it
only changes hashes and invalidates any bundle already handed over.
