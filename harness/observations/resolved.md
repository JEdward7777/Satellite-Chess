# Resolved observations

Moved here once promoted to a stage, fixed, or dismissed. Keep the outcome — a
dismissed observation is as valuable as a fixed one, because it stops the next
session re-raising it.

### O-04 — Nothing decides what happens to a game whose opponent never returns
**Resolved:** 2026-08-02, stage 5.3.4 (decision 0025)
**Outcome:** Decided and built. A suspended game freezes indefinitely and is never
deleted on a timer; after **30 days** the player who did *not* stop it may claim
the win, by a button that is never automatic and stays available until pressed.
The opponent may still resume right up to that moment. A claim is recorded as
`abandoned` — an honest label for how it ended, not a discount on the result.

Three things the observation did not contain:

- **Who may claim is the load-bearing part.** The obvious implementation, "you may
  claim if your opponent is not connected", inverts the rule: after a month
  *nobody* is connected, so the player who walked off could claim against the one
  who stayed. The game now records `suspended_by` at the moment of suspension and
  excludes them. If both vanished at once, neither may claim.
- **A loss, not a draw, and the reason is incentives.** If abandoning cost
  nothing, closing the app would be the correct move in any lost position. It
  cannot be made perfectly fair; it only has to be worse than losing honestly.
- **`ABANDONED_GAME_TTL_MS` had to go.** Fourteen days contradicts a thirty-day
  window outright — the game would have been deleted a fortnight before the button
  appeared. `FINISHED_GAME_TTL_MS` went with it. Only the unclaimed *join code*
  still expires, at 30 minutes, because nobody has invested anything in it.

### O-05 — `@cloudflare/workers-types` shadows DOM globals in client code
**Resolved:** 2026-07-25, stage 1.7 (decision 0021)
**Outcome:** Fixed. One `tsconfig.json` covering both halves is now four: a
`tsconfig.base.json` of shared settings that deliberately names no `lib` or `types`,
then `tsconfig.client.json` (DOM only, `types: []`), `tsconfig.worker.json`
(Workers only, no DOM) and `tsconfig.tools.json` (both, for tests and scripts). The
root is a solution file of references so an editor resolves each file to its owning
project. `npm run typecheck` runs the three with `-p`.

Verified by deleting the workaround rather than by asserting the fix: the
`appendChild`/`getElementsByTagName` dance in `views/sim-panel.ts` is now plain
`document.body.append(panel)` and compiles. A stray `document` in worker code is now
a compile error too, which is the half of the benefit the observation did not
anticipate.


### O-06 — Shell asset paths are relative, so deep links will break
**Resolved:** 2026-08-01, stage 6.0
**Outcome:** Fixed, and the observation understated it. Every `href`/`src` in
`index.html`, the manifest's `start_url` and `scope`, and the service worker's
precache list are now absolute; `navigator.serviceWorker.register('sw.js')` is now
`/sw.js`, which was the worst of the four — it resolves against the *document*, so
the phone that arrived by scanning a QR was exactly the one that would have ended
up with no offline shell, silently.

Two things the observation did not anticipate, both found by running it rather than
by reading it:

- **The Worker had to learn the routes at all.** `/j/CODE` was a 404 from the
  assets binding, so no amount of path-fixing would have helped. `src/shared/routes.ts`
  is now the one table the Worker and the client both read.
- **`env.ASSETS.fetch('/index.html')` answers with a 307 to `/`.** The assets
  binding's default `html_handling` strips `index.html`. A browser follows it, so a
  scanned invite would have landed on the home screen with the code gone from the
  URL — which reads as the client failing to parse the code, with nothing wrong in
  the Worker. `SELF.fetch` follows redirects too, so the first version of the test
  passed against the bug. The shell is now fetched and cached as `/`, and the test
  asserts `redirect: 'manual'`.

Verified in Chromium by `scripts/check-deeplink.mjs`: a cold `/j/ABC123` renders
with no request under `/j/`, and the same URL renders again with the network cut.


### O-09 — `carry.test.ts` flakes — **closed 2026-08-01, two separate races**
**Spotted:** 2026-07-26, stage 4.3. **Updated:** 2026-07-31, stage 4.3.5.
**Why it matters:** "lets both players move in turn" failed twice across about
fifteen runs of the suite, and passed thirteen. A test that fails one time in ten
erodes trust in the whole suite and trains people to re-run rather than read.
Two earlier flakes in this file had the same root cause — a predicate matching the
opponent's stale broadcast (O-07) — and both were fixed; this is not obviously the
same, because the failing test sends no `pos` messages and the most recent change
was to `onPos`. Not yet reproduced under diagnosis: eight consecutive targeted runs
came back clean.

**2026-07-31 — a mechanism, for the two suspension tests at least.** Two more
failures on one day, both in `describe('suspension puts the piece back')` and both
saying the same thing: the game was still `active` when the test expected
`suspended`. One failed on `expect(await stub.peek()).toMatchObject({ status:
'suspended' })`, the other on `expect(clocks.running).toBe(false)` a few lines
later. Five consecutive targeted reruns of the worker project were clean.

Both tests do `black.close()` and then immediately overwrite the `disconnect`
timer with `due_at = Date.now() - 1` so the alarm fires at once. But the close is
not awaited, and the DO's own `webSocketClose` → `onDisconnect` schedules
`disconnect` at `now + DISCONNECT_GRACE_MS` (`game-do.ts:420`). If the runtime
delivers the close *after* the test's `INSERT OR REPLACE`, the DO's future
deadline wins, `runDurableObjectAlarm` finds nothing due, and the game never
suspends. Nothing is wrong with the product: both sides are doing their job, and
the test is racing the runtime.

That makes it a different bug from the O-07 family, and the `rev` floor would not
have touched it — the failing assertion reads stored state, not a broadcast.

**2026-08-01 — both fixed, and the second one was O-07 after all.**

*The suspension tests* now go through `closeAndSettle`, which waits for the
object to have scheduled its own `disconnect` deadline before bringing it
forward. Waiting on the timer row rather than on `presence.connected = 0` — the
fix this note proposed — matters: `onDisconnect` writes presence **first** and
schedules afterwards, so presence going to zero still leaves a window where the
object's deadline has not landed and can still replace the test's. The row
appearing is the last thing that can move it. The manual `UPDATE presence` the
tests did is gone, so they now assert the object marks presence itself.

*"Lets both players move in turn"* was the O-07 pattern in a test written before
the pattern was understood. Black waited for "a carry exists" — and black had
already received the broadcast of **white's** lift, so `next()` matched from the
buffer instantly, `walked()` backdated a row that did not exist yet, black's
place read as a teleport, and the test timed out waiting for a move the server
had rightly refused. It passed most of the time because the round trip into the
object was usually slow enough for the real lift to land first. Reproduced three
times in eleven runs under load, then rewritten to go through `move()`, whose
predicates identify the lift. Eight consecutive clean runs of the worker project
afterwards.

So O-07's family is bigger than it looked, and its "if a third appears, make it
structural" trigger has arguably now been met — the third was the same bug in an
older test rather than a new one, and converting the last hand-rolled sequence to
`move()` removed it. The `rev` floor is still the structural answer if a fourth
turns up.

### O-11 — One unidentified suite failure — **closed 2026-08-03, a third `carry.test.ts` race**
**Resolved:** 2026-08-03, stage 6.4
**Outcome:** Identified and fixed in the test. The failure was
`credits a disconnect to whoever went missing` asserting `suspended_by === 'b'`
and getting `null`, and it reproduced on the first full-suite run of the session
— a run with `wrangler dev` up and the client bundle rebuilding, exactly the
loaded conditions the original note guessed at.

**The guess about the cause was wrong, and that is the useful part.** O-11
hypothesised a `Client.next()` wall-clock timeout on a slow machine. This test
does not wait on the clock at all: it drives the alarm itself with
`runDurableObjectAlarm`. Acting on the hypothesis would have meant scaling a
timeout the failing test never uses.

The real cause is a write race between the test and the Durable Object:

1. `black.close()` returns immediately; `webSocketClose` runs whenever it runs.
2. The test writes a `disconnect` timer due **in the past**, so the alarm it
   runs next has something due.
3. `onDisconnect` also schedules a `disconnect` timer — `DISCONNECT_GRACE_MS` in
   the **future**, through `INSERT OR REPLACE`, which replaces the row rather
   than adding one.

When 3 lands after 2 the past deadline is gone, the alarm finds nothing due, no
suspension is recorded, and `suspended_by` is null. Load changes the
interleaving, which is why it never appeared in isolation across twenty-odd runs.

Fixed by waiting for white's next `state` broadcast — which `onDisconnect` sends
*after* it writes — before overwriting the deadline. The assertion is untouched.
That matters: `suspended_by` is the one part of decision 0025 that must not be
weakened, and "expected null" is exactly the shape of failure that tempts someone
to relax it.

**The transferable lesson is the same one O-09 and O-07 taught, for the third
time:** a test that writes to a Durable Object's storage is racing that object's
own handlers unless it waits for them. `close()`, like `next()`, is not a
synchronisation point. Three of the four flakes this suite has produced have been
this shape.
