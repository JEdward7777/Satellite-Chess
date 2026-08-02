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
  type FieldSnapshot,
  deriveGeometry,
  distanceFromBoardPointToSquareM,
  fromBoardPoint,
  toBoardPoint,
} from '../../shared/field.js';
import type { LatLng } from '../../shared/geo.js';
import type { CarryState, GameSnapshot } from '../../shared/protocol.js';
import { DEFAULT_REACH, accuracyTooPoor, effectiveReachM } from '../../shared/reach.js';
import { type Color, type Square, fromSquare, toSquare } from '../../shared/squares.js';
import {
  type AlertLevel,
  alertLevel,
  browserClockAlertOptions,
  clockReadout,
  createClockAlerts,
  nextAlert,
} from '../clock.js';
import { type GpsProvider, type GpsState, qualityLabel } from '../gps.js';
import type { GameConnection, NetState } from '../net.js';
import { OPPONENT_FRAME_MS, OpponentTrack } from '../opponent.js';
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
   * Lifted locally, not yet confirmed, so the destinations are not known yet.
   *
   * An empty destination list identifies this on its own: the server refuses to
   * lift a piece that has nowhere to go (`no_legal_moves`), so every carry it
   * sends has at least one. Only `client/optimistic.ts` produces an empty set,
   * and only ever for your own piece. Without this the readout would report a
   * fresh lift as "no fix", which is both wrong and alarming.
   */
  pending: boolean;
  /**
   * The closest legal destination, and how much further there is to walk.
   *
   * `walkM` is the number worth showing. Reach extends past your feet, so a
   * square 14 m away with 8 m of reach is six metres of walking, not fourteen,
   * and quoting the larger number walks a player straight past the square.
   */
  nearest: { square: Square; distanceM: number; walkM: number } | null;
}

/**
 * My handicap, in metres of extra reach (decision 0004).
 *
 * Read from the snapshot rather than remembered from the create screen, because
 * the joining phone never saw that screen and both players have to see the same
 * circle — the handicap being *visible* is half the reason it is reach rather
 * than clock.
 *
 * Leaving this out of the client's reach does not make a handicapped player's
 * moves fail; the server still accepts them. It makes the screen tell them they
 * cannot play a move that would in fact be allowed, which is worse, because
 * they believe it and walk further than they had to.
 */
export function myReachBonusM(game: GameSnapshot | null): number {
  if (!game) return 0;
  return game.players[game.you]?.reachBonusM ?? 0;
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

  const mine = carry.color === myColor;
  return {
    from: carry.from,
    piece: carry.piece,
    glyph: PIECE_GLYPHS[carry.piece.toLowerCase() as PieceType] ?? '?',
    mine,
    destinations,
    inReach,
    nearest,
    pending: mine && destinations.length === 0,
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
  if (guidance.pending) return `${what} · in hand`;
  if (guidance.inReach.length > 0) return `${what} · ${guidance.inReach.length} in reach`;
  if (!guidance.nearest) return `${what} · no fix`;
  return `${what} → ${guidance.nearest.square} · ${metres(guidance.nearest.walkM)}`;
}

/** What to do next while someone is carrying, in one line. */
export function carryPrompt(guidance: CarryGuidance): string {
  if (!guidance.mine) return 'Your opponent is carrying a piece.';
  // Said while the lift is still in flight. It names what happened rather than
  // what to do, because for the moment it takes to confirm there is nothing to
  // do — and "start walking" is true whatever the destinations turn out to be.
  if (guidance.pending) return `Picked up ${guidance.from}. Start walking.`;
  if (!guidance.nearest) return `Carrying from ${guidance.from}. Waiting for a fix…`;
  if (guidance.inReach.length > 0) {
    return `Carrying. Tap a bright dot to place — ${guidance.inReach.length} in reach.`;
  }
  return `Carrying. Walk ${metres(guidance.nearest.walkM)} to ${guidance.nearest.square}, or to any other marked square.`;
}

export interface GameViewDeps {
  gps: GpsProvider;
  connection: GameConnection;
  /**
   * Only needed until the server's snapshot arrives with its own field.
   *
   * A snapshot rather than a saved field, because the joining phone may never
   * have calibrated anything: what it holds is the copy that came back with its
   * seat (stage 6.3), which is the same immutable geometry the game is played on.
   */
  field: FieldSnapshot;
  onLeave(): void;
  /** The simulator hooks the canvas here, exactly as the board view does. */
  onCanvas?(canvas: HTMLCanvasElement, toLatLng: (x: number, y: number) => LatLng): void;
}

/** How long a rejection stays on screen before it stops being useful. */
const ERROR_LINGER_MS = 6_000;

/**
 * How often the clock readout is redrawn.
 *
 * Fast enough that the tenths shown under ten seconds count smoothly, which is
 * the only reason it is not one second. Cheap because `paintClock` touches text
 * rather than the canvas.
 */
const CLOCK_FRAME_MS = 100;

export function mountGame(root: HTMLElement, deps: GameViewDeps): () => void {
  root.innerHTML = `
    <div class="board-screen">
      <canvas data-board></canvas>
      <div class="board-status">
        <div class="clocks" data-clocks hidden>
          <div class="clock" data-clock-side="mine">
            <span class="clock-label">You</span>
            <span class="clock-time" data-clock-mine>—</span>
          </div>
          <div class="clock" data-clock-side="theirs">
            <span class="clock-label">Them</span>
            <span class="clock-time" data-clock-theirs>—</span>
          </div>
        </div>
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
  /**
   * The opponent's dot, smoothed between the relays that carry it.
   *
   * Their position arrives every couple of seconds at best, so it is animated
   * rather than drawn raw — and the animation is what `animator` below is for.
   */
  const opponentTrack = new OpponentTrack();
  let animator: ReturnType<typeof setInterval> | null = null;
  /**
   * The worst thing already said about my clock, so it is said once rather than
   * ten times a second. Improves again when the increment hands time back.
   */
  let alertedAt: AlertLevel = 'none';
  const alerts = createClockAlerts(browserClockAlertOptions());

  /** The field the *game* is played on, which outranks the one we were handed. */
  const geometry = () =>
    net.game ? deriveGeometry(net.game.field) : deriveGeometry(deps.field);

  const myColor = (): Color => net.game?.you ?? 'w';

  /** The circle drawn on screen, which must be the one the server judges by. */
  const reachNow = () =>
    effectiveReachM(
      gps.fix?.accuracyM ?? 0,
      net.game?.reach ?? DEFAULT_REACH,
      myReachBonusM(net.game ?? null),
    );

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
    // A lift that has not come back yet has no destination list, so there is no
    // way to tell a legal placement from a stray tap — and no way to know whether
    // it promotes, which would send a place with no piece chosen. The window is
    // one round trip and the next act is a walk away, so dropping the tap costs
    // nothing; guessing could cost a queen.
    if (carry.pending) return;
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
    // Inside a real gesture, which is the only place a mobile browser will let
    // audio start — and it refuses silently, so the low-time warning would
    // simply never be heard if this were done at mount. Every player taps the
    // board long before their clock is low, so by the time it matters the
    // context is running. Idempotent after the first call.
    alerts.arm();
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

  /**
   * Draw both clocks, and shout if mine is nearly out.
   *
   * Deliberately separate from {@link paint} and driven by its own faster timer:
   * under ten seconds `formatClock` counts in tenths, which a once-a-second
   * repaint renders as a stuttering slideshow at exactly the moment the number
   * matters most. This touches two text nodes and a class, where `paint`
   * redraws the whole canvas — so it is cheap enough to run ten times a second
   * on a phone that is outdoors and not on charge, and `paint` is not.
   */
  function paintClock(): void {
    const clocks = root.querySelector<HTMLElement>('[data-clocks]');
    const game = net.game;
    if (!clocks) return;

    // Nothing to show before the first snapshot, and nothing worth showing once
    // the game is over — the result line says everything at that point.
    if (!game || net.gameAt === null || game.result !== null) {
      clocks.hidden = true;
      return;
    }
    clocks.hidden = false;

    const readout = clockReadout(game, net.gameAt, Date.now());
    set('[data-clock-mine]', readout.mine);
    set('[data-clock-theirs]', readout.theirs);

    // Which clock is running is the thing read at a glance from arm's length,
    // so it is a visual state rather than a label to parse.
    for (const el of root.querySelectorAll<HTMLElement>('.clock')) {
      const mine = el.dataset.clockSide === 'mine';
      el.classList.toggle('clock-running', readout.running && mine === readout.yourTurn);
      el.classList.toggle('clock-low', mine && alertLevel(readout.mineMs) !== 'none');
    }

    // Only my own clock, and only while it is actually going down. Being told
    // about an opponent's time trouble is information they earned; being buzzed
    // for it while walking is noise.
    const level =
      readout.running && readout.yourTurn ? alertLevel(readout.mineMs) : 'none';
    const decision = nextAlert(alertedAt, level);
    alertedAt = decision.level;
    if (decision.fire && decision.level !== 'none') alerts.fire(decision.level);
  }

  /**
   * Repaint fast, but only while the opponent's dot is actually in motion.
   *
   * The screen is on for the whole game (`wakelock.ts`) on a phone that is
   * outdoors and probably not on charge, so ten repaints a second all game is a
   * real cost. It buys nothing either: the relay speaks only on movement, so for
   * most of a game there is nothing moving to draw.
   */
  function syncAnimator(moving: boolean): void {
    if (moving && animator === null) {
      animator = setInterval(paint, OPPONENT_FRAME_MS);
    } else if (!moving && animator !== null) {
      clearInterval(animator);
      animator = null;
    }
  }

  function paint(): void {
    const geo = geometry();
    const fix = gps.fix;
    const accuracyM = fix?.accuracyM ?? 0;
    const reachM = reachNow();
    const carry = guidanceNow();
    const dot = opponentTrack.at(Date.now());
    const them = net.game?.players?.[myColor() === 'w' ? 'b' : 'w'] ?? null;

    projection = drawBoard(canvas, {
      geo,
      orientation: myColor(),
      pieces: piecesFromFen(net.game?.fen ?? ''),
      pos: fix?.pos ?? null,
      accuracyM,
      reachM,
      carry,
      opponent: dot ? { pos: dot.pos, connected: them?.connected ?? false } : null,
    });
    syncAnimator(dot?.moving ?? false);

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
    // So a snapshot's arrival shows on the clock immediately rather than at the
    // next tick — most visibly the increment landing as a move is accepted.
    paintClock();

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
    // Fed here rather than in `net.ts`, which deliberately knows nothing about
    // how anything is drawn. The track ignores a fix it has already seen, so a
    // snapshot repeating the last relay does not restart the glide.
    if (state.opponent) opponentTrack.push(state.opponent);
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

  // The notice has to expire on its own, so the screen cannot only repaint when
  // something arrives.
  const ticker = setInterval(paint, 1_000);
  // The clock gets its own, faster one. See `paintClock`.
  const clockTicker = setInterval(paintClock, CLOCK_FRAME_MS);
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
    clearInterval(clockTicker);
    alerts.dispose();
    syncAnimator(false);
    removeEventListener('resize', onResize);
    canvas.removeEventListener('pointerup', onPointerUp);
    void screenLock.release();
    root.innerHTML = '';
  };
}
