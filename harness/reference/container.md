# Working in the container

*Split out of `STATE.md` on 2026-09-08. Nothing here is about the game: it is
about the box the game is built in, and it is the part a new thread needs only
when something refuses to run.*

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
npm run build:client && npx wrangler dev --port 8799 --local   # the same, no dev seam
node scripts/build-client.mjs --serve                          # client only, :8788
npm install --no-save playwright jsqr                          # then any driver
node scripts/drive-game.mjs                                    # two phones, a game
node scripts/check-deeplink.mjs                                # deep links, offline
node scripts/check-invite.mjs                                  # create, code, QR, share
node scripts/check-join.mjs                                    # joining, with no field
node scripts/check-clock.mjs                                   # clocks, low time, tenths
node scripts/check-calibrate.mjs                               # four taps, a 12x6 board
node scripts/check-scan.mjs                                    # camera, advice, camera released
node scripts/check-field.mjs                                   # sharing a field, and keeping one
node scripts/check-fields.mjs                                  # a field following the account (needs DEV_AUTH_SECRET)
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

## Wrangler cannot reach Cloudflare from the container — deploys are the operator's

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

**What does not**: `wrangler login`, `wrangler deploy`, `wrangler secret put`,
KV namespace creation — anything touching the Cloudflare API. So `1.9.1`,
`1.9.3.4`, `2.4` and the deployed-origin half of `2.1` were the operator's, from
a local clone, and they are the only things that are. `1.9.1` and `1.9.3.4` are
now done; `2.4` and the `2.1` verification remain. Do not plan a session around
getting a deploy out of this container, and do not retry the 403 or route around
it. (Sessions run from the operator's own machine — e.g. `2026-09-06-03`, the
survey walk — do have Cloudflare API access and `wrangler whoami` works there;
that is where `1.9.3.4`'s secret rotation and read-back happened.)

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
