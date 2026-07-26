# Where the project is

*Rewritten every session. Short by design — the plan holds the detail, the session
files hold the history.*

**Tree state**: clean, pushed to `main`
**Active stage**: `4.3` — the client half of the carry. **Now unblocked.**
**Next action**: `4.3.1` — tap a reachable own piece to lift it
**Last session**: `harness/sessions/2026-07-26-02.md`

## In one paragraph

Phases 0 and 1 are done bar the walk, phase 3 is essentially complete, and
**phase 4's server side is finished** — lift, carry, place, resign, draw,
terminal detection, clock handover, and a whole game played move by move against
the real `workerd` runtime. **250 tests pass.**

The transport now exists (`src/client/net.ts`) and is verified against the real
Durable Object, so **`4.3` is unblocked**: the remaining work is UI. Tap a
reachable piece to lift it, show legal destinations and which are in reach, tap to
place. **283 tests pass.**

## The field survey is ready and waiting on a walk

The riskiest assumption in the project — that consumer GPS can resolve 8 m
squares on grass — now has an instrument pointed at it (decision 0022). The
operator's part:

```bash
npx wrangler login
npx wrangler secret put SURVEY_SECRET     # any long random string
npm run deploy
```

Then on a phone, outdoors, with **about 30 m of open ground**:
`https://<worker>.workers.dev/?survey=<secret>` and follow the ten steps. Twelve
to fifteen minutes. Read it back with:

```bash
curl -s -H "x-survey-secret: $SECRET" "$URL/api/survey/traces"
curl -s -H "x-survey-secret: $SECRET" "$URL/api/survey/trace/$ID" \
  | node scripts/analyse-survey.mjs -
```

The analyser was validated against synthetic traces before any real walk, so a
wasted trip is not discovered afterwards.

## What to do next, concretely

1. **`4.3`** — the carry UI. Everything under it is drawing and tapping now:
   `net.ts` connects, syncs, plays a move both sockets see, surfaces rejections
   and relays position. Wire it to `views/board.ts`, which already knows how to
   draw reach and the square under foot.
2. `1.9.3.4` — the walk. Needs Cloudflare access and ~30 m of open ground.
3. `1.9.3.5` — fold the findings back into square size and the reach constants.
4. O-06 (relative asset paths break deep links) before the join flow in phase 6.

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
- **The survey is deletable on purpose** (decision 0022). It is off unless
  `SURVEY_SECRET` is set, and 404s rather than 401s so an unconfigured deployment
  looks like one without the feature. Do not give it callers in the game.
- **The relay refuses most of what it is offered, and that is the feature.**
  599 messages per player per 30 continuous minutes, measured — identical at 0.7,
  1.4 and 3 m/s, because the 2.5 s interval floor binds and the 2 m delta never
  does. A stationary player sends one. The server keeps its own stricter
  backstop, so a relay sent legitimately by the client can still be discarded.
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
