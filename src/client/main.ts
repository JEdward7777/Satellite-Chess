/**
 * Client entry point: pick a GPS provider, then show either the fields this
 * phone has saved or the flow for walking out a new one.
 *
 * The board itself (stage 1.3) mounts from here too, once it exists.
 */

import { type FieldSpec, deriveGeometry } from '../shared/field.js';
import { fromLocal } from '../shared/geo.js';
import {
  type GpsProvider,
  type GpsState,
  browserGeolocationOptions,
  createGeolocationGps,
  qualityLabel,
  simRequested,
} from './gps.js';
import { GpsSimWorld, type SimGps, runSimClock } from './gps-sim.js';
import { createFieldStore, getPlayerId } from './store.js';
import { mountBoard } from './views/board.js';
import { mountCalibrate } from './views/calibrate.js';
import { mountGame } from './views/game.js';
import { mountSurvey } from './views/survey.js';
import { connectToGame } from './net.js';
import { withOptimism } from './optimistic.js';
import { type SimPanelHandle, attachSimDrag, mountSimPanel } from './views/sim-panel.js';

/**
 * Where the simulator starts. Arbitrary open ground — it only has to be
 * somewhere a board could plausibly be laid out.
 */
const SIM_START = { lat: 51.4779, lng: -0.0015 };

interface SimHandle {
  world: GpsSimWorld;
  me: SimGps;
  opponent: SimGps;
}

function startSim(): { gps: GpsProvider; sim: SimHandle } {
  const world = new GpsSimWorld();
  // The simulator inherits the real platform, so that running `?sim=1` on an
  // actual iPhone rehearses the messages an iPhone would really get.
  const platform = browserGeolocationOptions().platform;
  const me = world.add('me', { start: SIM_START, accuracyM: 5, platform });
  // Two players from the outset: half the failure modes in this game only show
  // up when both phones are moving (stage 1.1.4.2).
  const opponent = world.add('opponent', {
    start: fromLocal(SIM_START, { e: 0, n: 56 }),
    accuracyM: 5,
    platform,
  });
  me.start();
  opponent.start();
  runSimClock(world);
  return { gps: me, sim: { world, me, opponent } };
}

async function boot(): Promise<void> {
  const found = document.getElementById('app');
  if (!found) throw new Error('no #app to mount into');
  // Re-bound with an explicit type: `showCalibrate` is hoisted, so TypeScript
  // will not carry the null-narrowing into it.
  const root: HTMLElement = found;

  let gps: GpsProvider;
  let simPanel: SimPanelHandle | null = null;
  if (simRequested(location.search)) {
    const started = startSim();
    gps = started.gps;
    simPanel = mountSimPanel({ me: started.sim.me, opponent: started.sim.opponent });
    // Deliberately global as well as on screen: driving the simulator from a
    // console, or from a browser test, is how the rest of phase 1 was verified.
    Object.assign(globalThis, { satchess: started.sim });
  } else {
    gps = createGeolocationGps(browserGeolocationOptions());
    gps.start();
  }

  // Made on first run, before any sign-in and before anything is saved against
  // it (decision 0013).
  getPlayerId();

  // The field survey hijacks the whole app: it is a measuring instrument, not a
  // screen of the game, and mixing it with the normal flow would risk shipping
  // a location recorder to a player who never asked for one.
  const surveySecret = new URLSearchParams(location.search).get('survey');
  if (surveySecret) {
    // Mounted for the lifetime of the page; the teardown is deliberately
    // dropped, because nothing else ever gets to replace this screen.
    mountSurvey(root, { gps, secret: surveySecret });
    return;
  }

  const store = await createFieldStore();

  /** Only one screen is mounted at a time, and each cleans up after itself. */
  let teardown: (() => void) | null = null;
  const swap = (mount: () => () => void) => {
    teardown?.();
    teardown = mount();
  };

  const showHome = async () => {
    const fields = await store.list();
    if (fields.length === 0) {
      showCalibrate();
      return;
    }
    swap(() =>
      mountHome(root, {
        gps,
        fields,
        onCalibrate: () => showCalibrate(),
        onOpen: showBoard,
        onStart: (field) => void startGame(field),
        onJoin: (code, field) => void joinGame(code, field),
      }),
    );
  };

  /**
   * Create a game on this field and drop straight into it.
   *
   * The full invite flow is phase 6; this is the minimum that makes a game
   * reachable at all, and it prints the join code so a second phone can get in.
   */
  async function startGame(field: FieldSpec): Promise<void> {
    const playerId = getPlayerId();
    const response = await fetch('/api/game', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, field }),
    });
    const body = (await response.json()) as { joinCode?: string; message?: string };
    if (!response.ok || !body.joinCode) {
      alert(body.message ?? 'Could not start a game.');
      return;
    }
    enterGame(body.joinCode, field, playerId);
  }

  async function joinGame(joinCode: string, field: FieldSpec): Promise<void> {
    const playerId = getPlayerId();
    const response = await fetch(`/api/game/${encodeURIComponent(joinCode)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId }),
    });
    if (!response.ok) {
      const body = (await response.json()) as { message?: string };
      alert(body.message ?? 'Could not join that game.');
      return;
    }
    enterGame(joinCode, field, playerId);
  }

  function enterGame(joinCode: string, field: FieldSpec, playerId: string): void {
    // Wrapped so the three acts of a carry land on screen the moment they are
    // tapped. The messages on the wire are identical; only the wait is gone.
    const connection = withOptimism(connectToGame({ joinCode, playerId }));
    swap(() => {
      let detachDrag: (() => void) | null = null;
      const teardown = mountGame(root, {
        gps,
        connection,
        field,
        onLeave: () => void showHome(),
        onCanvas: (canvas, toLatLng) => {
          const panel = simPanel;
          if (!panel) return;
          detachDrag = attachSimDrag(canvas, { active: () => panel.active, toLatLng });
        },
      });
      // The join code is the only way a second phone gets in, so it has to be
      // visible rather than buried in a URL nobody can read out loud.
      const banner = document.createElement('p');
      banner.className = 'dim';
      banner.dataset.joinCode = joinCode;
      banner.textContent = `Join code: ${joinCode}`;
      root.querySelector('.board-status')?.prepend(banner);
      return () => {
        detachDrag?.();
        teardown();
        connection.close();
      };
    });
  }

  function showBoard(field: FieldSpec): void {
    swap(() => {
      let detachDrag: (() => void) | null = null;
      const teardown = mountBoard(root, {
        gps,
        field,
        onBack: () => void showHome(),
        onCanvas: (canvas, toLatLng) => {
          const panel = simPanel;
          if (!panel) return;
          detachDrag = attachSimDrag(canvas, { active: () => panel.active, toLatLng });
        },
      });
      return () => {
        detachDrag?.();
        teardown();
      };
    });
  }

  function showCalibrate(existing?: FieldSpec): void {
    swap(() =>
      mountCalibrate(root, {
        gps,
        store,
        existing,
        onSaved: () => void showHome(),
      }),
    );
  }

  await showHome();
}

interface HomeDeps {
  gps: GpsProvider;
  fields: FieldSpec[];
  onCalibrate(): void;
  onOpen(field: FieldSpec): void;
  onStart(field: FieldSpec): void;
  onJoin(joinCode: string, field: FieldSpec): void;
}

/**
 * The saved fields, plus a live GPS readout.
 *
 * The readout stays because it is the thing you look at before deciding whether
 * it is worth walking out a board at all.
 */
function mountHome(root: HTMLElement, deps: HomeDeps): () => void {
  const paint = (state: GpsState) => {
    const fix = state.fix;
    root.innerHTML = `
      <h1>Satellite Chess</h1>
      <dl class="readout">
        <dt>Signal</dt>
        <dd class="quality-${state.quality}" data-quality>${
          fix ? qualityLabel(state.quality) : 'Waiting for a fix…'
        }</dd>
        <dt>Accuracy</dt>
        <dd data-accuracy>${fix ? `±${fix.accuracyM.toFixed(0)} m` : '—'}</dd>
        <dt>Walked</dt>
        <dd data-distance>${formatDistance(state.distanceM)}</dd>
      </dl>
      ${state.error ? `<p class="notice" data-error="${state.error.code}">${state.error.message}</p>` : ''}
      <h2>Your fields</h2>
      <ul class="fields" data-fields>
        ${deps.fields.map(fieldItem).join('')}
      </ul>
      <p><button data-calibrate>Calibrate a new field</button></p>
      ${
        deps.fields.length > 0
          ? `<h2>Play</h2>
             <p><button data-start>Start a game on ${escapeHtml(deps.fields[0].name)}</button></p>
             <p>
               <label>Or join a code<br />
                 <input data-code type="text" maxlength="8" placeholder="ABC123" />
               </label>
             </p>
             <p><button data-join class="secondary">Join</button></p>`
          : ''
      }
    `;
    root
      .querySelector<HTMLButtonElement>('[data-calibrate]')
      ?.addEventListener('click', deps.onCalibrate);
    root.querySelector<HTMLButtonElement>('[data-start]')?.addEventListener('click', () => {
      if (deps.fields[0]) deps.onStart(deps.fields[0]);
    });
    root.querySelector<HTMLButtonElement>('[data-join]')?.addEventListener('click', () => {
      const code = root.querySelector<HTMLInputElement>('[data-code]')?.value.trim();
      if (code && deps.fields[0]) deps.onJoin(code.toUpperCase(), deps.fields[0]);
    });
    for (const item of root.querySelectorAll<HTMLElement>('[data-field]')) {
      item.addEventListener('click', () => {
        const field = deps.fields.find((f) => f.id === item.dataset.field);
        if (field) deps.onOpen(field);
      });
    }
  };

  const unsubscribe = deps.gps.subscribe(paint);
  return () => {
    unsubscribe();
    root.innerHTML = '';
  };
}

function fieldItem(spec: FieldSpec): string {
  const geo = deriveGeometry(spec);
  return `<li data-field="${spec.id}" tabindex="0" role="button">
    <strong>${escapeHtml(spec.name)}</strong>
    <span class="dim">${geo.squareM.toFixed(1)} m squares · ${(geo.squareM * 8).toFixed(0)} m a side</span>
  </li>`;
}

/** Metres until it is silly, then kilometres. */
export function formatDistance(metres: number): string {
  return metres < 1000 ? `${metres.toFixed(0)} m` : `${(metres / 1000).toFixed(2)} km`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/**
 * Registered after boot, never before: a failing service worker must not be able
 * to stop the game starting.
 */
function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  addEventListener('load', () => {
    void navigator.serviceWorker.register('sw.js').catch(() => undefined);
  });
}

void boot();
registerServiceWorker();
