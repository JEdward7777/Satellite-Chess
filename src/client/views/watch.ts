/**
 * The watcher's page (stage 10.14, decision 0055): a game followed live, on a
 * link a player sent.
 *
 * **Open without signing in.** It is mounted before the sign-in gate and
 * before anything asks for this device's location: a watcher is on a sofa,
 * and has no business being asked where they are. It sends nothing but the
 * free keepalive (`watch-net.ts`).
 *
 * What it shows is the watcher's view and nothing else: the board in squares,
 * both players as dots on it, the piece in hand beside its carrier, the last
 * move, the clocks, the moves, and how far each has walked, in this device's
 * units (the setting is an account's, so a signed-out watcher reads the
 * locale's, or this device's remembered choice). No map, no place, no names.
 */

import type { Color } from '../../shared/squares.js';
import type { WatchLink } from '../../shared/watch.js';
import { canvasSizePx, zoomFrameFor } from '../render.js';
import { pieceLook } from '../piece-look.js';
import { REPLAY_GEOMETRY } from '../replay-draw.js';
import { displayUnits } from '../units.js';
import { drawWatch } from '../watch-draw.js';
import { type WatchConnection, type WatchNetState, connectToWatch } from '../watch-net.js';
import {
  lastMoveWords,
  moveListText,
  walkedLine,
  watchClocks,
  watchEndWords,
  watchHeadline,
  whereWords,
} from '../watching.js';
import { BOARD_FRAME_HTML, attachBoardZoom } from './board-gestures.js';

export interface WatchDeps {
  link: WatchLink;
  /** For a test or a driver; the page's own origin otherwise. */
  connection?: WatchConnection;
}

const CLOCK_FRAME_MS = 100;

export function mountWatch(root: HTMLElement, deps: WatchDeps): () => void {
  root.innerHTML = `
    <div class="board-screen watch-screen" data-watch-page>
      <p class="watch-head"><strong>Satellite Chess</strong> · watching live</p>
      <div class="clocks watch-clocks" data-clocks hidden>
        <div class="clock" data-clock-side="w">
          <span class="clock-label">White <span class="dim" data-where="w"></span></span>
          <span class="clock-time" data-clock="w">—</span>
        </div>
        <div class="clock" data-clock-side="b">
          <span class="clock-label">Black <span class="dim" data-where="b"></span></span>
          <span class="clock-time" data-clock="b">—</span>
        </div>
      </div>
      ${BOARD_FRAME_HTML}
      <div class="board-status">
        <p class="prompt" data-watch-headline>Connecting…</p>
        <p class="dim" data-watch-last hidden></p>
        <p class="notice" data-watch-ended hidden></p>
        <p class="moves" data-watch-moves hidden></p>
        <p class="dim" data-watch-walked hidden></p>
        <p>
          <button class="secondary" data-watch-flip>Flip board</button>
          <button class="look-toggle" data-look-toggle aria-label="Switch piece look">—</button>
        </p>
        <p class="dim watch-legend">
          Each player is a dot ringed in red, filled white or black for their side; a dashed
          ring is a phone that has gone quiet. You see the board, never the place: no map and
          no location.
        </p>
      </div>
    </div>
  `;

  const canvas = root.querySelector<HTMLCanvasElement>('[data-board]')!;
  const page = root.querySelector<HTMLElement>('[data-watch-page]')!;
  const connection = deps.connection ?? connectToWatch({ link: deps.link });
  const looks = pieceLook();
  const units = displayUnits();
  let net: WatchNetState = connection.state;
  let orientation: Color = 'w';

  const zoom = attachBoardZoom({
    canvas,
    controls: root.querySelector<HTMLElement>('[data-zoom-controls]'),
    onChange: () => paint(),
  });

  const set = (selector: string, text: string, hidden = false) => {
    const el = root.querySelector<HTMLElement>(selector);
    if (!el) return;
    el.textContent = text;
    el.hidden = hidden;
  };

  function paintClocks(): void {
    const view = net.view;
    const clocks = root.querySelector<HTMLElement>('[data-clocks]');
    if (!clocks) return;
    if (view === null || net.receivedAt === null) {
      clocks.hidden = true;
      return;
    }
    clocks.hidden = false;
    const readout = watchClocks(view, net.receivedAt, Date.now());
    set('[data-clock="w"]', readout.w);
    set('[data-clock="b"]', readout.b);
    for (const el of root.querySelectorAll<HTMLElement>('.clock')) {
      el.classList.toggle('clock-running', readout.running !== null && el.dataset.clockSide === readout.running);
    }
  }

  function paint(): void {
    const view = net.view;
    const { width, height } = canvasSizePx(canvas);
    const { frame } = zoomFrameFor(REPLAY_GEOMETRY, orientation, width, height);
    drawWatch(canvas, {
      fen: view?.fen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      orientation,
      look: looks.get(),
      zoom: zoom.settle(frame, null),
      lastMove: view?.lastMove ?? null,
      carry: view?.carry ?? null,
      dots: {
        w: view?.players.w.at ? { at: view.players.w.at, connected: view.players.w.connected } : null,
        b: view?.players.b.at ? { at: view.players.b.at, connected: view.players.b.connected } : null,
      },
    });
    // At 1x a finger scrolls the page; zoomed in, it pans the board.
    canvas.style.touchAction = zoom.zoomed() ? 'none' : 'pan-y';

    // For a driver and a screen reader: what is up.
    page.dataset.status = net.status;
    page.dataset.ended = net.ended ?? '';
    page.dataset.fen = view?.fen.split(' ')[0] ?? '';
    page.dataset.moves = String(view?.moves.length ?? 0);
    page.dataset.dots = (['w', 'b'] as const)
      .map((c) => {
        const p = view?.players[c];
        return `${c}:${p?.at ? `${p.at.file},${p.at.rank}${p.connected ? '' : ',away'}` : '-'}`;
      })
      .join(' ');

    const u = units.get();
    if (net.ended !== null) {
      set('[data-watch-ended]', watchEndWords(net.ended));
    } else {
      set('[data-watch-ended]', '', true);
    }
    if (view === null) {
      set('[data-watch-headline]', net.ended !== null ? 'Not watching.' : 'Connecting…');
    } else {
      const reconnecting = net.status === 'reconnecting' ? ' (Reconnecting…)' : '';
      set('[data-watch-headline]', `${watchHeadline(view)}${reconnecting}`);
      const last = lastMoveWords(view, u);
      set('[data-watch-last]', last ?? '', last === null);
      set('[data-watch-moves]', moveListText(view.moves), view.moves.length === 0);
      set('[data-watch-walked]', walkedLine(view, u));
      for (const color of ['w', 'b'] as const) set(`[data-where="${color}"]`, `· ${whereWords(view, color)}`);
    }
    paintClocks();
  }

  const offNet = connection.subscribe((state) => {
    net = state;
    paint();
  });
  const clockTicker = setInterval(paintClocks, CLOCK_FRAME_MS);

  const flip = root.querySelector<HTMLButtonElement>('[data-watch-flip]');
  const onFlip = () => {
    orientation = orientation === 'w' ? 'b' : 'w';
    // The zoom is kept in screen pixels, which mean nothing upside down.
    zoom.reset();
    paint();
  };
  flip?.addEventListener('click', onFlip);

  const lookToggle = root.querySelector<HTMLButtonElement>('[data-look-toggle]');
  const syncLook = () => {
    if (lookToggle) lookToggle.textContent = looks.get() === 'disc' ? 'Pieces: on discs' : 'Pieces: standard';
  };
  const onLook = () => looks.set(looks.get() === 'disc' ? 'standard' : 'disc');
  lookToggle?.addEventListener('click', onLook);
  syncLook();
  const offLook = looks.subscribe(() => {
    syncLook();
    paint();
  });
  const offUnits = units.subscribe(() => paint());
  const onResize = () => paint();
  addEventListener('resize', onResize);
  paint();

  return () => {
    offNet();
    offLook();
    offUnits();
    clearInterval(clockTicker);
    removeEventListener('resize', onResize);
    flip?.removeEventListener('click', onFlip);
    lookToggle?.removeEventListener('click', onLook);
    zoom.detach();
    connection.close();
    root.innerHTML = '';
  };
}

