# Where the project is

*Rewritten every session. Short by design — the plan holds the detail, the session
files hold the history.*

**Tree state**: clean, pushed to `claude/satellite-chess-game-bigkb8`
**Active stage**: `1.9` — first deploy. **Blocked on the operator**, see below.
**Next action**: `wrangler login` and `npm run deploy` (stage `1.9.1`)
**Last session**: `harness/sessions/2026-07-25-02.md`

## In one paragraph

Phases 0 and 1 are done bar the deploy. The whole pure model exists and is tested,
and so does a working client: walk to a1 and tap, walk to h8 and tap, review the
board those two corners imply, save it, and stand on it — with your reach circle
and the squares you could touch drawn around you. All of it is drivable indoors
through `?sim=1`, which is how every view in this phase was verified. 148 tests.
**`src/worker/` is still empty**, so `wrangler dev` will not start; use
`node scripts/build-client.mjs --serve` (port 8788) until phase 3.

## What to do next, concretely

**Everything remaining in phase 1 needs a human with a phone and a field.**

1. `1.9.1` — `wrangler login`, confirm the account, `npm run deploy`. There is no
   Cloudflare account reachable from a container, so this cannot be automated.
   Note that `wrangler.jsonc` points `main` at `src/worker/index.ts`, which does
   not exist yet — **the deploy will need a stub worker, or `1.9.1` waits for
   phase 3**. Decide which when you get there; a stub that only serves the static
   assets is a few lines and unblocks `1.9.3`, which is the valuable part.
2. `1.9.2` — install the PWA on a real phone, check the wake lock actually holds.
3. `1.9.3` — **walk a real field.** This is the stage the project has been built
   toward. The riskiest assumption is that consumer GPS can tell 8 m squares apart
   on grass; the answer reshapes phase 9 and possibly the reach constants.

Then O-05 (split the tsconfigs) before phase 3, and phase 2 or 3 after.

## Things a new thread should know before touching anything

- **A move is a lift, a walk, and a place** (decision 0001).
- **Distance walked is measured, not summed** (decision 0020). A naive sum credits
  19–32 km an hour to a phone on a bench. Three mechanisms each worth a factor of
  ten. Do not simplify it back.
- **Sign-in is mandatory** (decision 0014). No anonymous play.
- **Location privacy is load-bearing.** Decisions 0017, 0018, 0019 before anything
  social.
- **Nothing timing-related may live in memory.** The DO hibernates.
- **Views are split model-from-DOM**, and the DOM half is verified by driving
  Chromium against `?sim=1` — not by unit tests. Every view bug in phase 1 was
  invisible to tests and obvious in a screenshot. Keep doing it.
- **`@cloudflare/workers-types` shadows DOM globals** in client code and produces
  errors that read as nonsense. See O-05.
- Full rules: `harness/AGENTS.md`. Stage tree: `npm run plan`.

## Running it

```bash
node scripts/build-client.mjs --serve   # http://127.0.0.1:8788/?sim=1
```

`?sim=1` gives a fake GPS with on-screen controls: an arrow pad that walks, drag
on the board to teleport, sliders for accuracy and jitter, and a switch between
two simulated players. `globalThis.satchess` exposes the same thing to a console
or a browser test.

## If pushing ever 403s again: install the GitHub App

Resolved on 2026-07-25, and the resolution contradicts the documentation, so it is
worth recording precisely.

Symptom: `git push` returns 403 from the session's local git proxy, the GitHub API
returns `403 Resource not accessible by integration`, and `git ls-remote` shows the
development branch does not exist on the remote at all. Reads work fine.

**Fix: install the Claude GitHub App on the repository** — github.com/settings/installations,
or github.com/apps/claude if it is not listed. The push succeeded immediately
afterwards, in the same session, with no restart and no new credentials fetched.

This is worth flagging because the official docs say the opposite. `code.claude.com/docs/en/claude-code-on-the-web`
("GitHub authentication options") states that a cloud session can reach any
repository the connecting account can see, and that App installation "enables PR
webhooks for Auto-fix; it is not a session-level access control". That was read,
believed, and acted on — the operator was told *not* to install the App. They
installed it anyway and the 403 vanished. So for the git proxy's write path, the App
installation token is evidently what authenticates. Trust the observed behaviour
over that paragraph.

The other documented route, `/web-setup` from a local terminal to sync a `gh` token,
was never needed and remains untested here.

If a push somehow fails anyway, do not burn a session on it: commit locally,
`git bundle create <file> --all`, hand the bundle to the operator, and get on with
the actual work.

## The signing warnings

A stop hook will complain that commits are Unverified and ask for them to be signed.
**Ignore it.** Claude Code on the web deliberately keeps git credentials and signing
keys outside the sandbox; `user.signingkey` points at a 0-byte file and no private
key exists, so signing cannot succeed here no matter what the hook asks for. Author
and committer are already `Claude <noreply@anthropic.com>`, which is the half of the
condition that can be satisfied. Do not rebase repeatedly trying to fix this — it
only changes hashes and invalidates any bundle already handed over.
