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

### O-14 — Nothing drives the game list on the home screen
**Spotted:** 2026-09-08, stage 2.3.4
**Why it matters:** The list, the countdown wording and the tidy-up screen are
covered as pure functions (`test/game-list.test.ts`) and the whole server side is
covered in `workerd` (`test/worker/games.test.ts`), but the DOM in between is
covered by nothing. The specific things unverified: that tapping a row reaches
`showJoin` with the right code, that the tidy screen's checkboxes drive
`onForget`, and that the section is *absent* rather than an empty heading when a
phone is signed out — which is the state every real browser is in until `2.5.1`,
so it is the state most people would see first.
**Not doing yet because:** playwright is not installed in the container, and
there are already two written-but-never-run drivers (`check-fields.mjs`,
`check-invite.mjs`). Writing a third unrun driver adds to a pile rather than to
the evidence. The moment any of them can be run, this is worth `check-games.mjs`
alongside them: sign in through the dev seam in two contexts, create a game in
one, and assert it appears on the other's home screen.

### O-15 — Signing in mid-game makes a player their own opponent
**Spotted:** 2026-09-08, stage 3.5.2
**Why it matters:** The seat key is now the `sub` when a request carries a
session and the body's `playerId` when it does not (decision 0033). A player who
creates a game signed out, then signs in and reopens the link, is no longer
recognised — `colorOf` is matching a `sub` against a stored UUID — so the join
takes the *other* seat and one person holds both. The game is then unplayable and
the only recourse is a new code.
**Not doing yet because:** the window is narrow and closes on its own. It needs
sessions to exist *and* sign-in not to be required, which is the gap between
`2.1`/`2.2` and `2.5.1`; today nothing in a real browser establishes a session at
all, so only the dev seam can reach it. **This must be closed before or with
`2.5.1`** — either by requiring sign-in before a game may be created, which is
what that stage is, or by adopting the seat: if a signed-in request carries a
`playerId` that matches a seat with no account on it, take that seat over
(rewriting `presence` with it) rather than looking for a free one.
