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
