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
  if (simRequested(location.search)) {
    const started = startSim();
    gps = started.gps;
    // Deliberately global: the simulator is a debugging instrument, and being
    // able to drive it from a console — or from a browser test — is the point.
    // The on-screen controls arrive with the board in stage 1.1.4.3.
    Object.assign(globalThis, { satchess: started.sim });
  } else {
    gps = createGeolocationGps(browserGeolocationOptions());
    gps.start();
  }

  // Made on first run, before any sign-in and before anything is saved against
  // it (decision 0013).
  getPlayerId();

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
      mountHome(root, { gps, fields, onCalibrate: () => showCalibrate(), onOpen: showBoard }),
    );
  };

  function showBoard(field: FieldSpec): void {
    swap(() => mountBoard(root, { gps, field, onBack: () => void showHome() }));
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
    `;
    root
      .querySelector<HTMLButtonElement>('[data-calibrate]')
      ?.addEventListener('click', deps.onCalibrate);
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

void boot();
