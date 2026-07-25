# 0013 — Persist locally first; OAuth can only ever add sync, never hold data hostage

- **Date:** 2026-07-25
- **Status:** partly superseded by [0014](0014-accounts-are-mandatory.md) — rule 2 is
  reversed (sign-in is now required up front, not optional). Rules 1 and 3, and the
  whole analysis of why a redirect must never hold data hostage, still stand.
- **Stage:** 1.5.3, 7.3

## Decision

Three rules, in priority order:

1. **Calibrating a field saves it immediately and unconditionally** to IndexedDB
   under the anonymous `player_id`. No login, no prompt, no confirmation step.
   There is never a moment where a field exists only in memory.
2. **Google OAuth is offered only as "also sync this across my devices"**, on
   something already saved. The redirect can fail, be cancelled, or be eaten by
   the browser, and the worst outcome is that syncing did not happen.
3. **Never initiate OAuth while a game is `staging`, `active` or `suspended`.**
   The control is hidden, not merely disabled, and the reason is stated.

Before any redirect, write a `pendingIntent` record (what the user was doing, and
where to return) to `localStorage`, and resolve it on return.

## Why

OAuth's Authorization Code flow is a full-page navigation. Anything held only in
JavaScript memory — including a field the player has just spent five minutes
walking out — is destroyed by it. The original brief's phrasing, "prompt for it
when someone taps *save this field*", reads as though the login is what performs
the save. If it were, a failed or abandoned redirect would lose the field, and it
would lose it at the exact moment the player had invested the most effort.

Inverting the order removes the failure mode rather than handling it. The local
save is the real save; the login is a separate, optional, idempotent act.

The mid-game prohibition is a distinct hazard and worse than it first looks. A
full-page redirect closes the WebSocket. The DO cannot distinguish that from a
player walking behind a building, so after the 20 s grace it freezes both clocks
and suspends the game — and recovering then requires *both* players to walk back
to their own back rank (decision 0005). Tapping "sign in" would therefore
teleport your opponent's evening. Hiding the control during a game is a one-line
rule that eliminates it.

Standalone-display PWAs make the redirect additionally unreliable — on iOS an
OAuth navigation from a home-screen PWA can hand off to Safari and return to a
different browsing context entirely. That is a further reason to make the flow
lossless by construction rather than trying to make the redirect trustworthy.

## Rejected

**Login-gated saving.** Simplest to implement, and the thing the brief's wording
implies. Rejected: it puts an account wall in front of a pickup game in a park,
which is the wrong first experience, and it is exactly the data-loss shape
described above.

**A popup or `BroadcastChannel` OAuth flow to avoid navigating away.** Keeps the
page alive, so in-memory state survives. Rejected as the primary mechanism: popup
behaviour in standalone PWAs is inconsistent, popup blockers intervene, and it
would leave us relying on the page surviving rather than on the data already being
safe. May still be worth adding later as a nicer path, but only on top of rules 1
and 2, never instead of them.

**Deferring the whole question by dropping Google sign-in from v1.** Tempting, and
the anonymous path genuinely covers create, join, play and resume on one device.
Rejected because cross-device field sharing is the feature that makes a saved
field worth having, and the rules above make it cheap and safe to add.

## Consequences

- `player_id` in `localStorage` and fields in IndexedDB are the primary store;
  the `UserDO` is a replica, not the origin.
- Claim-on-link (7.3.5) must be idempotent and must merge rather than overwrite —
  a player may have calibrated fields on two devices before ever logging in on
  either.
- The anonymous id is kept as an alias after linking, so in-flight games survive.

## Revisit if

- A field is ever large or numerous enough that IndexedDB quota becomes real.
  Unlikely: a field is four numbers and a name.
- We add a flow that genuinely must collect an identity before play, such as
  ranked games or tournaments.
