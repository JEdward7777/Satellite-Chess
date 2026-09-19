# 0039 — The phone remembers who it is, but never decides anything with it

- **Date:** 2026-09-18
- **Status:** accepted
- **Stage:** 2.2.3, 2.2.4, 2.2.5

## Decision

Four rules, which together are the session lifecycle after sign-in.

**1. A confirmed identity is cached on the phone; the cache is words, never a
door.** Every launch that gets a 200 from `/api/me` writes `{sub, via, email,
expiresAt, confirmedAt}` to `localStorage` (`client/account.ts`). An `unknown`
launch reads it back so home and the account screen can say *who* the phone is.
It is **not consulted about the gate**: `resolveLaunch` still closes the gate on
`signed_out` alone and opens on `unknown` whether the cache is present, absent or
visibly expired. A 401 and a sign-out both clear it. Decision 0035's rule 2 is
unchanged — this is its "revisit if 2.2.4 lands", answered by keeping rule 2 as
the whole of the gate and letting the cache add only words.

**2. The server reports a session's expiry, beside its own clock.** `/api/me`
returns `expiresAt` and `serverNow`; the client keeps only the difference and
adds it to its own clock at receipt. The phone never compares a server timestamp
with `Date.now()`.

**3. `/api/me` re-issues the session cookie on every launch.** The record slid
(2.2.2); the cookie did not. It was set once at sign-in with a 30-day `Max-Age`,
so a daily player's browser threw away a live session a month after they signed
in. A `Set-Cookie` costs no KV write, and `/api/me` is asked once per launch.

**4. Whenever an account stops being this phone's, the phone forgets the
identity and empties the field journal, and keeps the fields.** There are three
routes and all do it (`forgetAccount` in `client/account.ts`): signing out
(`POST /api/signout`, same-origin only, which ends the record first); any launch
that meets a 401 — a session that lapsed, or was ended in another tab; and a
confirmed launch whose `sub` differs from the remembered one (`accountChanged`)
— "Sign in again" answered by Google's chooser with a different account, which
reaches neither a sign-out nor a 401. With no remembered identity the third is
undetectable (O-27).
The journal is emptied so the next account's list cannot delete this account's
fields off the phone through decision 0032's one deletion rule; the next account
to sign in here therefore *adopts* the phone's fields. The account screen says so
before anybody taps. Emptying is unconditional on a 401, even when the same
person is about to sign back in: an empty journal can only resurrect, never
lose.

## Why

**The cache as an authority is the simplification to fear.** The obvious next
step once a phone knows its session has lapsed is to show the gate — and that is
exactly the sign-in screen with no signal to complete it that 0035 exists to
prevent. The cache is never sent anywhere and gates nothing; the server still
refuses every call without a live cookie.

**The pre-flight warning rarely fires, and that is correct.** With rule 3 and
sliding renewal, a session checked with a connection is ~30 days from its end. The
warning catches what goes wrong around that: a renewal that could not be written
(the free tier's ~1,000 KV writes a day — which, until this stage, also turned
every authenticated request into a 500), and a remembered session nearing its end
while offline. It is silent for a dev session, whose 12-hour token is always
inside the window.

**Fields stay because they are the phone's first** (decision 0013). Deleting them
at sign-out would lose any not yet synced, which is the one loss 0013 forbids.

## Rejected

- **Consulting the cache at the gate** (a lapsed cache closes it). See above.
- **Emptying the journal on sign-out only.** The 401 route is the likelier one
  (a month idle, or a sign-out in another tab), and it reaches the same gate
  with the old journal intact.
- **Keeping the journal across sign-out, or keying it by `sub`.** Kept, it lets
  account B's list delete account A's fields locally as "deleted elsewhere" while
  pushing A's unacknowledged ones into B, which is the worst of both. Keying it by
  `sub` gives the same merge as emptying it, for more code.
- **Wiping fields at sign-out.** Loses unsynced ground; see above.
- **A 400-day cookie instead of re-issuing.** Still a cliff, just a later one.
- **Signing out with a GET link.** Any `<img>` on any page could trigger it.

## Revisit if

- **A shared family phone becomes a real case.** Rule 4 hands one person's saved
  fields to whoever signs in next. That is a privacy question for fields
  (decision 0017), and the fix would be owner-tagged local fields. Logged as O-27.
- **O-17 is seen.** The callback handing the session to the client would also
  write this cache without a second read.
