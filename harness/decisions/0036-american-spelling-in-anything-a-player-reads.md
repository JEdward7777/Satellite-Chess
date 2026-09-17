# 0036 — American spelling in anything a player reads; metric units stay

- **Date:** 2026-09-16
- **Status:** accepted
- **Stage:** 2.5.1 (owner feedback, not part of the stage)
- **Supersedes:** the spelling rule in [`AGENTS.md`](../AGENTS.md) §9

## Decision

Two rules, and they are separate questions that must not be conflated.

**1. Every string a player can read is American English.** Done the same day, and
it was six strings: `views/survey.ts` ×2 ("about 8 **meters**", "about 24
**meters**"), `gps.ts` ×3 (the iOS, Android and generic "accurate to about a
**kilometer**" permission help), and `views/create.ts` ×1 ("past the
**neighboring** square"). Nothing else in the app renders a British word.

**2. Units stay metric.** Metres, not yards. Decided by the owner on the grounds
that a unit conversion is a bug surface and the game does not need one.

Identifiers and code comments remain British **for now**, deliberately. That is a
transitional state, not an oversight, and **O-22** holds the analysis for finishing
it.

## Why

The owner is American and reads his own game in a foreign dialect; his words were
that he "will get asked on the spellings if they are not changed". User-visible
text is where that costs something, and it turned out to be six strings — so the
part that matters was cheap, and was done immediately rather than scheduled.

The rest is not cheap in the same way. Roughly 615 lines carry a British spelling
across `src/`, `test/`, `scripts/` and the living harness docs, of which ~250 are
identifiers in `src/`. The owner's binding constraint was **"I don't want bugs"**,
and a mechanical sweep of that size at the end of a long session is exactly how
you get them. Splitting it means the expensive half can be done deliberately,
with the browser drivers as the net, by someone who is not also finishing a stage.

**Units and spelling are different questions with different costs**, and the
temptation to treat "metre" as one problem is the trap. Spelling is a rendering
concern. Units reach into what the game *offers*: 8 m is 8.7 yd, which nobody
wants to read or pace out, so going imperial would mean offering round 10-yard
squares, not converting metric ones — the calibration review and the create
screen, not `formatDistance`. The owner closed that question; this file records
that it was closed deliberately rather than never asked.

Nothing underneath changes in either case: `shared/geo.ts` works in metres because
GPS does, the board is fitted in metres, and decision 0031 already made reach a
count of **fractional squares**, so the game's main dial has no units at all.

## Rejected

**Rename everything now.** Tempting because the analysis was already done and the
dangerous surfaces turned out to be nil — no SQL column, wire field or storage key
carries a British spelling, so there is no migration. Rejected on timing, not on
merit: the only benefit is internal consistency, the cost is a 600-line mechanical
diff nobody can eyeball, and it would land in the same commit as a stage that had
just been deployed and verified. It is **O-22**, and it should be its own pass.

**Keep British throughout, as §9 said.** The convention was never argued for; it
was inherited from whatever the first session wrote and then written down as a
rule. An owner who gets asked about his own app's spelling is a real cost, and
"it is what is already there" is not an answer to it.

**Switch to yards.** Rejected by the owner outright. See above for why it would
have been a bigger change than it looks.

**Change the `apiError` codes** (`'unauthorised'`). Rejected for now: these are
machine-readable contract values with tests asserting on them, not prose, and the
codebase is already inconsistent (`index.ts` uses `unauthenticated`). Folded into
O-22 rather than done piecemeal.

## Revisit if

- **O-22 is done.** Then §9 should be rewritten again to say American throughout,
  and this file's "for now" clause retired.
- **A second person writes code here.** A half-and-half convention survives one
  author who knows why; it does not survive two who do not.
- **The game is ever localised.** Then user-visible strings leave the source
  entirely and rule 1 becomes a property of the message catalogue instead.
