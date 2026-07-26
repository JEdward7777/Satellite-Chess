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

import { type FieldSpec, deriveGeometry, fromBoardPoint, toBoardPoint } from '../../shared/field.js';
import type { LatLng } from '../../shared/geo.js';
import { DEFAULT_REACH, accuracyTooPoor, effectiveReachM } from '../../shared/reach.js';
import { type Color, type Square, toSquare } from '../../shared/squares.js';
import { type GpsProvider, type GpsState, qualityLabel } from '../gps.js';
import type { GameConnection, NetState } from '../net.js';
import { type Projection, drawBoard, piecesFromFen, squareUnderFoot } from '../render.js';
import { browserScreenLockOptions, createScreenLock } from '../wakelock.js';

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
        </dl>
        <p data-prompt class="prompt">Connecting…</p>
        <p data-notice class="notice" hidden></p>
        <p>
          <button data-ready hidden>I'm on my back rank</button>
          <button data-drop class="secondary" hidden>Put it back</button>
          <button data-leave class="secondary">Leave</button>
        </p>
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

  /** The field the *game* is played on, which outranks the one we were handed. */
  const geometry = () =>
    net.game ? deriveGeometry(net.game.field) : deriveGeometry(deps.field);

  const myColor = (): Color => net.game?.you ?? 'w';

  const reachNow = () =>
    effectiveReachM(gps.fix?.accuracyM ?? 0, net.game?.reach ?? DEFAULT_REACH);

  /** My carry, the opponent's, or none. */
  const carryState = () => {
    const carry = net.game?.carry;
    if (!carry) return null;
    return {
      from: carry.from as Square,
      destinations: (carry.destinations ?? []) as Square[],
      mine: carry.color === myColor(),
    };
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
    const carry = carryState();
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
    // Promotion is resolved here rather than by asking: a pawn reaching the last
    // rank almost always wants a queen, and the picker (4.3.5) can refine it.
    deps.connection.send({ t: 'place', to: square, pos: fix, promotion: 'q' });
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

    const carry = carryState();
    if (carry?.mine) {
      const geo = geometry();
      const here = gps.fix ? toBoardPoint(geo, gps.fix.pos) : null;
      if (!here) return `Carrying from ${carry.from}. Waiting for a fix…`;
      const inReach = carry.destinations.filter((square) => {
        const fr = { file: 'abcdefgh'.indexOf(square[0]), rank: Number(square[1]) - 1 };
        const du = Math.max(0, Math.abs(here.u - fr.file * geo.squareM) - geo.squareM / 2);
        const dv = Math.max(0, Math.abs(here.v - fr.rank * geo.squareM) - geo.squareM / 2);
        return Math.hypot(du, dv) <= reachNow();
      });
      return inReach.length > 0
        ? `Carrying. Tap a bright dot to place — ${inReach.length} in reach.`
        : 'Carrying. Walk to one of the marked squares.';
    }
    if (carry && !carry.mine) return 'Your opponent is carrying a piece.';
    if (game.clock.active !== myColor()) return 'Your opponent to move.';
    return 'Your move — tap a piece you can reach.';
  }

  function paint(): void {
    const geo = geometry();
    const fix = gps.fix;
    const accuracyM = fix?.accuracyM ?? 0;
    const reachM = reachNow();
    const carry = carryState();

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

    const dropButton = root.querySelector<HTMLButtonElement>('[data-drop]');
    if (dropButton) dropButton.hidden = !carry?.mine;
    const readyButton = root.querySelector<HTMLButtonElement>('[data-ready]');
    if (readyButton) {
      const staging = net.game?.status === 'staging' || net.game?.status === 'suspended';
      readyButton.hidden = !staging;
      readyButton.disabled = !fix;
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
