import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { deriveGeometry, makeFieldSpec, snapshotField, squareCentreLatLng } from '../../src/shared/field.js';
import { fromLocal } from '../../src/shared/geo.js';
import { POS_MIN_INTERVAL_MS, POS_SERVER_MIN_INTERVAL_MS } from '../../src/shared/protocol.js';
import { fromSquare } from '../../src/shared/squares.js';
import { type WebSocketLike, connectToGame } from '../../src/client/net.js';
import type { GameDO } from '../../src/worker/game-do.js';

/**
 * The real client transport against the real Durable Object.
 *
 * Everything else about `net.ts` is tested with a fake socket, which proves the
 * policy but not the protocol. This is the only test that puts both halves of the
 * wire together — and it is the one that would have caught a mismatched URL, a
 * mis-shaped message, or a `sync` the server does not answer.
 */

const A1 = { lat: 51.4779, lng: -0.0015 };
const SQUARE_M = 8;
const FIELD = snapshotField(
  makeFieldSpec('Net field', { a1: A1, h8: fromLocal(A1, { e: 7 * SQUARE_M, n: 7 * SQUARE_M }) }),
);
const GEO = deriveGeometry(FIELD);

function at(square: string, acc = 3) {
  const p = squareCentreLatLng(GEO, fromSquare(square));
  return { lat: p.lat, lng: p.lng, acc, ts: Date.now() };
}

function gpsFix(square: string, accuracyM = 3) {
  const p = squareCentreLatLng(GEO, fromSquare(square));
  return { pos: { lat: p.lat, lng: p.lng }, accuracyM, at: Date.now() };
}

let counter = 6000;
const nextCode = () => `N${String(++counter).padStart(5, '0')}`;

const DEV_SECRET = 'test-dev-auth-secret';
const mutableEnv = env as unknown as Record<string, unknown>;
const cookies = new Map<string, string>();

/**
 * A session cookie for a seat (stage 2.5.1).
 *
 * The upgrade is seated by the cookie now rather than by a `playerId` query
 * parameter, which is what `net.ts` sends in the browser — so this test carries
 * one for the same reason a phone does. Loopback because the dev seam's hostname
 * lock guards reading a token as well as minting one (decision 0029).
 */
async function cookieFor(sub: string): Promise<string> {
  const known = cookies.get(sub);
  if (known !== undefined) return known;
  mutableEnv.DEV_AUTH_SECRET = DEV_SECRET;
  const response = await SELF.fetch('http://127.0.0.1/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-auth-secret': DEV_SECRET },
    body: JSON.stringify({ sub }),
  });
  expect(response.status).toBe(200);
  const cookie = (response.headers.get('set-cookie') as string).split(';')[0];
  cookies.set(sub, cookie);
  return cookie;
}

/**
 * Adapt a Workers WebSocket to the shape `net.ts` expects.
 *
 * Two differences from a browser socket, both inherent to the runtime rather than
 * to the code under test: it arrives already connected (so `onopen` has to be
 * synthesised after `accept()`), and it prefers `addEventListener`.
 */
function adapt(ws: WebSocket): WebSocketLike {
  const adapter: WebSocketLike = {
    readyState: 1,
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
  };
  ws.accept();
  ws.addEventListener('message', (event) => {
    adapter.onmessage?.({ data: (event as MessageEvent).data });
  });
  ws.addEventListener('close', () => {
    adapter.readyState = 3;
    adapter.onclose?.({});
  });
  // The handshake already happened, so hand control back before announcing it.
  setTimeout(() => adapter.onopen?.({}), 0);
  return adapter;
}

/** A clock a test drives, so the client's interval floor costs no real time. */
function fakeClock(start = Date.now()) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/**
 * Push this game's stored instants into the past.
 *
 * The server keeps its own interval floor and its own rate ceiling on distance,
 * both measured against stored timestamps — so a test that wants a second relay
 * accepted either sleeps through them or moves them, and sleeping leaves a real
 * socket idle for seconds at a time, which is what made this file flaky.
 */
async function backdate(stub: DurableObjectStub<GameDO>, ms: number): Promise<void> {
  await runInDurableObject(stub, (_i, state) => {
    const now = Date.now();
    state.storage.sql.exec(`UPDATE presence SET last_pos_at = ?, last_relay_at = ?`, now - ms, now - ms);
    state.storage.sql.exec(
      `UPDATE game SET last_clock_start_at = ? WHERE id = 1 AND last_clock_start_at IS NOT NULL`,
      now - ms,
    );
  });
}

async function connected(joinCode: string, playerId: string, now?: () => number) {
  const res = await SELF.fetch(`http://127.0.0.1/api/game/${joinCode}/ws`, {
    headers: { upgrade: 'websocket', cookie: await cookieFor(playerId) },
  });
  expect(res.status).toBe(101);
  const socket = res.webSocket;
  if (!socket) throw new Error('no webSocket on the upgrade response');

  return connectToGame({
    joinCode,
    origin: 'http://127.0.0.1',
    pingIntervalMs: 60_000,
    socketFactory: () => adapt(socket),
    ...(now === undefined ? {} : { now }),
  });
}

/** Poll the connection's own state, which is what a view would render from. */
async function until<T>(read: () => T | null | undefined, ms = 3_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value !== null && value !== undefined && value !== false) return value as T;
    if (Date.now() - started > ms) throw new Error('timed out waiting on connection state');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function readPresence(stub: DurableObjectStub<GameDO>) {
  const rows = await runInDurableObject(stub, (_i, state) =>
    [...state.storage.sql.exec<{ last_lat: number | null; travel_m: number }>(
      `SELECT last_lat, travel_m FROM presence WHERE color = 'w'`,
    )],
  );
  return rows[0];
}

/** As `until`, but for a reader that has to await something. */
async function untilAsync<T>(read: () => Promise<T | null | undefined>, ms = 3_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    if (Date.now() - started > ms) throw new Error('timed out waiting on storage');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function startedGame(opts: { whiteClock?: () => number } = {}) {
  const joinCode = nextCode();
  const stub = env.GAME.getByName(joinCode);
  await stub.create({
    joinCode,
    creatorPlayerId: 'net-white',
    creatorColor: 'w',
    field: FIELD,
    initialMs: 600_000,
    incrementMs: 0,
  });
  await stub.join('net-black');

  const white = await connected(joinCode, 'net-white', opts.whiteClock);
  const black = await connected(joinCode, 'net-black');
  await until(() => white.state.game);
  await until(() => black.state.game);

  white.send({ t: 'ready', pos: at('e1') });
  black.send({ t: 'ready', pos: at('e8') });
  await until(() => white.state.game?.status === 'active' || null);

  return { stub, white, black };
}

async function backdateLift(stub: DurableObjectStub<GameDO>): Promise<void> {
  await runInDurableObject(stub, (_i, state) => {
    state.storage.sql.exec(`UPDATE carry SET lift_at = lift_at - 10000`);
  });
}

describe('the client transport against the real GameDO', () => {
  it('connects, syncs, and receives a snapshot without being asked twice', async () => {
    const { white, black } = await startedGame();
    expect(white.state.status).toBe('open');
    expect(white.state.game).toMatchObject({ status: 'active' });
    // Colour is in the snapshot, so the client never has to guess which side it
    // is — and both sockets are told their own, not the same one.
    expect(white.state.game?.you).toBe('w');
    expect(black.state.game?.you).toBe('b');
    white.close();
    black.close();
  });

  it('plays a move end to end, through the real transport', async () => {
    const { stub, white, black } = await startedGame();

    white.send({ t: 'lift', from: 'e2', pos: at('e2') });
    await until(() => white.state.game?.carry?.from === 'e2' || null);
    await backdateLift(stub);
    white.send({ t: 'place', to: 'e4', pos: at('e4') });

    const moved = await until(() => white.state.game?.lastMove ?? null);
    expect(moved).toMatchObject({ from: 'e2', to: 'e4', san: 'e4' });
    // And the opponent saw it too, which is the whole reason for the socket.
    await until(() => black.state.game?.lastMove?.san === 'e4' || null);

    white.close();
    black.close();
  });

  it('surfaces a server rejection as an error the view can show', async () => {
    const { white, black } = await startedGame();
    // Black moving first is not black's move to make.
    black.send({ t: 'lift', from: 'e7', pos: at('e7') });
    const error = await until(() => black.state.lastError ?? null);
    expect(error.code).toBe('not_your_turn');
    expect(error.message.length).toBeGreaterThan(10);
    white.close();
    black.close();
  });

  it('drops a relay that arrives inside the server\'s own backstop', async () => {
    const { stub, white, black } = await startedGame();

    // The `ready` handshake has just recorded a position, so a relay now falls
    // inside POS_SERVER_MIN_INTERVAL_MS. The client's limiter cannot know that —
    // it has sent nothing yet — so it offers, and the server is right to discard.
    expect(white.offerPosition(gpsFix('d4'), 42)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const presence = await readPresence(stub);
    expect(presence.travel_m).toBe(0);

    white.close();
    black.close();
  });

  it('records a relay that clears both limiters, and credits what the counter adds', async () => {
    // Both limiters are driven rather than waited out: the client's from an
    // injected clock, the server's by moving its stored instants. A real socket
    // left idle for seconds while a test sleeps is what made this flaky.
    const clock = fakeClock();
    const { stub, white, black } = await startedGame({ whiteClock: clock.now });

    await backdate(stub, POS_SERVER_MIN_INTERVAL_MS + 2_000);
    expect(white.offerPosition(gpsFix('d4'), 42, 'page-1')).toBe(true);

    // The first report from a counter this game has not seen sets its
    // baseline and earns nothing (decision 0040): those 42 m were walked
    // before the game could have seen them.
    const first = await untilAsync(async () => {
      const row = await readPresence(stub);
      return row.last_lat !== null && Math.abs(row.last_lat - gpsFix('d4').pos.lat) < 1e-6
        ? row
        : null;
    });
    expect(first.travel_m).toBe(0);

    // The next one, past the client's own interval floor, earns the difference.
    clock.advance(POS_MIN_INTERVAL_MS + 100);
    await backdate(stub, POS_SERVER_MIN_INTERVAL_MS + 2_000);
    expect(white.offerPosition(gpsFix('d6'), 60, 'page-1')).toBe(true);
    const second = await untilAsync(async () => {
      const row = await readPresence(stub);
      return row.travel_m > 0 ? row : null;
    });
    expect(second.travel_m).toBeCloseTo(18, 6);
    expect(second.last_lat).toBeCloseTo(gpsFix('d6').pos.lat, 5);

    white.close();
    black.close();
  });

  it('gives the opponent a dot from the snapshot, then moves it on the relay', async () => {
    const { white, black } = await startedGame();

    // No relay has happened yet — the back-rank handshake is the only position
    // either has sent. Black can still draw white, because the snapshot carries
    // it. This is the case the live relay cannot cover: a player who is standing
    // still sends nothing, so waiting for one would mean waiting all game.
    const seeded = await until(() => black.state.opponent);
    expect(seeded.lat).toBeCloseTo(at('e1').lat, 6);

    await new Promise((resolve) => setTimeout(resolve, POS_SERVER_MIN_INTERVAL_MS + 100));
    expect(white.offerPosition(gpsFix('d4'))).toBe(true);

    const relayed = await until(() =>
      Math.abs(black.state.opponent!.lat - at('d4').lat) < 1e-9 ? black.state.opponent : null,
    );
    expect(relayed.at).toBeGreaterThanOrEqual(seeded.at);
    // And white is not shown their own position as the opponent's.
    expect(white.state.opponent?.lat).toBeCloseTo(at('e8').lat, 6);

    white.close();
    black.close();
  });

  it('refuses to send after close, and reports itself closed', async () => {
    const { white, black } = await startedGame();
    white.close();
    expect(white.state.status).toBe('closed');
    expect(white.send({ t: 'sync' })).toBe(false);
    black.close();
  });
});
