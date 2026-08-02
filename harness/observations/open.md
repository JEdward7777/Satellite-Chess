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

### O-02 — Reach ceiling interacts with the handicap in a way that may be exploitable
**Spotted:** 2026-07-25, stage 0.4.2
**Why it matters:** A reach bonus raises the clamp ceiling as well as the base
reach, so a large handicap plus a poor GPS fix could let a player span a move that
ought to require walking. `effectiveReachM(100, DEFAULT_REACH, 10)` gives 25 m,
which on 8 m squares reaches three squares away from a standing start.
**Not doing yet because:** No field data on what handicap sizes people actually
want. Capping the bonus is the obvious fix but the right cap is a measurement, not
a guess. Revisit with stage 9.2.2 when `DEFAULT_REACH` is tuned from real games.
**Updated 2026-08-01 (decision 0023):** the root is the same as the flat `maxM`
ceiling — both are absolute metre values in a rule that should scale with square
size. Expect one fix for both: express the ceiling, and the bonus's share of it,
as a multiple of square size once `1.9.3.5` supplies a real one.
**Updated 2026-08-01 (stage 6.1.1):** there is now a UI that can set a handicap,
so the exploit is reachable rather than theoretical. `MAX_HANDICAP_M = 4` in
`client/views/create.ts` bounds what the control can produce — a *bound*, not the
fix, chosen so no game created today carries a handicap the eventual cap would
have to invalidate. `effectiveReachM(25, DEFAULT_REACH, 4)` is 19 m, which on 8 m
squares still reaches two squares from standing. The server enforces nothing:
`asNonNegativeInt` accepts any value a hand-rolled `POST /api/game` sends. Cap it
server-side when the real number is known.

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

### O-04 — Nothing decides what happens to a game whose opponent never returns
**Spotted:** 2026-07-25, stage 5.3
**Why it matters:** Suspension freezes both clocks indefinitely. A player whose
opponent simply walks away has a game that is neither won, lost, nor closable, and
it sits in their game index forever. There is a `ResultReason` of `abandoned` and an
`ABANDONED_GAME_TTL_MS` constant, but no rule for who gets the point or after how
long.
**Not doing yet because:** It needs a decision, not just an implementation — a
claim-the-win timer, a mutual-abandon draw, and the interaction with the permanent
record all have to be settled together. Promote to a stage in phase 5 once the
suspension path exists to hang it on.
**Updated 2026-08-02 (phase 5 audit):** the suspension path this was waiting for
already exists and has since phase 4 — `suspendForDisconnect` freezes both clocks
and sets `suspended`, and it was simply never marked in the plan. So the trigger
above has been met for some time. `5.3.4` (player-requested pause) is the one
stage left in `5.3` and is the natural place to settle this: a deliberate pause
and an abandoned game land in exactly the same frozen state, and giving them two
different rules would mean two ways out of one condition. Decide them together.

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

### O-11 — One unidentified suite failure, after O-09 was closed
**Spotted:** 2026-08-01, stage 6.3
**Why it matters:** Mostly so the next thread does not read it as "O-09 is back"
and re-derive a mechanism that has already been fixed. One `npm run check` run
reported `1 failed | 438 passed` and the name was not captured — the failure block
had scrolled past a `tail`. Twelve further full-suite runs were clean, including
two under 2x CPU oversubscription, and eight targeted runs of the worker project
before that.

What is known: the failing run took **69 s of test time** against a normal 18–30 s,
and it coincided with `wrangler dev` still running and a Playwright driver
finishing. The worker tests wait on `Client.next()` with a 2 s wall-clock timeout,
so a machine that slow is a plausible cause and the failure would then be the
harness rather than the product. That is a hypothesis, not a diagnosis — the
deliberate-load attempt did not reproduce it.
**Not doing yet because:** there is nothing to fix without knowing which test it
was. If it recurs, capture the whole vitest output rather than a `tail`, and if it
is a `next()` timeout, the fix is to scale that 2 s with an environment variable
rather than to chase it. Do not treat one failure as a reason to weaken an
assertion.
