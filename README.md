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
npm run check      # all three
npm run dev        # wrangler dev (not usable until phase 3)
```

The game cannot be played by hand in a terminal, so there is a GPS simulator
(`?sim=1`) that fakes `watchPosition` and lets you drag players around a field.

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
