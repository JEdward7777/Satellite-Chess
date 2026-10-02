/**
 * What the game screen offers for ending a game early, and what it says about
 * offers (stage 10.11, decision 0050).
 *
 * The model half only: data in, labels and messages out, tested in node. The
 * rules themselves are `shared/endings.ts`, which the server applies; this only
 * turns them into buttons, so the screen never offers what the server would
 * refuse.
 *
 * **Anything that ends the game on the tap asks first** (`ends: true`): resign,
 * an abort nobody else has to agree to, and accepting an offer. The screen puts
 * those behind a second, separate button that is not live the instant it
 * appears, because a player walking with the phone out can brush anything. An
 * offer, and declining one, end nothing and go at once.
 */

import { abortsAlone, canAbort, canOfferDraw, canResign } from '../shared/endings.js';
import type { ClientMsg, GameSnapshot } from '../shared/protocol.js';
import type { Color } from '../shared/squares.js';

export type EndingKind = 'resign' | 'draw' | 'abort';

export interface EndingAction {
  kind: EndingKind;
  /** The button's words. */
  label: string;
  /** This tap ends the game, so it is confirmed first. */
  ends: boolean;
  /** Offered already, and waiting on the opponent: shown, and not tappable. */
  pending: boolean;
  /** What is sent once the player means it. */
  msg: ClientMsg;
}

/** The two lines and the button of the step that asks "are you sure?". */
export interface EndingConfirm {
  title: string;
  body: string;
  yes: string;
}

function other(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

/**
 * The choices behind "End game…", in the order they are listed, or none at
 * all when the game cannot be ended early (waiting for a second player, or
 * already over).
 *
 * Before each side has moved, abort is the only choice and needs nobody else:
 * there is nothing to resign and nothing to draw. After that, resign ends it
 * alone, and a draw or an abort is offered — or, when the opponent has already
 * offered it, taken.
 */
export function endingActions(game: GameSnapshot | null): EndingAction[] {
  if (!game || !canAbort(game.status)) return [];
  const them = other(game.you);

  if (abortsAlone(game.status, game.moveCount)) {
    return [{ kind: 'abort', label: 'Abort game', ends: true, pending: false, msg: { t: 'abort' } }];
  }

  const actions: EndingAction[] = [];
  if (canOfferDraw(game.status)) {
    const theirs = game.drawOfferFrom === them;
    const mine = game.drawOfferFrom === game.you;
    actions.push({
      kind: 'draw',
      label: theirs ? 'Accept the draw' : mine ? 'Draw offered' : 'Offer a draw',
      ends: theirs,
      pending: mine,
      msg: { t: 'draw', action: theirs ? 'accept' : 'offer' },
    });
  }
  const theirs = game.abortOfferFrom === them;
  const mine = game.abortOfferFrom === game.you;
  actions.push({
    kind: 'abort',
    label: theirs ? 'Abort game' : mine ? 'Abort offered' : 'Offer to abort',
    ends: theirs,
    pending: mine,
    msg: theirs ? { t: 'abort', action: 'accept' } : { t: 'abort' },
  });
  if (canResign(game.status)) {
    actions.push({ kind: 'resign', label: 'Resign', ends: true, pending: false, msg: { t: 'resign' } });
  }
  return actions;
}

/** The line at the top of the "End game…" choices. */
export function endingHint(game: GameSnapshot | null): string {
  if (!game) return '';
  if (abortsAlone(game.status, game.moveCount)) {
    return 'Nobody has lost anything yet: an aborted game ends with no result and is not recorded.';
  }
  return 'Resigning ends it now. A draw or an abort needs your opponent to agree.';
}

/** What the confirming step says for an action that ends the game. */
export function endingConfirm(action: EndingAction): EndingConfirm {
  switch (action.kind) {
    case 'resign':
      return {
        title: 'Resign this game?',
        body: 'Your opponent wins, and it goes in your record as a loss.',
        yes: 'Resign',
      };
    case 'draw':
      return {
        title: 'Accept the draw?',
        body: 'The game ends drawn, and it goes in both records.',
        yes: 'Accept draw',
      };
    case 'abort':
      return {
        title: 'Abort this game?',
        body:
          'It ends with no result. Nothing goes in either record, and you can remove it from your list.',
        yes: 'Abort game',
      };
  }
}

/** An offer from the opponent, as the banner under the board says it. */
export interface IncomingOffer {
  kind: 'draw' | 'abort';
  text: string;
  /** Accepting ends the game, so it is confirmed like any other ending. */
  accept: EndingAction;
  decline: ClientMsg;
}

/** The opponent's open offers, abort first — it is the one that matters on a broken field. */
export function incomingOffers(game: GameSnapshot | null): IncomingOffer[] {
  if (!game || !canAbort(game.status)) return [];
  const them = other(game.you);
  const offers: IncomingOffer[] = [];
  if (game.abortOfferFrom === them) {
    offers.push({
      kind: 'abort',
      text: 'Your opponent offers to abort. The game would end with no result and not be recorded.',
      accept: {
        kind: 'abort',
        label: 'Abort game',
        ends: true,
        pending: false,
        msg: { t: 'abort', action: 'accept' },
      },
      decline: { t: 'abort', action: 'decline' },
    });
  }
  if (game.drawOfferFrom === them && canOfferDraw(game.status)) {
    offers.push({
      kind: 'draw',
      text: 'Your opponent offers a draw.',
      accept: {
        kind: 'draw',
        label: 'Accept the draw',
        ends: true,
        pending: false,
        msg: { t: 'draw', action: 'accept' },
      },
      decline: { t: 'draw', action: 'decline' },
    });
  }
  return offers;
}

/** The player's own open offers, said so they know it is still standing. */
export function myOfferLine(game: GameSnapshot | null): string | null {
  if (!game || !canAbort(game.status)) return null;
  const parts: string[] = [];
  if (game.drawOfferFrom === game.you) parts.push('a draw');
  if (game.abortOfferFrom === game.you) parts.push('to abort');
  if (parts.length === 0) return null;
  const stands = parts.length === 1 ? 'It stands' : 'They stand';
  return `You offered ${parts.join(' and ')}. ${stands} until your opponent answers, or the next move is played.`;
}

/**
 * What happened to an offer of mine that has gone, or null.
 *
 * The server says nothing when an offer ends, beyond a snapshot without it —
 * so the phone compares two snapshots. An offer that went with a move lapsed;
 * one that went with nothing else changing was declined. One that went with
 * the game is not worth a word: the result line says everything.
 */
export function offerEndedNotice(
  before: GameSnapshot | null,
  after: GameSnapshot | null,
): string | null {
  if (!before || !after || before.joinCode !== after.joinCode) return null;
  if (!canAbort(after.status)) return null;
  const me = after.you;
  const moved = after.moveCount !== before.moveCount;
  const notes: string[] = [];
  if (before.drawOfferFrom === me && after.drawOfferFrom === null) {
    notes.push(moved ? 'Your draw offer lapsed with the move.' : 'Your opponent declined the draw.');
  }
  if (before.abortOfferFrom === me && after.abortOfferFrom === null) {
    notes.push(
      moved ? 'Your offer to abort lapsed with the move.' : 'Your opponent declined to abort.',
    );
  }
  return notes.length === 0 ? null : notes.join(' ');
}

/** What an offer I have just sent says, straight away, before the server answers. */
export function offerSentNotice(kind: EndingKind): string {
  return kind === 'draw'
    ? 'Draw offered. Your opponent can accept or decline.'
    : 'Abort offered. Your opponent can accept or decline.';
}
