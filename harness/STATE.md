# Where the project is

*Rewritten every session. Short by design — the plan holds the detail, the session
files hold the history, and `reference/` holds everything that is simply true.*

**Tree state**: clean, pushed to `main`.
**Active stage**: none. **Sign-in is built and deployed.** `2.1` (Google OAuth),
`2.2.1`/`2.2.2` (sessions) and `2.4` (the `SESSIONS` KV namespace) all landed on
2026-09-16, on top of the four consecutive sessions that built the UserDO.
**Next action**: `2.5.1` — the sign-in gate on the client, which is now the only
thing standing between a working sign-in and a player who can use it. **It must
close O-15 with it** (see below).
**Live**: `https://satellite-chess.hootowl7777-cloud.workers.dev`, redeployed
2026-09-16 with `env.SESSIONS` bound. **A real Google sign-in has been completed
through it**, from Chrome on the operator's phone, the same day.
**Last session**: `harness/sessions/2026-09-16-01.md`.
**737 tests pass.** All eleven browser drivers passed on 2026-09-13;
`check-deeplink.mjs` re-run 2026-09-16 after the `sw.js` change.

## Sign-in has been done for real, once

The operator signed in from **Chrome on a phone** on 2026-09-16, against the
deployed origin. The evidence is a session record in the `SESSIONS` namespace with
a 30-day expiry, which only the callback can write — so the whole chain held: the
registered `redirect_uri` matched, the deployed client secret is right, Google
accepted the PKCE verifier, the ID token's issuer, audience, expiry and nonce all
checked out, and the signed flow cookie survived the round trip to Google and back
(`SameSite=Lax` doing exactly its job).

That is the one thing no test in this project can cover (decision 0034), and it is
now done rather than pending. **O-17 did not bite** on this attempt — one data
point, not a clearance.

What is *not* yet shown is whether the phone had the service worker installed at
the time. If it did, the `sw.js` exclusion was genuinely exercised; if not, the
fix is deployed but unproven in the field. Worth confirming on the next phone
visit rather than assuming either way.

## Where the detail lives

- **`reference/gotchas.md`** — what will bite you when you touch the code. The
  affine board's two coordinate types, the clock that must never be compared
  against `Date.now()`, the privacy edges that are one careless index away from
  being undone. **Read it before changing anything you have not changed before.**
- **`reference/container.md`** — **check which machine you are on first.** The
  "wrangler cannot reach Cloudflare" rule is about the ephemeral container only;
  on the operator's WSL machine deploys, secrets and KV all work.
- `reference/platform-verified.md`, `budget.md`, `geometry.md` — durable facts.
- `harness/AGENTS.md` — the rules. `npm run plan` — the stage tree.

## In one paragraph

Phases 0 and 1 are done bar `1.9.2` (PWA install on a phone) and `1.9.3.6` (what
to become of the survey trace — keeping it is recommended). Phase 3 is complete
bar `3.6.2` and the standing `3.7`, **phase 4 is finished server and client**,
**phase 5 is closed**, and **phase 6 is closed**: lift, carry, place, resign, draw,
terminal detection, clock handover, the promotion picker, optimistic local
application, both clocks on screen, pause and the thirty-day claim, invites by QR
and share sheet, joining by code or link, and fields that travel in a URL. A whole
game has been played through it in two browsers against a real `wrangler dev`.

**Phase 2 now has a real identity.** `identityOf` has the second branch decision
0029 promised: a `d1.` dev token or an opaque `g1_` session, reported as
`via: 'dev' | 'google'`. Sessions are 32 random bytes with the record in KV, a
30-day TTL, and **renewal throttled to once a day** because the free tier allows
~1,000 KV writes against ~100,000 reads. The UserDO is addressed by
`getByName(sub)`; `/api/me` brings an account into existence on first contact;
fields sync through `/api/fields/sync`; the game index is written by `GameDO` and
read by nobody else (decision 0033).

**Reach is the independent variable, measured in fractional squares** (decision
0031). **The board is not forced to be square** (decision 0028): calibration walks
the perimeter and fits a least-squares affine map. Every field, game and link made
before either still reads as it was calibrated.

## The field survey is walked — the news is good

The riskiest assumption in the project — that consumer GPS can resolve 8 m squares
on grass — has real data against it. The operator walked the ten-step protocol on
2026-09-06: Android Chrome, 2008 fixes over 29 minutes.

- Static scatter while standing still: **0.2 m median**, 0.6 m worst — against a
  4 m half-square. The square does not flicker.
- Claimed accuracy (±3.7 m) was ~16x pessimistic but **100% honest** — every fix
  landed inside its own circle, so the reach rule is sound.
- **8 m squares refuse 0% of moves** and mis-highlight 0%, down to 6 m squares.
- The one finding not acted on is **O-12**: the distance floor scales by claimed
  accuracy rather than observed scatter. Relaxing the constants was tried and
  reverted — `test/gps.test.ts` immediately produced 1525 m of phantom distance
  per hour. Over-counting is much worse than losing 9% of a walk.

Full numbers in `harness/sessions/2026-09-06-03.md` and decision 0031. The live
trace `2026-09-06T23-10-47-510Z-ioop0u` is deliberately **kept** (`1.9.3.6`).
`SURVEY_SECRET` is `field-walk-2026-a7k3m9qx`.

## What to do next, concretely

1. **`2.5.1` — the sign-in gate.** ← **start here.** An unauthenticated launch
   goes to a sign-in screen and nowhere else (decision 0014). The server half is
   done and waiting; nothing in the client offers a sign-in button yet, so today
   the only way in is typing `/auth/google/login` by hand. **O-15 must close
   before or with this stage**, and it is no longer theoretical: real sessions now
   exist in an ordinary browser while sign-in is not yet required, which is
   exactly the window that makes a player their own opponent. `2.5.3` (honest
   failure messages) is the natural companion — `auth.ts` already redirects to
   `/?signin=failed&reason=…` with nothing rendering it.
2. **`2.3.5` — the permanent record.** Unblocked and no longer third in the queue
   behind two inert features. Metres walked leads, games played never does
   (decision 0019); board crossings sit beside it. The distance is still only in
   `presence.travel_m` inside each GameDO — carrying it to the account is the
   first thing to build. Its headline number has two known defects against it,
   **O-03** and **O-12**, and both deserve a sentence in the record's own UI.
3. **`2.2.3`–`2.2.5`** — the expiry pre-flight warning, offline session caching,
   and sign-out. `destroySession` already exists for the last of these.
4. **O-16 — the home screen's ordering.** Two unbounded lists sit above the
   controls a player came to tap. The game list is capped; the rest wants a
   deliberate session.
5. **`1.9.2`** — PWA install and wake lock, on the next convenient phone.
