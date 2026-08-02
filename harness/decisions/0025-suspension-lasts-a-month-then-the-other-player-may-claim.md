# 0025 — A suspended game waits a month, then the other player may claim the win

- **Date:** 2026-08-02
- **Status:** accepted
- **Stage:** 5.3.4, resolves O-04
- **Builds on:** [0005](0005-back-rank-resume-handshake.md),
  [0009](0009-suspension-cancels-a-carry.md),
  [0019](0019-distance-is-the-currency-not-games.md)

## Decision

**One rule covers a deliberate pause and an opponent who never came back**, because
both land in exactly the same frozen state and two rules for one condition would be
two ways out of it.

1. **A suspended game freezes indefinitely.** Both clocks stop, the position is
   kept, and either player may resume at any time by the back-rank handshake
   (decision 0005). A carried piece goes back (decision 0009).
2. **The game records who suspended it** — the player who disconnected, or the one
   who asked for the pause.
3. **After 30 days, the *other* player may claim the win.** A button, never
   automatic, never forced. It stays available until pressed.
4. **A claim is a real loss for the absent player**, recorded as `abandoned` so the
   record says how it ended, but counting as a defeat.
5. **The opponent may still resume right up until the button is pressed.** Arriving
   on day 40 with an apology works, if nobody has claimed.
6. **Games are never deleted on a timer.** An unclaimed *join code* still evaporates
   after 30 minutes, because nobody has invested anything in it — but once two
   people have played, the game persists until a player chooses to clear it.
7. **Distance walked always counts**, however the game ended. You walked it.

## Why

**A month, because the failure this protects against is rain.** Two people who
cannot meet for a month probably are not going to, and the owner's framing is the
right one: if you have thirty days to charge a phone and turn up, you have had
enough. Anything much shorter starts punishing weather, illness and busy weeks —
and losing a game to a cancelled Saturday would be a genuinely bad experience in a
game whose whole premise is meeting someone outdoors.

**A loss rather than a draw or a void, because of what the alternative rewards.**
This is the argument that settles it. If walking away cost nothing, then walking
away would be the correct move whenever you are losing — the dominant strategy in a
lost position would be to close the app. Any rule that leaves an abandoning player
unpunished makes abandonment the default behaviour of a losing player, which
poisons every close game. It cannot be made perfectly fair, and it does not need to
be: it needs to be worse than losing honestly.

**Only the player who did *not* stop the game may claim, and this is load-bearing.**
The obvious implementation — "you may claim if your opponent is not connected" —
inverts the rule completely, because after thirty days *nobody* is connected. The
player who walked off could open the app and claim the win against the person who
stayed. So the responsible player is recorded at the moment of suspension and
excluded. One sentence: **whoever stopped the game cannot also win it by default.**
If both players vanished at once, neither may claim; nobody earned anything.

**Never deleting a game follows from what a game costs to keep.** A finished game is
a few kilobytes — a move list, two position fixes per move, a field snapshot. Even
thousands of them sit far inside the free tier's storage, so a timer that deletes
someone's game is spending their history to save nothing. Clearing out old games
becomes something the app *offers* rather than something it *does*, which is also
the honest place for it: the player knows which games mattered and the server does
not.

The 30-minute expiry for an **unclaimed join code** stays, and is a different thing
entirely. Nobody has played anything, nobody will miss it, and letting dead codes
accumulate would eventually collide with live ones.

## Rejected

**A shorter claim window — an hour, a day.** Right for online chess, wrong here.
The opponent is not idling in a lobby; they are a person who has to physically
travel to a field. A day would make a rained-off Saturday a loss.

**Automatic forfeit when the window expires.** Rejected: only the stranded player
knows whether their friend is coming back. A rule that ends a game while both
players still intend to finish it is worse than one that waits. Making it a button
also means the common outcome is that nobody presses it and the game just resumes.

**A draw on abandonment.** Kinder, and creates the exact incentive described above:
if you are losing, a guaranteed draw is a better outcome than playing on.

**Recording it as a win rather than as `abandoned`.** Rejected as dishonest in the
other direction. It was not won at the board, and the record should say so — but
saying so is a label, not a discount. It still counts.

**Deleting abandoned games after 14 days**, which the unused `ABANDONED_GAME_TTL_MS`
constant implied. It directly contradicts a 30-day claim window: the game would be
destroyed a fortnight before the button appeared, and the player who waited would
return to nothing.

## Revisit if

- Playtesting shows a month is so long that games pile up unresolved and the index
  becomes a graveyard. The fix would be a reminder, not a shorter window.
- Someone finds a way to abuse the claim — most likely by engineering a suspension
  they did not technically cause.
- Storage ever becomes a real constraint, at which point the prompt to clear old
  games becomes a nudge rather than an offer.
