# Satellite-Chess

Real chess played on real ground.

GPS maps a 64-square board onto a field. You may only pick a piece up when you are
physically near its square — so you walk there. Then you **carry it** while you
cross the field, and you may only put it down when you are near the destination. A
chess clock runs throughout, which means walking costs you time.

`Ra1-a8` is 56 metres. Think about that before you play it.

Two players, both physically present on the same field, each on their own phone.

## Status

**Early.** The full rules model is built and tested; the app is not written yet.

| | |
|---|---|
| Shared model — projection, calibration, reach, carry, clock | done, 76 tests |
| Platform assumptions verified against Cloudflare | done |
| Client, server, actual playable game | not started |

Current position: [`harness/STATE.md`](harness/STATE.md). Stage tree:
`npm run plan`.

## How the field works

You calibrate a field by walking to where the white a1 rook would stand and
tapping, then walking to where the black h8 rook would stand and tapping. From
those two points the app derives the square size and which way the board faces.
Eight-metre squares make a 64-metre board, which is about a football pitch and
plays well.

Your **reach** is a circle around you, five metres plus whatever error your GPS is
reporting. It is drawn on screen so you can see it breathe as the fix tightens and
loosens. You can lift a piece whose square your circle touches, and place it on a
square your circle touches — which for anything longer than a step means walking.

Since reach is measured to the nearest edge of a square, standing anywhere on a
square always reaches it. But playing `e2-e4` still requires stepping out onto e3,
because from e2's centre, e4 is twelve metres away.

## Stack

PWA, Cloudflare Workers, SQLite-backed Durable Objects, Workers KV. Free tier
throughout, which is a real design constraint rather than a preference — see
[`harness/reference/budget.md`](harness/reference/budget.md) for the request
arithmetic that shapes the whole architecture.

## Development

```bash
npm install
npm test           # vitest — the pure model
npm run typecheck
npm run plan       # the stage tree with statuses
npm run check      # all of the above, client build included
npm run dev        # wrangler dev, with the dev identity seam switched on
```

The game cannot be played by hand in a terminal, so there is a GPS simulator
(`?sim=1`) that fakes `watchPosition` and lets you drag players around a field.

### Signing in locally

Sign-in is mandatory to play (decision 0014) and the Google half needs a deployed
origin, so local development uses a **dev identity seam** instead: one request
mints a session for any account you name.

`npm run dev` switches it on by passing `--var DEV_AUTH_SECRET:local-dev-secret`.
Running `wrangler dev` directly, the seam stays off unless you pass the same flag.

Since stage 2.5.1 the gate stands in front of every screen, so **in a browser the
quickest way in is the "Sign in as a test account" button on the sign-in screen
itself**. It appears only when the seam's two locks are already open, which is
`wrangler dev` on loopback and nowhere else — a deployed build reports that the
seam is unavailable and never draws it. The `curl` route below is still the way
to sign in as a *named* account, which is what the browser drivers do (see
`scripts/driver-signin.mjs`) when they need two different players.

```bash
curl -c jar.txt -X POST -H "x-dev-auth-secret: local-dev-secret" \
     -H "content-type: application/json" -d '{"sub":"alice"}' \
     http://127.0.0.1:8787/api/dev/session
curl -b jar.txt http://127.0.0.1:8787/api/me      # {"sub":"alice","via":"dev"}
```

It is a test seam, not a product fallback, and it is behind two locks: the
variable must be set **and** the request must arrive on a loopback hostname. A
deployed Worker fails the second no matter what anyone sets, which is the point
— see `src/worker/identity.ts` and decision 0029.

**That value is committed and is not confidential**, deliberately. It is passed
on the `wrangler dev` command line rather than kept in `.dev.vars`, because
`wrangler types` reads `.dev.vars` and would bake a per-developer local file into
the committed `worker-env.d.ts` — making `npm run check` pass or fail depending
on who ran it. Nothing is lost by publishing it: what keeps the seam off a
deployed build is that `wrangler deploy` never carries this flag, and the only
thing the value itself guards is a loopback dev server full of invented accounts.

### Signing in with Google

The real sign-in is two full-page redirects, at paths that are fixed and must not
move (decision 0030):

| `GET /auth/google/login`    | builds a PKCE challenge and redirects to Google |
| `GET /auth/google/callback` | where Google sends the browser back with a code |

`redirect_uri` is derived from the origin the request arrived on, so one build
works everywhere — but **Google only accepts redirect URIs registered on the OAuth
client**, and these two are registered:

- `https://satellite-chess.hootowl7777-cloud.workers.dev/auth/google/callback`
- `http://localhost:8787/auth/google/callback`

`8787` is the default `wrangler dev` port, which is what `npm run dev` uses.
Running dev on another port means adding that origin's callback URL in the Google
console — additive, about thirty seconds, no code change.

`GOOGLE_CLIENT_ID` is in `wrangler.jsonc` (it is not a secret; it travels in the
redirect URL on every sign-in). `GOOGLE_CLIENT_SECRET` is a Worker secret, set
with `wrangler secret put`, and is **deliberately not available locally** — local
development uses the dev seam above instead, and the Google flow is verified
against the deployed Worker. See decision 0034 for why that split rather than a
`.dev.vars` file.

**If you are an AI assistant working on this, read
[`harness/AGENTS.md`](harness/AGENTS.md) first.** Development state, the stage plan,
and every decision made so far live in [`harness/`](harness/) so that a fresh
session can pick up from files alone.

## Design notes worth knowing

- **A move is a lift, a walk, and a place.** Requiring reach to both ends at one
  instant makes long moves physically impossible — `Ra1-a8` would need 24 m of
  reach. [Decision 0001](harness/decisions/0001-two-phase-carry.md).
- **The clock pauses when someone drops.** A lost connection is a network failure,
  not a decision, so it must not cost anyone time.
- **Resuming means walking back to your own end.** Body position is part of the game
  state and cannot be saved, so it is reset rather than restored.
  [Decision 0005](harness/decisions/0005-back-rank-resume-handshake.md).
- **A field is a precise location, so play history is indexed by player and never by
  place.** Share cards draw your walk across the 8×8 grid rather than over a map, so
  the picture carries no coordinates at all.
  [Decisions 0017](harness/decisions/0017-play-history-belongs-to-players-not-places.md)
  and [0018](harness/decisions/0018-bragging-without-broadcasting-location.md).
- **Distance walked is the metric, not games played**, because a metric that ignores
  field size rewards shrinking the field — and small fields are where GPS gets
  unreliable. [Decision 0019](harness/decisions/0019-distance-is-the-currency-not-games.md).

## Licence

See [LICENSE](LICENSE).
