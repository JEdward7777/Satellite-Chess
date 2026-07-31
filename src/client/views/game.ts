/**
 * The game screen: the board, your dot, and a piece you can pick up and carry.
 *
 * This is where every other part of the project finally meets. GPS says where you
 * are, `shared/reach.ts` says what that lets you touch, the canvas draws it, and
 * the socket carries the two acts of a move to the only authority that counts.
 *
 * The interaction is deliberately two taps separated by a walk, because that is
 * the game (decision 0001): tap a piece you can reach to lift it, walk, tap the
 * destination to place it. There is no drag, and there could not be — the two
 * ends of a move are often forty metres apart.
 *
 * **Nothing here decides anything.** Legality comes from the server with the
 * carry; reach is computed locally only so the screen can respond at GPS rate
 * without spending a request per fix. Every rejection the server sends is shown
 * as-is, because the server's messages are written for someone standing in a
 * field and the client has no better words for it.
 */

import {
  type BoardPoint,
  type FieldGeometry,
  type FieldSpec,
  deriveGeometry,
  distanceFromBoardPointToSquareM,
  fromBoardPoint,
  toBoardPoint,
} from '../../shared/field.js';
import type { LatLng } from '../../shared/geo.js';
import type { CarryState } from '../../shared/protocol.js';
import { DEFAULT_REACH, accuracyTooPoor, effectiveReachM } from '../../shared/reach.js';
import { type Color, type Square, fromSquare, toSquare } from '../../shared/squares.js';
import { type GpsProvider, type GpsState, qualityLabel } from '../gps.js';
import type { GameConnection, NetState } from '../net.js';
import {
  PIECE_GLYPHS,
  type PieceType,
  type Projection,
  drawBoard,
  piecesFromFen,
  squareUnderFoot,
} from '../render.js';
import { browserScreenLockOptions, createScreenLock } from '../wakelock.js';

// ---------------------------------------------------------------------------
// The model half
//
// Split from the DOM so it can be tested in node. The DOM half below is checked
// by driving Chromium against `?sim=1` instead, because every view bug in phase
// 1 was invisible to a unit test and obvious in a screenshot.
// ---------------------------------------------------------------------------

/** What a pawn may become. Not a king, and not another pawn. */
export type PromotionPiece = 'q' | 'r' | 'b' | 'n';

export const PROMOTION_CHOICES: readonly { type: PromotionPiece; name: string }[] = [
  { type: 'q', name: 'Queen' },
  { type: 'r', name: 'Rook' },
  { type: 'b', name: 'Bishop' },
  { type: 'n', name: 'Knight' },
];

/**
 * Would putting the carried piece down on `to` promote it?
 *
 * Asked of the carry rather than of the FEN, because mid-carry the position
 * still shows the pawn on its origin — the board only changes when the piece
 * goes down — and `piece` is the server's word for what is actually in hand.
 */
export function promotesOn(carry: Pick<CarryState, 'piece' | 'color'>, to: Square): boolean {
  if (carry.piece.toLowerCase() !== 'p') return false;
  return fromSquare(to).rank === (carry.color === 'w' ? 7 : 0);
}

/** The piece in hand, and the nearest place it can be put down. */
export interface CarryGuidance {
  from: Square;
  piece: string;
  glyph: string;
  mine: boolean;
  destinations: Square[];
  /** Those that could be placed on from where the player stands right now. */
  inReach: Square[];
  /**
   * The closest legal destination, and how much further there is to walk.
   *
   * `walkM` is the number worth showing. Reach extends past your feet, so a
   * square 14 m away with 8 m of reach is six metres of walking, not fourteen,
   * and quoting the larger number walks a player straight past the square.
   */
  nearest: { square: Square; distanceM: number; walkM: number } | null;
}

export function carryGuidance(
  geo: FieldGeometry,
  here: BoardPoint | null,
  reachM: number,
  carry: CarryState,
  myColor: Color,
): CarryGuidance {
  // Deduped: a promotion square arrives four times, once per piece the pawn
  // could become, because that is how chess.js enumerates the moves. Four dots
  // land on the same square harmlessly, but "4 in reach" for one square does not.
  const destinations = [...new Set(carry.destinations ?? [])];
  const inReach: Square[] = [];
  let nearest: CarryGuidance['nearest'] = null;

  // Without a fix there is no "here", so nothing is in reach and there is no
  // nearest — which is what the screen should say rather than guessing.
  if (here) {
    for (const square of destinations) {
      const distanceM = distanceFromBoardPointToSquareM(geo, here, fromSquare(square));
      if (distanceM <= reachM) inReach.push(square);
      if (!nearest || distanceM < nearest.distanceM) {
        nearest = { square, distanceM, walkM: Math.max(0, distanceM - reachM) };
      }
    }
  }

  return {
    from: carry.from,
    piece: carry.piece,
    glyph: PIECE_GLYPHS[carry.piece.toLowerCase() as PieceType] ?? '?',
    mine: carry.color === myColor,
    destinations,
    inReach,
    nearest,
  };
}

/** Distances are read while walking, so they are short and never reflow. */
export function metres(m: number): string {
  return m < 10 ? `${m.toFixed(1)} m` : `${Math.round(m)} m`;
}

/** The HUD line: what is in hand, and where it is going. */
export function carryReadout(guidance: CarryGuidance | null): string {
  if (!guidance) return '—';
  const what = `${guidance.glyph} ${guidance.from}`;
  if (!guidance.mine) return `${what} · theirs`;
  if (guidance.inReach.length > 0) return `${what} · ${guidance.inReach.length} in reach`;
  if (!guidance.nearest) return `${what} · no fix`;
  return `${what} → ${guidance.nearest.square} · ${metres(guidance.nearest.walkM)}`;
}

/** What to do next while someone is carrying, in one line. */
export function carryPrompt(guidance: CarryGuidance): string {
  if (!guidance.mine) return 'Your opponent is carrying a piece.';
  if (!guidance.nearest) return `Carrying from ${guidance.from}. Waiting for a fix…`;
  if (guidance.inReach.length > 0) {
    return `Carrying. Tap a bright dot to place — ${guidance.inReach.length} in reach.`;
  }
  return `Carrying. Walk ${metres(guidance.nearest.walkM)} to ${guidance.nearest.square}, or to any other marked square.`;
}

export interface GameViewDeps {
  gps: GpsProvider;
  connection: GameConnection;
  /** Only needed until the server's snapshot arrives with its own field. */
  field: FieldSpec;
  onLeave(): void;
  /** The simulator hooks the canvas here, exactly as the board view does. */
  onCanvas?(canvas: HTMLCanvasElement, toLatLng: (x: number, y: number) => LatLng): void;
}

/** How long a rejection stays on screen before it stops being useful. */
const ERROR_LINGER_MS = 6_000;

export function mountGame(root: HTMLElement, deps: GameViewDeps): () => void {
  root.innerHTML = `
    <div class="board-screen">
      <canvas data-board></canvas>
      <div class="board-status">
        <dl class="readout">
          <dt>On</dt><dd data-square>—</dd>
          <dt>Reach</dt><dd data-reach>—</dd>
          <dt>Turn</dt><dd data-turn>—</dd>
          <dt data-carry-label hidden>Carrying</dt><dd data-carry hidden>—</dd>
        </dl>
        <p data-prompt class="prompt">Connecting…</p>
        <p data-notice class="notice" hidden></p>
        <p>
          <button data-ready hidden>I'm on my back rank</button>
          <button data-drop class="secondary" hidden>Put it back</button>
          <button data-leave class="secondary">Leave</button>
        </p>
      </div>
      <div class="promotion" data-promotion hidden>
        <p data-promotion-title>Promote to</p>
        <div class="promotion-choices">
          ${PROMOTION_CHOICES.map(
            (choice) => `
            <button data-promote="${choice.type}">
              <span aria-hidden="true">${PIECE_GLYPHS[choice.type]}</span>
              <span>${choice.name}</span>
            </button>`,
          ).join('')}
        </div>
        <button data-promote-cancel class="secondary">Keep carrying</button>
      </div>
    </div>
  `;

  const canvas = root.querySelector<HTMLCanvasElement>('[data-board]')!;
  const screenLock = createScreenLock(browserScreenLockOptions());
  void screenLock.acquire();

  let gps: GpsState = deps.gps.state;
  let net: NetState = deps.connection.state;
  let projection: Projection | null = null;
  let errorShownAt = 0;
  let lastErrorSeen: string | null = null;
  /** A place that is waiting on the promotion picker being answered. */
  let pendingPromotion: { from: Square; to: Square } | null = null;

  /** The field the *game* is played on, which outranks the one we were handed. */
  const geometry = () =>
    net.game ? deriveGeometry(net.game.field) : deriveGeometry(deps.field);

  const myColor = (): Color => net.game?.you ?? 'w';

  const reachNow = () =>
    effectiveReachM(gps.fix?.accuracyM ?? 0, net.game?.reach ?? DEFAULT_REACH);

  /** Where the player is in board space, or null before the first fix. */
  const hereNow = (): BoardPoint | null =>
    gps.fix ? toBoardPoint(geometry(), gps.fix.pos) : null;

  /** My carry, the opponent's, or none — with the distances already worked out. */
  const guidanceNow = (): CarryGuidance | null => {
    const carry = net.game?.carry;
    if (!carry) return null;
    return carryGuidance(geometry(), hereNow(), reachNow(), carry, myColor());
  };

  function squareAtPointer(x: number, y: number): Square | null {
    if (!projection) return null;
    const geo = geometry();
    const bp = projection.toBoard(x, y);
    const file = Math.round(bp.u / geo.squareM);
    const rank = Math.round(bp.v / geo.squareM);
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
    return toSquare(file, rank);
  }

  /** The fix to attach to a lift or a place. Raw, never smoothed. */
  function fixNow(): { lat: number; lng: number; acc: number; ts: number } | null {
    const fix = gps.fix;
    if (!fix) return null;
    return { lat: fix.pos.lat, lng: fix.pos.lng, acc: fix.accuracyM, ts: fix.at };
  }

  function onTap(square: Square): void {
    const game = net.game;
    const fix = fixNow();
    if (!game || !fix) return;

    // Everything below is a *request*. The server decides, and says why not.
    const carry = guidanceNow();
    if (carry === null) {
      deps.connection.send({ t: 'lift', from: square, pos: fix });
      return;
    }
    if (!carry.mine) return;
    if (square === carry.from) {
      // Tapping the square you lifted from puts it back — free, bar the clock.
      deps.connection.send({ t: 'drop' });
      return;
    }
    // A pawn landing on the last rank has to be asked about. Only for a square
    // the server already called legal: a stray tap should be refused by the
    // server as usual, not answered with a picker for a move that cannot happen.
    if (game.carry && carry.destinations.includes(square) && promotesOn(game.carry, square)) {
      pendingPromotion = { from: carry.from, to: square };
      paint();
      return;
    }
    deps.connection.send({ t: 'place', to: square, pos: fix });
  }

  /**
   * Answer the picker and complete the move.
   *
   * The fix is taken *now*, not when the picker opened, because the server
   * checks reach at the instant of the place — and a player can drift a couple
   * of metres in the time it takes to decide between a queen and a knight.
   */
  function choosePromotion(promotion: PromotionPiece): void {
    const pending = pendingPromotion;
    const fix = fixNow();
    pendingPromotion = null;
    if (pending && fix) {
      deps.connection.send({ t: 'place', to: pending.to, pos: fix, promotion });
    }
    paint();
  }

  const onPointerUp = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const square = squareAtPointer(event.clientX - rect.left, event.clientY - rect.top);
    if (square) onTap(square);
  };
  canvas.addEventListener('pointerup', onPointerUp);

  root.querySelector<HTMLButtonElement>('[data-leave]')?.addEventListener('click', deps.onLeave);
  root.querySelector<HTMLButtonElement>('[data-drop]')?.addEventListener('click', () => {
    deps.connection.send({ t: 'drop' });
  });
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-promote]')) {
    button.addEventListener('click', () => {
      choosePromotion(button.dataset.promote as PromotionPiece);
    });
  }
  root.querySelector<HTMLButtonElement>('[data-promote-cancel]')?.addEventListener('click', () => {
    // Cancelling abandons the *place*, not the carry — the piece is still in
    // hand and can go somewhere else, or back where it came from.
    pendingPromotion = null;
    paint();
  });
  root.querySelector<HTMLButtonElement>('[data-ready]')?.addEventListener('click', () => {
    const fix = fixNow();
    // The server checks the back rank itself and says how far off you are, so
    // there is nothing to pre-validate here.
    if (fix) deps.connection.send({ t: 'ready', pos: fix });
  });

  const set = (selector: string, text: string) => {
    const el = root.querySelector(selector);
    if (el) el.textContent = text;
  };

  /** What the player should do next, in one line. */
  function prompt(): string {
    const game = net.game;
    if (net.status !== 'open' && net.status !== 'idle') return 'Reconnecting…';
    if (!game) return 'Connecting…';
    if (game.result) {
      return `${game.result.outcome} — ${game.result.reason.replace(/_/g, ' ')}.`;
    }
    if (game.status === 'staging') return 'Walk to your own back rank, then tap Ready.';
    if (game.status === 'suspended') return 'Game paused — waiting for both players.';

    const carry = guidanceNow();
    if (carry) return carryPrompt(carry);
    if (game.clock.active !== myColor()) return 'Your opponent to move.';
    return 'Your move — tap a piece you can reach.';
  }

  function paint(): void {
    const geo = geometry();
    const fix = gps.fix;
    const accuracyM = fix?.accuracyM ?? 0;
    const reachM = reachNow();
    const carry = guidanceNow();

    projection = drawBoard(canvas, {
      geo,
      orientation: myColor(),
      pieces: piecesFromFen(net.game?.fen ?? ''),
      pos: fix?.pos ?? null,
      accuracyM,
      reachM,
      carry,
    });

    const here = fix ? toBoardPoint(geo, fix.pos) : null;
    const under = here ? squareUnderFoot(geo, here) : null;
    set('[data-square]', under ? toSquare(under.file, under.rank) : fix ? 'off the board' : '—');
    set(
      '[data-reach]',
      !fix ? '—' : accuracyTooPoor(accuracyM, net.game?.reach ?? DEFAULT_REACH)
        ? 'too vague'
        : `${reachM.toFixed(1)} m · ${qualityLabel(gps.quality)}`,
    );
    set(
      '[data-turn]',
      net.game ? (net.game.clock.active === myColor() ? 'yours' : 'theirs') : '—',
    );
    set('[data-prompt]', prompt());

    // The carry line earns its space only while there is something in hand;
    // a permanent "Carrying —" is a row of screen spent saying nothing.
    set('[data-carry]', carryReadout(carry));
    for (const el of root.querySelectorAll<HTMLElement>('[data-carry], [data-carry-label]')) {
      el.hidden = carry === null;
    }

    const dropButton = root.querySelector<HTMLButtonElement>('[data-drop]');
    if (dropButton) dropButton.hidden = !carry?.mine;
    const readyButton = root.querySelector<HTMLButtonElement>('[data-ready]');
    if (readyButton) {
      const staging = net.game?.status === 'staging' || net.game?.status === 'suspended';
      readyButton.hidden = !staging;
      readyButton.disabled = !fix;
    }

    const picker = root.querySelector<HTMLElement>('[data-promotion]');
    if (picker) {
      picker.hidden = pendingPromotion === null;
      if (pendingPromotion) {
        set('[data-promotion-title]', `Promote on ${pendingPromotion.to}`);
      }
    }

    // A rejection is worth reading, but not worth staring at for the rest of the
    // game — it describes a moment that has usually passed.
    const notice = root.querySelector<HTMLElement>('[data-notice]');
    if (notice) {
      const error = net.lastError;
      const signature = error ? `${error.code}:${error.message}` : null;
      if (signature && signature !== lastErrorSeen) {
        lastErrorSeen = signature;
        errorShownAt = Date.now();
      }
      const fresh = error !== null && Date.now() - errorShownAt < ERROR_LINGER_MS;
      notice.hidden = !fresh;
      notice.textContent = fresh ? error!.message : '';
    }
  }

  const offGps = deps.gps.subscribe((state) => {
    gps = state;
    paint();
    // The one place position leaves the phone outside a move, and it refuses far
    // more often than it accepts (see `offerPosition`).
    if (state.fix) deps.connection.offerPosition(state.fix, state.distanceM);
  });
  const offNet = deps.connection.subscribe((state) => {
    net = state;
    // A picker left open over a carry that has ended — placed, dropped, or
    // cancelled by a suspension (decision 0009) — would offer to promote a piece
    // that is no longer in hand. The server would refuse it, but the screen
    // would have lied first.
    const carry = state.game?.carry;
    if (
      pendingPromotion &&
      (!carry || carry.color !== myColor() || carry.from !== pendingPromotion.from)
    ) {
      pendingPromotion = null;
    }
    paint();
  });

  // The notice has to expire on its own, and a clock has to tick, so the screen
  // cannot only repaint when something arrives.
  const ticker = setInterval(paint, 1_000);
  const onResize = () => paint();
  addEventListener('resize', onResize);

  paint();
  deps.onCanvas?.(canvas, (x, y) =>
    projection ? fromBoardPoint(geometry(), projection.toBoard(x, y)) : deps.field.a1,
  );

  return () => {
    offGps();
    offNet();
    clearInterval(ticker);
    removeEventListener('resize', onResize);
    canvas.removeEventListener('pointerup', onPointerUp);
    void screenLock.release();
    root.innerHTML = '';
  };
}
