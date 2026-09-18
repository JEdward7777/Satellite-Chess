# 0037 — The phone says `ready` once per arrival, and a back rank is forgotten when the socket goes

- **Date:** 2026-09-17
- **Status:** accepted
- **Stage:** 7.2.1 (with 7.1.1 and 7.3.3)

## Decision

Three rules for the back-rank handshake of decision 0005.

1. **The client sends `ready` on its own, once per arrival.** `AutoReady` in
   `client/handshake.ts` sends when the game is `staging` or `suspended`, the
   phone's own zone check passes, and the server's snapshot does not already say
   so. It then latches until the player leaves the zone or the *episode* changes —
   a new socket, a new status, a new suspension. When the relay has just carried
   an in-zone fix it waits 3 s for a snapshot to confirm it, then sends `ready`
   anyway — a relay can be sent and dropped by the server's interval floor.
   Repeats from jitter on the zone boundary are spaced at least 10 s apart. The
   button stays as the fallback (7.2.3).
2. **`in_start_zone` is cleared when a player's last socket closes.** Evidence of
   where someone is standing lasts only as long as the connection that gave it.
3. **While the handshake is pending, a relay that changes a player's
   `in_start_zone` is followed by a snapshot**, so both screens can say who has
   arrived (7.2.2). Outbound, so it costs no request.

## Why

The relay alone cannot be trusted to carry "I have arrived". It speaks only after
2 m of movement and 2.5 s, so a player who stops 1.5 m inside their zone just
after a relay sent from outside it stands on their back rank while the server
believes they do not — and standing still is silent, so nothing corrects it. In
`check-resume.mjs`, with its relay live, black's phone still sent one automatic
`ready` on reaching e8: the relay for that fix had been held back by its floor.

The stale flag was the opposite failure: a phone killed while standing on e1 kept
`in_start_zone = 1`, so after reconnecting from anywhere it would resume the moment
the opponent arrived. That is the positional advantage decision 0005 exists to
remove.

Budget: at most one `ready` per arrival per episode — a handful per game, inside the
~10 control messages `budget.md` already allows.

## Rejected

- **Send `ready` on every fix inside the zone.** Streams GPS by another name.
- **Clear the flag at every suspension, including a pause.** Needless: while both
  are connected the relay keeps the flag current, and a pause taken on the back
  ranks would then resume itself immediately via rule 1. Only a disconnect makes
  the flag unverifiable.
- **Hide the Ready button once the server agrees.** Two players who pause standing
  on their back ranks and stay still have no relay coming; the tap is their resume.

## Revisit if

Playtest (10.4.4) finds the zone boundary jitter noisy enough that the 10 s floor
shows as flicker, or budget measurements (9.5) show `ready` is not negligible.
