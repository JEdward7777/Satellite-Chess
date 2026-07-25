# The plan

The stage tree, split one file per top-level phase. **These files are the source
of truth for what is done and what is next.** Run `npm run plan` for a rollup
rather than reading them all.

## Phases

| # | Phase | File |
|---|---|---|
| 0 | Foundation — shared model, verified platform | [`00-foundation.md`](00-foundation.md) |
| 1 | Field: calibration, board render, first deploy | [`01-field.md`](01-field.md) |
| 2 | Identity: accounts required, permanent record | [`02-identity.md`](02-identity.md) |
| 3 | Transport: GameDO, hibernating WebSockets, presence | [`03-transport.md`](03-transport.md) |
| 4 | Chess: server-authoritative rules and carry validation | [`04-chess.md`](04-chess.md) |
| 5 | Clock: alarms, flag-fall, suspension | [`05-clock.md`](05-clock.md) |
| 6 | Join: QR, typed code, share sheet | [`06-join.md`](06-join.md) |
| 7 | Resume: the back-rank handshake | [`07-resume.md`](07-resume.md) |
| 8 | Post-game: PGN, distance, replay | [`08-postgame.md`](08-postgame.md) |
| 9 | Hardening: bad GPS, tree cover, small fields | [`09-hardening.md`](09-hardening.md) |
| 10 | Playtest: an actual game with an actual human | [`10-playtest.md`](10-playtest.md) |

Phases 0–7 give a game two people can really play. Everything after that is
review, polish and finding out what the field does to it.

### Why this order

It mostly follows the original brief, with two deliberate departures.

**Deploy moved early, into 1.9.** The brief's build order validates calibration
before writing server code, which is right — but it assumed local testing. Since
a real Cloudflare account is available, deploying as soon as the board renders
means the riskiest assumption in the whole project (that GPS is good enough to
tell squares apart on grass, under trees, on a cloudy day) gets tested on a real
phone on real ground before anything is built on top of it. Nothing else in the
project is worth building if that fails.

**Identity moved from late to phase 2.** The brief was anonymous-first, with
Google sign-in prompted only at "save this field". That was reversed by decision
0014: accounts are mandatory, so that every game, result and metre walked accrues
to a permanent personal record. Identity therefore has to land before any game
state exists that could be stranded on an anonymous id — but after phase 1, so
that the concept is validated on real ground before an account system is built for
it. Phases 3–7 each shifted up by one when this was inserted; nothing had been
built in them, and it has not happened since.

**Playtesting is its own phase, not a footnote.** Phase 9 hardens against
problems we can predict. Phase 10 exists because the ones that matter will be
the ones we cannot, and they deserve tracked stages rather than a note at the
bottom of a file.

## Numbering

Dotted decimals, arbitrary depth: `3`, `3.2`, `3.2.4`. Depth is logical nesting.
Subdivide freely; **never renumber siblings** to make room, just go deeper.

One stage per line, in this exact shape:

```
- `3.2.4` active: Persist a pending lift across hibernation
```

Statuses: `todo`, `active`, `done`, `blocked`, `dropped`.

Indented prose beneath a stage line is notes for humans and is ignored by the
parser. Use it freely — for why a stage exists, what it depends on, what was
tried. A `blocked` stage should always say what it is blocked on.

Rules the checker enforces (`npm run plan:check`):

- Stage ids are unique.
- Every stage deeper than one level has an existing parent.
- A `done` parent has no unfinished children.
- A `dropped` stage says why in its notes.

Keep at most two or three stages `active`. More than that means the work was not
decomposed finely enough.
