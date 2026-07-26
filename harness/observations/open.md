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

### O-06 — Shell asset paths are relative, so deep links will break
**Spotted:** 2026-07-25, stage 1.8
**Why it matters:** `public/index.html` references `app.css`, `app.js`,
`manifest.webmanifest` and `icons/…` relatively, and `sw.js` precaches the same
paths as `./…`. Served from `/` that is fine. Served from `/j/ABC123` — the QR deep
link in phase 6 — the browser would resolve `app.js` to `/j/app.js` and the app
would not load at all. The same applies to the `/f/<blob>` field-share link
(decision 0016).
**Not doing yet because:** It is not merely a search-and-replace to absolute paths:
the service worker's precache list and its cache-first matching have to agree, and
the offline behaviour then needs re-verifying in a browser, which is how 1.5.2 was
validated. Phase 6 has to build and test deep-link routing anyway, so the fix
belongs there rather than being done blind now. Nothing before phase 6 serves any
path other than `/`, so this cannot bite in the meantime. **Do it as the first
stage of phase 6**, before the QR encoder, or the first scan will fail in a field.

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

### O-09 — `carry.test.ts` fails roughly one run in ten, cause unidentified
**Spotted:** 2026-07-26, stage 4.3
**Why it matters:** "lets both players move in turn" failed twice across about
fifteen runs of the suite, and passed thirteen. A test that fails one time in ten
erodes trust in the whole suite and trains people to re-run rather than read.
Two earlier flakes in this file had the same root cause — a predicate matching the
opponent's stale broadcast (O-07) — and both were fixed; this is not obviously the
same, because the failing test sends no `pos` messages and the most recent change
was to `onPos`. Not yet reproduced under diagnosis: eight consecutive targeted runs
came back clean.
**Not doing yet because:** Chasing it blind costs more than it currently returns,
and the suite is otherwise green at 285 tests. The structural fix proposed in O-07
would very likely close it too: give `next()` a monotonic `rev` floor so a stale
snapshot cannot satisfy any predicate. That is the thing to do if it recurs, rather
than another per-call patch.
