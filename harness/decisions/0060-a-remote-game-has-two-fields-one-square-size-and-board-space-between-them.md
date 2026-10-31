# 0060 — A remote game has two fields, one square size, and only board space between them

- **Date:** 2026-10-31
- **Status:** accepted
- **Stage:** 12 (O-32)
- **Builds on:** [0004](0004-handicap-is-reach-not-clock.md), [0005](0005-back-rank-resume-handshake.md), [0028](0028-four-corners-fitted-as-an-affine-board.md), [0031](0031-reach-is-the-independent-variable-measured-in-squares.md), [0055](0055-a-game-can-be-watched-live-on-a-link-both-players-agreed-to.md)
- **Constrains:** [0027](0027-a-joiner-keeps-the-field-they-played-on.md) (does not apply to a remote game)

## Decision

Settled with the owner on 2026-10-31.

1. **The creator chooses "same field" or "remote".** A remote joiner picks one
   of their own fields, or calibrates a new one, when they take the seat.
   Absent means same field, and a same-field game is unchanged, byte for byte.
   This works for every game type.
2. **One square size, carried from the smaller field.** The shared square is
   `s = min(meanSquareM)` over the two fields. The larger field's board is
   shrunk by **one uniform factor** about its own center, keeping its shape and
   orientation. Only that one number crosses over; width and length are not
   matched separately ("don't get OCD about it"). Reach in meters is derived
   from `s`, so a move is the same number of meters for both players.
3. **Same square, same place.** All that crosses the wire between players is
   board space. A player on A1 is drawn on A1 on the other phone, wherever
   that is on the other player's ground. The opponent never receives your
   field's geometry, your lat/lon, or a kept copy of your field. The server
   projects positions into board space before relaying them. The watch link,
   replay and share card are already board space, so they work unchanged.
4. **A disclosure before every remote game.** On both create and join, the
   player is told that an opponent with the right tools could work out where
   they are, and accepts that before getting a seat. Friends and family are the
   expected use, but the game is not restricted to them.
5. **No terrain allowance and no handicap.** Equal meters is fair enough. The
   reach handicap (0004) remains available as it already is.
6. **A bad field is fixed during a pause.** While a remote game is suspended, a
   player may recalibrate **their own** field, by re-tapping the corners of the
   real ground. `s` is then recomputed and crosses over again, so the other
   player's board may change size. **That change is not re-approved**: the
   owner judged a second agreement "too much mental complexity". Resuming goes
   through the back-rank handshake (0005) as usual, which resets bodies against
   the new board. The rule that games snapshot their field still holds outside
   this one case: the change is made only while paused, only by the field's
   owner, and only to their own field.
7. **A shrunk board shows the field it came from.** The calibrated outline is
   drawn around the playable board, so it is obvious why the board does not
   match the corners that were tapped, and so a recalibration means re-tapping
   the outer corners.

## Why

Walking, not co-presence, is the game. Sending board space keeps the experience
("you feel like you are in the same location if you are on the same square")
and takes the location leak out of the protocol rather than leaving it to the
disclosure. The disclosure covers what remains: timing and movement patterns,
and anything a determined person can infer.

## Rejected

- **Each player keeps their own full field.** One player would walk further
  for the same move.
- **Matching width and length separately.** That distorts the shape of a field
  for little gain.
- **The player positions the shrunk board.** It adds a setup screen; centering
  needs no input.
- **Re-approving a rescale after recalibration.** The owner rejected it.
- **A clock or reach allowance for terrain.** It cannot be measured, and the
  owner judged equal meters fair.
- **Detecting "remote" from distance.** It misfires when someone opens an
  invitation at home before walking to the field.

## Revisit if

- Strangers start playing each other (matchmaking). The disclosure was sized
  for invited opponents.
- The shrink makes a board too small to tell squares apart on GPS. A minimum
  shared square size was considered and left out; that would be the fix.
