# Open observations

### O-01 — Mandatory sign-in can hard-block a game in the field
**Spotted:** 2026-07-25, decision 0014
**Why it matters:** Login-first with no fallback means a player who cannot reach
Google cannot play at all. The likeliest moment is the worst one: a friend scanning
a QR in a park on one bar, or an iOS home-screen PWA whose OAuth redirect hands off
to Safari and loses the context. The failure lands on the opponent, who did not
choose it, at the point where two people have already travelled to play.
**Not doing yet because:** The owner considered this and chose the simpler model
deliberately. Mitigations are already planned rather than hypothetical — long-lived
sliding sessions and a pre-flight expiry warning (stage 2.2), and inviting ahead of
time so sign-in happens on wifi (decision 0015). Logged so that if it does bite
during playtesting the evidence is framed, and the pre-analysed remedy
(login-first *with* a field fallback) can be adopted without re-arguing it.
**Updated 2026-09-16 (`2.5.1`) — this stops being theoretical today.** The gate
is built, so an unauthenticated launch now genuinely reaches a sign-in screen and
nothing else; until this morning the app simply let everyone in. One edge was
mitigated in passing (decision 0035, rule 2): the launch check has three states,
not two, so a phone that merely *cannot reach* the server opens the app rather
than being shown a sign-in screen it has no signal to complete. That covers the
returning player with a live session, which is the commonest version of this.
What it does not cover is the case this observation is actually about — a friend
who has never signed in, standing in a park on one bar — and nothing will, short
of the rejected fallback. Stage `2.2.4` (cache the identity for offline start)
narrows it further. Watch for it in phase 10.

### O-03 — Distance-travelled is client-reported and therefore trivially inflatable
**Spotted:** 2026-07-25, stage 0.6
**Why it matters:** Now that accounts are mandatory and the permanent record is a
headline feature (decision 0014, stage 2.3.5), the mileage total is something
someone might want to inflate. It is currently accumulated on the client and
piggybacked on position messages.
**Not doing yet because:** The server does store both position fixes for every
move, so a plausible lower bound on distance walked is derivable server-side from
data we already keep. That is probably the answer, but it is a phase 8 concern and
worth designing alongside the replay feature rather than bolted on now.

### O-07 — A predicate over a shared broadcast stream must identify itself
**Spotted:** 2026-07-26, stage 4.5.4
**Why it matters:** Twice now, a test has failed in a way that blamed the product
for a harness bug, and both had the same shape. `Client.next()` searches
*already-received* messages, and the DO broadcasts every state change to **both**
players, so any predicate loose enough to match the opponent's traffic matches it
instantly and silently returns the wrong snapshot.

The first instance: "wait until a carry exists" matched a state left over from the
opponent's carry, so `walked()` backdated a row that did not exist yet and the
place read as `implausible: 34 m in 0.0 s` — which looks exactly like a
plausibility-guard bug. The second: `lastMove.to === 'd5'` was already true from
black's `d7-d5`, so white's `e4xd5` returned black's move and the capture appeared
not to have happened.

Both were one-line predicate fixes. The danger is not the failure, it is the
plausible false diagnosis: the obvious "fix" for the first was to weaken a real
anti-cheat rule.
**Not doing yet because:** The two known instances are fixed and the pattern is
now written down, which may be enough. If a third appears, the fix is structural
rather than per-call — give every state snapshot a monotonic `rev` (the column
already exists) and have `next()` only consider messages newer than the caller's
last-seen rev. That would make a stale match impossible rather than merely
unlikely.
**Updated 2026-08-01:** there was a third, and it had been sitting in the suite
the whole time — the four-session-old flake in "lets both players move in turn"
(O-09) is this exact pattern in a test written before the pattern was understood.
Fixed by routing it through `move()`, which was already the answer. So the
trigger above has technically been met, but by an *older* instance rather than a
new one, and grepping for the shape found no others: every remaining
`carry !== null` predicate is in a test where only one carry ever exists. Leaving
the `rev` floor for a genuinely new fourth. The transferable lesson is the search,
not the fix: two instances found and fixed is a reason to grep for the pattern,
not a reason to consider it handled.

### O-08 — Standing on your back rank starts the game, with no confirmation
**Spotted:** 2026-07-26, first end-to-end browser run
**Why it matters:** Decision 0005 makes the start handshake *positional* —
"standing in their own start zone, verified server-side", an observable condition
rather than a button press. The implementation half-applied it: a relayed position
set `in_start_zone` but never re-checked whether that completed the handshake, so
two players who both simply walked to their ends waited forever, while one tapping
Ready started the game on the strength of the other's position. Now consistent:
`onPos` completes the handshake too.

The consequence is that **the clock can start while nobody is looking at a phone**.
Two people wandering near their back ranks while agreeing on a time control will
find the game already running. The Ready button is now a nudge — "check me now" —
rather than the thing that starts play.
**Not doing yet because:** This is what decision 0005 specifies, and it is the more
physical reading: you start by standing where you start. But it was decided before
anyone had walked it, and it is exactly the kind of rule that feels different
outdoors. Worth a deliberate look during `1.9.3`/phase 10 playtesting. If it does
bite, the fix is small — require an explicit `ready` while `staging`, and keep the
purely positional rule for `suspended`, where both players already know they are
resuming.

### O-10 — The service worker answers navigations the Worker would 404
**Spotted:** 2026-08-01, stage 6.0
**Why it matters:** The Worker serves the shell only for the routes in
`shared/routes.ts` and 404s anything else, deliberately, so a broken link does not
present as a broken app. The service worker answers **every** in-scope navigation
from the cached shell. Once it is installed it decides, so a returning visitor gets
a 200 and the app at `/nonsense` where a first-time visitor gets a 404. Measured
both ways in `scripts/check-deeplink.mjs`, which asserts the divergence rather than
leaving it to be rediscovered.
**Not doing yet because:** Offline there is no way to tell a real code from a typo,
and the app saying "no game with that code" is friendlier than a browser error
page — so the broad rule may simply be right. Narrowing it means duplicating
`parseAppRoute` inside `sw.js`, which is served raw and cannot import, or building
`sw.js` from TypeScript — a fourth runtime and so a fourth tsconfig under decision
0021. Neither is worth doing on a guess. Revisit if `6.2.5` (clear failures for a
bad code) finds the two behaviours actually diverge for a player rather than for a
test.
**Updated 2026-08-01 (`6.2.5` done):** they diverge, and the divergence is benign,
so this stays open and unfixed. A returning visitor at `/j/SHORT` now gets the
shell from the service worker, `parseAppRoute` returns null, and the client falls
through to the home screen; a first-time visitor gets the honest 404. Two
different answers to the same URL, and the friendlier one is the one that reaches
the phone most likely to be offline. What did *not* materialise is the case this
note was worried about: a well-formed code that names no game is now the client's
business either way — it asks the server and says "no game with that code" — so
the Worker's 404 was never the mechanism a player relied on. Revisit only if
something starts depending on `/j/<junk>` being distinguishable offline.
**Updated 2026-09-16 (`2.1`):** the divergence stopped being benign, once. Sign-in
is two full-page navigations to `/auth/google/…`, which are in scope, so the
navigation rule answered them from the cached shell — for every returning visitor
the sign-in button would have done nothing and Google's redirect back would have
been swallowed, with no error anywhere. Found by reading `sw.js` before deploying
rather than by losing an afternoon to it. Fixed with a two-line prefix exclusion,
which is *not* the `parseAppRoute` duplication this note baulks at: `/auth/` is a
literal prefix with nothing to keep in step. The general rule stays open and
unfixed. The lesson is narrower than the observation: **any new server-side path
that is reached by navigation rather than by `fetch` has to be excluded here**,
and there is now one line in `sw.js` where that list lives.

### O-12 — The distance floor is scaled by claimed accuracy, not observed scatter
**Spotted:** 2026-09-07, stage 1.9.3.5
**Why it matters:** `DistanceAccumulator` refuses to credit a hop shorter than
`ANCHOR_ACCURACY_FACTOR * reportedAccuracy`, which assumes a phone's true error
is about what it claims. The field walk says that assumption can be off by 16x —
3.4 m claimed, 0.21 m delivered — so on a good handset the floor is ~6.7 m and
throws away real walking. Replayed over the trace, the accumulator credits 84.0 m
of a 104 m walk at the current factor of 2, and 92.8 m at 1, with zero phantom
distance either way. Distance is the currency of the whole game (decision 0019),
so a systematic ~9% under-count on good hardware is not cosmetic.
**Not doing yet because:** the fix is not the constant. Relaxing the factor to 1
was tried on 2026-09-07 and reverted: the existing tests model a phone whose true
error really is as large as it claims, and at factor 1 that phone clocks up
~1525 m per hour sitting on a bench. Over-counting is worse than under-counting
here, and one good device on one day does not license removing the floor that
exists for bad ones. The real fix is to scale the floor by *observed* scatter —
the accumulator already keeps a smoothing window it could measure from — which is
a design change needing traces from more than one handset. Pairs with **O-03**,
which wants a server-side lower bound on the same number.
**Still open after O-33 (2026-09-24):** O-33's text said removing the reach
bonus would close this "by removal". It does not. Decision 0043 took accuracy
out of *reach*. This is the *distance counter's* floor, which guards against
phantom metres, and removing it would credit a phone on a bench ~1525 m an
hour. It still needs the observed-scatter design above.

### O-13 — A field the server refuses is re-pushed on every sync, for ever
**Spotted:** 2026-09-07, stage 2.3.3.2
**Why it matters:** `syncOnce` decides what to push by comparing each field's
`updatedAt` against the journal's `acked` entry, and a field the server rejected
never gets an entry — so it is dirty for ever and rides along in every
subsequent request. Deliberately so: the alternative, acking a field the account
does not hold, would make the next sync mistake it for one deleted on another
phone and delete it locally, which is the one outcome this whole design refuses.
The cost is a few hundred bytes per sync on a phone holding a corrupt field, and
`rejected` comes back on every response so nothing is silent.
**Not doing yet because:** it needs a third state in the journal — "the account
has seen this and will not take it" — and the only thing that can produce a
rejected field today is a bug in our own writer or a hand-edited store. Worth
doing if `rejected` ever turns out to be non-empty in practice; the fix is a
`refused` map beside `acked`, holding the `updatedAt` that was turned down, so
the field is re-offered when it changes and not before.

### O-16 — Two unbounded lists sit above the home screen's primary actions
**Spotted:** 2026-09-13, stage 2.3.4, by looking at a screenshot
**Why it matters:** Home is ordered readout → Your games → Your fields →
Calibrate → Play. Both lists grow, and everything a player came to tap is below
them. Measured in a browser at 480x900, "New game" sits at y=542 with no games,
y=709 with one, and **crosses the fold at three**; the fields list above it has
the same shape with a cap of two hundred. So a regular player eventually opens
the app and cannot see the button that starts a game.
**Not doing yet because:** the game list was capped at `HOME_SHOWN` on
2026-09-13, which bounds the new half of the problem — seven games now cost the
same page as five, with the rest one tap away — and that was the part this stage
introduced. The rest is older and bigger than one stage: the honest fix is
either to put Play above the lists, or to give both lists a collapsed default,
and both change a screen that three other drivers assert against. Worth doing
deliberately rather than at the end of a session. `scripts/check-games.mjs`
asserts the bound (home fits in two screens with seven games) rather than the
fold, so the constraint does not quietly regress in the meantime.

### O-17 — A session is written to KV and read back a second later
**Spotted:** 2026-09-16, stage 2.2.1
**Why it matters:** The OAuth callback writes the session record to KV and
redirects to `/`, where the client's first `/api/me` reads it back — typically
within a second. Workers KV is eventually consistent, with a documented
propagation window of up to 60 seconds. In practice the read is served by the
colo that performed the write and the record is there, which is why this is not
a bug anyone has seen; but a player whose two requests land in different colos
would be bounced straight back to a sign-in screen having just signed in
successfully, and on a mandatory-sign-in app that reads as a loop rather than as
a hiccup. Exactly the read-after-write window that made the UserDO a Durable
Object rather than KV in the first place (stage 2.3.2) — the difference is that
there it was on the critical path of every request, and here it is on the
critical path of one.
**Not doing yet because:** every fix costs more than the failure. A signed
stateless token would not need the read, but then it cannot be revoked, which is
the entire reason 2.2.1 specifies a stored record. A Durable Object would be
strongly consistent but wakes an object on every authenticated request, against a
100k/day budget. Retrying the read is guessing at a timeout in the one place a
player is already waiting. **Watch for it during the live sign-in test and during
phase 10 playtesting**: the symptom is signing in successfully and arriving back
at the app signed out, and it would be intermittent and unreproducible, so it is
worth recognising rather than debugging from scratch. If it does appear, the
cheapest honest fix is for the callback to hand the session straight to the
client rather than making it re-read — the callback already knows the `sub`.
**Updated 2026-09-16:** the first real sign-in, from a phone, did not hit this.
That is one data point and not a clearance — the failure is intermittent by
nature, so a single success is exactly what a latent version of this bug also
looks like. Keep watching.
**Updated 2026-09-16, again:** a second real sign-in, from desktop Firefox and
through the deployed gate, did not hit it either. Two for two, and still not a
clearance for the same reason: both were from the operator's own machines, which
will consistently reach the same colo, and this bug needs the write and the read
to land in *different* ones. So these two successes are close to no evidence at
all about the case that matters — a second player, somewhere else, signing in for
the first time. The first time somebody else uses this app is the real test.

### O-18 — The board shows an un-handicapped reach until the first snapshot lands
**Spotted:** 2026-09-16, while diagnosing a `check-invite.mjs` failure
**Why it matters:** `reachNow()` in `client/views/game.ts` draws the reach circle
from the GPS fix alone, and every input it needs has a no-snapshot fallback —
`deps.field` for geometry, `DEFAULT_REACH` for the config, and
`myReachBonusSquares(null)`, which returns **0**. So between the first GPS fix and
the first `state` message the board shows the *base* reach with no handicap on it:
3.2 m rather than 5.2 m on an 8 m field with a 0.25-square bonus.

It self-corrects within a second and only at board entry, which is why nobody has
seen it. But `reference/gotchas.md` names this exact failure as one the project
has already shipped once: a handicapped player is told a legal move is out of
reach, believes it, and walks further. A second of it is survivable; the shape is
not one to leave un-noted, because the obvious "simplification" — rendering reach
before the snapshot because a fix is available — is what produces it.

**How it was found, which is the useful part:** it masqueraded as a server bug.
`check-invite.mjs` asserted the handicap "survived the round trip" by reading
`[data-reach]` after waiting for *any digit*, which the pre-snapshot 3.2 m
satisfies — so the assertion **had never once passed**, at any commit, and looked
exactly like the server dropping the handicap and serving the default reach. Two
sessions' records say "all eleven drivers passed" on 2026-09-13; that is wrong
about this driver, and a note written from it would have sent someone bisecting
towards the reach redefinition (`bd3470a`) for a bug that was never there. The
server half is fine and now has its own test in `test/worker/game-do.test.ts`:
the bonus is stored per colour and does reach the snapshot.

**Not doing yet because:** the driver race is fixed (it now waits for
`[data-turn]`, which only leaves '—' once a snapshot exists), so the misleading
symptom is gone. The product flash is real but small, and the honest fix is a
decision rather than a patch: either the board renders no reach until the first
snapshot — which costs a visible '—' on entry and is arguably more honest — or
`deps` carries the bonus in from the invite so the first paint is already right.
Worth deciding when `2.3.5` or phase 10 brings someone back to this screen, not
in the middle of a stage about sign-in.

### O-19 — The browser drivers are not repeatable against accumulated local state
**Spotted:** 2026-09-16, during the first full driver run against the sign-in gate
**Why it matters:** Every driver assumes an empty world and nothing resets one.
Miniflare keeps its Durable Object and KV state in `.wrangler/`, so fields, games
and accounts accumulate across runs under the same `sub` — and the drivers that
*count* things eventually fail. `check-field` is the canary: it asserts "still one
field" and "without leaving the old one beside it", which a second run cannot
satisfy.

The cost is not the failure, it is **the diagnosis it invites**. Measured: a
second run of an unchanged commit gave 8/11, with `check-field` and `check-join`
failing 3 times out of 3 and `drive-game` 2 of 3 — deterministic enough to read as
a real regression, in three drivers that commit had not touched. The peer session
running it came within one step of reporting three phantom regressions; what saved
it was checking what the commit actually changed (docs and tests, no client or
worker source) and concluding it *could not* be the cause.

**Not doing yet because:** `rm -rf .wrangler` is a complete workaround, costs
nothing, and is now documented in `reference/container.md` as part of the runbook.
The real fix is a reset the drivers own rather than the operator remembers, and
there are two shapes and no obvious winner: a shared `resetWorld()` helper each
driver calls on entry (precise, but every driver has to remember it, which is the
same failure one level up), or a per-run `--persist-to` directory so `wrangler dev`
starts empty by construction and nothing needs remembering (cleaner, but changes
how every driver is launched and how the runbook reads). Worth deciding when
somebody is next touching the drivers as a group rather than in the middle of a
stage — and worth doing before anyone relies on a green run they did not watch.

### O-20 — The simulator panel renders underneath the sign-in gate
**Spotted:** 2026-09-16, stage 2.5.1, from a screenshot of the gate
**Why it matters:** `boot()` mounts the simulator panel before it asks who you
are, so a signed-out launch at `?sim=1` gets the gate *and*, below it, a working
SIM / Me / Opponent row, accuracy and jitter sliders, and a D-pad. Decision 0014
says an unauthenticated launch goes to a sign-in screen "and nowhere else", and
this is visibly something else.

It is not a security hole and does not reach a player: `?sim=1` is a client-side
query check, so it exists on the deployed origin too, but the panel only drives a
fake GPS — every API call still 401s without a session, and no *home screen* is
reachable behind the gate (the drivers assert exactly that). So this is honesty
and tidiness rather than exposure.

**Not doing yet because:** it looks like a one-line move and is not. The mount
sits above **two** early returns, not one — the field survey (decision 0022) also
returns before the gate, and it currently inherits the panel. Moving the mount
below the gate silently takes the simulator away from the survey, which is a
measuring instrument nobody would notice losing until they needed it outdoors;
mounting it in both places is two call sites for one panel. Neither is hard, both
want a browser to confirm, and this session had none. Do it with the next change
to `boot()`, and check the survey at `?survey=…&sim=1` afterwards rather than
assuming.

**Updated 2026-09-16 — the shape is decided, by the session that watched it fail.**
Use a **per-run `--persist-to <fresh dir>`**, not a `resetWorld()` helper. Three
arguments, and the first is the one that settles it:

- **The blast radius was wider than the counting assertions.** `check-field`'s
  "still one field" is the obvious victim, but `check-join` died waiting on
  `[data-reason]` and `drive-game` on `[data-board]` — neither is a count, and
  neither driver creates a field at all. Which residue broke those two was never
  identified. So `resetWorld()` would be *an allowlist of state somebody
  remembered to clear*, and the bug class here is state nobody remembered.
  `--persist-to` makes emptiness **structural rather than enumerated**, which
  covers the residue nobody could name.
- **A per-driver reset is an obligation every future driver has to remember**,
  which is the failure that already happened once this session: two drivers kept
  their own `signIn()` and were skipped when the preamble went into the other
  nine. A flag in the launcher cannot drift, because there is one of it.
- **Per run, not per driver.** The eleven run sequentially, and resetting at each
  driver's start would be more destructive than the problem warrants. A fresh
  directory per run guarantees the clean start without taking any position on
  whether a driver may depend on a predecessor.

**Do not delete the directory on exit.** The entire diagnosis above came from
being able to read 11 MB of accumulated `UserDO` sqlite *after* the failures;
auto-cleaning would have left three deterministic failures and no evidence. Use a
named per-run temp dir and print the path, exactly as the drivers already print
their screenshot directory.

**And `drive-game` is not fully exonerated.** On dirty state it went FAIL, PASS,
FAIL — the only one of the three that was not deterministic. Two clean passes is
consistent with state being the whole story but does not rule out an independent
race on top. **If it ever fails again on a verified-clean run, treat it as its own
bug rather than assuming this observation came back.**

### O-21 — Every distance on screen is metric, and the owner is American
**Spotted:** 2026-09-16, by the owner reading the word "metre" on screen
**Why it matters:** Distance is not a detail here, it is *the currency*
(decision 0019) — "you have walked 47 km playing chess" is the headline of the
permanent record `2.3.5` is about to build, and it is the most player-facing
number in the project. Square size, reach, field dimensions and the calibration
review are all in metres too. An owner who thinks in yards is reading their own
game in a foreign unit.

**Two separate questions, and conflating them would be expensive:**

1. **Display units** (metres vs yards/feet). A *display* concern only. Everything
   underneath must stay metric and would not change: `shared/geo.ts` works in
   metres because GPS does, the affine board is fitted in metres, and distance is
   accumulated in metres. A conversion anywhere below the view layer would be a
   bug factory. There is already a precedent for unit-free design that went well:
   decision 0031 made reach a count of **fractional squares**, so the game's main
   dial has no units at all and needs no conversion.
2. **British spelling** (`metre`/`normalise`/`centre`). A deliberate project
   convention — `harness/AGENTS.md` §9 mandates it in prose *and identifiers*.
   That is a different change with a different cost, and it reaches into function
   names and stored field names rather than into rendered strings.

**Not doing yet because:** the owner said "that is for later", and it is a
feature rather than a fault. Worth scoping alongside `2.3.5`, which is what makes
the number prominent enough to care about. When it is scoped: the setting belongs
on the **account** (UserDO), not the device, for the same reason fields do — it
should follow the player to their second phone. The call sites are few and
findable: `formatDistance` (`client/main.ts`), `describeSquares`
(`shared/field.ts`), the reach readout in `client/views/game.ts`, the calibration
review, and the reach and handicap notes on the create screen.

**The spelling half is cheaper now than later**, and gets more expensive with
every identifier added, so it is worth an explicit decision rather than drift —
the convention is documented, so changing it should supersede §9 rather than
quietly diverge from it.

**One design note for whoever scopes this, because it makes the change bigger
than a format string.** If the game goes imperial, the natural square size is
probably *not* a converted metric one. 8 m is 8.7 yd, which is a silly number to
read on a screen or to pace out; an American laying out a pitch would far more
likely want a round **10 yards**, which is a football field's own unit and is
pace-able. So the honest version of this is not "render metres as yards", it is
"offer field sizes that are round in the player's own units" — and that reaches
the calibration review and the create screen, not just `formatDistance`.

The good news is that decision 0031 already did the hard part: reach is a count of
**fractional squares**, not a distance, so it needs no conversion and no second
set of constants whatever the square turns out to be. The board geometry is fitted
in metres and stays that way; only what is *offered* and what is *displayed*
changes.

### O-22 — The codebase is half British, half American, on purpose for now
**Spotted:** 2026-09-16, decision 0036
**Why it matters:** Every string a player reads is American as of today, which was
the part that mattered and is done. Identifiers and comments are still British, so
the repository now has `myColour` next to `Color` and `normaliseJoinCode` beside
`unauthenticated`. Consistent-by-accident is fine; **inconsistent-by-accident is
what produces a `normalize` that silently shadows nothing and a `myColor` that is
a second variable**. AGENTS.md §9 now says "match the file you are editing", which
holds the line but does not end the split.

**Not doing yet because:** the owner's constraint was "I don't want bugs", and
this is ~615 lines across `src/`, `test/`, `scripts/` and the living harness docs
(~250 of them identifiers in `src/`). It is mechanical, but it is too large to
eyeball and was not worth landing on top of a stage that had just been deployed.

**The analysis is already done, so whoever picks this up should not redo it:**

- **There is no migration.** No SQL column, wire field, `localStorage` key or
  IndexedDB name carries a British spelling — every hit in `schema.ts`,
  `user-schema.ts` and `protocol.ts` is a *comment*. This was the thing that could
  have made it dangerous, and it is not there.
- **`harness/decisions/` and `harness/sessions/` must NOT be touched** (71 and 43
  lines). They are append-only and immutable by AGENTS.md §4; their spelling is a
  historical record. Only `plan/`, `reference/`, `observations/`, `STATE.md`,
  `AGENTS.md`, `README.md` and `CLAUDE.md` are in scope.
- **Three coupled surfaces**, each of which must change atomically or something
  breaks silently:
  1. `data-colour`, `data-colours`, `data-colour-note` — 4 occurrences in
     `client/views/create.ts` and 4 in `scripts/check-invite.mjs`, which selects
     on them. Not persisted, but src and driver must move together.
  2. `reason: 'cancelled'` — an internal union tag produced in `client/share.ts`
     and consumed in `views/invite.ts` and `views/field.ts`. Never displayed.
  3. `apiError('unauthorised', …)` in `worker/survey.ts` and `worker/identity.ts`
     — a machine-readable contract value with tests asserting on it. Note
     `index.ts` already uses `unauthenticated`, so this is inconsistent *today*.
- **Exported symbols** whose call sites all move at once: `normaliseJoinCode`
  (14 uses), `squareCentre`, `squareCentreLatLng`, `metresPerDegLng`, `normalise`
  (the vector one, in `geo.ts`), `resolveColour`, `ColourChoice`, `isInitialised`,
  and `metres` (the formatter in `views/game.ts`, which renders `m` and so is safe
  to rename).
- **Do not do a blanket `-ise` → `-ize` sweep.** `advertise`, `compromise`,
  `exercise`, `surprise`, `otherwise` and `precise` are spelled that way in both
  dialects. Use an explicit word list. `metre` → `meter` is safe by contrast:
  `parameter`, `diameter` and `perimeter` contain "meter", not "metre".
- **`grey` appears twice, both in comments.** Nothing in `app.css` depends on it.

Suggested order: exported symbols first with `npm run typecheck` after each, then
local identifiers, then the three coupled surfaces in single commits, then prose,
then the living harness docs. Then **re-run all eleven drivers from an empty
`.wrangler`** (O-19) — `check-invite.mjs` is the one that would catch a broken
`data-colour`.

### O-25 — A deferred automatic `ready` waits for the next GPS fix, not for the clock
**Spotted:** 2026-09-18, review of phase 7 (optional note)
**Why it matters:** `considerReady` in `views/game.ts` runs on a GPS fix or a
network event, never on the 1 s paint ticker. After an in-zone relay, `AutoReady`
gives the server `RELAY_CONFIRM_MS` (3 s) to confirm and then sends `ready`, but
only on the next call. A phone standing still still gets a fix about once a
second, so in practice this costs at most a second. A browser that throttles or
stops `watchPosition` while the handset is motionless, though (some do when
backgrounded or when there is no movement), would hold the `ready` until the
player moves, which is the stranded "checking with the server…" state that fix
was meant to remove.
**Fix, when wanted:** call `considerReady(false)` from the existing 1 s `ticker`
as well. It is idempotent and does nothing almost every time.
**Not doing yet because:** not seen. The simulator emits a fix every second, and
no real phone has run the handshake yet (stage 10.1).

### O-26 — A refused automatic `ready` keeps the latch for the rest of the episode
**Spotted:** 2026-09-18, review of phase 7
**Why it matters:** `AutoReady` latches when it sends, whatever the answer. If the
server refuses (its fix and the phone's differ at the edge of the zone), no
further automatic `ready` goes until the player leaves the zone locally, the
socket changes, or the status changes. Recovery then depends on the relay (which
speaks only after 2 m of movement) or the Ready button. Both work, and the
refusal is shown on screen with a distance, so the player is not left guessing.
But decision 0037 does not say this, and the obvious reading of "once per
arrival" is that an unanswered arrival is retried.
**Not doing yet because:** retrying a *refused* claim on a timer would spend
requests on a disagreement that a second identical fix will not settle. Leaving
it to the player is probably right. Record it in the next decision that touches
the handshake, or promote it if playtesting (10.4.4) finds people stuck on the
boundary.

### O-27 — Signing out hands this phone's fields to whoever signs in next
**Spotted:** 2026-09-18, stage 2.2.5 (decision 0039, rule 4)
**Why it matters:** Fields live on the phone first (decision 0013) and are not
owned locally by any account. When an account stops being this phone's — a
sign-out, or a launch that meets a 401 — the field journal is emptied so the next
account's first sync cannot delete them as "deleted elsewhere". The consequence
is that the next account to sign in on this phone *adopts* every field it holds
and pushes them into its own account. For one person switching Google accounts
that is harmless. On a shared family phone it gives one person's saved grounds —
places they repeatedly and predictably stand — to another person's account,
which is exactly the kind of edge decision 0017 exists to prevent. The account
screen says so before anybody signs out, but a 401 route gives no such warning.
**One case is undetectable today:** a switch to another account on a phone with
no remembered identity (storage cleared or refused, or a journal written before
stage 2.2.4 existed). `accountChanged` has nothing to compare the new `sub`
against, so the old journal survives and the new account's first sync can
delete the old account's acknowledged fields off the phone. Owner-tagged fields
close that too.
**And one multi-tab window:** a second tab still open as the old account can run
a field sync against the old journal in the moment between the new account's
callback and the first tab's `forgetAccount` — its request then carries the new
account's cookie with the old account's journal. Narrow (both tabs have to be
open and one has to sync in that gap), and closed by the same remedy.
**Remedy, when wanted:** owner-tagged local fields — each field on the phone
carries the `sub` that saved or synced it, sync pushes only the signed-in
account's own (plus untagged ones calibrated while nobody was confirmed), and
another account's fields are hidden rather than adopted or deleted. That keeps
0013 (nothing is ever lost) and 0017 (nothing is handed across) together.
**Not doing yet because:** a shared phone has not been seen, and the remedy is a
store schema change plus a sync rule change, which wants its own stage.

### O-28 — The gate crashes where `localStorage` throws
**Spotted:** 2026-09-18, review of stages 2.2.3–2.2.5
**Why it matters:** the gate path in `boot()` (`main.ts`, the `launch.kind ===
'gate'` branch) calls `createLocalStorageJournal()`, whose default parameter reads
the global `localStorage` *outside* `forgetAccount`'s try/catch. A browser whose
`localStorage` accessor throws (some private modes, blocked site data) therefore
throws on the way to the sign-in screen and renders nothing. The signed-in path
has always made the same call, so such a browser was already broken past the
gate; 2.2.5 moved the failure one screen earlier. The identity cache itself is
careful (`browserIdentityStorage` returns null), which is why this is easy to
miss.
**Fix, when wanted:** build the journal from the storage `browserIdentityStorage`
already resolved, or give `createLocalStorageJournal` the same try/null guard.
Not a one-liner, because the two types differ (`Storage` vs `IdentityStorage |
null`) and the signed-in path wants the same treatment.
**Not doing yet because:** not seen on any browser this game targets; found by
reading.

### O-29 — An expired dev token offline reads "It ends within the hour"
**Spotted:** 2026-09-18, review of stages 2.2.3–2.2.5
**Why it matters:** `expiryHtml` in `views/account.ts` passes `expiresAt - now`
to `timeUntil` for a dev account, and a remembered dev token that has already
expired gives a negative number, which `timeUntil` renders as "within the hour".
Dev only: a Google session in that state gets the "probably run out" notice
instead, and dev tokens are never renewed so nobody relies on the line.
**Fix, when wanted:** say "It has ended" when the difference is not positive.
**Not doing yet because:** it only affects the local test account, offline.

### O-30 — Piece outlines are the opponent's color, and a bishop can vanish
**Spotted:** 2026-09-20, the owner's first complete games outdoors (stage 10.1)
**Why it matters:** This is field evidence from real play, not a design worry.
Each piece is drawn outlined in the *other* side's color, and players repeatedly
had to stop and work out whose piece they were looking at. The bishop is the
worst case: on the square color that matches its own outline color it is hard to
see at all. Reading the board at a glance is the whole point of the board view —
a player is looking at a phone in daylight, mid-walk, deciding where to go next.
**Fix, when wanted:** Decide what the outline is *for* before changing it. If it
exists to separate a piece from the square underneath, it should take its color
from the square, not from the opposing side. Check the bishop specifically on
every square color, and check it outdoors rather than on a desk monitor.
**Not doing yet because:** it wants a look at the renderer and a real-daylight
check, not a quick color swap. It belongs with the other playtest findings (10.2).
**Update 2026-09-24:** built as stage `10.7` (decision 0045): the standard
cburnett set on mid-tone squares, a team-disc look behind a switch, and a
last-move tint. The outline now only separates a piece from its square and is
never the opponent's color. Stays open until the outdoor comparison
(`10.7.4`).

### O-31 — The host's clock kept rounding up to a whole number of minutes
**Spotted:** 2026-09-20, the owner's first complete games outdoors (stage 10.1)
**Why it matters:** Reported as "something funny going on with the host's clock —
it kept rounding up to an even number of minutes", so the clock looked flaky to
the person hosting. The clock is the one part of this game that must be beyond
suspicion, and it is also the part with the most room for a real bug: it is pure
functions over stored timestamps, reconstructed on every wake, and ticked locally
against a server-time offset (`src/shared/clock.ts`, `5.4.1`). A display that
jumps to a rounder number than the truth is the visible symptom of *either* a
harmless formatting choice *or* a recomputation landing on the wrong base.
**Fix, when wanted:** First establish which. Reproduce against `wrangler dev`,
watching the raw numbers in the snapshot beside what the screen shows. If the two
agree, it is the formatter; if they diverge, it is the clock, and that is serious.
Note the report says *host*, so the two seats may not behave the same — check
whether it is the creating device, the white seat, or the device that has been
connected longest.
**Not doing yet because:** unreproduced. It needs the numbers in front of you,
and it is the strongest candidate of the playtest findings for being a real bug.
**Update 2026-09-24 (stage `10.6`, decision 0044): a cause found and fixed.
Kept open until an outdoor game confirms it (`10.6.4`).** Reproduced in
`wrangler dev` by holding the server's answer to a place for two seconds.
While a place was predicted, the mover's clock jumped *up* to the balance
their turn began with. On a first move that is exactly the time control
(29:55 → 30:00 → 30:15). The prediction nulled `startedAt` without banking the
think; it now banks it at the tap. It hits whoever is moving, on either seat,
and shows only while the answer is in flight, which is seconds on one bar.
That fits "the host", who is White by default and moves first. It is a whole
number of minutes only on a first move, so "kept" is not fully explained.

Ruled out, by reading and by tests:
- **The server's arithmetic.** A DO test pins the balance on the wire after a
  move to the millisecond (`carry.test.ts`, "exact, unrounded balance").
  Reconstruction on wake and the pause and resume paths all bank exact
  milliseconds from stored columns.
- **Time control setup.** The presets are exact and the server takes
  `initialMs` as given. `initial_ms` (schema 5) feeds only the PGN.
- **The offset.** `estimateServerNow` adds locally measured elapsed time to
  `serverNow` and applies no offset. A snapshot arriving mid-tick simply
  rebases it.
- **The seat.** Nothing in the clock path depends on who created the game or
  how long a socket has been open.
- **The formatter** always rounded mm:ss down and could not round up a whole
  minute. The tenths rounded to nearest; they now truncate too (0044).
- **The frozen clock before the first move and during the handshake** shows
  the full time control. That is correct, and it may have contributed to the
  impression.

**For the next outdoor game:** tap either clock to show the debug readout. It
lists the server's raw balances, whose turn it is, the start instant,
`serverNow`, the offset and the age of the snapshot, beside what the screen
shows. It stays on across reloads until tapped again. A screenshot of it at
the moment the clock looks wrong settles whether anything is left.

### O-32 — Two players, two different fields, one game over the internet
**Spotted:** 2026-09-20, suggested to the owner during the first outdoor games
**Why it matters:** This is a feature idea rather than a defect, recorded here so
it is not lost and does not get built by accident. Today both players are on the
same ground, which is where every rule in this project comes from. Playing from
two separate fields would keep the walking and drop the co-presence. The fairness
problem has an answer already: shrink the larger field to match the smaller, so
both players walk the same distance for the same move.
**Before building anything, settle:** what a carry means when the opponent cannot
see you; whether the coarse opponent-position relay becomes a location leak to a
stranger rather than atmosphere for a friend (today it is broadcast to someone
standing next to you); what happens when one field is calibrated badly; and
whether the clock still reads as fair when the two walks are equal in meters but
not in terrain. The board is already not forced to be square (decision 0028), and
reach is already measured in fractional squares (decision 0031), so the geometry
side is less work than it sounds.
**Not doing yet because:** the owner explicitly wants it parked for future review
rather than confusing the current work. Phases 7–10 come first.

### O-35 — One account holding both seats writes one record row, not two
**Spotted:** 2026-09-19, stage 2.3.5 review
**Why it matters:** The record is keyed by join code, so if one account somehow
holds both seats of a game — two phones, one sign-in — the second seat's line
overwrites the first, and the game counts once, with whichever color pushed last.
Stage 2.5.1 makes this hard to reach (a seat is a `sub`, and `join` refuses a
second seat to the same one), so it is currently unreachable rather than
unhandled. It is worth writing down because the natural fix for it — keying rows
by `join_code + color` — is a schema change that gets much more expensive once
real rows exist.
**Not doing yet because:** it cannot happen today, and inventing the composite
key now would complicate every read for a case the seat rules already exclude.

### O-36 — A relay landing just after a ply loses the meters the cap clips
**Spotted:** 2026-09-22, stage 2.3.5 review
**Why it matters:** `creditTravel`'s ceiling is `MAX_PLAUSIBLE_SPEED_MPS` × the
window since the later of the player's last report and the last clock start, and
`last_clock_start_at` is re-stamped on every move. So a report arriving a few
hundred milliseconds after a ply is credited at most a sprint for those
milliseconds, and the rest of what that leg had genuinely added is not carried
forward — `seenM` moves to what was reported either way. It is small (the walking
of one relay interval, at most), always in the under-counting direction, and it
stacks with the two hops decision 0040 already concedes.
**Fix, when wanted:** carry the clipped remainder forward instead of dropping it
— keep it in the presence row and pay it out under the next window's ceiling.
That turns the cap into a rate limiter rather than a discarder, and it should be
done with O-03's server-side lower bound rather than on its own.
**Not doing yet because:** the whole residue is 1–3% of a game and one way; the
fix adds a column and a second accumulator to save a fraction of that.

### O-37 — A live link, so friends can watch the game from the sofa
**Spotted:** 2026-09-23, the owner's wish list after the first outdoor games
**Why it matters:** A spectator link is the one feature that lets somebody who is
not walking see the point of this game. Two people in a field already know what
they are doing; everyone else has to be told about it. A link a player can send
before starting — opened on a phone indoors, showing the board, both players
moving across it and the clock running — is the cheapest possible answer to
"what *is* that?", and it is the same argument decision 0019 makes for the record:
the shareable artifact is the reason the rest is worth building.
**What it probably is, technically:** read-only fan-out from the GameDO, which
already broadcasts every snapshot to the two seats and already relays coarse
opponent positions. A watcher is a third WebSocket that receives and never sends.
The pieces exist (`'staging'`/`'active'` snapshots, the position relay, the join
code, the QR and share-sheet encoders from 6.1.3/6.1.4). The nearest existing
work is `8.5` (the social layer) and `7.3` (rejoining), but neither covers live
viewing, so this wants its own stage rather than a child of either.
**Settle before building:**
- **Cost.** Outbound broadcast is free of request charges, but every watcher is a
  live WebSocket against a free-tier budget written for exactly two seats
  (`harness/reference/budget.md`). Decide a cap, and what the DO does past it.
- **Location privacy.** The relay today is atmosphere for someone standing beside
  you; a public link turns it into a live broadcast of where two people are
  standing. **This is the crux.** Options worth weighing: show both players in
  board space only, the way `8.5.1`'s share card already must; hold the link to
  people the player sends it to rather than anyone with the code; or let the
  players turn watching on per game, off by default.
- **Which link.** Reusing the join code would let a watcher take a seat, so a
  watch link needs its own token — and `O-34` already notes the join code hands a
  game's field to anyone holding it.
- **Delay.** A small deliberate lag would stop a watcher indoors from coaching a
  player in the field by phone. Worth deciding before somebody tries it.
**Not doing yet because:** it is a new feature with a real privacy decision in the
middle of it, and phases 8–10 are queued ahead. Logged now so the idea survives.

### O-38 — The phone's distance counter strands up to a hop at every stop, and chess is all stops
**Spotted:** 2026-09-23, stages 8.1/8.2 (the review screen put the two numbers side by side)
**Why it matters:** `DistanceAccumulator` (`client/gps.ts`) credits a hop only once
the smoothed position is a floor — `max(4 m, 2 × claimed accuracy)` — from its
anchor. When a player stops, whatever is short of the floor stays uncredited, and
the next walk measures from the old anchor: in the same direction that is
recovered, but a chess player turns at every lift and every place. In a
`check-review` run of Fool's mate the review read **"You covered 46 m"** above
**"60 m carrying"** — the carrying figure is measured by the server between the
lift and place fixes — and over four runs the phone counted 58.5–71 m since the
start against about 95 m walked (e8→e7→e5, e5→d8, d8→h4). Before the start, 48 m
counted of a ~65 m walk. The server's credit is not the cause: after decision 0041
it pays all but a steady 12–14 m of what the phone counts, and the spread between
runs is entirely in the counter. So the headline a player repeats
(8.2.2) is now mostly short because of the counter, and on a stop-start game the
shortfall looks like a third.
**Not doing yet because:** it is decision 0020's accumulator and O-12's floor, and
the fix is a design change rather than a constant — e.g. confirming the pending
remainder at a lift or place (a stop the game already knows is real), or measuring
the floor from observed scatter as O-12 proposes. Either wants traces from real
handsets, not the simulator, whose paths are straight lines with no jitter. The
server-measured `carriedM` between fixes is an independent lower bound on part of
the walk and could be compared against it first (O-03 wants the same).
**Already done about it:** the review screen's per-player total of carries ("60 m
carrying") was taken off in 8.2, because it sat under a smaller headline and read
as impossible on the screen meant for sharing; the longest carry and the per-move
rows stay, being single carries. The O-12 honesty sentence also lost its "around
a tenth" and now says it counts short, more so with stopping and starting. The
total can come back once the counter no longer runs below the straight-line sum of
the carries on stop-and-start play — measured on real handsets, not the simulator.
Since then the walked figure itself is floored by the player's summed carries
(decision 0041, rule 8), so the screen, PGN and record can no longer read below a
carry — but that hides the counter's shortfall behind the floor on stop-and-start
games rather than fixing it. The counter is still the problem this observation is
about.

### O-39 — After a lift or a place, the next relay can be throttled and the dot goes stale
**Spotted:** 2026-09-23, round 2 review of stages 8.1/8.2
**Why it matters:** since decision 0041 a lift or place with a counter moves
`last_pos_at` (so the travel windows never overlap), and `onPos` throttles against
that same column with `POS_SERVER_MIN_INTERVAL_MS` (1.5 s). A relay arriving
inside 1.5 s of a lift or place — including a *refused* one — is dropped whole, so
the opponent's dot can sit a few meters stale until the player moves far enough
to send another. The distance is not lost (the next accepted report credits the
difference), and AutoReady at worst waits for its 3 s fallback.
**Fix, when wanted:** throttle `onPos` against the time of the last *relay*
rather than the last fix of any kind — a separate column, or `last_seen_at` if
its other readers allow it — while `travelFrom` keeps measuring its window from
`last_pos_at`.
**Not doing yet because:** cosmetic and short-lived, and it wants a schema column
or a careful read of `last_seen_at`'s other uses, which is more than a review
round should carry.

### O-40 — Empty Durable Objects that the code before 8.4 left behind still exist
**Spotted:** 2026-09-23, stage 8.4 (decision 0042)
**Why it matters:** until 8.4, `GameDO` applied its schema on every wake, and
collection re-created the empty schema after `deleteAll`. So every code ever
peeked, typed wrong, or collected as unclaimed on the deployed Worker left an
object holding empty tables and a `meta` row, and that object will never go
away by itself. 8.4 stops new ones being made. It cannot find the old ones: a
Durable Object namespace cannot be listed.
**Fix, when wanted:** none needed for storage (a few dozen bytes each). If one is
ever woken by a `gc` alarm, `onCollect` already destroys a table-only object.
A sweep would need a list of codes, which the platform does not give us.
**Not doing yet because:** harmless, and not reachable.

### O-41 — Forgetting a game does not delete its archive, and a player cannot delete one
**Spotted:** 2026-09-23, stage 8.4 (decision 0042)
**Why it matters:** a finished game's archive (PGN plus board-space report, no
coordinates, no accounts) is kept with no expiry. Forgetting it from "Your
games" (2.3.4.2) only removes the pointer, and the review stays reachable by URL
for the two players. The privacy statement says deleting a finished game's moves
is "not possible yet". That is true, and it is the gap.
**Fix, when wanted:** a player-initiated delete. It needs a rule for the other
seat, since the archive is shared by two people. Probably: delete only when
both have forgotten it, or keep one copy per seat.
**Not doing yet because:** out of 8.4's scope, and the archive holds nothing
locating.

### O-42 — An unplayed game's index row survives if one player's account cannot be reached at collection
**Spotted:** 2026-09-23, stage 3.6.2 review
**Why it matters:** `dropIndex` swallows a failed `dropGame` and the object then
deletes itself. So a player whose account was unreachable at that moment keeps
a row in "Your games" that points at nothing. Tapping it gives "No game with
that code", and the row (status `staging`) cannot be forgotten, because only
finished games may be.
**Fix, when wanted:** retry the drop through the `gc` timer before deleting, as
`retire` does for record lines. Or let `forgetGames` remove a row whose game
answers "not found".
**Not doing yet because:** it needs an account outage at the exact moment of a
monthly collection of a game nobody played.

### O-43 — A 3D first-person board, as an option you can switch off (parked idea)
**Spotted:** 2026-09-24, the owner's idea
**Why it matters:** a fully virtual 3D board and pieces, scaled so the pieces
look taller than the viewer, which you appear to walk on, with the view driven
by the phone's GPS and motion sensors. Not a camera overlay (AR): the player
looks around the phone at the real world. Worth a try later as a switchable
view; if it doesn't work well, it stays off.
**Feasibility:** three.js, with freely usable models (Kenney's board-game pack
is CC0, and there are Sketchfab Staunton sets) or pieces built in code.
- **The hard part is heading.** The phone's combined compass, gyroscope and
  tilt reading is typically only 5–15° accurate, and worse near metal. 5° at
  20 m is about 1.7 m, nearly a square. Plan: the gyroscope for quick turns,
  the compass for slow correction, heading from GPS walking direction to
  correct drift, and a "face your king and tap" realignment as the fallback.
- iPhones need a tap to grant motion-sensor permission. There is a battery cost.
- The opponent's position is only the coarse relay. Never stream GPS for it.
**Not doing yet because:** behind the current work.

### O-44 — The carried piece should travel with the dot on the 2D board (idea, later phase)
**Spotted:** 2026-09-24, the owner's idea
**Why it matters:** while a piece is lifted, draw it on the carrier's dot and
dim its origin square, so the carry is visible as a carry. This applies to your
own carry (known locally) and to the opponent's (the server knows the lift, so
show it on their relayed dot). No new traffic.
**Not doing yet because:** a later phase; behind the current run.

### O-45 — `game-do.test.ts` "repeats the last relayed position in the snapshot" is flaky
**Spotted:** 2026-09-24, the O-33 review
**Why it matters:** the test at `test/worker/game-do.test.ts:478` does not wait
for the `pos` message to be handled before black connects, so it races. It
failed once in two runs in review. It predates O-33. A flaky test teaches
people to ignore red.
**Fix, when wanted:** wait for evidence the relay was stored (the opponent's
`opp` frame, or a read of the presence row) before connecting black.
**Not doing yet because:** out of O-33's scope.
