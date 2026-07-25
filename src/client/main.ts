/**
 * Client entry point.
 *
 * Its whole job for now is to choose a GPS provider and show what it is saying.
 * The calibration flow (stage 1.2) and the board (stage 1.3) replace the body of
 * this screen; the provider selection here is the part that stays.
 */

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

function boot(): void {
  const root = document.getElementById('app');
  if (!root) throw new Error('no #app to mount into');

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

  gps.subscribe((state) => render(root, state));
}

function render(root: HTMLElement, state: GpsState): void {
  const fix = state.fix;
  root.innerHTML = `
    <h1>Satellite Chess</h1>
    <dl class="readout">
      <dt>Signal</dt>
      <dd class="quality-${state.quality}" data-quality>${
        fix ? qualityLabel(state.quality) : waitingLabel(state)
      }</dd>
      <dt>Accuracy</dt>
      <dd data-accuracy>${fix ? `±${fix.accuracyM.toFixed(0)} m` : '—'}</dd>
      <dt>Position</dt>
      <dd data-position>${
        fix ? `${fix.pos.lat.toFixed(6)}, ${fix.pos.lng.toFixed(6)}` : '—'
      }</dd>
      <dt>Walked</dt>
      <dd data-distance>${formatDistance(state.distanceM)}</dd>
      <dt>Fixes</dt>
      <dd data-fixes>${state.fixCount}</dd>
    </dl>
    ${state.error ? `<p class="notice" data-error="${state.error.code}">${state.error.message}</p>` : ''}
  `;
}

function waitingLabel(state: GpsState): string {
  return state.status === 'error' ? 'No signal' : 'Waiting for a fix…';
}

/** Metres until it is silly, then kilometres. */
export function formatDistance(metres: number): string {
  return metres < 1000 ? `${metres.toFixed(0)} m` : `${(metres / 1000).toFixed(2)} km`;
}

boot();
