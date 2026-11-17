# 0062 — The phone takes its board from one seam, fits a shrunk board with its field, and asks for a remote seat when the server says it needs one

- **Date:** 2026-11-12
- **Status:** accepted
- **Stage:** 12.2
- **Builds on:** [0060](0060-a-remote-game-has-two-fields-one-square-size-and-board-space-between-them.md), [0061](0061-a-remote-seat-is-a-field-and-its-board-and-board-space-is-squares.md), [0027](0027-a-joiner-keeps-the-field-they-played-on.md), [0048](0048-the-carried-piece-travels-beside-a-live-dot.md)

## Decision

How 0060 is built on the phone, where 0060 and 0061 left the shape open.

1. **One seam.** `client/my-board.ts` answers "the board this phone plays on"
   from a snapshot: `myBoard(game)` is `playableBoard(field, remote?.squareM)`
   (the server's arithmetic), plus the calibrated field as an `outline` when
   that board was shrunk from it, the shared square, and whether the shrunk
   board is under `SMALL_SQUARE_M` at its narrowest. The game view's
   `geometry()` (and through it reach, the back rank, `AutoReady`, taps, the
   simulator's drag and the readout), the optimistic predictor's reach, and
   the opponent's dot all ask it. No view branches on `remote` to get a board;
   only words do.
2. **The opponent stays a place on my board.** `net.ts` keeps a remote
   opponent as squares (`opp_spot`, `PlayerView.spot`) and hands the views
   `opponent` as a latitude and longitude on *this* board (`spotOnBoard`), so
   the dot, its glide, the carried piece beside it (0048) and the opponent's
   back-rank line are the same code as a same-field game's. A spot of null is
   no dot; a board that changes shape puts the dot on its squares again.
3. **A shrunk board is fitted together with its field.** The canvas is fitted
   to the calibrated outline (a faint dashed line), not to the board, so the
   corners that were tapped are on screen at 1x. The cost is a smaller board
   on screen in proportion to the shrink. Measured on a 390 px phone at 10 m
   against 6 m (`scripts/check-remote.mjs`): the playable board is about
   187 px across and its squares about 23 px, against about 39 px for the
   same field played whole; one pinch to about 1.9x fills the canvas with
   the board. Pinch zoom is kept on the board itself.
4. **The phone finds out a join is remote from the server.** The join is sent
   with no body as always; a remote game with a free seat answers
   `field_required` with nothing written, and the phone then shows the field
   picker and the disclosure and joins again with both. A same-field join
   costs no extra request and is unchanged on the wire. A remote join keeps
   no copy of any field (0027 does not apply).
5. **The disclosure is one sentence and an unticked box**
   (`client/disclosure.ts`), the same on New game and on the remote join,
   beside the button it gates. Every remote create and join starts unticked.
6. **The shared square is a readout row** ("6.0 m on both fields", in the
   player's units; "for now" while waiting alone), with a line under the
   prompt before play and in a pause saying why the board is that size, and,
   only when needed, the calibration's own small-square warning, in play too.

## Why

The owner asked for one seam rather than remote checks through the views.
Keeping the opponent as a place on my board meant the dot, the plate and the
handshake line needed no second path. Fitting the outline is what makes 0060
point 7 visible: fitted to the board, the outline would be off the canvas for
any real difference in size.

## Rejected

- **Peeking (`GET`) before every join** to learn the game is remote: one more
  request on every same-field join, to learn what the join's own refusal says.
- **Fitting the board and clipping the outline**: invisible at the ratios
  that need it.
- **The opponent as squares through to the renderer**: a second dot, glide and
  plate path beside the same-field one.

## Revisit if

- Players find the shrunk board too small on screen: squares under about
  23 px at 1x, or players zooming in on every move, would be the sign. The
  owner (2026-11-17): keep the fit to the outline and revisit after play
  (stage 12.4); if it is too small, **auto-zoom onto the playable board** is
  the change, with the outline still drawn and reachable by zooming out.
- 12.3's recalibration needs the dot or the outline to react to a rescale
  in a way a new snapshot does not already give.
