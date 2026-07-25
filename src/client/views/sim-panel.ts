/**
 * On-screen controls for the GPS simulator (`?sim=1`).
 *
 * The simulator is the only way this game gets exercised indoors, and driving it
 * from a browser console is fine for a test but useless for actually playing
 * with the thing. This panel is what lets a person walk two players around a
 * field, wind the accuracy down until the reach circle swells, and see what the
 * game feels like when the fix is bad — none of which is reachable from a
 * keyboard in a container.
 *
 * It is deliberately a fixed overlay rather than part of any one screen, because
 * calibration needs to walk to two corners before there is a board to walk on.
 */

import { fromLocal } from '../../shared/geo.js';
import type { SimGps } from '../gps-sim.js';

export interface SimPanelHandle {
  /** Whichever player the controls are currently pointed at. */
  readonly active: SimGps;
  destroy(): void;
}

export interface SimPanelDeps {
  me: SimGps;
  opponent: SimGps;
  /** Called when the active player changes, so a view can follow along. */
  onSwitch?(active: SimGps): void;
}

/** One press of an arrow walks this far, which is a square on a typical field. */
const NUDGE_M = 8;

export function mountSimPanel(deps: SimPanelDeps): SimPanelHandle {
  const panel = document.createElement('div');
  panel.className = 'sim-panel';
  panel.innerHTML = `
    <div class="sim-row">
      <strong>SIM</strong>
      <button data-who="me" class="sim-toggle is-on">Me</button>
      <button data-who="opponent" class="sim-toggle">Opponent</button>
      <button data-halt class="sim-toggle">Stop</button>
    </div>
    <div class="sim-row">
      <label>±<span data-accuracy-value>5</span> m
        <input data-accuracy type="range" min="1" max="60" step="1" value="5" />
      </label>
    </div>
    <div class="sim-row">
      <label>jitter <span data-jitter-value>0</span> m
        <input data-jitter type="range" min="0" max="15" step="1" value="0" />
      </label>
    </div>
    <div class="sim-pad">
      <button data-nudge="n">↑</button>
      <button data-nudge="w">←</button>
      <button data-nudge="e">→</button>
      <button data-nudge="s">↓</button>
    </div>
  `;
  document.body.append(panel);

  let active = deps.me;

  const select = (which: 'me' | 'opponent') => {
    active = which === 'me' ? deps.me : deps.opponent;
    for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-who]')) {
      button.classList.toggle('is-on', button.dataset.who === which);
    }
    // The sliders describe the newly selected player, not the old one.
    accuracy.value = String(Math.round(active.state.fix?.accuracyM ?? 5));
    syncLabels();
    deps.onSwitch?.(active);
  };

  const accuracy = panel.querySelector<HTMLInputElement>('[data-accuracy]')!;
  const jitter = panel.querySelector<HTMLInputElement>('[data-jitter]')!;

  const syncLabels = () => {
    panel.querySelector('[data-accuracy-value]')!.textContent = accuracy.value;
    panel.querySelector('[data-jitter-value]')!.textContent = jitter.value;
  };

  accuracy.addEventListener('input', () => {
    active.setAccuracy(Number(accuracy.value));
    syncLabels();
  });
  jitter.addEventListener('input', () => {
    active.setJitter(Number(jitter.value));
    syncLabels();
  });

  for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-who]')) {
    button.addEventListener('click', () => select(button.dataset.who as 'me' | 'opponent'));
  }

  panel.querySelector<HTMLButtonElement>('[data-halt]')?.addEventListener('click', () => {
    active.halt();
  });

  // Compass directions, so the pad works before there is a board to be oriented
  // against — during calibration there is not yet one.
  const HEADINGS: Record<string, { e: number; n: number }> = {
    n: { e: 0, n: NUDGE_M },
    s: { e: 0, n: -NUDGE_M },
    e: { e: NUDGE_M, n: 0 },
    w: { e: -NUDGE_M, n: 0 },
  };

  for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-nudge]')) {
    button.addEventListener('click', () => {
      // Measured from where the current walk is *headed*, not from where the
      // player has got to, so holding a direction covers ground. Pressing a
      // different arrow mid-walk still turns, which is the other thing a person
      // expects of an arrow pad.
      const step = HEADINGS[button.dataset.nudge ?? 'n'];
      active.walkTo(fromLocal(active.target ?? active.truePos, step));
    });
  }

  return {
    get active() {
      return active;
    },
    destroy() {
      panel.remove();
    },
  };
}

/**
 * Drag anywhere on the board to put the active player there.
 *
 * A drag teleports rather than walks, which the distance accumulator will
 * rightly refuse to pay for — that is correct behaviour, not a bug to work
 * around. Use the arrow pad when a plausible walk is what is wanted.
 */
export function attachSimDrag(
  canvas: HTMLCanvasElement,
  deps: { active(): SimGps; toLatLng(x: number, y: number): { lat: number; lng: number } },
): () => void {
  let dragging = false;

  const place = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    deps.active().moveTo(deps.toLatLng(event.clientX - rect.left, event.clientY - rect.top));
  };

  const onDown = (event: PointerEvent) => {
    dragging = true;
    canvas.setPointerCapture(event.pointerId);
    place(event);
  };
  const onMove = (event: PointerEvent) => {
    if (dragging) place(event);
  };
  const onUp = (event: PointerEvent) => {
    dragging = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  return () => {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
  };
}
