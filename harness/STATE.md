# Where the project is

*Rewritten every session. Short by design — the plan holds the detail, the session
files hold the history.*

**Tree state**: clean, pushed to `main`
**Active stage**: `6` — the join flow. Only `6.2.3`/`6.2.4` (camera scanning) and
`6.4` (share a field) are left in it.
**Next action**: `6.2.3`, `BarcodeDetector` scanning — or skip to **phase 5, the
clock**, which is the larger hole and needs no decision first.
**Last session**: `harness/sessions/2026-08-01-05.md`

## In one paragraph

Phases 0 and 1 are done bar the walk, phase 3 is essentially complete, and
**phase 4 is finished, server and client** — lift, carry, place, resign, draw,
terminal detection, clock handover, the promotion picker, and optimistic local
application. **You can now see your opponent walking**: `3.4` closed, so the
relay is drawn as a dot that glides between fixes instead of jumping.
**Scan-to-play works end to end.** `6.0` closed O-06 (the shell loads from
`/j/CODE` and `/f/<blob>`, online and with the network cut), `6.1` built the
invite (a code shown large as `ABC 123`, a QR encoder written here rather than
fetched from a CDN — decision 0024 — and the OS share sheet), and `6.2.1`,
`6.2.2`, `6.2.5` and `6.3` now make following one *arrive*: a phone that has
never calibrated a field can scan a link, take a seat, and play on the creator's
ground, because the field travels back with the seat. **439 tests pass, and
`carry.test.ts` no longer flakes — O-09 is closed, two separate races.**

**The game is playable, and a whole game has been played through it.** Two
browsers against a real `wrangler dev`: calibrate a field, create a game, join by
code, both walk to their back ranks, then nine moves to a pawn on the seventh —
`1.h4 g5 2.hxg5 a6 3.g6 a5 4.gxh7 a4 5.hxg8=N`, underpromoting to a knight
through the picker.

What is missing is reach, not plumbing. Phase 6 is now what decision 0015
describes in both directions — you can hand someone a link and they can follow
it. What is left of it is the camera (`6.2.3`/`6.2.4`, and the typed code already
covers the case) and field sharing (`6.4`). **The clock, phase 5, is now the
largest untouched system**, and the game has no time pressure at all until it
exists.

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

Nothing is half-finished.

1. **Phase 5, the clock** — the largest untouched system, and the game has no
   time pressure at all until it exists. `shared/clock.ts` is already written and
   tested; what is missing is the DO half and the flag-fall alarm. This is the
   recommendation: it needs no decision first, and phase 6's remaining stages are
   both smaller and both optional to a playable game.
2. **`6.2.3`/`6.2.4`, the camera.** `BarcodeDetector` where it exists, and a
   decision about Safari, which has none — measure the WASM bundle before
   committing, because the service worker has to cache whatever is chosen. Note
   that the typed code already covers this case completely, so it buys speed
   rather than capability.
3. **`6.4`, sharing a field** (`/f/<blob>`, decision 0016). `parseAppRoute`
   already reads the route and `main.ts` deliberately falls through to home for
   it. This is also where "should a joiner keep the field they played on?" gets
   answered — `6.3` deliberately does not save it.
4. `1.9.3.4` — the walk. Needs Cloudflare access and ~30 m of open ground.
   **Not a gate** (decision 0023) — it sizes the squares, it does not decide
   whether the game works. Do not hold anything for it.
5. `1.9.3.5` — fold the findings back into square size and the reach constants.

## Things a new thread should know before touching anything

- **A move is a lift, a walk, and a place** (decision 0001).
- **Reach absorbs GPS error; squares scale with reach** (decision 0023). Poor
  accuracy means a bigger circle, never a refusal — but the circle must stay
  smaller than the square it selects, so worse GPS means *bigger squares and a
  bigger field*, not a tighter circle. The ratio is the playability constraint.
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
- **Silence on the relay means standing still, not gone.** Because it speaks only
  on movement, a player waiting on their back rank sends one message and then
  nothing all game. So the opponent's dot is never aged out on a timer — it is
  solid while `connected` and a hollow ring when not — and the snapshot repeats
  each player's last position (`PlayerView.pos`) so a client that has just
  connected has something to draw at all. Both are easy to "simplify" away and
  both then break the commonest state in the game.
- **The relay refuses most of what it is offered, and that is the feature.**
  599 messages per player per 30 continuous minutes, measured — identical at 0.7,
  1.4 and 3 m/s, because the 2.5 s interval floor binds and the 2 m delta never
  does. A stationary player sends one. The server keeps its own stricter
  backstop, so a relay sent legitimately by the client can still be discarded.
- **Views are split model-from-DOM**, and the DOM half is verified by driving
  Chromium against `?sim=1` — not by unit tests. Every view bug in phase 1 was
  invisible to tests and obvious in a screenshot, and so was the one in `4.3.5`:
  an author `display` rule beats the user agent's `[hidden] { display: none }`
  whatever the specificity, so the promotion overlay covered the board for a whole
  game while every test passed. Keep taking screenshots.
- **The shell is served at three paths, so every path in it is absolute.**
  `/`, `/j/CODE` and `/f/<blob>` are the same document; one relative `src` and two
  of the three break completely. `src/shared/routes.ts` is the one table of
  client-side routes — the Worker asks it what to serve, the client asks it what a
  path means. Adding a route means adding it there, not in two places.
- **`env.ASSETS.fetch('/index.html')` answers with a 307 to `/`**, because the
  assets binding's default `html_handling` strips `index.html`. Ask for `/`. Get
  this wrong and the app still loads — at `/`, with the join code gone from the
  URL, which reads as a bug in the client's parser.
- **`SELF.fetch` follows redirects**, so a test asserting `status === 200` passes
  against exactly that bug. Use `{ redirect: 'manual' }` whenever the status code
  is the thing being tested.
- **A correct QR is not a scannable one.** `scripts/check-qr.mjs` proves the
  encoder by decoding 351 symbols with jsQR; that says nothing about the thing on
  screen. Between the matrix and a camera sit an SVG, a stylesheet and a
  background colour, and a QR drawn transparent over this app's near-black chrome
  is mathematically perfect and physically unreadable. So `check-invite.mjs`
  screenshots the rendered symbol and decodes *that*. Keep both.
- **`navigator.share` must be reached with nothing awaited in front of it.** One
  `await` and the browser has discarded the user gesture; the call then fails with
  no console message and no visible cause. `shareInvite` is deliberately not an
  `async` function, and the comment saying so is load-bearing. A dismissed sheet
  rejects with `AbortError` and is a *decision*, not a failure — cascading to the
  mailto tier there pops a mail client at someone who just declined to share.
- **`querySelector<HTMLSelectElement>` does not compile under
  `tsconfig.tools.json`.** `HTMLSelectElement` redeclares `remove()`, and in the
  one config where the DOM and Workers globals coexist (decision 0021) the merged
  `Element` already has HTMLRewriter's, which returns something else. The errors
  name types with no bearing on the code, exactly as 0021 warns. Select untyped
  and cast the event target. Inputs and buttons do not redeclare `remove`, which
  is why no earlier view hit this.
- **The client's reach circle must include the handicap**, and for a whole phase
  it did not (found at 6.1.1). The bonus is per-player in the snapshot
  (`PlayerView.reachBonusM`) and read by `myReachBonusM`, not remembered from the
  create screen — the joining phone never saw that screen, and decision 0004
  turns on *both* players seeing the same circle. Getting this wrong does not
  fail anyone's moves; it tells a handicapped player a legal move is out of reach,
  and they believe it and walk further.
- **The joining phone is the one with no field, and that shaped three things.**
  It gets the field back from `POST /api/game/:code` along with its seat (6.3).
  Home is therefore shown even with nothing saved — it used to send a fresh phone
  straight into calibration, which meant the one phone that needed a code box
  could not reach one — and calibration therefore needed a way out that is not
  "save a field". A joiner is deliberately *not* given a copy of the field to
  keep; that is 6.4's question.
- **A scanned link and a typed code are one code path** (`client/join.ts`).
  Anything that can only fail on one of them is a bug. The client refuses an
  impossible code before spending a request, and every other failure is the
  server's message plus a hint of ours, because the server does not know how the
  phone arrived.
- **The game lives in the address bar while you are in it**, put there by
  `rememberGame` on a typed join as well as a scanned one, and taken back out by
  `forgetDeepLink` on the way home. A reload resumes because the join is
  idempotent at the far end. Carry `location.search` through both, or `?sim=1`
  vanishes and every browser check stops working.
- **A join request outlives its screen.** Tapping Cancel on a slow join used to
  drop the player into the game seconds later, on top of whatever they had moved
  on to. `showJoin` holds a `live` flag that its own teardown clears. Any future
  screen that fires a request and then lets you leave needs the same.
- **There is a fourth browser driver: `scripts/check-join.mjs`.** Every phone in
  it except the creator's has never calibrated a field, which is the only way to
  tell a working join from one that merely renders. Run it after anything
  touching joining, routing, or the home screen.
- **There is a second browser driver: `scripts/check-deeplink.mjs`.** It loads a
  cold deep link, cuts the network, loads it again, and separately asks the server
  what it says with a request that bypasses the service worker. Run it after
  anything that touches `public/`, the assets binding, or routing. Same
  `npm install --no-save playwright` preamble as below.
- **There is a browser driver now: `scripts/drive-game.mjs`.** Three sessions
  wrote one and threw it away; this one is kept. It plays two simulated phones
  through a game and photographs each step. `npm install --no-save playwright`
  first — deliberately not a dependency, since it only matters when someone is
  looking at pixels. It also documents the two traps below in its header.
  Its `opponentDot()` finds a dot by colour in the canvas and returns its centre,
  which is how "does it glide or does it jump?" became a number rather than a
  judgement about a picture. Read pixels when the question is about motion.
- **Clicking the board under `?sim=1` teleports *and* taps.** `attachSimDrag`
  moves the player on `pointerdown`, the game view taps on `pointerup`. To drive a
  game from a script, teleport with `satchess.me.moveTo(...)` and dispatch a bare
  `pointerup` — a real click places the piece where you already stand.
- **The simulator emits a fix only once a second**, so a tap dispatched straight
  after a teleport still carries the *old* position and is refused for reach.
  That failure reads exactly like a bug in `shared/reach.ts` and is not one. Wait
  for the on-screen square readout to catch up first.
- **The screen can be ahead of the server on purpose** (`client/optimistic.ts`,
  stage 4.3.6). A lift, place or drop is applied locally the instant it is tapped
  and reconciled against the next snapshot. It predicts only what is *certain* to
  be accepted, and holds the pending action rather than the predicted result, so
  the server's snapshot is always the base. A carry with an **empty destination
  list is a local prediction, not a piece with nowhere to go** — the server
  refuses that case outright rather than sending one.
- **Three tsconfigs, one per runtime** (decision 0021). Client gets DOM only,
  worker gets Workers only, tools get both. Do not collapse them back into one —
  the Workers globals shadow their DOM namesakes and the resulting errors name
  types with no bearing on the code. Resolved O-05.
- Full rules: `harness/AGENTS.md`. Stage tree: `npm run plan`.

## Running it

```bash
npm run build:client && npx wrangler dev --port 8799 --local   # the whole thing
node scripts/build-client.mjs --serve                          # client only, :8788
npm install --no-save playwright jsqr                          # then any driver
node scripts/drive-game.mjs                                    # two phones, a game
node scripts/check-deeplink.mjs                                # deep links, offline
node scripts/check-invite.mjs                                  # create, code, QR, share
node scripts/check-join.mjs                                    # joining, with no field
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
