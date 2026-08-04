# Where the project is

*Rewritten every session. Short by design — the plan holds the detail, the session
files hold the history.*

**Tree state**: clean, pushed to `main`
**Active stage**: none — **phase 6 is closed**. Phases 0, 3, 4, 5 and 6 are done,
and `1.2` was rebuilt on four-corner calibration (decision 0028).
**Next action**: phase 2, and **not at `2.3.4`** — that stage is a child of the
UserDO, which is still a 29-line stub. Build phase 2 bottom-up, ending at OAuth:
`2.5.2`'s dev seam, then `2.3.1`/`2.3.2`, then the index. See below.
**Last session**: `harness/sessions/2026-08-03-03.md`

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
ground, because the field travels back with the seat. **548 tests pass, and
`carry.test.ts` no longer flakes — O-09 and O-11 are both closed, and all three
were races between a test and the Durable Object's own handlers.**

**The game is playable, and a whole game has been played through it.** Two
browsers against a real `wrangler dev`: calibrate a field, create a game, join by
code, both walk to their back ranks, then nine moves to a pawn on the seventh —
`1.h4 g5 2.hxg5 a6 3.g6 a5 4.gxh7 a4 5.hxg8=N`, underpromoting to a knight
through the picker.

What is missing is reach, not plumbing. Phase 6 is now what decision 0015
describes in both directions — you can hand someone a link and they can follow
it — and `6.2` is closed: **the camera works where the browser allows it, and
where it does not we ship nothing** (decision 0026). Android Chrome gets a real
viewfinder through `BarcodeDetector`; an iPhone gets one sentence pointing at the
Camera app, which reads a QR and offers the link in fewer taps than our own
scanner would need. The bundle that fallback would have cost was measured, not
guessed: jsQR is 45 KB gzipped against the whole app's 27 KB.

**`6.4` closed the phase: a field is now a thing you can send.** `/f/<blob>`
carries the whole field — twelve bytes of geometry, provenance, and a name — so
opening one is arithmetic rather than a request, and it works on a phone with no
signal and on a sign at the park. It arrives as a copy the recipient owns
outright, which needed a screen it did not have: tapping a field now opens one
that can share, rename, re-calibrate and **delete** it. Copies de-duplicate by
lineage, so a re-calibration arrives as an improvement to the field you have
rather than as a second entry beside it. **And the joiner keeps the field they
played on** — decision 0027, the question `6.3` deliberately left open, answered
yes and without asking. `scripts/check-field.mjs` is the seventh driver and the
only one where both ends of a share are real: the QR is decoded out of a
screenshot of the sender's screen and the URL that comes back is the one the
receiver's browser is then pointed at.

**The clock is done, and most of it was done before this session started.**
`5.1`–`5.3` went in during phase 4, because a move cannot be applied without
banking time, handing over and re-arming the flag — the code was written and
tested and nobody marked the stages, so this file recommended "phase 5, the DO
half is not written" for five sessions at a DO half that was written. Audited
against the source on 2026-08-02; `harness/plan/05-clock.md` names the evidence
per stage. What was genuinely missing was the client half, `5.4`, which is now
written: both clocks on screen, ticking locally for zero messages, red under a
minute, and a buzz and a beep for a phone that is in a pocket.
`scripts/check-clock.mjs` proves the screen half in Chromium.

**The board is no longer forced to be square (decision 0028).** The owner
challenged two-tap calibration — four corners, not a diagonal — and the challenge
held up under measurement: over 400 simulated calibrations at 3 m per tap, two
taps misidentify **22.3%** of squares against four taps' **11.9%**, because two
taps use half the available measurements. Calibration now walks the perimeter —
a1, h1, h8, a8 — and fits a **least-squares affine** map, so a board can be a
rectangle or a parallelogram laid into a real pitch. Verified for real by
`scripts/check-calibrate.mjs` on a 12 x 6 m board, walked through the UI and then
stood on square by square. Every field, game and link made before it still reads
as the square board it was calibrated as.

**`5.3.4` closed phase 5, and settled O-04 with it (decision 0025).** Either
player may pause; the game freezes indefinitely, keeps the position, puts a
carried piece back, and either player may resume by the back-rank handshake. The
game records **who** stopped it, and after **30 days** the *other* player may
claim the win by a button — never automatic, never expiring, and still
overtakeable by an opponent who turns up on day 40 with an apology. Games are no
longer deleted on any timer, and the three-way messaging was checked in two
browsers against a real `wrangler dev`.

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

**`2.3.4` is not the next stage, despite five sessions of this file saying so.**
It is a child of `2.3`, the UserDO, and `src/worker/user-do.ts` is still the
stub that returns `notImplemented`. The UserDO is addressed by `getByName(sub)`
— the Google `sub` claim — so a game index cannot be built before something
decides who owns it. `2.1` and `2.2` come first, logically.

But `2.1` needs the operator (below), so **build phase 2 bottom-up and leave the
live Google round-trip until last**, so the operator dependency blocks one stage
rather than the whole phase:

1. **`2.5.2` — the dev and simulator test seam.** Planned already, dev-only,
   never reachable in a deployed build. Doing it *first* rather than last is the
   whole trick: it is what lets `2.3` be written and tested with no Google
   round-trip, and every browser driver keeps working while identity exists.
2. **`2.3.1`, `2.3.2` — the UserDO proper.** Schema and addressing. Note the
   asymmetry that needs a comment in the schema: indexed player → fields, never
   field → players (decision 0017).
3. **`2.3.4`, the game index** — now reachable. Since decision 0025 a game can
   sit suspended for a month and **its join code is the only handle on it**,
   which is what makes this load-bearing rather than bookkeeping. `2.3.4.1`
   lists suspended games with the claim countdown; `2.3.4.2` offers to clear out
   old ones and must never be able to remove one that is still claimable.
4. **`2.3.3.2`** — move saved fields off local storage and onto the UserDO. This
   is where `2.3.7.4`'s shared copies land too: one migration, not two.
5. **`2.1`, `2.2`** — the real OAuth exchange and sessions. Last, because this is
   the part that cannot be finished in a container.

Blocked on the operator, in the same category as each other:

- `2.1` — a Google Cloud OAuth client, the `client_secret` into a Worker secret,
  and redirect URIs registered for a deployed origin. `1.9.1` (`wrangler login`,
  first deploy) has never happened, so there is no deployed origin to register.
- `1.9.3.4` — the walk. Needs Cloudflare access and ~30 m of open ground.
  **Not a gate** (decision 0023) — it sizes the squares, it does not decide
  whether the game works. Do not hold anything for it.
- `1.9.3.5` — fold the findings back into square size and the reach constants.

## Things a new thread should know before touching anything

- **A move is a lift, a walk, and a place** (decision 0001).
- **A board is four tapped corners, fitted affine** (decision 0028), and it may
  be a rectangle or a parallelogram. The two things not to undo: the fit is
  **least-squares, not an interpolation through the taps** — an interpolation
  turns GPS error into the permanent shape of the board — and board space is
  **two types, not one**. `BoardPoint` is metric (metres, rigid frame, safe to
  measure with); `BoardIndex` is which-square (affine inverse, never metric). On
  a 12 x 4 board one step along a file and one along a rank differ by 3x, so a
  `Math.hypot` over indices is meaningless. Collapsing them back into one type
  would silently restore the squares-are-square assumption everywhere.
- **Two-corner fields still exist and must keep working.** Every field saved
  before 2026-08-03, every game in flight, and every `/f/<blob>` link already
  printed reads as the square board it was calibrated as. `deriveGeometry`
  branches on whether `h1`/`a8` are present; the link format still writes the
  short two-corner layout whenever it is enough, so a square board's QR did not
  grow.
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
- **The phone's clock and the server's are different clocks**, and the client must
  never compare a stored timestamp against `Date.now()`. Elapsed time is measured
  locally and added to the server's own `serverNow` — `estimateServerNow` in
  `client/clock.ts` is the one place that arithmetic lives, and `net.ts` does the
  same conversion for the opponent's last fix. Getting it wrong does not look like
  a bug at first: the clock ticks, it is simply wrong by however far the handset
  drifts, and the two phones disagree about whether anyone has flagged.
- **A stage built as a side effect of another stage never gets marked**, and the
  cost compounds. `5.1`–`5.3` went in during phase 4 — a move cannot be applied
  without banking time and re-arming the flag — so this file recommended writing
  them for five sessions after they were written, tested and playing games. Before
  recommending the next phase, grep for its identifiers rather than trusting the
  previous session's "Next" list. **This has now happened twice**: `2.3.7`, the
  whole of field-link sharing, was built by `6.4` and sat `todo` for three
  sessions, because phase 6 needed a field to travel with an invitation and that
  *is* `2.3.7` entire. Twice is a pattern, so the rule is now stronger than
  "grep before recommending": **when a phase borrows work from a later one, mark
  the later one in the same commit.** The borrowing is not the problem — writing
  the stage where it was needed was right both times. Not marking it is.
- **Whoever stopped a game cannot also win it by default** (decision 0025), and
  this is the one part of the claim rule that must not be simplified. The obvious
  implementation — "you may claim if your opponent is not connected" — inverts it
  completely, because after thirty days *nobody* is connected, so the player who
  walked off could open the app and claim against the one who stayed. `suspended_by`
  is written at the moment of suspension precisely so that they can be excluded.
  If both vanished at once, neither may claim.
- **Nothing deletes a played game any more** (decision 0025). `FINISHED_GAME_TTL_MS`
  and `ABANDONED_GAME_TTL_MS` are gone, and the `gc` timer is *cancelled* when a
  game finishes rather than scheduled. A fourteen-day TTL and a thirty-day claim
  window cannot both exist: the game would be destroyed a fortnight before the
  button appeared. The only thing that still expires is an unclaimed join code, at
  30 minutes, because nobody has played anything yet.
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
  "save a field". Since 6.4 it *does* keep a copy of the field (decision 0027),
  which was that stage's open question.
- **A shared link is always asked about; a game's field never is** (decision
  0027), and the asymmetry is the decision rather than an oversight in it. A link
  is a message — opened out of curiosity, forwarded three times, tapped by
  someone nowhere near the place. A seat is an act, followed immediately by an
  hour of walking that exact ground. Do not "make them consistent"; making the
  join ask puts a dialogue between a tapped invitation and a board, at the worst
  possible moment, and it will be dismissed unread.
- **Copies of a field de-duplicate by lineage, and the key is inherited, never
  re-derived.** `FieldOrigin.key` is an eight-byte digest of the *original*
  field's id, carried forward by every copy, so A → B → C still matches A.
  Re-deriving it at each hop is the obvious simplification and it silently stops
  the matching after one forward — at which point a weekly fixture on the same
  common leaves one field per game. `fieldKey()` in `shared/fieldlink.ts` is the
  one place it is computed, and it falls back to the field's own id so that a
  sender recognises their own link coming back.
- **h8 travels as decimetres of east and north, not as degrees.** A degree of
  longitude is a different distance at every latitude, so quantising degrees puts
  a square-size error into the link that varies with where on the planet you are.
  Two bytes per axis of metric offset is uniform, and 0.1 m on the diagonal is
  0.01 m on a square edge.
- **A truncated field link usually still decodes**, because the name is at the
  end of the blob. Cutting the last few characters removes part of the *name* and
  leaves the geometry intact, so a test that truncates a link to prove the error
  screen works can quite happily assert against a successful decode. Cut into the
  header (under ~31 characters of blob) to get a real failure.
- **Decision 0016 promised rename, re-calibrate and delete before any of them
  existed.** They live on `views/field.ts` now, reached by tapping a field on
  home. If a future change moves that screen, those three go with it — a field
  that arrives on a phone with no way to be rid of it is not a gift, and it is
  what makes decision 0027 defensible.
- **Do not ship a QR decoder** (decision 0026), and the missing iOS scanner is
  not a gap to be closed. jsQR is 45 KB gzipped against the whole app's 27 KB,
  the service worker would precache it onto a phone on one bar, and the iPhone's
  own Camera app already reads the QR and opens `/j/CODE` in fewer taps than our
  scanner would take. `scanAdvice` exists so the absence is explained rather than
  silent. The one thing that would change this is Safari shipping
  `BarcodeDetector` — at which point the capability check already routes to the
  real scanner and the advice stops rendering by itself.
- **A camera track outlives the screen that showed it.** Clearing `srcObject`
  does nothing; only `track.stop()` turns the lens off, and the case that gets
  missed is a teardown *during* the permission prompt, where the stream arrives
  after the screen has gone. `startScan` returns its stop function synchronously
  for exactly that reason, and `check-scan.mjs` asserts `readyState === 'ended'`
  on real tracks rather than trusting the code to look right.
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
- **There is a seventh: `scripts/check-field.mjs`**, and it is the only one where
  **both ends of a share are real**. The QR is decoded out of a screenshot of the
  sender's screen with jsQR, and the URL that comes back out is the one the
  receiver's browser is then pointed at — nothing in between is constructed by
  the test. Run it after anything touching fields, the home screen, or sharing.
  One trap in it: an empty `<ul data-fields>` has no height, so Playwright calls
  it hidden and a wait on it times out after the last field is deleted. Wait for
  `[data-calibrate]`, which is always on home.
- **There is a sixth: `scripts/check-scan.mjs`**, and it injects a
  `BarcodeDetector` on purpose. Chromium on Linux ships none, so without the
  injection the driver could only ever test the *unsupported* path — the fake is
  the platform API, and everything on our side of it is real. The camera is
  Chrome's own fake device, which is what makes "was the track stopped?" a
  question with a real answer. It also reads pixels out of the viewfinder:
  `videoWidth > 0` says the stream has dimensions, not that anything is being
  painted, and the fake camera's pattern is dark enough that the first screenshot
  of a *working* viewfinder read as a black box.
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
node scripts/check-clock.mjs                                   # clocks, low time, tenths
node scripts/check-calibrate.mjs                               # four taps, a 12x6 board
node scripts/check-scan.mjs                                    # camera, advice, camera released
node scripts/check-field.mjs                                   # sharing a field, and keeping one
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
KV namespace creation — anything touching the Cloudflare API. So `1.9.1`, `1.9.3.4`,
`2.4` and the deployed-origin half of `2.1` are the operator's, from a local clone,
and they are the only things that are. Do not plan a session around getting a
deploy out of this container, and do not retry the 403 or route around it.

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
