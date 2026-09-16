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
