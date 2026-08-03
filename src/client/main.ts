/**
 * Client entry point: pick a GPS provider, then show either the fields this
 * phone has saved or the flow for walking out a new one.
 *
 * The board itself (stage 1.3) mounts from here too, once it exists.
 */

import {
  type FieldSnapshot,
  type FieldSpec,
  deriveGeometry,
  snapshotField,
} from '../shared/field.js';
import { fromLocal } from '../shared/geo.js';
import { formatJoinCode } from '../shared/joincode.js';
import { parseAppRoute } from '../shared/routes.js';
import {
  type GpsProvider,
  type GpsState,
  type Platform,
  browserGeolocationOptions,
  createGeolocationGps,
  detectPlatform,
  qualityLabel,
  simRequested,
} from './gps.js';
import { GpsSimWorld, type SimGps, runSimClock } from './gps-sim.js';
import { type JoinRejection, joinGame } from './join.js';
import { type ScanSupport, browserScanEnv, detectScanSupport, scanAdvice } from './scan.js';
import { createFieldStore, getPlayerId } from './store.js';
import { mountBoard } from './views/board.js';
import { mountCalibrate } from './views/calibrate.js';
import { type CreateDraft, createGameBody, mountCreate } from './views/create.js';
import { mountGame } from './views/game.js';
import { mountInvite } from './views/invite.js';
import { mountJoinFailed, mountJoining } from './views/join.js';
import { mountScan } from './views/scan.js';
import { mountSurvey } from './views/survey.js';
import type { Color } from '../shared/squares.js';
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

  // Asked once, here, because the answer needs `await` and the home screen
  // repaints on every GPS fix — a check that far down would run several times a
  // second to produce the same constant. It cannot change while the page is open.
  const platform = detectPlatform(navigator.userAgent, navigator.maxTouchPoints);
  const scanning = await detectScanSupport(browserScanEnv());

  /** Only one screen is mounted at a time, and each cleans up after itself. */
  let teardown: (() => void) | null = null;
  const swap = (mount: () => () => void) => {
    teardown?.();
    teardown = mount();
  };

  /**
   * Home, and the only screen that reads the field list.
   *
   * It is shown even with nothing saved. It used to hand a fresh phone straight
   * to calibration, which was right while a field was the only way in — but since
   * stage 6.3 it is not: a phone that has never walked out a board can join a game
   * on someone else's field, and it needs a screen with a code box on it to do so.
   */
  const showHome = async () => {
    // The URL keeps whatever brought us here, so a reload from the board resumes
    // the game. Home is not that game, and a reload here should not re-join one.
    forgetDeepLink();
    const fields = await store.list();
    swap(() =>
      mountHome(root, {
        gps,
        fields,
        scanning,
        platform,
        onCalibrate: () => showCalibrate(),
        onOpen: showBoard,
        onNew: () => showCreate(fields),
        onJoin: (code) => showJoin(code),
        onScan: () => showScan(),
      }),
    );
  };

  /**
   * The viewfinder (stage 6.2.3), reached only where the browser can actually
   * scan — home offers advice instead of a button otherwise.
   *
   * A scanned code goes through `showJoin`, which is the same path a deep link
   * and a typed code take. Three ways in, one join.
   */
  function showScan(): void {
    swap(() =>
      mountScan(root, {
        platform,
        onCode: (code) => showJoin(code),
        onCancel: () => void showHome(),
      }),
    );
  }

  /**
   * Take a seat, from a scanned link or from a typed code (stages 6.2.1–6.2.2).
   *
   * Both arrive here, because they are the same act. The screen in between is not
   * decoration: this runs on the phone with the worst signal in the game — the
   * one that has just been handed a link in a park — and an unexplained blank
   * page is what makes someone scan the QR a second time.
   */
  function showJoin(code: string): void {
    /**
     * False once this screen has been replaced by any other.
     *
     * The request outlives the screen. Someone who taps Cancel on a slow join —
     * the case the Cancel button exists for — would otherwise be dropped into
     * the game a few seconds later, on top of whatever they had moved on to.
     * `swap` runs the previous screen's teardown, so this flips at exactly the
     * moment the joining screen goes away.
     *
     * The seat may well have been taken at the far end regardless. That is fine
     * and cannot be helped: the join is idempotent, so reopening the link picks
     * the same seat back up rather than finding the game full.
     */
    let live = true;
    swap(() => {
      const teardown = mountJoining(root, { code, onCancel: () => void showHome() });
      return () => {
        live = false;
        teardown();
      };
    });
    void joinGame(code, getPlayerId()).then((outcome) => {
      if (!live) return;
      if (!outcome.ok) {
        showJoinFailed(code, outcome);
        return;
      }
      // Whichever way this game was reached, the address bar now describes it, so
      // a reload — or a phone that ran out of battery and came back — resumes
      // instead of landing on the home screen. The join is idempotent at the far
      // end, which is what makes that safe.
      rememberGame(outcome.code);
      // The field comes back with the seat, so this phone needs none of its own.
      enterGame(outcome.code, outcome.field, getPlayerId(), outcome.colour);
    });
  }

  function showJoinFailed(code: string, rejection: JoinRejection): void {
    swap(() =>
      mountJoinFailed(root, {
        code,
        rejection,
        onRetry: () => showJoin(code),
        onHome: () => void showHome(),
      }),
    );
  }

  /** The create screen (6.1.1). The network work is here, not in the view. */
  function showCreate(fields: FieldSpec[]): void {
    swap(() =>
      mountCreate(root, {
        fields,
        onCancel: () => void showHome(),
        onCreate: (draft, field, colour) => void createGame(draft, field, colour),
      }),
    );
  }

  async function createGame(
    draft: CreateDraft,
    field: FieldSpec,
    colour: Color,
  ): Promise<void> {
    const playerId = getPlayerId();
    const response = await fetch('/api/game', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createGameBody(draft, field, playerId, colour)),
    });
    const body = (await response.json()) as {
      joinCode?: string;
      color?: Color;
      message?: string;
    };
    if (!response.ok || !body.joinCode) {
      alert(body.message ?? 'Could not start a game.');
      // Back to the form with the draft gone rather than stranded on a dead
      // screen: the commonest cause is a field the server would not accept, and
      // that needs re-choosing anyway.
      void showHome();
      return;
    }
    // The server's answer wins over the one asked for, because it is the one
    // the Durable Object recorded.
    //
    // Snapshotted here for the same reason the server snapshots it: from now on
    // this is a *game's* field, and it must not change shape because someone
    // re-calibrates the saved one. A joiner is handed the server's copy of the
    // same thing, so both phones hold a snapshot and neither holds a live field.
    showInvite(body.joinCode, snapshotField(field), body.color ?? colour);
  }

  /**
   * The invite screen (6.1.2–6.1.4).
   *
   * Reachable twice: straight after creating, and from the board, because the
   * moment you need the QR again is when your opponent's phone has just failed
   * to scan it. Coming back here closes the WebSocket and re-opens it on the way
   * out, which the reconnect path already handles — the alternative is an
   * overlay that has to keep the board alive underneath it, for a screen nobody
   * looks at for more than a few seconds.
   */
  function showInvite(joinCode: string, field: FieldSnapshot, colour: Color): void {
    swap(() =>
      mountInvite(root, {
        joinCode,
        field,
        colour,
        onOpenBoard: () => enterGame(joinCode, field, getPlayerId(), colour),
        onLeave: () => void showHome(),
      }),
    );
  }

  function enterGame(
    joinCode: string,
    field: FieldSnapshot,
    playerId: string,
    colour: Color,
  ): void {
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
      // The join code is the only way a second phone gets in, so it stays
      // visible on the board rather than being buried in a URL nobody can read
      // out loud — and tapping it goes back to the QR, which is what you want
      // the moment your opponent's camera has just refused to focus.
      const banner = document.createElement('button');
      banner.className = 'secondary invite-again';
      banner.dataset.joinCode = joinCode;
      banner.textContent = `Invite · ${formatJoinCode(joinCode)}`;
      banner.addEventListener('click', () => showInvite(joinCode, field, colour));
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
        onCancel: () => void showHome(),
      }),
    );
  }

  // A scanned QR, a shared link, or a reload of either: the path is the whole
  // instruction (stage 6.2.1). `parseAppRoute` is the same parser the Worker used
  // to decide this document was worth serving at all, so the two cannot disagree
  // about what a path means — which is the failure O-06 was about.
  const route = parseAppRoute(location.pathname);
  if (route?.kind === 'join') {
    showJoin(route.code);
    return;
  }
  // `/f/<blob>` is stage 6.4 and there is nothing to open yet. Falling through to
  // home is the honest answer: the Worker served the shell for it, so a phone that
  // followed one is at least in the app rather than at a 404.

  await showHome();
}

/**
 * Put this game in the address bar, without navigating.
 *
 * A typed code and a scanned link end up in the same place, so they should
 * survive a reload the same way. The query string is carried over deliberately:
 * losing `?sim=1` here would end a simulated game the moment the page refreshed,
 * and that is how every browser check in this project is run.
 */
function rememberGame(code: string): void {
  history.replaceState(null, '', `/j/${code}${location.search}${location.hash}`);
}

/** And take it back out, so a reload of the home screen is a home screen. */
function forgetDeepLink(): void {
  if (parseAppRoute(location.pathname) === null) return;
  history.replaceState(null, '', `/${location.search}${location.hash}`);
}

interface HomeDeps {
  gps: GpsProvider;
  fields: FieldSpec[];
  /** Whether this browser can read a QR from inside a page (stage 6.2.3). */
  scanning: ScanSupport;
  platform: Platform;
  onCalibrate(): void;
  onOpen(field: FieldSpec): void;
  onNew(): void;
  onJoin(joinCode: string): void;
  onScan(): void;
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
      ${
        deps.fields.length === 0
          ? `<p class="dim" data-no-fields>
               No fields yet. Walk one out, or join a game on someone else's — a
               game brings its own field with it.
             </p>`
          : ''
      }
      <p><button data-calibrate>Calibrate a new field</button></p>
      <h2>Play</h2>
      ${
        // Starting a game means choosing a field to play it on, so this is the
        // one control that really does need one. Joining does not: the field
        // travels with the game (stage 6.3).
        deps.fields.length > 0 ? `<p><button data-new>New game</button></p>` : ''
      }
      ${
        // Offered only where it will work. Where it will not, the advice below
        // the box names what does — on iOS that is the Camera app, which is
        // better at this than we would be (decision 0026).
        deps.scanning === 'ready' ? `<p><button data-scan>Scan an invite</button></p>` : ''
      }
      <p>
        <label>${
          deps.fields.length > 0 || deps.scanning === 'ready' ? 'Or join a code' : 'Join a code'
        }<br />
          <input data-code type="text" maxlength="8" placeholder="ABC 123" />
        </label>
      </p>
      <p><button data-join class="secondary">Join</button></p>
      ${scanAdviceHtml(deps)}
    `;
    root
      .querySelector<HTMLButtonElement>('[data-calibrate]')
      ?.addEventListener('click', deps.onCalibrate);
    root.querySelector<HTMLButtonElement>('[data-new]')?.addEventListener('click', deps.onNew);
    root.querySelector<HTMLButtonElement>('[data-join]')?.addEventListener('click', () => {
      const typed = root.querySelector<HTMLInputElement>('[data-code]')?.value.trim() ?? '';
      // Nothing typed is not a mistake worth a screen about it.
      if (typed === '') return;
      // Handed on raw. `joinGame` folds it through the same normaliser a deep
      // link goes through — so a code read aloud across a field, with an O for a
      // 0 or a space in the middle, resolves identically either way — and refuses
      // one that cannot be a code with the same screen every other failure uses.
      deps.onJoin(typed);
    });
    root.querySelector<HTMLButtonElement>('[data-scan]')?.addEventListener('click', deps.onScan);
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

/**
 * The line that stands in for a Scan button on a phone that cannot have one.
 *
 * Rendered as a hint rather than a warning, because nothing is wrong: an iPhone
 * held up to a QR still joins the game, just through the Camera app instead of
 * through us. Silence here is what would be wrong — it would leave someone
 * looking for a scanner that is never going to appear.
 */
function scanAdviceHtml(deps: HomeDeps): string {
  const advice = scanAdvice(deps.scanning, deps.platform);
  return advice === null ? '' : `<p class="dim" data-scan-advice>${escapeHtml(advice)}</p>`;
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
 *
 * The path is absolute, and that matters more than it looks. `register('sw.js')`
 * resolves against the *document*, so a phone that arrived by scanning a QR at
 * `/j/ABC123` would ask for `/j/sw.js`, get a 404, and register nothing — the
 * one phone most likely to need an offline shell would be the one without one,
 * and the failure is silent. See O-06.
 */
function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  });
}

void boot();
registerServiceWorker();
