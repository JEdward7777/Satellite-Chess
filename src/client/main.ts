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
  describeSquares,
  snapshotField,
} from '../shared/field.js';
import { decodeFieldLink } from '../shared/fieldlink.js';
import type { ListedGame } from '../shared/game-index.js';
import { fromLocal } from '../shared/geo.js';
import { formatJoinCode } from '../shared/joincode.js';
import { parseAppRoute } from '../shared/routes.js';
import { adoptField, keepGameField, offerFor } from './fields.js';
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
import {
  browserSyncTransport,
  createFieldSync,
  createLocalStorageJournal,
} from './field-sync.js';
import { type GamesTransport, browserGamesTransport } from './games.js';
import { createFieldStore } from './store.js';
import {
  currentDestination,
  devSignIn,
  loadSession,
  signInFailure,
  signOut,
} from './session.js';
import {
  type IdentityStorage,
  type KnownIdentity,
  accountChanged,
  forgetAccount,
  readCachedIdentity,
  resolveLaunch,
  sessionNotice,
  writeCachedIdentity,
} from './account.js';
import { homeHeaderHtml, mountAccount, sessionNoticeHtml } from './views/account.js';
import { mountSignIn } from './views/signin.js';
import { mountBoard } from './views/board.js';
import { mountCalibrate } from './views/calibrate.js';
import { type CreateDraft, createGameBody, mountCreate } from './views/create.js';
import { mountField, mountFieldLinkFailed, mountFieldOffer } from './views/field.js';
import { mountGame } from './views/game.js';
import {
  HOME_SHOWN,
  gameItemHtml,
  hiddenGameCount,
  homeGames,
  mountTidy,
  shouldOfferTidy,
} from './views/games.js';
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

/**
 * How long signing out waits for pending field changes to reach the account
 * before going ahead anyway (stage 2.2.5). A UI timeout, not game timing.
 */
const SIGN_OUT_SYNC_WAIT_MS = 10_000;

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

  // The sign-in gate (stage 2.5.1, decision 0014): an unauthenticated launch
  // goes to a sign-in screen and nowhere else.
  //
  // Deliberately *after* the survey, which is a measuring instrument rather than
  // a screen of the game and is gated on its own secret (decision 0022) — and
  // deliberately before everything else, including calibration. "Nowhere else"
  // is the whole decision, and a half-gate that let someone walk out a field
  // first would re-open the window O-15 lives in.
  //
  // Only `signed_out` closes the gate. An unreachable server is `unknown` and
  // the app opens: a phone in a field with a fortnight-old session must never be
  // shown a sign-in screen it cannot complete. See `session.ts`.
  //
  // Since stage 2.2.4 a confirmed answer is also written down, and an `unknown`
  // one reads it back, so a phone with no signal still knows *who* it is. The
  // cache only ever adds words to an app that was opening anyway: it is not
  // consulted about the gate at all, which `resolveLaunch` decides from the
  // server's answer alone. See `account.ts`.
  const identityStorage = browserIdentityStorage();
  const remembered = readCachedIdentity(identityStorage);
  const launch = resolveLaunch(await loadSession(), remembered, Date.now());
  if (launch.kind === 'gate') {
    // The server said 401, so what the phone remembered belongs to an account
    // that is no longer this phone's. Forgotten here as well as on sign-out,
    // because a session can also end elsewhere — expired in KV, or signed out
    // from this same browser in another tab — and whoever signs in next must
    // not inherit the last account's field journal (decision 0039, rule 4).
    forgetAccount(identityStorage, createLocalStorageJournal());
    // Mounted for the lifetime of the page, as the survey is: the only ways out
    // are a navigation to Google and a reload, and both replace this document.
    mountSignIn(root, {
      next: currentDestination(location),
      devSeam: launch.devSeam,
      reason: signInFailure(location.search),
      onDevSignIn: () => {
        // The committed dev secret, the same value `npm run dev` passes. Safe to
        // ship: it guards a loopback server full of invented accounts, and the
        // hostname lock is what makes it worthless anywhere else (decision 0029).
        void devSignIn('dev-player', 'local-dev-secret').then((ok) => {
          // A reload rather than a re-render, because the cookie has to be in
          // the jar before anything else asks who we are — and the address bar
          // still holds whatever route we were gated on, so the reload resumes
          // it rather than landing home.
          if (ok) location.reload();
        });
      },
    });
    return;
  }

  // The journal is held on to because an account change empties it (decision
  // 0039, rule 4) — here, before the first sync can run against it, and again
  // on signing out.
  const journal = createLocalStorageJournal();
  if (accountChanged(remembered, launch)) {
    // Signed in as somebody else than last time, with no sign-out or 401 in
    // between — "Sign in again" came back from Google's chooser as another
    // account. The same forgetting as the other two routes, before the new
    // identity is written and before any sync sees the old journal.
    forgetAccount(identityStorage, journal);
  }
  if (launch.confirmed && launch.identity !== null) {
    writeCachedIdentity(identityStorage, launch.identity);
  }
  const { identity, confirmed } = launch;

  // Local first, account second (decision 0013). The store the screens use
  // writes to this phone and then, in the background and without being waited
  // for, to the account — so a field is safe before anything has been asked of
  // the network, and turns up on the player's other phone when there is one.
  const fieldSync = createFieldSync({
    store: await createFieldStore(),
    journal,
    transport: browserSyncTransport(),
  });
  const store = fieldSync.store;

  // The game index (stage 2.3.4). Nothing is cached and nothing is merged: the
  // game owns these rows and the phone only ever reads them (decision 0033).
  const games: GamesTransport = browserGamesTransport();

  // Asked once, here, because the answer needs `await` and the home screen
  // repaints on every GPS fix — a check that far down would run several times a
  // second to produce the same constant. It cannot change while the page is open.
  const platform = detectPlatform(navigator.userAgent, navigator.maxTouchPoints);
  const scanning = await detectScanSupport(browserScanEnv());

  /**
   * Re-draw the home screen, when it is the screen being looked at.
   *
   * A sync can bring in a field calibrated on the player's other phone, or take
   * away one deleted there, and the list was read once when the screen mounted.
   * Null on every other screen, because nothing else reads the whole list and a
   * board that redrew itself mid-game would be worse than a stale one.
   */
  let refreshHome: (() => void) | null = null;
  fieldSync.onChange(() => refreshHome?.());

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
    // Both awaited together: the fields come off this phone in a millisecond and
    // the games come off the network, and waiting for them one after the other
    // would hold the home screen behind a request that is allowed to fail.
    const [fields, listed] = await Promise.all([store.list(), games.list()]);
    const myGames = listed.kind === 'ok' ? listed.games : [];
    swap(() => {
      const teardownHome = mountHome(root, {
        gps,
        fields,
        games: myGames,
        scanning,
        platform,
        identity,
        confirmed,
        onAccount: () => showAccount(),
        onCalibrate: () => showCalibrate(),
        onOpen: showField,
        onNew: () => showCreate(fields),
        onJoin: (code) => showJoin(code),
        onScan: () => showScan(),
        onTidy: () => showTidy(myGames),
      });
      refreshHome = () => void showHome();
      return () => {
        refreshHome = null;
        teardownHome();
      };
    });
  };

  /**
   * Who this phone is, and signing out (stage 2.2.5).
   *
   * Reachable with no signal — the identity may be a remembered one (2.2.4) —
   * because "am I signed in, and as whom?" is a question somebody asks exactly
   * when something has gone wrong. Signing out itself needs the server, and the
   * screen says so rather than pretending.
   */
  function showAccount(): void {
    swap(() =>
      mountAccount(root, {
        identity,
        confirmed,
        next: currentDestination(location),
        onBack: () => void showHome(),
        onSignOut: async () => {
          // Anything still waiting to reach the account goes first — above all a
          // delete made offline, which the journal is about to forget. Never
          // rejects, and a sync that cannot run changes nothing. Bounded, so a
          // connection that stalls rather than fails cannot pin the button on
          // "Signing out…"; a sync still in flight finishes or fails on its own.
          await Promise.race([
            fieldSync.sync(),
            new Promise((settle) => setTimeout(settle, SIGN_OUT_SYNC_WAIT_MS)),
          ]);
          const result = await signOut();
          if (result !== 'signed_out') return result;
          // The identity and the field journal, both — see `forgetAccount`.
          forgetAccount(identityStorage, journal);
          // Back through the launch check, which will now meet a 401 and show
          // the gate. A replace, so Back does not return to a signed-in screen.
          location.replace(`/${location.search}`);
          return result;
        },
      }),
    );
  }

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
   * The tidy-up offer (stage 2.3.4.2).
   *
   * Reached only from the button home shows once the list has grown, never on a
   * schedule and never as a prompt somebody has to dismiss (decision 0025).
   */
  function showTidy(listed: ListedGame[]): void {
    swap(() =>
      mountTidy(root, {
        games: listed,
        onForget: (joinCodes) => games.forget(joinCodes),
        // Straight back to a freshly fetched home rather than to the list this
        // screen was built from, which is now wrong by exactly what it removed.
        onDone: () => void showHome(),
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
    void joinGame(code).then((outcome) => {
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
      //
      // And it keeps a copy of it (decision 0027). Deliberately not awaited: a
      // slow IndexedDB write must never sit between a tapped invite and a board,
      // and there is nothing on the next screen that depends on the answer.
      void keepGameField(store, outcome.field);
      enterGame(outcome.code, outcome.field, outcome.colour);
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
    const response = await fetch('/api/game', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createGameBody(draft, field, colour)),
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
        onOpenBoard: () => enterGame(joinCode, field, colour),
        onLeave: () => void showHome(),
      }),
    );
  }

  function enterGame(joinCode: string, field: FieldSnapshot, colour: Color): void {
    // Wrapped so the three acts of a carry land on screen the moment they are
    // tapped. The messages on the wire are identical; only the wait is gone.
    const connection = withOptimism(connectToGame({ joinCode }));
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

  /**
   * One field of your own: what it is, how to send it, and how to be rid of it.
   *
   * Tapping a field on the home screen used to open the board directly. It now
   * lands here first, because since stage 6.4 a field is a thing you can *do*
   * something with — share it, rename it, re-calibrate it, delete it — and the
   * board is the screen you walk with, not the screen you administer from. Open
   * the board is the first button on it, so the old path is one tap longer and
   * the other four are reachable at all.
   */
  function showField(field: FieldSpec): void {
    // Reached from the home screen (where the URL is already `/`) and from
    // accepting a `/f/<blob>` (where it is not, and a reload would otherwise
    // re-offer a field that is now saved).
    forgetDeepLink();
    swap(() =>
      mountField(root, {
        field,
        onOpenBoard: () => showBoard(field),
        onRecalibrate: () => showCalibrate(field),
        onRename: (name) => {
          const renamed = { ...field, name, updatedAt: Date.now() };
          // Saved before the screen changes, for the same reason calibration is
          // (decision 0013): a rename that only exists on screen is a rename
          // that is gone when the phone is put in a pocket.
          void store.save(renamed).then(() => showField(renamed));
        },
        onDelete: () => void store.remove(field.id).then(() => showHome()),
        onBack: () => void showHome(),
      }),
    );
  }

  /**
   * A shared field has been opened (stage 6.4, decision 0016).
   *
   * Everything needed to answer is in the path — there is no request here and no
   * server that knows this field exists — so this works on the phone in the park
   * with no signal, which is most of the point of putting the field in the link
   * rather than behind a lookup.
   */
  async function showFieldLink(blob: string): Promise<void> {
    const incoming = decodeFieldLink(blob);
    if (incoming === null) {
      swap(() => mountFieldLinkFailed(root, () => void showHome()));
      return;
    }
    // Against everything already held, so a copy of a copy is recognised rather
    // than piling up, and a re-calibration arrives as an improvement.
    const offer = offerFor(incoming, await store.list());
    swap(() =>
      mountFieldOffer(root, {
        offer,
        onAccept: () => void adoptField(store, offer, 'link').then(showField),
        onOpen: () => {
          if (offer.kind !== 'new') showField(offer.existing);
        },
        onDecline: () => void showHome(),
      }),
    );
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

  // Deliberately not awaited. A field that has not arrived yet is a home screen
  // with one fewer row on it; a home screen waiting on a request is a phone that
  // looks broken in a park. `online` covers the ordinary case of a walk that
  // started out of signal and ended in it.
  fieldSync.schedule();
  addEventListener('online', () => fieldSync.schedule());

  // A scanned QR, a shared link, or a reload of either: the path is the whole
  // instruction (stage 6.2.1). `parseAppRoute` is the same parser the Worker used
  // to decide this document was worth serving at all, so the two cannot disagree
  // about what a path means — which is the failure O-06 was about.
  const route = parseAppRoute(location.pathname);
  if (route?.kind === 'join') {
    showJoin(route.code);
    return;
  }
  if (route?.kind === 'field') {
    await showFieldLink(route.blob);
    return;
  }

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
  /** This account's games, or empty when signed out or off the air. */
  games: ListedGame[];
  /** Whether this browser can read a QR from inside a page (stage 6.2.3). */
  scanning: ScanSupport;
  platform: Platform;
  /** Who this phone is, as far as it knows (stage 2.2.4). */
  identity: KnownIdentity | null;
  /** Whether the server confirmed that on this launch. */
  confirmed: boolean;
  onAccount(): void;
  onCalibrate(): void;
  onOpen(field: FieldSpec): void;
  onNew(): void;
  onJoin(joinCode: string): void;
  onScan(): void;
  onTidy(): void;
}

/**
 * The saved fields, plus a live GPS readout.
 *
 * The readout stays because it is the thing you look at before deciding whether
 * it is worth walking out a board at all.
 */
function mountHome(root: HTMLElement, deps: HomeDeps): () => void {
  /**
   * Whether the games list is showing everything.
   *
   * Lives out here rather than in `paint`, because `paint` runs again on every
   * GPS fix — several times a second — and a flag inside it would collapse the
   * list under somebody's thumb.
   */
  let allGames = false;

  const paint = (state: GpsState) => {
    const fix = state.fix;
    root.innerHTML = `
      ${homeHeaderHtml(deps.identity, deps.confirmed)}
      ${
        // The pre-flight check (stage 2.2.3): above everything, because it is
        // only worth anything before somebody sets off. Recomputed on each
        // paint rather than once, which costs a subtraction and means a home
        // screen left open overnight catches up by itself.
        sessionNoticeHtml(
          sessionNotice(deps.identity, deps.confirmed, Date.now()),
          `/${location.search}`,
        )
      }
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
      ${gamesSectionHtml(deps, allGames)}
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
      .querySelector<HTMLButtonElement>('[data-account]')
      ?.addEventListener('click', deps.onAccount);
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
    root.querySelector<HTMLButtonElement>('[data-tidy]')?.addEventListener('click', deps.onTidy);
    root.querySelector<HTMLButtonElement>('[data-more]')?.addEventListener('click', () => {
      allGames = !allGames;
      paint(deps.gps.state);
    });
    // Tapping a game is the same act as typing its code, so it goes down the
    // same path: `showJoin` re-takes the seat, which is idempotent, and works
    // identically on the phone that started the game and on the player's other
    // one (stage 3.5.2).
    for (const item of root.querySelectorAll<HTMLElement>('[data-game]')) {
      item.addEventListener('click', () => deps.onJoin(item.dataset.game as string));
    }
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
 * "Your games", or nothing at all (stage 2.3.4).
 *
 * Absent rather than empty when there is nothing to show, and that covers three
 * different situations on purpose: no games yet, not signed in, and no signal.
 * All three are states in which the honest thing to say is nothing — a heading
 * over an empty list would read as "your games have gone", which for a player
 * who paused one last week is alarming and wrong. The list is an addition to the
 * home screen, and its failure mode is being the home screen that was there
 * before it existed.
 */
function gamesSectionHtml(deps: HomeDeps, all: boolean): string {
  const shown = homeGames(deps.games, all);
  if (shown.length === 0) return '';
  const now = Date.now();
  const hidden = hiddenGameCount(deps.games);
  return `
    <h2>Your games</h2>
    <ul class="games" data-games>
      ${shown.map((game) => gameItemHtml(game, now)).join('')}
    </ul>
    ${
      // Expanded in place rather than on a screen of its own. The whole problem
      // being solved is that this section pushes the rest of home out of reach,
      // and a second screen would be a heavier answer to "show me the other
      // two" than the question deserves.
      hidden > 0
        ? `<p><button data-more class="secondary">Show ${hidden} more game${hidden === 1 ? '' : 's'}</button></p>`
        : all && deps.games.length > HOME_SHOWN
          ? `<p><button data-more class="secondary">Show fewer</button></p>`
          : ''
    }
    ${
      shouldOfferTidy(deps.games)
        ? `<p><button data-tidy class="secondary">Tidy up old games</button></p>`
        : ''
    }
  `;
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
  // Ground you have never walked reads exactly like ground you have, unless it
  // is labelled — and since stage 6.4 a phone can acquire fields two ways
  // without anyone tapping a corner (decisions 0016 and 0027).
  const from =
    spec.origin === undefined
      ? ''
      : ` · ${spec.origin.via === 'game' ? 'from a game' : 'shared with you'}`;
  return `<li data-field="${spec.id}" tabindex="0" role="button">
    <strong>${escapeHtml(spec.name)}</strong>
    <span class="dim">${describeSquares(geo)}${from}</span>
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
 * `localStorage`, or null where touching it throws (some private modes do).
 *
 * The identity cache is a nicety (stage 2.2.4), so a browser that refuses it
 * loses the offline account line and nothing else.
 */
function browserIdentityStorage(): IdentityStorage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
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
