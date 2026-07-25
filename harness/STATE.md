# Where the project is

*Rewritten every session. Short by design — the plan holds the detail, the session
files hold the history.*

**Tree state**: clean, pushed to `main`
**Active stage**: `4.2` — the carry, server side. Done bar `4.2.6`.
**Next action**: `4.2.6` — suspension must cancel a carry (decision 0009)
**Last session**: `harness/sessions/2026-07-25-03.md`

## In one paragraph

Phases 0 and 1 are done bar the deploy, and phase 3 is essentially complete: a
real GameDO with join-code addressing, hibernating WebSockets, multiplexed alarms
and presence. Phase 4's server half is done too — lift, carry, place, terminal
detection, clock handover — all against the real `workerd` runtime. **218 tests
pass.** What does not exist yet is the client half of the carry (`4.3`), so the
PWA can draw a board and put you on it but cannot yet move a piece.

## What to do next, concretely

1. **`4.2.6` — suspension does not cancel a carry.** Confirmed missing by reading
   `suspendForDisconnect`: it banks the clock and cancels the flag timer, but
   leaves the `carry` row standing, so a player who drops mid-carry resumes still
   holding the piece. Decision 0009 says it goes back.
2. `4.4` — resign and draw. Currently wired to an explicit "not implemented"
   reply, which is better than silence but is not the feature.
3. `4.5.1` / `4.5.2` — a full game through the DO, then castling and en passant.
   Those are where the reach rules have the most room to be subtly wrong.
4. `4.3` — the client half. This is what makes the game playable end to end in
   the simulator.
5. `1.9.2` and `1.9.3` still need a real phone on real ground, and `1.9.3` is
   still the highest-information stage in the project.

## Things a new thread should know before touching anything

- **A move is a lift, a walk, and a place** (decision 0001).
- **Distance walked is measured, not summed** (decision 0020). A naive sum credits
  19–32 km an hour to a phone on a bench. Three mechanisms each worth a factor of
  ten. Do not simplify it back.
- **Sign-in is mandatory** (decision 0014). No anonymous play.
- **Location privacy is load-bearing.** Decisions 0017, 0018, 0019 before anything
  social.
- **Nothing timing-related may live in memory.** The DO hibernates.
- **Chess legality is checked before the carry verdict**, and the order matters.
  Legality does not depend on where anyone stands, so it is the cheaper and the
  honest check — the other way round, an illegal move is reported as
  `implausible`, telling a player their GPS jumped when the real problem is that
  bishops do not move like that.
- **Update this file as you go, not at the end.** A context compaction mid-session
  left a stale STATE.md saying "active stage 1.9", and the next thing I did was
  read my own uncommitted work as another session's and nearly hand it off. The
  file is the only defence against that.
- **Views are split model-from-DOM**, and the DOM half is verified by driving
  Chromium against `?sim=1` — not by unit tests. Every view bug in phase 1 was
  invisible to tests and obvious in a screenshot. Keep doing it.
- **Three tsconfigs, one per runtime** (decision 0021). Client gets DOM only,
  worker gets Workers only, tools get both. Do not collapse them back into one —
  the Workers globals shadow their DOM namesakes and the resulting errors name
  types with no bearing on the code. Resolved O-05.
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
