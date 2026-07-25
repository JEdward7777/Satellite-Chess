# The original brief, verbatim

Preserved exactly as received on 2026-07-25. The project owner's framing at the
time: *"The draft was written up by Sonnet so take the whole thing with a grain of
salt and just take it as an initial cursory technical overview."*

**Where this conflicts with `harness/decisions/`, the decision wins.** What is now
known to be wrong is listed at the bottom of this file.

---

## Satellite-Chess — Implementation Brief

Real chess played on real ground. GPS maps a 64-square board onto a field; you may only touch a piece when you're physically within reach of its square, and you must also be within reach of the destination square. A chess clock runs throughout. Two players, both physically present on the same field, each on their own phone.

Stack: PWA (no native shell for v1) + Cloudflare Workers + SQLite-backed Durable Objects + Workers KV. Free tier throughout.

### Platform constraints that shape the design

Durable Objects on the free plan must use the SQLite storage backend. Use `new_sqlite_classes` in the Wrangler migration — `new_classes` (the legacy key-value backend) will fail to deploy with error 10097. This is not optional and not a preference; the KV storage backend is unavailable on free, and as of July 2026 new KV-backed namespaces are restricted even on paid accounts without an existing one. Free tier gives 5 GB DO storage and up to 100 DO classes.

Request budget is the real ceiling, not storage. Workers free is 100k requests/day, and on a hibernatable DO each inbound WebSocket message counts as a request. Streaming GPS at 1 Hz from two players over a 30-minute game is ~3,600 requests for a single game. That budget is the single most important architectural driver below.

WebSocket Hibernation is mandatory, not an optimization. Use `ctx.acceptWebSocket()` rather than `server.accept()`, so an idle game (players walking, thinking, resting) is not billed for duration. Consequence: never hold clock state in an in-memory `setTimeout`. All timing must be reconstructible from stored timestamps on wake.

### The message-budget decision (read this before writing any client code)

Naive design streams every position fix to the server so the server can validate reach. Don't.

Split it:

* Reachability for UI is computed client-side. The client already holds the field definition and the board state, so it can render the reach circle and highlight legal-and-reachable pieces at full GPS frequency with zero network cost and zero latency. This also means the UI keeps working through a network blip.
* The server only needs a position at the moment a move is submitted. The `move` message carries `{from, to, playerPos, accuracy, fixTimestamp}`. The DO re-validates reach against its own copy of the field before accepting. Client is untrusted; client is also the only one doing per-frame work.
* Opponent position is streamed, but coarsely — it exists so you can see your opponent jogging across the board, which is atmosphere, not correctness. Send only on meaningful change (moved > 2 m) and rate-limit to one message every 2–3 s. Interpolate on the receiving client.

Budget check: that's roughly 300–600 messages per player per game instead of 3,600.

### Durable Object topology

`GameDO` — one per game, authoritative for everything

Addressing: derive the DO id from the join code. `env.GAME.getByName(joinCode)` (or `idFromName`). This is the key simplification — there is no join-code → game-id lookup table, so no KV eventual-consistency race when someone scans the QR three seconds after the game was created.

Join codes: 6 characters of Crockford base32 (no I/L/O/U, case-insensitive), ~1e9 space. On join, the DO checks whether it's already initialized with two players and rejects if so — that handles the collision case. Expire uninitialized codes after ~30 minutes via alarm.

SQLite tables:

```
game        id, join_code, status, fen, field_snapshot_json,
            white_player_id, black_player_id,
            white_ms_remaining, black_ms_remaining,
            increment_ms, active_color, last_clock_start_at,
            created_at, updated_at
moves       seq, color, uci, san, fen_after,
            from_pos_lat, from_pos_lng, from_accuracy,
            to_pos_lat, to_pos_lng, to_accuracy,
            server_ms, clock_ms_remaining_after
presence    player_id, connected, last_seen_at, last_lat, last_lng, last_accuracy

```

Store move-time positions and accuracy. It costs almost nothing and gives you post-game review, a distance-travelled stat (a headline feature — "you covered 2.4 km"), and the only cheat-forensics you'll ever need.

`UserDO` — one per authenticated user, for saved fields and game index

Use a DO rather than KV for anything with read-after-write expectations. Saving a field and immediately loading it on the same phone is exactly the pattern KV's ~60 s propagation window breaks.

```
fields      id, name, corner_a_lat, corner_a_lng, corner_h_lat, corner_h_lng,
            bearing_deg, square_m, created_at, version
game_index  game_id, opponent_label, status, result, last_move_at

```

KV's actual role

Things that are TTL'd, cacheable, or write-once: session tokens, Google JWKS cache, a read-cache of field definitions for the "fields near me" list, and archived finished games (PGN + position track) once nobody needs them transactionally.

### Field model

Calibrate from two opposite corners — players walk to the a1 corner and tap, then the h8 corner and tap. Derive bearing and square size from those. Store the raw corner coordinates, never the derived projection, so the math can be revised later without invalidating saved fields.

Projection: local ENU tangent-plane approximation anchored at corner A (equirectangular with a `cos(latitude)` correction on longitude). Accurate to well under a centimetre over a few hundred metres — do not reach for a real geodesic library.

Snapshot the field into the game at creation (`field_snapshot_json`). A saved field is mutable and versioned; an in-progress or suspended game must not change shape underneath the players because someone re-calibrated on another phone.

Reach radius: `R_effective = R_base + reported_accuracy`, clamped to something sane (say 4–15 m). Render it as a translucent circle so the rule and its breathing are both legible. Refuse move submission outright when accuracy exceeds a hard threshold (~25 m) and say why.

### Clock

Authoritative in the DO. Never trust a client timestamp for anything but display.

Pattern: store `last_clock_start_at` and `*_ms_remaining`. On each accepted move, compute elapsed from stored server time, decrement, apply increment, flip `active_color`, restore. Recompute on every wake — nothing lives in memory.

Flag-fall via `ctx.storage.setAlarm()` set to the exact instant the active player would expire. Alarms survive hibernation, cost one request when they fire, and mean you don't poll. Re-set the alarm on every move.

Pause on disconnect. In OTB chess your clock runs regardless, but here a dropped connection is a network or GPS failure, not a decision. Rule: if either player is disconnected for more than ~20 s, suspend the game and freeze both clocks.

### Save and resume

The mechanic that makes this tricky is that player body position is part of the game state and cannot be restored. Whose turn it is matters less than where each player is standing, since that determines what they can reach.

Resolve it at the rules layer, not the engineering layer:
On resume, both players must return to their own back rank (or a designated start zone) and be confirmed present before the clock restarts.

That neutralizes any positional advantage lost or gained during the suspension, is trivially explainable to players, and reduces resume to a well-defined handshake:

1. Either player opens the game from their index → hits `GameDO`.
2. DO status `suspended`; it waits for both `player_id`s to be connected AND localized within the field bounds.
3. Both must report a position inside their own start zone. Client shows "waiting for opponent to reach their back rank."
4. DO sets status `active`, sets `last_clock_start_at = now`, sets the flag alarm, broadcasts resume.

Persist `game_id` in `localStorage` on both devices so resume works without login. Login is only needed for the cross-device game list.

Note the free-tier corollary: a DO whose storage is entirely empty ceases to exist. Suspended games with rows in SQLite persist fine — but do garbage-collect abandoned games on an alarm, or your 5 GB and your game index both rot.

### Auth

Anonymous-first. Requiring a Google login before a pickup game in a park is the wrong first experience. Generate a random `player_id` (UUID) in `localStorage` on first load; that's enough to create, join, play, and resume games on the same device.

Google OAuth exists only to persist across devices: saved fields and a durable game history. Prompt for it when someone taps "save this field," not at launch.

Implementation notes for Workers specifically:

* Authorization Code flow with PKCE. `client_secret` in a Worker secret binding; do the code exchange server-side.
* No Node crypto. Use Web Crypto (`crypto.subtle`) for PKCE challenge and session token signing.
* Because you exchange the code directly with Google over TLS, you may trust the returned ID token's payload without verifying its signature — per Google's own guidance for the server-side flow. This saves you implementing RS256 JWKS verification. If you later accept ID tokens from the client instead, verification becomes mandatory; cache the JWKS in KV.
* Session: HttpOnly, Secure, SameSite=Lax cookie holding an opaque token; session record in KV with a TTL.
* Identity key is the Google `sub` claim, never the email. `UserDO` is addressed by `getByName(sub)`.
* Claim-on-link: when an anonymous player first authenticates, migrate their local `player_id`'s fields and game index into the `UserDO`, and keep the anon id as an alias so in-flight games don't break.

### Client

* `navigator.geolocation.watchPosition` with `enableHighAccuracy: true`. Gate on the `accuracy` field, and detect the iOS "Precise Location" toggle being off (persistent accuracy in the 1000 m range) with a specific, actionable message — the generic permission prompt won't help them find that setting.
* Screen Wake Lock API. Non-negotiable; the screen locking mid-sprint kills the game.
* Server-authoritative rules, but run `chess.js` on both sides — client for instant legal-move highlighting, DO for the real decision. chess.js is pure JS and runs fine in a Worker.
* QR scanning: `BarcodeDetector` where available; Safari lacks it, so bundle a WASM fallback (`zxing-wasm` or `jsQR`). Always display the 6-character code as a typed fallback — it's smaller than the QR-scanner code path and it works when a camera permission prompt goes sideways.
* QR encodes `https://<host>/j/ABC123`.
* Service worker: cache the shell and the field definitions. A resumable game is worth more than a perfectly fresh asset.

### Deliberately out of scope for v1

Anti-cheat beyond plausibility checks (max implied speed, accuracy floor, positions logged for review) — both players are standing in the same field watching each other, so social enforcement is sufficient and real GPS spoofing defense is not worth building. Also deferred: more than two players, spectators, ranked play, background location, native wrappers.

### Build order

1. Field calibration + local board render, no network. Walk a field, tap two corners, see the 64 squares and your reach circle. This is where the concept succeeds or fails, so validate it before writing a single line of server code — including on a small field, in tree cover, and on a cloudy day.
2. `GameDO` with hibernatable WebSockets, `getByName(joinCode)` addressing, two clients joining, positions relaying. No chess yet.
3. Server-authoritative chess + reach validation at submit time.
4. Clock with alarms and disconnect suspension.
5. QR join flow + typed-code fallback.
6. Google OAuth, `UserDO`, saved fields, cross-device game index.
7. Resume handshake with the back-rank rule.
8. Post-game: PGN export, distance travelled, position replay over the board.

Steps 1–5 give a game you can actually play with a friend. Everything after that is persistence.

### Open questions worth deciding early

* Does a capture require reaching the victim's square (yes, by the both-ends rule) — and does that make capturing correctly expensive, or annoying?
* Castling and en passant: which squares must you be near? Suggest king's origin and destination only, and ignore the rook.
* Is the reach radius symmetric for both players, or a handicap knob for mismatched fitness? A handicap here is more humane than a clock handicap.
* Pawn promotion involves no travel and should probably stay a pure UI choice.

---

## What is now known to be wrong or superseded

| Brief says | Reality | See |
|---|---|---|
| Reach to both ends of a move, at one instant. `move` carries one position. | Makes every long move physically impossible — `Ra1-a8` needs 24 m of reach against the brief's own 15 m ceiling. A move is a lift, a walk, and a place, carrying two position fixes. | [0001](../decisions/0001-two-phase-carry.md) |
| Projection "accurate to well under a centimetre over a few hundred metres". | ~4 cm over 400 m, measured against haversine. Conclusion unchanged — still far below GPS noise. | [geometry.md](geometry.md) |
| Anonymous-first; prompt for Google only at "save this field". | Sign-in is mandatory before playing, so that play, results and distance accrue to a permanent record. Identity moved from build step 6 to phase 2. | [0014](../decisions/0014-accounts-are-mandatory.md) |
| Calibrate from "the a1 corner" and "the h8 corner". | The taps are the square *centres*, which is a thing two people can actually stand on. | [0002](../decisions/0002-calibration-taps-are-square-centres.md) |
| (Silent on how reach distance is measured.) | To the nearest point of a square, not its centre — otherwise you cannot reach the square you are standing on. | [0003](../decisions/0003-reach-to-nearest-point-of-square.md) |
| (Silent on the social layer, and on privacy.) | A field is a precise location, so history is indexed by player and never by place; bragging is push-only and drawn in board space; distance rather than games is the metric. | [0017](../decisions/0017-play-history-belongs-to-players-not-places.md), [0018](../decisions/0018-bragging-without-broadcasting-location.md), [0019](../decisions/0019-distance-is-the-currency-not-games.md) |
| One alarm used for flag-fall, and re-set on every move. | A DO has exactly *one* alarm and the design needs at least three deadlines, so they are multiplexed through a `timers` table. | [0006](../decisions/0006-sqlite-do-and-hibernation.md) |

Everything in the brief's platform-constraints section was tested and holds. See
[platform-verified.md](platform-verified.md).
