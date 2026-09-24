# Phase 10 — Playtest: an actual game with an actual human

This phase exists because the failures that matter cannot be predicted from a
container, and they deserve tracked stages rather than a note at the bottom of a
file. Expect most of it to be written after the first real game.

- `10` todo: Playtest and iterate

- `10.1` todo: First full game outdoors, two phones, two people
  - `10.1.1` todo: Choose a field and a time control that give a game rather than
    a running race
  - `10.1.2` todo: Play to a finish; note every moment either player was confused,
    annoyed, or arguing with the phone
- `10.2` todo: Write up what broke, as observations
- `10.3` todo: Promote the ones worth fixing into stages, and record any rule
  changes as decisions
- `10.4` todo: Open questions only a real game can settle
  - `10.4.1` todo: Does carrying a piece across the field feel like the point of
    the game, or like an errand?
  - `10.4.2` todo: Is capturing correctly expensive, or merely annoying?
  - `10.4.3` dropped: Does the reach circle read as fair when it breathes with GPS
    quality, or does it feel arbitrary?
    - Moot since `10.5`: the circle no longer breathes (decision 0043). The
      question that replaces it is `10.5.4`.
  - `10.4.4` todo: Is the back-rank resume rule as easy to accept in practice as
    it is on paper?
  - `10.4.5` todo: What square size actually plays best?

- `10.5` active: Poor signal stops buying reach (O-33, decision 0043)
  - The owner's ruling after the 2026-09-20 games: a phone in a pocket earned a
    longer reach than the opponent had. Reported accuracy no longer enters
    reach at all; a fix worse than `maxAccuracyM` still refuses the move.
  - `10.5.1` done: Delete the accuracy term from `effectiveReachM`, and the
    accuracy argument from it and from `inStartZone`, so the server's lift,
    place and back-rank checks, the client's circle, the handshake's "walk N m"
    and the board view all get the same accuracy-free circle. Unit and DO tests
    that a ±14 m and a ±20 m fix reach no further than a ±1 m one.
  - `10.5.2` done: Say so when the dot may be what is wrong. An out-of-reach
    refusal on a fix worse than `goodAccuracyM` tells the player their
    position is vague, rather than only "walk closer".
  - `10.5.3` done: Bring the rest into line: `scripts/analyse-survey.mjs`
    modelled the rule from before 0031 and now models this one, with accuracy
    refusals counted apart; `README.md` and `reference/gotchas.md`.
  - `10.5.4` todo: Outdoors, on real phones: is anybody standing on a square
    refused because the dot is off? Decision 0043's revisit condition. Needs a
    real game, and ideally a second handset (see O-12 and `1.9.3.6`).
