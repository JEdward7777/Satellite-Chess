# Things a new thread should know before touching anything

*Split out of `STATE.md` on 2026-09-08, which had grown to 563 lines against its
own "short by design" header. This list grows every session and is therefore
unbounded by construction — which AGENTS.md section 4 says makes it a reference
file rather than part of the current position. `STATE.md` says where the project
is; this says what will bite you when you touch it.*

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
- **The `sub` is the account's address, and `userFor` is the only place that is
  spelled out.** `env.USER.getByName(sub)`, exactly as a join code addresses a
  game — so there is no user table and nothing to go stale. A second call site
  that lower-cased the `sub`, or hashed an email, or used a player id, would
  silently address a *different and empty* object; the symptom is a player whose
  saved fields have vanished, not an error anybody sees. `UserDO.touch` throws if
  it is ever asked to hold a second `sub`, because the quiet version of that
  failure is one player reading another's fields.
- **There is deliberately no field → players edge anywhere** (decision 0017), and
  the `fields` schema is where that gets undone if anyone is careless. It reads
  as a missing index, and the obvious tidy-up — one shared table with an
  `owner_sub` column — restores the reverse lookup for free. A shared field is a
  place people repeatedly and predictably stand, so that edge is a list of where
  somebody can be found on a Sunday morning. `user-do.test.ts` asserts the
  forbidden columns are absent.
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
- **The field sync journal is not bookkeeping — it is the delete rule**
  (decision 0032). `client/field-sync.ts` keeps two maps in `localStorage`:
  `acked` (the `updatedAt` the account last confirmed for each field) and
  `removed` (deletes not yet sent). A phone may remove a field locally **only**
  when it appears in `acked` and is absent from the account's list; a field the
  account has never acknowledged is one it has not caught up with, not one
  deleted elsewhere. Delete the journal and the two cases become
  indistinguishable, so a field deleted on one phone is pushed straight back by
  the other, for ever. It is deliberately lossy in the safe direction: an empty
  journal resurrects at worst and can never lose a live field.
- **`lineage_key` is always the server's own answer, never the client's.**
  `bindValuesFor` computes it with `fieldKey(spec)` on the way into SQLite. Taking
  it from the request body would let a phone name any lineage it liked, and a
  field could then pose as a newer version of somebody else's and be offered as
  an update to it.
- **A saved field is written to the phone first and to the account after, always**
  (decision 0013, unchanged by 0032). Nothing in the sync path is awaited before a
  screen is shown. `createFieldSync` returns the store every screen uses, so
  calibrate, rename, re-calibrate, delete and "keep the field this game was on"
  all sync without knowing synchronisation exists — and all of them work with no
  session and no signal.
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
- **There is an eighth: `scripts/check-fields.mjs`**, and it is the first driver
  that needs an **identity**. Two browser contexts are two phones belonging to one
  person, signed in through the dev seam with `context.request` (which shares the
  page's cookie jar — the only way a driver can establish a session before stage
  2.1). It is the only check that can see the stage at all: a second phone is a
  second store, and every unit test in the suite shares one. **Never run** —
  playwright is not installed in the container.
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
