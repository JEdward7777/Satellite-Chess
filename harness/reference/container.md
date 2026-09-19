# Working in the container

*Split out of `STATE.md` on 2026-09-08. Nothing here is about the game: it is
about the box the game is built in, and it is the part a new thread needs only
when something refuses to run.*

## This tree is a Syncthing folder, and git can briefly look corrupt

Seen on 2026-09-16: `fatal: bad object HEAD`, while a push was in flight from
another session on the same tree. `refs/heads/main` had already synced to a new
commit whose *object* had not arrived yet, so git was reading a ref that pointed
at nothing. It resolved itself inside a minute.

Nothing is wrong when this happens and nothing needs repairing. **Wait, then look
again, before believing any report of repository corruption in this tree** — and
in particular do not reach for `git fsck --lost-found`, `git gc --prune`, or a
reclone, all of which are destructive answers to a problem that fixes itself.

## Delegating a driver run: assume a shared working tree

Learned the hard way on 2026-09-16, and it nearly cost uncommitted work.

Another session was asked to run the drivers because it had a browser. It turned
out to be on the **same machine, in the same checkout** — `~/Sync/projects/Satellite-Chess`
is one directory, not one per session. The instructions sent to it included
`git checkout <old-commit>` for a bisect, which would have moved `HEAD` in that
shared tree on top of three files being edited live at that moment. Nothing was
lost only because the peer noticed, refused to run it, and used a detached
`git worktree` in scratch space instead.

So, when handing a run to another session:

- **Never send a command that moves `HEAD`, stashes, resets or cleans.** Assume
  your tree is their tree until proven otherwise.
- A bisect belongs in `git worktree add <scratch-dir> <commit>`, with
  `node_modules` symlinked in and the client built there. That is what worked.
- Say which paths you are actively editing, so a peer can avoid them.
- The cheap check is `git config --get remote.origin.url` plus `pwd` at both
  ends before anything is run.

## Running the browser drivers

**Playwright can be installed without root and without touching the system**,
and on a machine that is not an ephemeral container it only has to be done once.
This was worked out on 2026-09-13, after three sessions had recorded "playwright
is not installed here" as a standing fact and let a backlog of unrun drivers
build up to three.

```bash
npm install --no-save playwright jsqr          # into node_modules, not package.json
mkdir -p ~/.cache/satellite-chess/playwright
PLAYWRIGHT_BROWSERS_PATH=~/.cache/satellite-chess/playwright \
  npx playwright install chromium              # ~115 MB download, 658 MB unpacked
```

**If the box already has Chrome, skip the download entirely.** Found on
2026-09-16 by a peer session running our drivers on a machine with system Chrome,
and it is strictly better than the above wherever it applies — 17 seconds against
several minutes, and no 658 MB sitting in a cache:

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright jsqr
mkdir -p ~/.cache/satellite-chess/playwright/chromium-sys
# …/chrome is the Chrome *install directory*, which is `/opt/google/chrome` on
# Debian and Ubuntu and something else everywhere else. The path is the local
# detail; the symlink's shape is the part that generalises.
ln -s <chrome-install-dir> ~/.cache/satellite-chess/playwright/chromium-sys/chrome-linux
```

It works because `findChromium()` in each driver only scans
`PLAYWRIGHT_BROWSERS_PATH` for `chromium-*/chrome-linux/chrome` and hands the
result to `chromium.launch({ executablePath })` — so **a symlink named to match
that shape resolves to the system browser with no source change**. That naming is
the whole mechanism and is what to reproduce on a different platform.

Verified against Google Chrome 152 on Ubuntu 24.04, Node 24: eight of eleven
drivers passed, and all three failures were real findings rather than browser
problems.

Notes that matter:

- **No `--with-deps`.** That flag runs `apt-get` and needs root. It was not
  needed on WSL2 Ubuntu — chromium launched with no missing shared libraries. If
  a future box does need them, that is the one step to hand to the operator.
- **`PLAYWRIGHT_BROWSERS_PATH` must be set when the drivers run too**, not only
  when the browser is installed, or playwright looks in its default cache and
  finds nothing.
- The browser lives in one folder and is removed with a single `rm -rf` of it.
  Deliberately **not** under the repo: this tree is inside `Sync/`, and 658 MB of
  browser binaries have no business being synced between machines.
- `findChromium()` in each driver looks for `chrome-linux/chrome`; current
  playwright unpacks to `chrome-linux64/chrome`, so it returns `undefined` and
  playwright resolves the binary itself. Harmless, and `check-games.mjs` handles
  both layouts. Do not "fix" the others by deleting the helper without checking
  that the environment variable is set wherever they run.

Then, with the dev server up:

```bash
rm -rf .wrangler          # see below — not optional if anything has run before
npm run build:client
npx wrangler dev --port 8799 --var DEV_AUTH_SECRET:local-dev-secret &
export PLAYWRIGHT_BROWSERS_PATH=~/.cache/satellite-chess/playwright
for d in scripts/check-*.mjs scripts/drive-game.mjs; do node "$d" || echo "FAILED $d"; done
```

**Start from an empty `.wrangler`, or you will be told lies.** The drivers assume
an empty world and nothing resets it, so local state accumulates across runs —
duplicate fields under the same `sub`, games outliving the run that made them —
until the drivers that *count* things start failing. `check-field` is the canary,
because it asserts "still one field" and "without leaving the old one beside it".

This was measured on 2026-09-16, and the failure is convincing rather than flaky:
a second run gave 8/11, with `check-field` and `check-join` failing **3 times out
of 3** and `drive-game` 2 out of 3. The three had nothing to do with the commit
under test — it had touched no client or worker source at all — and all three
passed immediately against a fresh `.wrangler`. So the symptom is *three phantom
regressions in drivers nobody changed*, which is an expensive thing to chase.
Logged as **O-19**; wiping is the workaround, not the fix.

All eleven passed on 2026-09-13, **before the sign-in gate existed**. They have
not been run since.

**Every driver now needs `DEV_AUTH_SECRET`**, which is the opposite of what this
paragraph said until 2026-09-16. Stage `2.5.1` made sign-in mandatory, so a
browser context that has not signed in reaches the gate and nothing else; each
driver therefore mints a session through `scripts/driver-signin.mjs` before its
first navigation, and that needs the seam open. Start `wrangler dev` with the
`--var` above and not with a bare `--local`.

**The failure, if you forget, does not mention signing in.** The driver times out
waiting for a selector — `[data-calibrate]`, `[data-new]` — on a home screen that
was never going to render, so it reads as a broken app rather than a missing
session. If a driver hangs on its first `waitForSelector`, check the `--var`
before you check anything else.

`check-qr.mjs` is the exception and needs no server at all: it decodes QR
matrices in node and never launches a browser.

## Running it

**A fresh container may have no Node at all.** One did on 2026-09-06, and a
missing `npm` reads at first glance like a broken checkout rather than a bare
box. Install it and carry on — the repo itself is fine:

```bash
echo <sudo-password> | sudo -S bash -c \
  'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs'
npm install
```

```bash
npm run dev                                                    # the whole thing, dev seam on
npm run build:client && npx wrangler dev --port 8799 \
  --var DEV_AUTH_SECRET:local-dev-secret                       # what the drivers need
node scripts/build-client.mjs --serve                          # client only, :8788
npm install --no-save playwright jsqr                          # then any driver

# Every driver below needs the `--var` above — see the top of this file. Without
# it they hang on a selector that is never going to appear, which reads as a
# broken home screen rather than as a missing session. `check-qr.mjs` is the one
# exception: it needs no server and no browser at all.
node scripts/drive-game.mjs                                    # two phones, a game
node scripts/check-deeplink.mjs                                # deep links, offline
node scripts/check-invite.mjs                                  # create, code, QR, share
node scripts/check-join.mjs                                    # joining, with no field
node scripts/check-clock.mjs                                   # clocks, low time, tenths
node scripts/check-calibrate.mjs                               # four taps, a 12x6 board
node scripts/check-scan.mjs                                    # camera, advice, camera released
node scripts/check-field.mjs                                   # sharing a field, and keeping one
node scripts/check-fields.mjs                                  # a field following the account
node scripts/check-resume.mjs                                  # the handshake, and a cold start
node scripts/check-account.mjs                                 # offline identity, sign-out, pre-flight
node scripts/check-qr.mjs                                      # the encoder, 351 cases
```

Install the two together: `npm install --no-save` prunes anything not in
`package.json`, so installing one on its own removes the other.

`wrangler dev` works now that the worker exists, and is the only way to exercise a
real game. Open `http://127.0.0.1:8799/?sim=1` in two browser profiles: calibrate
the same field on each, start a game on one, join with the displayed code on the
other, then walk both to their back ranks.

`?sim=1` gives a fake GPS with on-screen controls: an arrow pad that walks, drag
on the board to teleport, sliders for accuracy and jitter, and a switch between
two simulated players. `globalThis.satchess` exposes the same thing to a console
or a browser test.

## Wrangler and Cloudflare — **check which machine you are on first**

**This section is about the ephemeral container, and only about it.** On the
operator's own WSL machine — where sessions increasingly run — `wrangler whoami`,
`deploy`, `secret put` and KV namespace creation all work normally. Read the
paragraph below as "in the container", never as "in this project".

That distinction was buried in a parenthesis at the end of this section until
2026-09-16, and it cost two sessions: `2026-09-15-01` nearly deferred `2.1` on the
grounds that it "cannot be finished in a container", and `2026-09-16-01` found
`2.4` marked operator-only and created the KV namespace in about ten seconds. The
cheap test is one command — run `npx wrangler whoami` and believe it, rather than
believing this file.

One real wrinkle, wherever you are: a bare `wrangler kv namespace list` fails with
**"Authentication error [code: 10000]"** even with `workers_kv (write)` on the
token. It needs `CLOUDFLARE_ACCOUNT_ID` set explicitly, and the error names the
wrong cause entirely. `deploy` and `secret list` need no such help.

**And `wrangler kv key list` reads *local* storage unless you pass `--remote`.**
It does not say so, does not warn, and does not fail: it prints `[]` and exits 0.
Against the `SESSIONS` namespace that reads as "there are no sessions" — which,
on a mandatory-sign-in app whose only evidence of a working sign-in is a session
record, is a false alarm of exactly the wrong shape. Measured 2026-09-16: the same
command was `[]` without the flag and one live session with it. **Pass `--remote`
whenever the question is about production**, and treat a `[]` without it as
meaningless rather than as an answer.

When counting sessions, count them — do not list them. A key is `session:<token>`
and **the token *is* the session**: anyone holding one is signed in as that user.
`… --remote | grep -c 'session:'` answers "how many" without putting live
credentials in a terminal, a log, or a transcript.

Measured 2026-08-04, so no future session has to discover it by burning a stage on
it. The session's egress proxy answers **403 to CONNECT** for both
`api.cloudflare.com:443` and `dash.cloudflare.com:443` — an organisation egress
policy denial, recorded in the proxy's own `recentRelayFailures`. `wrangler whoami`
says "not authenticated", and it cannot become authenticated: `wrangler login` runs
an OAuth callback to *the container's* localhost, which the operator's browser
cannot reach, and the API path is blocked anyway. `CLOUDFLARE_API_TOKEN` would not
help, for the same 403.

**What still works, and it is nearly everything**: `wrangler dev --port 8799 --local`
serves on 127.0.0.1 with no Cloudflare contact at all — verified again on 2026-08-04,
HTTP 200 at `/` and at `/j/ABC123`. That is what all eight browser drivers run
against, so the DO, the routing and the whole game remain fully testable here.

**What does not, in the container**: `wrangler login`, `wrangler deploy`,
`wrangler secret put`, KV namespace creation — anything touching the Cloudflare
API. Do not plan a *container* session around getting a deploy out, and do not
retry the 403 or route around it.

**None of those are outstanding any more.** `1.9.1` and `1.9.3.4` were done from
the operator's machine earlier; `2.4` (the `SESSIONS` namespace) and the deploy
carrying `2.1` followed on 2026-09-16 from the same place. What remains of the
`2.1` verification is not a wrangler problem at all — it is a human at a browser
completing a Google consent screen, which no machine in this project can do on
its own.

## A plain container may have no git credentials at all — bundle and move on

Distinct from the 403 below, and diagnosed on 2026-09-06 so the next thread does
not read one as the other. Here `git fetch` worked fine (the remote is public)
and `git push` failed with **`could not read Username for 'https://github.com'`**
— not a 403, not a permissions problem, simply no credential to offer. There was
no `gh`, no `credential.helper`, no `GH_TOKEN`, and no `~/.git-credentials`.
Installing the GitHub App fixes the *other* failure and would not have touched
this one.

Git identity was also unset, which stops `git commit` outright. Previous
container sessions committed as `Claude <noreply@anthropic.com>` (43 of the 47
commits), so match that:

```bash
git config user.name "Claude" && git config user.email "noreply@anthropic.com"
```

Then take AGENTS.md section 8's documented exit rather than burning the session
on credentials — commit locally and hand the operator a bundle:

```bash
git bundle create <file>.bundle origin/main..main   # incremental, ~17 KB
git bundle verify <file>.bundle
# operator, in their local clone:  git pull <file>.bundle main
```

Do **not** amend or rebase to tidy up afterwards. It only changes hashes and
invalidates a bundle already handed over — the same warning as the signing note
below.

**This worked, on 2026-09-06.** The operator pulled the bundle and pushed; a
`git fetch` from the container then showed the same hashes with zero ahead and
zero behind. So the route is proven rather than theoretical, and it costs about
two minutes. Confirm with `git rev-list --left-right --count main...FETCH_HEAD`
rather than assuming — the commits keep their hashes through a bundle, so a
successful handover is exactly a fast-forward and is easy to check.

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
