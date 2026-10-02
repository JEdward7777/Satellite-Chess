import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { deriveGeometry, makeFieldSpec, snapshotField, squareCentreLatLng } from '../../src/shared/field.js';
import { fromLocal } from '../../src/shared/geo.js';
import type { ListedGame } from '../../src/shared/game-index.js';
import type { RecordSummary } from '../../src/shared/record.js';
import { fromSquare } from '../../src/shared/squares.js';
import { archiveKey } from '../../src/worker/archive.js';
import { UNPLAYED_GAME_TTL_MS } from '../../src/worker/collection.js';
import type { GameDO } from '../../src/worker/game-do.js';
import { applySchema } from '../../src/worker/schema.js';

/**
 * Ending a game early: resign, a draw by agreement, and abort (stage 10.11,
 * decision 0050, O-50).
 *
 * The owner's game sat on a broken field with no way out. What has to be true,
 * each against the real runtime:
 *
 * - a player can resign alone in every state a game can be stuck in — the
 *   opponent gone, the game paused or suspended — and the result flows to the
 *   record like any other;
 * - a draw offer is answered, declined, or lapses with the next move;
 * - either player may abort alone before each side has moved, including a
 *   handshake that never completed, and only both together after;
 * - an aborted game writes **no** record line, however often it is pushed,
 *   can be tidied off the list, and is collected like an unplayed game.
 */

const SECRET = 'test-dev-auth-secret';
const LOCAL = 'http://127.0.0.1';
const A1 = { lat: 51.4779, lng: -0.0015 };
const SQUARE_M = 8;
const FIELD = snapshotField(
  makeFieldSpec('Broken field', { a1: A1, h8: fromLocal(A1, { e: 7 * SQUARE_M, n: 7 * SQUARE_M }) }),
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
  mutableEnv.DEV_AUTH_SECRET = SECRET;
  const response = await SELF.fetch(`${LOCAL}/api/dev/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-auth-secret': SECRET },
    body: JSON.stringify({ sub }),
  });
  expect(response.status).toBe(200);
  const cookie = (response.headers.get('set-cookie') as string).split(';')[0];
  cookies.set(sub, cookie);
  return cookie;
}

let counter = 0;
function nextSub(): string {
  counter += 1;
  return `endings-tester-${counter}`;
}
function nextCode(): string {
  counter += 1;
  return `E${String(counter).padStart(5, '0')}`;
}

function at(square: string, acc = 3) {
  const p = squareCentreLatLng(GEO, fromSquare(square));
  return { lat: p.lat, lng: p.lng, acc, ts: Date.now() };
}

type Msg = Record<string, unknown>;

class Client {
  readonly received: Msg[] = [];
  private readonly waiters: { predicate: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];

  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String((event as MessageEvent).data)) as Msg;
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
      this.waiters.push({ predicate, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }

  /**
   * The first snapshot since the last {@link clear} that satisfies `test`.
   * Both phones see every broadcast, so a test sends through {@link say},
   * which clears both first: a leftover snapshot would otherwise satisfy a
   * wait before the message it is waiting on has even arrived.
   */
  state(test: (game: Msg) => boolean): Promise<Msg> {
    return this.next((m) => m.t === 'state' && test(m.game as Msg)).then((m) => m.game as Msg);
  }

  error(): Promise<Msg> {
    return this.next((m) => m.t === 'error');
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

interface Game {
  joinCode: string;
  stub: DurableObjectStub<GameDO>;
  white: string;
  black: string;
}

/** Two accounts seated, staging: the handshake has not happened. */
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

/** Seated, both connected, and started through the real handshake. */
async function started(): Promise<Game & { w: Client; b: Client }> {
  const game = await seated();
  const w = await openSocket(game, game.white);
  const b = await openSocket(game, game.black);
  w.send({ t: 'ready', pos: at('e1') });
  b.send({ t: 'ready', pos: at('e8') });
  await w.state((g) => g.status === 'active');
  await b.state((g) => g.status === 'active');
  w.clear();
  b.clear();
  return { ...game, w, b };
}

/** Send from one phone, having emptied both phones' buffers. */
function say(game: { w: Client; b: Client }, from: Client, msg: unknown): void {
  game.w.clear();
  game.b.clear();
  from.send(msg);
}

/** Lift, walk (backdated, as `carry.test.ts` explains), place. */
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

async function peekStatus(game: Game): Promise<string | undefined> {
  return (await game.stub.peek()).status;
}

async function row(game: Game): Promise<Record<string, unknown>> {
  return runInDurableObject(game.stub, (_i, state) =>
    [...state.storage.sql.exec(`SELECT * FROM game WHERE id = 1`)][0] as Record<string, unknown>,
  );
}

async function metaKeys(game: Game): Promise<string[]> {
  return runInDurableObject(game.stub, (_i, state) =>
    [...state.storage.sql.exec<{ key: string }>(`SELECT key FROM meta`)].map((r) => r.key),
  );
}

async function timerKinds(game: Game): Promise<string[]> {
  return runInDurableObject(game.stub, (_i, state) =>
    [...state.storage.sql.exec<{ kind: string }>(`SELECT kind FROM timers`)].map((r) => r.kind),
  );
}

async function recordOf(sub: string): Promise<RecordSummary> {
  const response = await SELF.fetch(`${LOCAL}/api/record`, { headers: { cookie: await cookieFor(sub) } });
  expect(response.status).toBe(200);
  return ((await response.json()) as { record: RecordSummary }).record;
}

async function listGames(sub: string): Promise<ListedGame[]> {
  const response = await SELF.fetch(`${LOCAL}/api/games`, { headers: { cookie: await cookieFor(sub) } });
  expect(response.status).toBe(200);
  return ((await response.json()) as { games: ListedGame[] }).games;
}

async function forget(sub: string, joinCodes: string[]) {
  const response = await SELF.fetch(`${LOCAL}/api/games/forget`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: await cookieFor(sub) },
    body: JSON.stringify({ joinCodes }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { forgotten: string[]; kept: { joinCode: string; reason: string }[] };
}

/** Wait until the object has seen every socket close. */
async function settled(game: Game): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const open = await runInDurableObject(game.stub, (_i, state) =>
      state.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN).length,
    );
    if (open === 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('sockets never closed');
}

/** Close a socket and wait for the object to schedule the disconnect grace. */
async function dropAndSettle(game: Game, client: Client): Promise<void> {
  client.close();
  for (let i = 0; i < 400; i++) {
    if ((await timerKinds(game)).includes('disconnect')) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('no disconnect deadline was scheduled');
}

/** Fire every timer that is due now, through the real alarm handler. */
async function fireDue(game: Game, kind: string): Promise<void> {
  await runInDurableObject(game.stub, async (_i, state) => {
    state.storage.sql.exec(`UPDATE timers SET due_at = ? WHERE kind = ?`, Date.now() - 1, kind);
    await state.storage.setAlarm(Date.now() + 3_600_000);
  });
  expect(await runDurableObjectAlarm(game.stub)).toBe(true);
}

// ---------------------------------------------------------------------------

describe('resign works in every state a game can be stuck in', () => {
  it('while active: a normal result, in both records and both lists', async () => {
    const game = await started();
    await move(game, game.w, 'e2', 'e4');
    await move(game, game.b, 'e7', 'e5');
    say(game, game.w, { t: 'resign' });
    const ended = await game.b.state((g) => g.result !== null);
    expect(ended.result).toMatchObject({ outcome: '0-1', reason: 'resignation' });

    const white = await recordOf(game.white);
    const black = await recordOf(game.black);
    expect(white.recent.map((r) => r.joinCode)).toEqual([game.joinCode]);
    expect(black.recent.map((r) => r.joinCode)).toEqual([game.joinCode]);
    expect(white.totals.losses).toBe(1);
    expect(black.totals.wins).toBe(1);
    expect((await listGames(game.white))[0]).toMatchObject({ status: 'finished', removable: true });
    game.w.close();
    game.b.close();
  });

  it('while suspended, with the opponent gone: alone', async () => {
    const game = await started();
    await move(game, game.w, 'e2', 'e4');
    await move(game, game.b, 'e7', 'e5');
    // Black walks off; the grace runs out; the game suspends.
    await dropAndSettle(game, game.b);
    await fireDue(game, 'disconnect');
    expect(await peekStatus(game)).toBe('suspended');

    game.w.clear();
    say(game, game.w, { t: 'resign' });
    const ended = await game.w.state((g) => g.result !== null);
    expect(ended.result).toMatchObject({ outcome: '0-1', reason: 'resignation' });
    expect((await recordOf(game.white)).totals.losses).toBe(1);
    game.w.close();
  });

  it('while paused, by the player who paused', async () => {
    const game = await started();
    await move(game, game.w, 'd2', 'd4');
    await move(game, game.b, 'd7', 'd5');
    say(game, game.b, { t: 'pause' });
    await game.w.state((g) => g.status === 'suspended');
    say(game, game.b, { t: 'resign' });
    const ended = await game.w.state((g) => g.result !== null);
    expect(ended.result).toMatchObject({ outcome: '1-0', reason: 'resignation' });
    game.w.close();
    game.b.close();
  });

  it('is refused while staging, and says to abort instead', async () => {
    const game = await seated();
    const w = await openSocket(game, game.white);
    w.clear();
    w.send({ t: 'resign' });
    const err = await w.error();
    expect(err.code).toBe('not_active');
    expect(String(err.message)).toMatch(/Abort the game instead/);
    expect(await peekStatus(game)).toBe('staging');
    w.close();
  });

  it('clears any open offer, so a finished game carries none', async () => {
    const game = await started();
    await move(game, game.w, 'e2', 'e4');
    await move(game, game.b, 'e7', 'e5');
    say(game, game.w, { t: 'draw', action: 'offer' });
    say(game, game.w, { t: 'abort' });
    await game.b.state((g) => g.drawOfferFrom === 'w' && g.abortOfferFrom === 'w');
    say(game, game.b, { t: 'resign' });
    const ended = await game.w.state((g) => g.result !== null);
    expect(ended.drawOfferFrom).toBeNull();
    expect(ended.abortOfferFrom).toBeNull();
    game.w.close();
    game.b.close();
  });
});

describe('a draw offer is answered, declined, or lapses', () => {
  it('accepted: a draw in both records', async () => {
    const game = await started();
    await move(game, game.w, 'e2', 'e4');
    say(game, game.w, { t: 'draw', action: 'offer' });
    await game.b.state((g) => g.drawOfferFrom === 'w');
    say(game, game.b, { t: 'draw', action: 'accept' });
    const ended = await game.w.state((g) => g.result !== null);
    expect(ended.result).toMatchObject({ outcome: '1/2-1/2', reason: 'agreement' });
    expect((await recordOf(game.white)).recent[0]).toMatchObject({ result: 'draw', reason: 'agreement' });
    expect((await recordOf(game.black)).recent[0]).toMatchObject({ result: 'draw', reason: 'agreement' });
    game.w.close();
    game.b.close();
  });

  it('lapses when the next move is placed — by the opponent, or by the one who offered', async () => {
    const game = await started();
    say(game, game.w, { t: 'draw', action: 'offer' });
    await game.b.state((g) => g.drawOfferFrom === 'w');
    // White offers, then moves: the offer goes with the move.
    await move(game, game.w, 'e2', 'e4');
    expect((await row(game)).draw_offer_from).toBeNull();

    say(game, game.w, { t: 'draw', action: 'offer' });
    await game.b.state((g) => g.drawOfferFrom === 'w');
    // Black plays on instead of answering: that declines it.
    await move(game, game.b, 'e7', 'e5');
    expect((await row(game)).draw_offer_from).toBeNull();

    game.b.clear();
    say(game, game.b, { t: 'draw', action: 'accept' });
    expect((await game.b.error()).code).toBe('no_draw_offer');
    expect(await peekStatus(game)).toBe('active');
    game.w.close();
    game.b.close();
  });

  it('stands across a suspension, and can be accepted by the player left behind', async () => {
    const game = await started();
    await move(game, game.w, 'e2', 'e4');
    await move(game, game.b, 'e7', 'e5');
    say(game, game.b, { t: 'draw', action: 'offer' });
    await game.w.state((g) => g.drawOfferFrom === 'b');
    await dropAndSettle(game, game.b);
    await fireDue(game, 'disconnect');
    expect(await peekStatus(game)).toBe('suspended');
    say(game, game.w, { t: 'draw', action: 'accept' });
    const ended = await game.w.state((g) => g.result !== null);
    expect(ended.result).toMatchObject({ reason: 'agreement' });
    game.w.close();
  });
});

describe('abort alone, before each side has moved', () => {
  it('ends a game whose handshake never completed, with no result', async () => {
    const game = await seated();
    const w = await openSocket(game, game.white);
    w.clear();
    w.send({ t: 'abort' });
    const ended = await w.state((g) => g.status === 'aborted');
    expect(ended.result).toBeNull();
    expect(ended.abortOfferFrom).toBeNull();
    expect((await row(game)).result_reason).toBe('aborted');
    w.close();
  });

  it('lets either player abort after White’s first move, and not Black’s', async () => {
    for (const who of ['w', 'b'] as const) {
      const game = await started();
      await move(game, game.w, 'e2', 'e4');
      say(game, who === 'w' ? game.w : game.b, { t: 'abort' });
      await game.w.state((g) => g.status === 'aborted');
      expect((await game.stub.clocks()).running).toBe(false);
      game.w.close();
      game.b.close();
    }
  });

  it('works with the opponent gone and the game suspended', async () => {
    const game = await started();
    await move(game, game.w, 'e2', 'e4');
    await dropAndSettle(game, game.b);
    await fireDue(game, 'disconnect');
    expect(await peekStatus(game)).toBe('suspended');
    say(game, game.w, { t: 'abort' });
    await game.w.state((g) => g.status === 'aborted');
    game.w.close();
  });

  it('refuses a game nobody has joined, and one that is over', async () => {
    const joinCode = nextCode();
    const white = nextSub();
    const stub = env.GAME.getByName(joinCode) as DurableObjectStub<GameDO>;
    await stub.create({
      joinCode, creatorPlayerId: white, creatorAccount: white, creatorColor: 'w',
      field: FIELD, initialMs: 600_000, incrementMs: 0,
    });
    const lonely = await openSocket({ joinCode, stub, white, black: '' }, white);
    lonely.clear();
    lonely.send({ t: 'abort' });
    const err = await lonely.error();
    expect(err.code).toBe('not_active');
    expect(String(err.message)).toMatch(/Nobody has joined yet/);
    lonely.close();

    const game = await started();
    say(game, game.w, { t: 'resign' });
    await game.b.state((g) => g.result !== null);
    game.b.clear();
    say(game, game.b, { t: 'abort' });
    expect((await game.b.error()).code).toBe('not_active');
    expect(await peekStatus(game)).toBe('finished');
    game.w.close();
    game.b.close();
  });
});

describe('abort together, once both sides have moved', () => {
  it('is an offer, not an ending, and the opponent accepts it', async () => {
    const game = await started();
    await move(game, game.w, 'e2', 'e4');
    await move(game, game.b, 'e7', 'e5');
    say(game, game.w, { t: 'abort' });
    const offered = await game.b.state((g) => g.abortOfferFrom === 'w');
    expect(offered.status).toBe('active');

    // Asking again is not an error, and still not an ending.
    say(game, game.w, { t: 'abort' });
    await new Promise((r) => setTimeout(r, 50));
    expect(await peekStatus(game)).toBe('active');

    say(game, game.b, { t: 'abort', action: 'accept' });
    const ended = await game.w.state((g) => g.status === 'aborted');
    expect(ended.result).toBeNull();
    game.w.close();
    game.b.close();
  });

  it('takes an abort into the opponent’s open offer as agreement', async () => {
    const game = await started();
    await move(game, game.w, 'e2', 'e4');
    await move(game, game.b, 'e7', 'e5');
    say(game, game.b, { t: 'abort' });
    await game.w.state((g) => g.abortOfferFrom === 'b');
    say(game, game.w, { t: 'abort' });
    await game.b.state((g) => g.status === 'aborted');
    game.w.close();
    game.b.close();
  });

  it('clears on decline, and lapses with the next move', async () => {
    const game = await started();
    await move(game, game.w, 'e2', 'e4');
    await move(game, game.b, 'e7', 'e5');
    say(game, game.w, { t: 'abort' });
    await game.b.state((g) => g.abortOfferFrom === 'w');
    say(game, game.b, { t: 'abort', action: 'decline' });
    await game.w.state((g) => g.abortOfferFrom === null);
    expect(await peekStatus(game)).toBe('active');

    say(game, game.b, { t: 'abort' });
    await game.w.state((g) => g.abortOfferFrom === 'b');
    await move(game, game.w, 'g1', 'f3');
    expect((await row(game)).abort_offer_from).toBeNull();

    game.w.clear();
    say(game, game.w, { t: 'abort', action: 'accept' });
    expect((await game.w.error()).code).toBe('no_abort_offer');
    game.w.clear();
    say(game, game.w, { t: 'abort', action: 'withdraw' });
    expect((await game.w.error()).code).toBe('bad_message');
    expect(await peekStatus(game)).toBe('active');
    game.w.close();
    game.b.close();
  });

  it('will not let a player accept their own offer', async () => {
    const game = await started();
    await move(game, game.w, 'e2', 'e4');
    await move(game, game.b, 'e7', 'e5');
    say(game, game.w, { t: 'abort' });
    await game.w.state((g) => g.abortOfferFrom === 'w');
    game.w.clear();
    say(game, game.w, { t: 'abort', action: 'accept' });
    expect((await game.w.error()).code).toBe('no_abort_offer');
    expect(await peekStatus(game)).toBe('active');
    game.w.close();
    game.b.close();
  });

  it('is only an offer while suspended too: the player left alone resigns instead', async () => {
    const game = await started();
    await move(game, game.w, 'e2', 'e4');
    await move(game, game.b, 'e7', 'e5');
    await dropAndSettle(game, game.b);
    await fireDue(game, 'disconnect');
    say(game, game.w, { t: 'abort' });
    await game.w.state((g) => g.abortOfferFrom === 'w');
    expect(await peekStatus(game)).toBe('suspended');
    game.w.close();
  });
});

describe('an aborted game', () => {
  it('writes no record line, pushed however often, and is not counted', async () => {
    const game = await started();
    await move(game, game.w, 'e2', 'e4');
    say(game, game.b, { t: 'abort' });
    await game.w.state((g) => g.status === 'aborted');
    game.w.close();
    game.b.close();
    await settled(game);

    // Re-taking a seat is what re-pushes a finished game's line; do it twice.
    expect(await game.stub.join(game.white, game.white)).toMatchObject({ ok: true });
    expect(await game.stub.join(game.black, game.black)).toMatchObject({ ok: true });
    for (const sub of [game.white, game.black]) {
      const record = await recordOf(sub);
      expect(record.recent).toEqual([]);
      expect(record.totals.games).toBe(0);
      expect(record.unplayedGames).toBe(0);
    }
    expect((await metaKeys(game)).filter((k) => k.startsWith('record'))).toEqual([]);
    expect(await timerKinds(game)).not.toContain('record');
  });

  it('refuses every move and every other ending', async () => {
    const game = await started();
    say(game, game.w, { t: 'abort' });
    await game.b.state((g) => g.status === 'aborted');
    for (const msg of [
      { t: 'lift', from: 'e2', pos: at('e2') },
      { t: 'resign' },
      { t: 'draw', action: 'offer' },
      { t: 'pause' },
      { t: 'abort' },
    ]) {
      game.w.clear();
      say(game, game.w, msg);
      expect((await game.w.error()).code).toBe('not_active');
    }
    expect(await peekStatus(game)).toBe('aborted');
    game.w.close();
    game.b.close();
  });

  it('is listed as aborted, and can be tidied off the list', async () => {
    const game = await seated();
    const w = await openSocket(game, game.white);
    w.send({ t: 'abort' });
    await w.state((g) => g.status === 'aborted');
    w.close();

    const [line] = await listGames(game.white);
    expect(line).toMatchObject({ joinCode: game.joinCode, status: 'aborted', result: null, removable: true });
    expect(await forget(game.white, [game.joinCode])).toEqual({ forgotten: [game.joinCode], kept: [] });
    expect(await listGames(game.white)).toEqual([]);
    // Black's line is Black's to tidy.
    expect((await listGames(game.black))[0]).toMatchObject({ status: 'aborted' });
  });

  it('answers its file with Result "*" and says why, while the object lives', async () => {
    const game = await started();
    await move(game, game.w, 'e2', 'e4');
    say(game, game.w, { t: 'abort' });
    await game.b.state((g) => g.status === 'aborted');
    const response = await SELF.fetch(`${LOCAL}/api/game/${game.joinCode}/pgn`, {
      headers: { cookie: await cookieFor(game.black) },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('[Result "*"]');
    expect(text).toContain('[Termination "abandoned"]');
    expect(text).toContain('[SatelliteEnd "aborted"]');
    expect(text).toMatch(/\{Aborted by the players: no result\.\}\s+\*\n$/);
    game.w.close();
    game.b.close();
  });

  it('is collected on an unplayed game’s terms, moves or not, with no archive', async () => {
    const game = await started();
    await move(game, game.w, 'e2', 'e4');
    await move(game, game.b, 'e7', 'e5');
    say(game, game.w, { t: 'abort' });
    await game.b.state((g) => g.abortOfferFrom === 'w');
    say(game, game.b, { t: 'abort', action: 'accept' });
    await game.w.state((g) => g.status === 'aborted');
    game.w.close();
    game.b.close();
    await settled(game);
    expect(await timerKinds(game)).toContain('gc');

    const old = Date.now() - UNPLAYED_GAME_TTL_MS - 60_000;
    await runInDurableObject(game.stub, (_i, state) => {
      state.storage.sql.exec(`UPDATE game SET updated_at = ?, created_at = ?, result_at = ?`, old, old, old);
      state.storage.sql.exec(`DELETE FROM meta WHERE key = 'seen_at'`);
    });
    await fireDue(game, 'gc');

    expect(await game.stub.peek()).toEqual({ exists: false });
    expect(await listGames(game.white)).toEqual([]);
    expect(await listGames(game.black)).toEqual([]);
    expect(await env.ARCHIVE.get(archiveKey(game.joinCode))).toBeNull();
    expect((await recordOf(game.white)).recent).toEqual([]);
  });
});

/**
 * Run the mover's clock out without letting the alarm notice: the flag timer
 * is pushed into the future, so only a message can find the fallen flag.
 */
async function flagFallsUnnoticed(game: Game): Promise<void> {
  await runInDurableObject(game.stub, async (_i, state) => {
    const sql = state.storage.sql;
    sql.exec(`UPDATE game SET last_clock_start_at = ? WHERE id = 1`, Date.now() - 3_600_000);
    sql.exec(`UPDATE timers SET due_at = ? WHERE kind = 'flag'`, Date.now() + 3_600_000);
    await state.storage.setAlarm(Date.now() + 3_600_000);
  });
}

describe('a fallen flag is settled before any early ending', () => {
  it('an abort before the second move loses on time instead', async () => {
    const game = await started();
    await flagFallsUnnoticed(game);
    say(game, game.w, { t: 'abort' });
    const ended = await game.b.state((g) => g.result !== null);
    expect(ended.status).toBe('finished');
    expect(ended.result).toMatchObject({ outcome: '0-1', reason: 'timeout' });
    const err = await game.w.error();
    expect(err.code).toBe('not_active');
    expect(String(err.message)).toMatch(/time ran out/);
    // Snapshot first, refusal second, so the phone does not wipe it unread.
    const order = game.w.received.map((m) => m.t);
    expect(order.indexOf('state')).toBeLessThan(order.indexOf('error'));
    game.w.close();
    game.b.close();
  });

  it('a resignation by the opponent does not rescue the player whose flag fell', async () => {
    const game = await started();
    await move(game, game.w, 'e2', 'e4');
    await flagFallsUnnoticed(game);
    // Black's clock is the one running, and it is out; white resigns too late.
    say(game, game.w, { t: 'resign' });
    const ended = await game.w.state((g) => g.result !== null);
    expect(ended.result).toMatchObject({ outcome: '1-0', reason: 'timeout' });
    expect((await game.w.error()).code).toBe('not_active');
    game.w.close();
    game.b.close();
  });

  it('a draw accepted after the flag fell is refused, and the clock decides', async () => {
    const game = await started();
    await move(game, game.w, 'e2', 'e4');
    await move(game, game.b, 'e7', 'e5');
    say(game, game.b, { t: 'draw', action: 'offer' });
    await game.w.state((g) => g.drawOfferFrom === 'b');
    await flagFallsUnnoticed(game);
    say(game, game.w, { t: 'draw', action: 'accept' });
    const ended = await game.b.state((g) => g.result !== null);
    expect(ended.result).toMatchObject({ outcome: '0-1', reason: 'timeout' });
    game.w.close();
    game.b.close();
  });

  it('a pause after the flag fell ends the game on time, so no abort can follow it', async () => {
    const game = await started();
    await move(game, game.w, 'e2', 'e4');
    // Black's clock runs out; the alarm is late; black pauses.
    await flagFallsUnnoticed(game);
    say(game, game.b, { t: 'pause' });
    const ended = await game.w.state((g) => g.result !== null);
    expect(ended.status).toBe('finished');
    expect(ended.result).toMatchObject({ outcome: '1-0', reason: 'timeout' });
    expect((await game.b.error()).code).toBe('not_active');
    say(game, game.b, { t: 'abort' });
    expect((await game.b.error()).code).toBe('not_active');
    expect(await peekStatus(game)).toBe('finished');
    game.w.close();
    game.b.close();
  });

  it('a disconnect suspension that falls due with the flag ends the game on time', async () => {
    const game = await started();
    await move(game, game.w, 'e2', 'e4');
    await dropAndSettle(game, game.b);
    await flagFallsUnnoticed(game);
    // Only the disconnect deadline is due: the flag's own timer is still in
    // the future, as for an alarm that fired late and out of order.
    await fireDue(game, 'disconnect');
    expect(await row(game)).toMatchObject({
      status: 'finished',
      result_outcome: '1-0',
      result_reason: 'timeout',
      suspended_at: null,
    });
    game.w.close();
  });

  it('a move after the flag fell is refused, and the clock decides', async () => {
    const game = await started();
    await flagFallsUnnoticed(game);
    say(game, game.w, { t: 'lift', from: 'e2', pos: at('e2') });
    const ended = await game.b.state((g) => g.result !== null);
    expect(ended.result).toMatchObject({ outcome: '0-1', reason: 'timeout' });
    expect((await game.w.error()).code).toBe('not_active');
    expect(ended.carry).toBeNull();
    game.w.close();
    game.b.close();
  });

  it('a place after the flag fell loses on time, and the walk it reports is in the record', async () => {
    const game = await started();
    // White lifts in time, with the phone's counter at 100 m: a baseline.
    say(game, game.w, { t: 'lift', from: 'e2', pos: at('e2'), travelM: 100, leg: 'page-A' });
    await game.w.state((g) => (g.carry as Msg | null)?.from === 'e2');
    await flagFallsUnnoticed(game);
    // Thirty seconds of walking since that report, so the sprint cap allows
    // what is reported next; then the place arrives after the flag fell.
    await runInDurableObject(game.stub, (_i, state) => {
      state.storage.sql.exec(`UPDATE presence SET last_pos_at = ? WHERE color = 'w'`, Date.now() - 30_000);
    });
    say(game, game.w, { t: 'place', to: 'e4', pos: at('e4'), travelM: 140, leg: 'page-A' });
    const ended = await game.b.state((g) => g.result !== null);
    expect(ended.result).toMatchObject({ outcome: '0-1', reason: 'timeout' });
    expect((await game.w.error()).code).toBe('not_active');
    expect((await row(game)).fen).toMatch(/^rnbqkbnr\/pppppppp\/8\/8\/8\/8\/PPPPPPPP/);

    const [line] = (await recordOf(game.white)).recent;
    expect(line).toMatchObject({ joinCode: game.joinCode, result: 'loss', reason: 'timeout' });
    expect(line!.travelM).toBeCloseTo(40, 6);
    game.w.close();
    game.b.close();
  });

  it('a drop after the flag fell loses on time, and leaves no piece in hand', async () => {
    const game = await started();
    say(game, game.w, { t: 'lift', from: 'g1', pos: at('g1') });
    await game.w.state((g) => (g.carry as Msg | null)?.from === 'g1');
    await flagFallsUnnoticed(game);
    say(game, game.w, { t: 'drop' });
    const ended = await game.b.state((g) => g.result !== null);
    expect(ended.result).toMatchObject({ outcome: '0-1', reason: 'timeout' });
    expect(ended.carry).toBeNull();
    expect((await game.w.error()).code).toBe('not_active');
    game.w.close();
    game.b.close();
  });

  it('changes nothing while the clock still has time on it', async () => {
    const game = await started();
    say(game, game.w, { t: 'abort' });
    const ended = await game.b.state((g) => g.status === 'aborted');
    expect(ended.result).toBeNull();
    game.w.close();
    game.b.close();
  });
});

describe('finish() writes a result once', () => {
  it('leaves a checkmate alone when asked to finish again, and an abort too', async () => {
    const game = await started();
    // Fool's mate.
    await move(game, game.w, 'f2', 'f3');
    await move(game, game.b, 'e7', 'e5');
    await move(game, game.w, 'g2', 'g4');
    await move(game, game.b, 'd8', 'h4');
    expect((await row(game)).result_reason).toBe('checkmate');
    await runInDurableObject(game.stub, async (instance) => {
      const target = instance as unknown as {
        finish(o: string, r: string, n: number): Promise<void>;
      };
      await target.finish('1-0', 'resignation', Date.now());
    });
    expect(await row(game)).toMatchObject({
      status: 'finished',
      result_outcome: '0-1',
      result_reason: 'checkmate',
    });

    const aborted = await started();
    say(aborted, aborted.w, { t: 'abort' });
    await aborted.b.state((g) => g.status === 'aborted');
    await runInDurableObject(aborted.stub, async (instance) => {
      await (instance as unknown as { finish(o: string, r: string, n: number): Promise<void> }).finish(
        '1-0',
        'resignation',
        Date.now(),
      );
    });
    expect(await row(aborted)).toMatchObject({ status: 'aborted', result_outcome: null });
    for (const c of [game.w, game.b, aborted.w, aborted.b]) c.close();
  });
});

describe('schema 7', () => {
  it('adds the abort offer to a game created before it', async () => {
    const game = await seated();
    const columns = await runInDurableObject(game.stub, (_i, state) => {
      const sql = state.storage.sql;
      sql.exec(`ALTER TABLE game DROP COLUMN abort_offer_from`);
      applySchema(sql);
      return [...sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('game')`)].map((r) => r.name);
    });
    expect(columns).toContain('abort_offer_from');
    expect((await row(game)).abort_offer_from).toBeNull();
  });
});
