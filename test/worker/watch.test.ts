import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { deriveGeometry, makeFieldSpec, snapshotField, squareCentreLatLng } from '../../src/shared/field.js';
import { fromLocal } from '../../src/shared/geo.js';
import { fromSquare } from '../../src/shared/squares.js';
import { WATCH_CLOSE, WATCH_MAX_WATCHERS, parseWatchLink } from '../../src/shared/watch.js';
import type { GameDO } from '../../src/worker/game-do.js';

/**
 * Watching a game live (stage 10.14, decision 0055, O-37), against the real
 * runtime.
 *
 * What has to be true:
 *
 * - **consent**: one player alone turns nothing on; both do; either turns it
 *   off, and the link dies at once and stays dead;
 * - **the token**: the join code is not a watch link, and a watch link is not
 *   a seat;
 * - **the cap**: at most {@link WATCH_MAX_WATCHERS} at once, and a polite
 *   refusal past it;
 * - **watchers are nobody**: arriving or leaving changes nothing the game
 *   holds — presence, the handshake, the disconnect grace, the suspension,
 *   collection — in any state;
 * - **no coordinate ever reaches a watcher**, across a whole game;
 * - **the link dies with the game**, after the watcher has seen the result.
 */

const SECRET = 'test-dev-auth-secret';
const LOCAL = 'http://127.0.0.1';
// Somewhere whose coordinates no square index or clock could ever be mistaken
// for: a leak of either shows up in the scan below as itself.
const A1 = { lat: 37.123456, lng: -122.654321 };
const SQUARE_M = 6;
const FIELD = snapshotField(
  makeFieldSpec('Grandma backyard', { a1: A1, h8: fromLocal(A1, { e: 7 * SQUARE_M, n: 7 * SQUARE_M }) }),
);
const GEO = deriveGeometry(FIELD);
const mutableEnv = env as unknown as Record<string, unknown>;

beforeEach(() => {
  mutableEnv.DEV_AUTH_SECRET = SECRET;
});

const cookies = new Map<string, string>();
async function cookieFor(sub: string): Promise<string> {
  const known = cookies.get(sub);
  if (known !== undefined) return known;
  const response = await SELF.fetch(`${LOCAL}/api/dev/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-auth-secret': SECRET },
    body: JSON.stringify({ sub }),
  });
  expect(response.status).toBe(200);
  const cookie = (response.headers.get('set-cookie') as string).split(';')[0]!;
  cookies.set(sub, cookie);
  return cookie;
}

let counter = 0;
function nextSub(): string {
  counter += 1;
  return `watch-tester-${counter}`;
}
function nextCode(): string {
  counter += 1;
  return `W${String(counter).padStart(5, '0')}`;
}

function at(square: string, acc = 3) {
  const p = squareCentreLatLng(GEO, fromSquare(square));
  return { lat: p.lat, lng: p.lng, acc, ts: Date.now() };
}

type Msg = Record<string, unknown>;

class Client {
  readonly received: Msg[] = [];
  readonly raw: string[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly waiters: { predicate: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];

  constructor(readonly ws: WebSocket) {
    ws.accept();
    this.closed = new Promise((resolve) => {
      ws.addEventListener('close', (event) => {
        const e = event as CloseEvent;
        resolve({ code: e.code, reason: e.reason });
      });
    });
    ws.addEventListener('message', (event) => {
      const text = String((event as MessageEvent).data);
      this.raw.push(text);
      const msg = JSON.parse(text) as Msg;
      this.received.push(msg);
      const i = this.waiters.findIndex((w) => w.predicate(msg));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(msg);
    });
  }

  next(predicate: (m: Msg) => boolean = () => true, timeoutMs = 2000): Promise<Msg> {
    const buffered = this.received.find(predicate);
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out; got ${JSON.stringify(this.received.map((m) => m.t))}`)),
        timeoutMs,
      );
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  state(test: (game: Msg) => boolean): Promise<Msg> {
    return this.next((m) => m.t === 'state' && test(m.game as Msg)).then((m) => m.game as Msg);
  }

  view(test: (game: Msg) => boolean): Promise<Msg> {
    return this.next((m) => m.t === 'watch_state' && test(m.game as Msg)).then((m) => m.game as Msg);
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  clear(): void {
    this.received.length = 0;
  }

  close(): void {
    this.ws.close();
  }
}

/** As in `record.test.ts` (O-52): wait until the object has handled everything sent on `ws`. */
let barriers = 0;
async function handled(ws: WebSocket, timeoutMs = 2_000): Promise<void> {
  barriers += 1;
  const marker = `test-barrier-${barriers}`;
  let onMessage: (event: Event) => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answered = new Promise<void>((resolve, reject) => {
    onMessage = (event: Event) => {
      const data = JSON.parse(String((event as MessageEvent).data)) as { t: string; message?: string };
      if (data.t === 'error' && data.message?.includes(`"${marker}"`)) resolve();
    };
    ws.addEventListener('message', onMessage);
    timer = setTimeout(() => reject(new Error(`barrier reply never came within ${timeoutMs} ms`)), timeoutMs);
  });
  ws.send(JSON.stringify({ t: marker }));
  try {
    await answered;
  } finally {
    clearTimeout(timer);
    ws.removeEventListener('message', onMessage);
  }
}

interface Game {
  joinCode: string;
  stub: DurableObjectStub<GameDO>;
  white: string;
  black: string;
}

async function seated(): Promise<Game> {
  const joinCode = nextCode();
  const white = nextSub();
  const black = nextSub();
  const stub = env.GAME.getByName(joinCode) as DurableObjectStub<GameDO>;
  expect(
    await stub.create({
      joinCode,
      creatorPlayerId: white,
      creatorAccount: white,
      creatorColor: 'w',
      field: FIELD,
      initialMs: 600_000,
      incrementMs: 10_000,
    }),
  ).toBe(true);
  expect(await stub.join(black, black)).toMatchObject({ ok: true, color: 'b' });
  return { joinCode, stub, white, black };
}

async function openSocket(game: Game, sub: string): Promise<Client> {
  const res = await SELF.fetch(`${LOCAL}/api/game/${game.joinCode}/ws`, {
    headers: { upgrade: 'websocket', cookie: await cookieFor(sub) },
  });
  expect(res.status).toBe(101);
  const client = new Client(res.webSocket as WebSocket);
  await client.next((m) => m.t === 'state');
  return client;
}

/** Both players connected, still staging. */
async function connected(): Promise<Game & { w: Client; b: Client }> {
  const game = await seated();
  const w = await openSocket(game, game.white);
  const b = await openSocket(game, game.black);
  return { ...game, w, b };
}

async function start(game: Game & { w: Client; b: Client }): Promise<void> {
  game.w.send({ t: 'ready', pos: at('e1') });
  game.b.send({ t: 'ready', pos: at('e8') });
  await game.w.state((g) => g.status === 'active');
  await game.b.state((g) => g.status === 'active');
  game.w.clear();
  game.b.clear();
}

/** Both agree, and the link the players were given. */
async function agree(game: Game & { w: Client; b: Client }): Promise<string> {
  game.w.clear();
  game.b.clear();
  game.w.send({ t: 'watch', action: 'on' });
  await game.b.state((g) => (g.watch as Msg).offeredBy === 'w');
  game.b.send({ t: 'watch', action: 'on' });
  const on = await game.w.state((g) => (g.watch as Msg).on === true);
  const link = (on.watch as Msg).link as string;
  expect(link).toMatch(/^\/w\/[0-9a-f]{64}\.[A-Za-z0-9_-]{22}$/);
  game.w.clear();
  game.b.clear();
  return link;
}

/** Open a watcher on a link's path (`/w/…`), signed out. Resolves once it is open or refused. */
async function watcher(link: string): Promise<Client> {
  const segment = link.replace(/^\/w\//, '');
  const res = await SELF.fetch(`${LOCAL}/api/watch/${segment}/ws`, { headers: { upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  return new Client(res.webSocket as WebSocket);
}

async function watching(link: string): Promise<Client> {
  const client = await watcher(link);
  await client.view(() => true);
  return client;
}

async function refused(link: string): Promise<number> {
  const client = await watcher(link);
  const { code } = await client.closed;
  expect(client.received.filter((m) => m.t === 'watch_state')).toEqual([]);
  return code;
}

async function row(game: Game): Promise<Record<string, unknown>> {
  return runInDurableObject(game.stub, (_i, state) =>
    [...state.storage.sql.exec(`SELECT * FROM game WHERE id = 1`)][0] as Record<string, unknown>,
  );
}

async function presence(game: Game): Promise<Record<string, unknown>[]> {
  return runInDurableObject(game.stub, (_i, state) => [
    ...state.storage.sql.exec(
      `SELECT player_id, color, connected, in_start_zone, last_seen_at, last_lat, last_lng, last_pos_at FROM presence ORDER BY color`,
    ),
  ]);
}

async function timerKinds(game: Game): Promise<string[]> {
  return runInDurableObject(game.stub, (_i, state) =>
    [...state.storage.sql.exec<{ kind: string }>(`SELECT kind FROM timers ORDER BY kind`)].map((r) => r.kind),
  );
}

/** Everything the game holds that a watcher must never move. */
async function gameFacts(game: Game) {
  const r = await row(game);
  return {
    rev: r.rev,
    status: r.status,
    updated_at: r.updated_at,
    suspended_by: r.suspended_by,
    last_clock_start_at: r.last_clock_start_at,
    presence: await presence(game),
    timers: await timerKinds(game),
  };
}

/** Wait until the object has seen a watcher's socket close. */
async function watcherGone(game: Game, open: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const n = await runInDurableObject(game.stub, (_i, state) =>
      state.getWebSockets('watcher').filter((ws) => ws.readyState === WebSocket.OPEN).length,
    );
    if (n <= open) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the watcher never closed');
}

/** Wait until a player's presence says they have gone. */
async function untilAbsent(game: Game, color: 'w' | 'b'): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await presence(game)).find((r) => r.color === color)?.connected === 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${color} never went`);
}

async function dropAndSettle(game: Game, client: Client): Promise<void> {
  client.close();
  for (let i = 0; i < 400; i++) {
    if ((await timerKinds(game)).includes('disconnect')) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('no disconnect deadline was scheduled');
}

async function fireDue(game: Game, kind: string): Promise<void> {
  await runInDurableObject(game.stub, async (_i, state) => {
    state.storage.sql.exec(`UPDATE timers SET due_at = ? WHERE kind = ?`, Date.now() - 1, kind);
    await state.storage.setAlarm(Date.now() + 3_600_000);
  });
  expect(await runDurableObjectAlarm(game.stub)).toBe(true);
}

async function move(game: Game, client: Client, from: string, to: string): Promise<void> {
  client.clear();
  client.send({ t: 'lift', from, pos: at(from) });
  await client.state((g) => (g.carry as Msg | null)?.from === from);
  await runInDurableObject(game.stub, (_i, state) => {
    state.storage.sql.exec(`UPDATE carry SET lift_at = lift_at - 10000`);
  });
  client.send({ t: 'place', to, pos: at(to) });
  const answer = await client.next(
    (m) =>
      m.t === 'error' ||
      (m.t === 'state' &&
        ((m.game as Msg).lastMove as Msg | null)?.from === from &&
        ((m.game as Msg).lastMove as Msg).to === to),
  );
  if (answer.t === 'error') throw new Error(`${from}-${to}: ${answer.code} ${answer.message}`);
  client.clear();
}

/**
 * Every place a coordinate, the field, or anything that names the game or the
 * players could hide in a message: by key, by number and by text. Returns the
 * paths of whatever it found.
 */
function leaks(value: unknown, path = '$'): string[] {
  const found: string[] = [];
  const forbiddenKey = /lat|lng|lon|acc|field|corner|bearing|origin|joincode|code|name|account|sub|player_?id|reach|geo/i;
  // Within about a kilometer of the field. A revision or a square could be 37,
  // but never 37.12.
  const nearCoordinate = (n: number) => Math.abs(n - A1.lat) < 0.01 || Math.abs(n - A1.lng) < 0.01;
  if (typeof value === 'number') {
    if (nearCoordinate(value)) found.push(`${path} = ${value}`);
  } else if (typeof value === 'string') {
    if (/37\.12|122\.65|Grandma/.test(value)) found.push(`${path} = ${value}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => found.push(...leaks(v, `${path}[${i}]`)));
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, v] of Object.entries(value)) {
      if (forbiddenKey.test(key)) found.push(`${path}.${key}`);
      found.push(...leaks(v, `${path}.${key}`));
    }
  }
  return found;
}

// ---------------------------------------------------------------------------

describe('both players agree before anyone can watch', () => {
  it('one player asking turns nothing on; the other agreeing does', async () => {
    const game = await connected();
    game.w.send({ t: 'watch', action: 'on' });
    const asked = await game.b.state((g) => (g.watch as Msg).offeredBy === 'w');
    expect(asked.watch).toEqual({ offeredBy: 'w', on: false, link: null });
    // Asking again, alone, still turns nothing on.
    game.w.send({ t: 'watch', action: 'on' });
    await handled(game.w.ws);
    expect((await row(game)).status).toBe('staging');
    const metaRows = await runInDurableObject(game.stub, (_i, state) =>
      [...state.storage.sql.exec<{ key: string }>(`SELECT key FROM meta WHERE key LIKE 'watch%'`)].map((r) => r.key),
    );
    expect(metaRows).toEqual(['watch_offer']);

    game.b.send({ t: 'watch', action: 'on' });
    const on = await game.w.state((g) => (g.watch as Msg).on === true);
    expect((on.watch as Msg).offeredBy).toBeNull();
    const link = (on.watch as Msg).link as string;
    // Both players hold the same link.
    const theirs = await game.b.state((g) => (g.watch as Msg).on === true);
    expect((theirs.watch as Msg).link).toBe(link);
    const w = await watching(link);
    expect(w.received[0]!.t).toBe('watch_state');
    w.close();
    game.w.close();
    game.b.close();
  });

  it('a link nobody agreed to does not work, and declining clears the ask', async () => {
    const game = await connected();
    game.w.send({ t: 'watch', action: 'on' });
    await game.b.state((g) => (g.watch as Msg).offeredBy === 'w');
    // The right object, a made-up secret: the same refusal as a dead link.
    const id = await runInDurableObject(game.stub, (_i, state) => state.id.toString());
    expect(await refused(`/w/${id}.${'A'.repeat(22)}`)).toBe(WATCH_CLOSE.notLive);
    game.w.clear();
    game.b.clear();
    game.b.send({ t: 'watch', action: 'off' });
    const declined = await game.w.state((g) => (g.watch as Msg).offeredBy === null);
    expect(declined.watch).toEqual({ offeredBy: null, on: false, link: null });
    game.w.close();
    game.b.close();
  });

  for (const who of ['w', 'b'] as const) {
    it(`${who === 'w' ? 'white' : 'black'} turning it off kills the link at once, and for good`, async () => {
      const game = await connected();
      await start(game);
      const link = await agree(game);
      const first = await watching(link);
      const second = await watching(link);
      game[who].send({ t: 'watch', action: 'off' });
      expect((await first.closed).code).toBe(WATCH_CLOSE.notLive);
      expect((await second.closed).code).toBe(WATCH_CLOSE.notLive);
      const off = await game.w.state((g) => (g.watch as Msg).on === false);
      expect(off.watch).toEqual({ offeredBy: null, on: false, link: null });
      expect(await refused(link)).toBe(WATCH_CLOSE.notLive);

      // On again: a new link, and the old one stays dead.
      const again = await agree(game);
      expect(again).not.toBe(link);
      expect(await refused(link)).toBe(WATCH_CLOSE.notLive);
      const third = await watching(again);
      third.close();
      game.w.close();
      game.b.close();
    });
  }

  it('an unanswered ask lapses with a pause, and an "on" after the resume is a new ask', async () => {
    const game = await connected();
    await start(game);
    game.w.send({ t: 'watch', action: 'on' });
    await game.b.state((g) => (g.watch as Msg).offeredBy === 'w');
    game.w.clear();
    game.b.clear();
    game.b.send({ t: 'pause' });
    // Both phones learn it from the snapshot that says the game is paused.
    for (const phone of [game.w, game.b]) {
      const paused = await phone.state((g) => g.status === 'suspended');
      expect(paused.watch).toEqual({ offeredBy: null, on: false, link: null });
    }
    game.w.send({ t: 'ready', pos: at('e1') });
    game.b.send({ t: 'ready', pos: at('e8') });
    await game.w.state((g) => g.status === 'active');
    game.w.clear();
    game.b.clear();
    game.b.send({ t: 'watch', action: 'on' });
    const asked = await game.w.state((g) => (g.watch as Msg).offeredBy === 'b');
    expect(asked.watch).toEqual({ offeredBy: 'b', on: false, link: null });
    await handled(game.b.ws);
    const keys = await runInDurableObject(game.stub, (_i, state) =>
      [...state.storage.sql.exec<{ key: string }>(`SELECT key FROM meta WHERE key LIKE 'watch%'`)].map((r) => r.key),
    );
    expect(keys).toEqual(['watch_offer']);
    game.w.close();
    game.b.close();
  });

  it('a link already agreed to stays on through a pause', async () => {
    const game = await connected();
    await start(game);
    const link = await agree(game);
    const w = await watching(link);
    game.w.send({ t: 'pause' });
    const paused = await game.b.state((g) => g.status === 'suspended');
    expect((paused.watch as Msg).on).toBe(true);
    await w.view((g) => g.status === 'suspended');
    expect(w.ws.readyState).toBe(WebSocket.OPEN);
    w.close();
    game.w.close();
    game.b.close();
  });

  it('cannot be asked for before both players are in, or after the game', async () => {
    const joinCode = nextCode();
    const white = nextSub();
    const stub = env.GAME.getByName(joinCode) as DurableObjectStub<GameDO>;
    await stub.create({
      joinCode,
      creatorPlayerId: white,
      creatorAccount: white,
      creatorColor: 'w',
      field: FIELD,
      initialMs: 600_000,
      incrementMs: 0,
    });
    const w = await openSocket({ joinCode, stub, white, black: '' }, white);
    w.send({ t: 'watch', action: 'on' });
    const error = await w.next((m) => m.t === 'error');
    expect(error.code).toBe('not_active');
    w.close();
  });
});

describe('the watch link is its own token', () => {
  it('the join code does not work as a watch link, nor a watch link as a code', async () => {
    const game = await connected();
    const link = await agree(game);
    const parsed = parseWatchLink(link.replace(/^\/w\//, ''))!;
    // The join code in place of the secret, of the id, and of the whole link.
    expect(await refused(`/w/${parsed.id}.${game.joinCode.padEnd(22, 'A')}`)).toBe(WATCH_CLOSE.notLive);
    for (const segment of [game.joinCode, `${game.joinCode}.${parsed.secret}`]) {
      const res = await SELF.fetch(`${LOCAL}/api/watch/${segment}/ws`, { headers: { upgrade: 'websocket' } });
      expect(res.status).toBe(404);
    }
    // An id that is not this namespace's.
    const res = await SELF.fetch(`${LOCAL}/api/watch/${'0'.repeat(64)}.${parsed.secret}/ws`, {
      headers: { upgrade: 'websocket' },
    });
    expect(res.status).toBe(404);
    // The link where a code goes: not a code at all.
    const asCode = await SELF.fetch(`${LOCAL}/api/game/${parsed.secret}`, {
      method: 'POST',
      headers: { cookie: await cookieFor(nextSub()) },
    });
    expect(asCode.status).toBe(400);
    game.w.close();
    game.b.close();
  });

  it('a watcher holds no seat: what it sends closes it and changes nothing', async () => {
    const game = await connected();
    await start(game);
    const link = await agree(game);
    const before = await gameFacts(game);
    const w = await watching(link);
    w.send({ t: 'lift', from: 'e2', pos: at('e2') });
    expect((await w.closed).code).toBe(WATCH_CLOSE.sent);
    await watcherGone(game, 0);
    await handled(game.w.ws);
    expect(await gameFacts(game)).toEqual(before);
    expect((await row(game)).fen).toMatch(/^rnbqkbnr\/pppppppp/);

    // Nor does a signed-out phone get anything from the game's own routes.
    const ws = await SELF.fetch(`${LOCAL}/api/game/${game.joinCode}/ws`, { headers: { upgrade: 'websocket' } });
    expect(ws.status).toBe(401);
    // And the watcher's view never carries the code or the field.
    expect(JSON.stringify(w.received)).not.toContain(game.joinCode);
    game.w.close();
    game.b.close();
  });

  it('an object with no game answers 404 and is not brought into being', async () => {
    const code = nextCode();
    const stub = env.GAME.getByName(code);
    const id = stub.id.toString();
    const res = await SELF.fetch(`${LOCAL}/api/watch/${id}.${'B'.repeat(22)}/ws`, {
      headers: { upgrade: 'websocket' },
    });
    expect(res.status).toBe(404);
    const tables = await runInDurableObject(stub, (_i, state) =>
      [
        ...state.storage.sql.exec(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\_cf\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\_%' ESCAPE '\\'`,
        ),
      ].length,
    );
    expect(tables).toBe(0);
  });
});

describe('the cap', () => {
  it(`takes ${WATCH_MAX_WATCHERS} watchers, politely refuses the next, and has room again when one leaves`, async () => {
    const game = await connected();
    const link = await agree(game);
    const watchers: Client[] = [];
    for (let i = 0; i < WATCH_MAX_WATCHERS; i++) watchers.push(await watching(link));
    expect(await refused(link)).toBe(WATCH_CLOSE.full);
    // A refusal is not a watcher, and moves nobody already watching off.
    for (const w of watchers) expect(w.ws.readyState).toBe(WebSocket.OPEN);
    watchers.shift()!.close();
    await watcherGone(game, WATCH_MAX_WATCHERS - 1);
    watchers.push(await watching(link));
    for (const w of watchers) w.close();
    game.w.close();
    game.b.close();
  });
});

describe('a watcher is nobody to the game', () => {
  it('staging: arriving and leaving moves nothing, and the handshake ignores them', async () => {
    const game = await connected();
    const link = await agree(game);
    const before = await gameFacts(game);
    const watchers = [await watching(link), await watching(link)];
    await handled(game.w.ws);
    expect(await gameFacts(game)).toEqual(before);
    watchers[0]!.close();
    await watcherGone(game, 1);
    await handled(game.w.ws);
    expect(await gameFacts(game)).toEqual(before);

    // Black goes away; a watcher stays. White on the back rank does not start
    // a game against a watcher.
    game.b.close();
    await untilAbsent(game, 'b');
    game.w.send({ t: 'ready', pos: at('e1') });
    await handled(game.w.ws);
    expect((await row(game)).status).toBe('staging');
    const rows = await presence(game);
    expect(rows.map((r) => [r.color, r.connected])).toEqual([
      ['b', 0],
      ['w', 1],
    ]);
    watchers[1]!.close();
    game.w.close();
  });

  it('active: a player gone with watchers still open is gone, and the game suspends on them', async () => {
    const game = await connected();
    await start(game);
    const link = await agree(game);
    const w1 = await watching(link);
    const w2 = await watching(link);
    const before = await gameFacts(game);
    // A watcher leaving during play: no grace timer, no snapshot, nothing.
    w2.close();
    await watcherGone(game, 1);
    await handled(game.w.ws);
    expect(await gameFacts(game)).toEqual(before);
    expect(await timerKinds(game)).not.toContain('disconnect');

    await dropAndSettle(game, game.b);
    await fireDue(game, 'disconnect');
    const r = await row(game);
    expect(r.status).toBe('suspended');
    // Black is the one gone: the watchers did not make anybody "both gone"
    // or "both here".
    expect(r.suspended_by).toBe('b');
    const view = await w1.view((g) => g.status === 'suspended');
    expect(view.suspension).toEqual({ by: 'b' });
    expect((view.players as Msg).b).toMatchObject({ connected: false });
    w1.close();
    game.w.close();
  });

  it('suspended: watchers come and go and the resume still needs both players', async () => {
    const game = await connected();
    await start(game);
    const link = await agree(game);
    game.w.send({ t: 'pause' });
    await game.b.state((g) => g.status === 'suspended');
    const before = await gameFacts(game);
    const w = await watching(link);
    w.close();
    await watcherGone(game, 0);
    await handled(game.w.ws);
    expect(await gameFacts(game)).toEqual(before);
    game.w.clear();
    game.b.clear();
    game.w.send({ t: 'ready', pos: at('e1') });
    game.b.send({ t: 'ready', pos: at('e8') });
    await game.w.state((g) => g.status === 'active');
    game.w.close();
    game.b.close();
  });

  it('collection does not count a watcher as somebody looking at the board', async () => {
    const game = await connected();
    const link = await agree(game);
    const w = await watching(link);
    const counts = await runInDurableObject(game.stub, (instance) => {
      const open = (instance as unknown as { openSockets(): number }).openSockets();
      return open;
    });
    // Two players' boards; the watcher is not a third.
    expect(counts).toBe(2);
    w.close();
    game.w.close();
    game.b.close();
  });
});

describe('a watcher never receives a coordinate', () => {
  it('across a whole game: lifts, carries, relays, the handshake and the mate', async () => {
    const game = await connected();
    const link = await agree(game);
    const w = await watching(link);
    await start(game);
    // Relays from both, on and off the board, and far away.
    game.w.send({ t: 'pos', ...at('d3') });
    await w.next((m) => m.t === 'watch_pos' && m.color === 'w');
    await new Promise((r) => setTimeout(r, 1600));
    game.b.send({ t: 'pos', ...fromLocal(A1, { e: 3000, n: 4000 }), acc: 5 });
    const far = await w.next((m) => m.t === 'watch_pos' && m.color === 'b');
    expect(far.at).toBeNull();
    // Fool's mate, each piece carried.
    await move(game, game.w, 'f2', 'f3');
    await move(game, game.b, 'e7', 'e5');
    await move(game, game.w, 'g2', 'g4');
    game.b.clear();
    // With the distance report a real phone sends, which is what moves the
    // carrier's stored fix to where the lift was made.
    game.b.send({ t: 'lift', from: 'd8', pos: at('d8'), travelM: 0, leg: 'leg-b' });
    const carrying = await w.view((g) => (g.carry as Msg | null)?.from === 'd8');
    expect(carrying.carry).toEqual({ color: 'b', from: 'd8', piece: 'q' });
    // The carrier's dot, in squares, on d8: (3, 7).
    const spot = (carrying.players as Record<string, Msg>).b!.at as Msg;
    expect(spot.file).toBeCloseTo(3, 1);
    expect(spot.rank).toBeCloseTo(7, 1);
    await runInDurableObject(game.stub, (_i, state) => {
      state.storage.sql.exec(`UPDATE carry SET lift_at = lift_at - 10000`);
    });
    game.b.send({ t: 'place', to: 'h4', pos: at('h4') });
    const final = await w.view((g) => g.result !== null);
    expect(final.result).toMatchObject({ outcome: '0-1', reason: 'checkmate' });
    expect(final.moves).toEqual(['f3', 'e5', 'g4', 'Qh4#']);
    expect(final.lastMove).toMatchObject({ from: 'd8', to: 'h4', san: 'Qh4#', color: 'b' });
    await w.closed;

    // Every message, every key, every number, every string.
    expect(w.received.length).toBeGreaterThan(8);
    expect(new Set(w.received.map((m) => m.t))).toEqual(new Set(['watch_state', 'watch_pos']));
    expect(w.received.flatMap((m, i) => leaks(m, `#${i}`))).toEqual([]);
    expect(w.raw.join('\n')).not.toContain(game.joinCode);
    // While the players' own messages are full of them, which is the point of
    // building the watcher's view apart rather than trimming theirs.
    expect(leaks({ t: 'state', game: (await game.stub.peek(game.white)) }).length).toBeGreaterThan(0);
    game.w.close();
    game.b.close();
  });
});

describe('the link dies with the game', () => {
  it('a result: the watcher sees it, is closed, and the link is dead', async () => {
    const game = await connected();
    await start(game);
    const link = await agree(game);
    const w = await watching(link);
    await move(game, game.w, 'e2', 'e4');
    game.b.send({ t: 'resign' });
    const final = await w.view((g) => g.status === 'finished');
    expect(final.result).toMatchObject({ outcome: '1-0', reason: 'resignation' });
    expect((await w.closed).code).toBe(WATCH_CLOSE.over);
    expect(await refused(link)).toBe(WATCH_CLOSE.notLive);
    const after = await game.w.state((g) => g.status === 'finished');
    expect(after.watch).toEqual({ offeredBy: null, on: false, link: null });
    // And it cannot be turned on again.
    game.w.send({ t: 'watch', action: 'on' });
    expect((await game.w.next((m) => m.t === 'error')).code).toBe('not_active');
    game.w.close();
    game.b.close();
  });

  it('an abort, and an ask left standing, go too', async () => {
    const game = await connected();
    const link = await agree(game);
    const w = await watching(link);
    game.w.send({ t: 'abort' });
    expect((await w.closed).code).toBe(WATCH_CLOSE.over);
    expect(await refused(link)).toBe(WATCH_CLOSE.notLive);
    const keys = await runInDurableObject(game.stub, (_i, state) =>
      [...state.storage.sql.exec<{ key: string }>(`SELECT key FROM meta WHERE key LIKE 'watch%'`)].map((r) => r.key),
    );
    expect(keys).toEqual([]);
    game.w.close();
    game.b.close();
  });
});
