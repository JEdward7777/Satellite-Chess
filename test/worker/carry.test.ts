import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { deriveGeometry, makeFieldSpec, snapshotField, squareCentreLatLng } from '../../src/shared/field.js';
import { fromLocal } from '../../src/shared/geo.js';
import { CLAIM_AFTER_MS, POS_SERVER_MIN_INTERVAL_MS } from '../../src/shared/protocol.js';
import { fromSquare } from '../../src/shared/squares.js';
import type { GameDO } from '../../src/worker/game-do.js';

/**
 * The carry mechanic: lift near the origin, walk, place near the destination
 * (decision 0001). This is the distinctive rule of the whole game, so it gets
 * exercised against the real runtime rather than a mock.
 */

const A1 = { lat: 51.4779, lng: -0.0015 };
const SQUARE_M = 8;
const FIELD = snapshotField(
  makeFieldSpec('Carry field', A1, fromLocal(A1, { e: 7 * SQUARE_M, n: 7 * SQUARE_M })),
);
const GEO = deriveGeometry(FIELD);

const WHITE = 'carry-white-0001';
const BLACK = 'carry-black-0002';

let counter = 5000;
function nextCode(): string {
  counter += 1;
  return `C${String(counter).padStart(5, '0')}`;
}

/** A fix at the centre of a square, as a player standing on it would report. */
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
      let msg: Msg;
      try {
        msg = JSON.parse(String((event as MessageEvent).data)) as Msg;
      } catch {
        msg = { t: 'raw', data: String((event as MessageEvent).data) };
      }
      this.received.push(msg);
      const i = this.waiters.findIndex((w) => w.predicate(msg));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
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

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  clear(): void {
    this.received.length = 0;
  }

  /** The most recent full snapshot received. */
  state(): Msg {
    const states = this.received.filter((m) => m.t === 'state');
    return states[states.length - 1]?.game as Msg;
  }

  close(): void {
    this.ws.close();
  }
}

async function openSocket(joinCode: string, playerId: string): Promise<Client> {
  const res = await SELF.fetch(
    `https://example.com/api/game/${joinCode}/ws?playerId=${playerId}`,
    { headers: { upgrade: 'websocket' } },
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error('no webSocket');
  return new Client(ws);
}

/**
 * A game with both players connected and the clock running, reached through the
 * real handshake: both walk to their own back rank (decision 0005).
 */
async function startedGame(opts: { initialMs?: number; incrementMs?: number } = {}): Promise<{
  stub: DurableObjectStub<GameDO>;
  white: Client;
  black: Client;
  joinCode: string;
}> {
  const joinCode = nextCode();
  const stub = env.GAME.getByName(joinCode);
  await stub.create({
    joinCode,
    creatorPlayerId: WHITE,
    creatorColor: 'w',
    field: FIELD,
    initialMs: opts.initialMs ?? 600_000,
    incrementMs: opts.incrementMs ?? 10_000,
  });
  await stub.join(BLACK);

  const white = await openSocket(joinCode, WHITE);
  const black = await openSocket(joinCode, BLACK);
  await white.next((m) => m.t === 'state');
  await black.next((m) => m.t === 'state');

  white.send({ t: 'ready', pos: at('e1') });
  black.send({ t: 'ready', pos: at('e8') });
  await white.next((m) => m.t === 'state' && (m.game as Msg).status === 'active');

  return { stub, white, black, joinCode };
}

/**
 * Backdate the pending lift, as though the player had spent `seconds` walking.
 *
 * A test sends `lift` and `place` in the same millisecond, which the server is
 * right to reject: covering ground in no time is exactly the teleport
 * `isPlausibleStep` exists to catch (decision 0001). Rather than weaken a real
 * anti-cheat rule to suit the tests, or sleep for whole seconds in each of them,
 * this moves the lift into the past so the walk becomes physically possible.
 */
async function walked(stub: DurableObjectStub<GameDO>, seconds = 10): Promise<void> {
  await runInDurableObject(stub, (_i, state) => {
    state.storage.sql.exec(`UPDATE carry SET lift_at = lift_at - ?`, seconds * 1000);
  });
}

/**
 * Close a socket and wait until the object has finished reacting to it.
 *
 * This is O-09, and it was a real race rather than flakiness in the abstract.
 * `close()` returns as soon as the client end is shut; the object's own
 * `webSocketClose` runs whenever the runtime gets round to delivering it, and
 * that handler schedules `disconnect` at now + the 20 s grace. A test that
 * overwrites that row *before* the handler runs has its own row replaced by the
 * object's, `runDurableObjectAlarm` then finds nothing due, and the game stays
 * active — which the assertion reports as suspension being broken. Both sides
 * were doing their job; the test was racing the runtime.
 *
 * Waiting on the timer rather than on `presence.connected` is deliberate: the
 * handler writes presence *first* and schedules afterwards, so presence going to
 * zero would still leave a window where the schedule has not landed. The row
 * appearing is the last thing that can move the deadline.
 */
async function closeAndSettle(
  client: Client,
  stub: DurableObjectStub<GameDO>,
): Promise<void> {
  client.close();
  for (let attempt = 0; attempt < 400; attempt++) {
    const rows = await runInDurableObject(stub, (_i, state) => [
      ...state.storage.sql.exec(`SELECT due_at FROM timers WHERE kind = 'disconnect'`),
    ]);
    if (rows.length > 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('the object never scheduled a disconnect deadline');
}

describe('the start handshake', () => {
  it('does not start until both players are on their own back rank', async () => {
    const joinCode = nextCode();
    const stub = env.GAME.getByName(joinCode);
    await stub.create({
      joinCode,
      creatorPlayerId: WHITE,
      creatorColor: 'w',
      field: FIELD,
      initialMs: 600_000,
      incrementMs: 0,
    });
    await stub.join(BLACK);

    const white = await openSocket(joinCode, WHITE);
    const black = await openSocket(joinCode, BLACK);
    await white.next((m) => m.t === 'state');
    await black.next((m) => m.t === 'state');

    white.send({ t: 'ready', pos: at('d1') });
    await new Promise((r) => setTimeout(r, 80));
    expect(await stub.peek()).toMatchObject({ status: 'staging' });
    expect((await stub.clocks()).running).toBe(false);

    black.send({ t: 'ready', pos: at('d8') });
    await white.next((m) => m.t === 'state' && (m.game as Msg).status === 'active');
    expect((await stub.clocks()).running).toBe(true);

    white.close();
    black.close();
  });

  it('rejects a ready sent from the middle of the board, and says how far to walk', async () => {
    const joinCode = nextCode();
    const stub = env.GAME.getByName(joinCode);
    await stub.create({
      joinCode, creatorPlayerId: WHITE, creatorColor: 'w', field: FIELD,
      initialMs: 600_000, incrementMs: 0,
    });
    await stub.join(BLACK);
    const white = await openSocket(joinCode, WHITE);
    await white.next((m) => m.t === 'state');

    white.send({ t: 'ready', pos: at('d4') });
    const err = await white.next((m) => m.t === 'error');
    expect(err.code).toBe('out_of_reach');
    expect(String(err.message)).toMatch(/your own end of the board/);
    white.close();
  });

  it('will not start on the wrong back rank', async () => {
    const joinCode = nextCode();
    const stub = env.GAME.getByName(joinCode);
    await stub.create({
      joinCode, creatorPlayerId: WHITE, creatorColor: 'w', field: FIELD,
      initialMs: 600_000, incrementMs: 0,
    });
    await stub.join(BLACK);
    const white = await openSocket(joinCode, WHITE);
    await white.next((m) => m.t === 'state');

    // White standing on black's rank is not white being ready.
    white.send({ t: 'ready', pos: at('e8') });
    const err = await white.next((m) => m.t === 'error');
    expect(err.code).toBe('out_of_reach');
    white.close();
  });

  it('arms the flag deadline once the clock starts', async () => {
    const { stub, white, black } = await startedGame({ initialMs: 600_000 });
    const timers = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ kind: string; due_at: number }>(`SELECT kind, due_at FROM timers`)],
    );
    expect(timers.map((t) => t.kind)).toContain('flag');
    const flag = timers.find((t) => t.kind === 'flag')!;
    // Roughly ten minutes out, which is exactly when white would expire.
    expect(flag.due_at - Date.now()).toBeGreaterThan(590_000);
    white.close();
    black.close();
  });
});

describe('lifting a piece', () => {
  it('lifts a piece you can reach and shows the opponent what you are carrying', async () => {
    const { white, black } = await startedGame();
    black.clear();

    white.send({ t: 'lift', from: 'e2', pos: at('e2') });
    const seen = await black.next((m) => m.t === 'state' && (m.game as Msg).carry !== null);
    const carry = (seen.game as Msg).carry as Msg;
    expect(carry.from).toBe('e2');
    expect(carry.piece).toBe('p');
    expect(carry.color).toBe('w');
    expect(carry.destinations).toEqual(expect.arrayContaining(['e3', 'e4']));

    white.close();
    black.close();
  });

  it('refuses to lift a piece you are standing nowhere near', async () => {
    const { white, black } = await startedGame();
    // Standing on e2, reaching for a2 — four squares away.
    white.send({ t: 'lift', from: 'a2', pos: at('e2') });
    const err = await white.next((m) => m.t === 'error');
    expect(err.code).toBe('out_of_reach');
    expect(String(err.message)).toMatch(/from a2/);
    white.close();
    black.close();
  });

  it('refuses to lift the opponent’s piece', async () => {
    const { white, black } = await startedGame();
    white.send({ t: 'lift', from: 'e7', pos: at('e7') });
    const err = await white.next((m) => m.t === 'error');
    expect(err.code).toBe('illegal_move');
    white.close();
    black.close();
  });

  it('refuses to lift out of turn', async () => {
    const { white, black } = await startedGame();
    black.send({ t: 'lift', from: 'e7', pos: at('e7') });
    const err = await black.next((m) => m.t === 'error');
    expect(err.code).toBe('not_your_turn');
    white.close();
    black.close();
  });

  it('refuses a piece with no legal moves, rather than stranding you mid-field', async () => {
    const { white, black } = await startedGame();
    // The a1 rook is hemmed in at the start of the game.
    white.send({ t: 'lift', from: 'a1', pos: at('a1') });
    const err = await white.next((m) => m.t === 'error');
    expect(err.code).toBe('no_legal_moves');
    white.close();
    black.close();
  });

  it('refuses to lift twice', async () => {
    const { white, black } = await startedGame();
    white.send({ t: 'lift', from: 'e2', pos: at('e2') });
    await white.next((m) => m.t === 'state' && (m.game as Msg).carry !== null);
    white.send({ t: 'lift', from: 'd2', pos: at('d2') });
    const err = await white.next((m) => m.t === 'error');
    expect(err.code).toBe('already_carrying');
    white.close();
    black.close();
  });

  it('refuses a lift on a hopeless fix', async () => {
    const { white, black } = await startedGame();
    white.send({ t: 'lift', from: 'e2', pos: { ...at('e2'), acc: 1200 } });
    const err = await white.next((m) => m.t === 'error');
    expect(err.code).toBe('accuracy');
    expect(String(err.message)).toMatch(/1200 m/);
    white.close();
    black.close();
  });

  it('puts a carried piece back for free', async () => {
    const { white, black, stub } = await startedGame();
    white.send({ t: 'lift', from: 'e2', pos: at('e2') });
    await white.next((m) => m.t === 'state' && (m.game as Msg).carry !== null);

    white.clear();
    white.send({ t: 'drop' });
    const after = await white.next((m) => m.t === 'state' && (m.game as Msg).carry === null);
    expect((after.game as Msg).fen).toContain('rnbqkbnr');
    // Still white's move: the piece never moved.
    expect((await stub.clocks()).running).toBe(true);
    white.close();
    black.close();
  });
});

describe('placing a piece', () => {
  it('completes a move whose ends are too far apart to reach at once', async () => {
    const { white, black, stub } = await startedGame();

    // Clear e2 and d1 so the queen has the whole diagonal.
    white.send({ t: 'lift', from: 'e2', pos: at('e2') });
    await white.next((m) => m.t === 'state' && (m.game as Msg).carry !== null);
    white.clear();
    await walked(stub);
    white.send({ t: 'place', to: 'e4', pos: at('e3') });
    const moved = await white.next(
      (m) => m.t === 'state' && ((m.game as Msg).lastMove as Msg | null) !== null,
    );
    const last = (moved.game as Msg).lastMove as Msg;
    expect(last.san).toBe('e4');
    expect((moved.game as Msg).fen).toContain('4P3');
    // Turn has passed.
    expect(((moved.game as Msg).clock as Msg).active).toBe('b');

    const record = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ from_sq: string; to_sq: string; carried_m: number }>(
        `SELECT from_sq, to_sq, carried_m FROM moves ORDER BY seq`,
      )],
    );
    expect(record).toHaveLength(1);
    expect(record[0]).toMatchObject({ from_sq: 'e2', to_sq: 'e4' });

    white.close();
    black.close();
  });

  it('records where the piece was lifted and where it was put down', async () => {
    const { white, black, stub } = await startedGame();
    white.send({ t: 'lift', from: 'e2', pos: at('e2') });
    await white.next((m) => m.t === 'state' && (m.game as Msg).carry !== null);
    await walked(stub);
    white.send({ t: 'place', to: 'e4', pos: at('e4') });
    await white.next((m) => m.t === 'state' && ((m.game as Msg).lastMove as Msg | null) !== null);

    const row = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{
        lift_lat: number; place_lat: number; carried_m: number; carried_ms: number;
      }>(`SELECT lift_lat, place_lat, carried_m, carried_ms FROM moves WHERE seq = 1`)][0],
    );
    // Two distinct fixes, and a real distance between them.
    expect(row.lift_lat).not.toBe(row.place_lat);
    expect(row.carried_m).toBeGreaterThan(SQUARE_M - 1);
    expect(row.carried_ms).toBeGreaterThanOrEqual(0);

    white.close();
    black.close();
  });

  it('refuses a place made away from the destination', async () => {
    const { white, black } = await startedGame();
    white.send({ t: 'lift', from: 'e2', pos: at('e2') });
    await white.next((m) => m.t === 'state' && (m.game as Msg).carry !== null);

    // Still standing on e2, trying to put the pawn on e4 twelve metres away.
    white.send({ t: 'place', to: 'e4', pos: at('e2') });
    const err = await white.next((m) => m.t === 'error');
    expect(err.code).toBe('out_of_reach');
    expect(String(err.message)).toMatch(/from e4/);
    white.close();
    black.close();
  });

  it('refuses an illegal move even from the right place', async () => {
    const { white, black } = await startedGame();
    white.send({ t: 'lift', from: 'e2', pos: at('e2') });
    await white.next((m) => m.t === 'state' && (m.game as Msg).carry !== null);

    // Standing on e5, which is in reach of nothing legal for an e2 pawn.
    white.send({ t: 'place', to: 'e5', pos: at('e5') });
    const err = await white.next((m) => m.t === 'error');
    expect(err.code).toBe('illegal_move');
    white.close();
    black.close();
  });

  it('refuses a place with nothing in hand', async () => {
    const { white, black } = await startedGame();
    white.send({ t: 'place', to: 'e4', pos: at('e4') });
    const err = await white.next((m) => m.t === 'error');
    expect(err.code).toBe('not_carrying');
    white.close();
    black.close();
  });

  it('charges the mover and hands the clock over with an increment', async () => {
    const { white, black, stub } = await startedGame({ initialMs: 600_000, incrementMs: 10_000 });

    white.send({ t: 'lift', from: 'e2', pos: at('e2') });
    await white.next((m) => m.t === 'state' && (m.game as Msg).carry !== null);
    await new Promise((r) => setTimeout(r, 120));
    await walked(stub);
    white.send({ t: 'place', to: 'e4', pos: at('e4') });
    await white.next((m) => m.t === 'state' && ((m.game as Msg).lastMove as Msg | null) !== null);

    const clocks = await stub.clocks();
    // Spent a fraction of a second walking, then gained ten seconds of increment.
    expect(clocks.w).toBeGreaterThan(600_000);
    expect(clocks.w).toBeLessThan(610_000);
    // Black's clock is running by now, so it is already ticking down — what
    // matters is that black was not charged for white's move.
    expect(clocks.b).toBeGreaterThan(599_000);
    expect(clocks.b).toBeLessThanOrEqual(600_000);
    expect(clocks.running).toBe(true);

    white.close();
    black.close();
  });

  it('moves the flag deadline to the other player after a move', async () => {
    const { white, black, stub } = await startedGame({ initialMs: 600_000, incrementMs: 0 });
    const before = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ due_at: number }>(`SELECT due_at FROM timers WHERE kind='flag'`)][0].due_at,
    );

    white.send({ t: 'lift', from: 'e2', pos: at('e2') });
    await white.next((m) => m.t === 'state' && (m.game as Msg).carry !== null);
    await new Promise((r) => setTimeout(r, 60));
    await walked(stub);
    white.send({ t: 'place', to: 'e4', pos: at('e4') });
    await white.next((m) => m.t === 'state' && ((m.game as Msg).lastMove as Msg | null) !== null);

    const after = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ due_at: number }>(`SELECT due_at FROM timers WHERE kind='flag'`)][0].due_at,
    );
    // Black's full ten minutes now, starting later than white's did.
    expect(after).toBeGreaterThan(before);
    white.close();
    black.close();
  });

  it('lets both players move in turn', async () => {
    const { white, black, stub } = await startedGame();

    // Through `move()` rather than by hand, and that is the fix for the oldest
    // half of O-09. Written out inline, black's "wait until a carry exists"
    // matched the broadcast of *white's* lift, which black had already received
    // — so `walked()` backdated a row that did not exist yet, black's place read
    // as a teleport, and the test timed out waiting for a move the server had
    // rightly refused. It passed most of the time because the round trip into the
    // object was usually slow enough for the real lift to land first.
    await move(white, stub, 'e2', 'e4');
    await move(black, stub, 'e7', 'e5');

    const moves = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ san: string }>(`SELECT san FROM moves ORDER BY seq`)].map((r) => r.san),
    );
    expect(moves).toEqual(['e4', 'e5']);
    white.close();
    black.close();
  });
});

describe('the carry survives the object going to sleep', () => {
  it('keeps a pending lift in storage, not in memory', async () => {
    const { white, black, stub } = await startedGame();
    white.send({ t: 'lift', from: 'e2', pos: at('e2') });
    await white.next((m) => m.t === 'state' && (m.game as Msg).carry !== null);

    // The walk can take a minute, during which the object hibernates. If the carry
    // lived in memory it would be gone.
    const stored = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ from_sq: string; piece: string }>(`SELECT from_sq, piece FROM carry`)][0],
    );
    expect(stored).toMatchObject({ from_sq: 'e2', piece: 'p' });
    white.close();
    black.close();
  });
});

describe('flag-fall', () => {
  it('ends the game on time, in favour of the player who still has some', async () => {
    const { white, black, stub } = await startedGame({ initialMs: 600_000, incrementMs: 0 });

    // Wind white's clock down rather than waiting ten minutes, then fire the
    // deadline the way the runtime would.
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec(
        `UPDATE game SET white_ms_remaining = 5, last_clock_start_at = ? WHERE id = 1`,
        Date.now() - 1_000,
      );
      state.storage.sql.exec(`UPDATE timers SET due_at = ? WHERE kind = 'flag'`, Date.now() - 1);
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await stub.peek()).toMatchObject({ status: 'finished' });
    const state = await black.next(
      (m) => m.t === 'state' && ((m.game as Msg).result as Msg | null) !== null,
    );
    expect((state.game as Msg).result).toMatchObject({ outcome: '0-1', reason: 'timeout' });
    expect((await stub.clocks()).running).toBe(false);

    white.close();
    black.close();
  });

  it('draws rather than losing when the opponent could never mate', async () => {
    const { white, black, stub } = await startedGame({ initialMs: 600_000, incrementMs: 0 });

    // Black has only a king, so white running out of time is a draw.
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec(
        `UPDATE game SET fen = ?, white_ms_remaining = 5, last_clock_start_at = ? WHERE id = 1`,
        '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
        Date.now() - 1_000,
      );
      state.storage.sql.exec(`UPDATE timers SET due_at = ? WHERE kind = 'flag'`, Date.now() - 1);
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const state = await black.next(
      (m) => m.t === 'state' && ((m.game as Msg).result as Msg | null) !== null,
    );
    expect((state.game as Msg).result).toMatchObject({
      outcome: '1/2-1/2',
      reason: 'insufficient_material',
    });

    white.close();
    black.close();
  });

  it('does not end a game that still has time on the clock', async () => {
    const { white, black, stub } = await startedGame({ initialMs: 600_000, incrementMs: 0 });

    // An alarm that fires early must re-arm, not declare a loss.
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec(`UPDATE timers SET due_at = ? WHERE kind = 'flag'`, Date.now() - 1);
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await stub.peek()).toMatchObject({ status: 'active' });
    const timers = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ kind: string }>(`SELECT kind FROM timers`)].map((r) => r.kind),
    );
    expect(timers).toContain('flag');

    white.close();
    black.close();
  });
});

describe('checkmate', () => {
  it('ends the game when a move delivers mate', async () => {
    const { white, black, stub } = await startedGame();

    // A position one move from mate, with the mating square reachable on foot.
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(
        `UPDATE game SET fen = ? WHERE id = 1`,
        // Scholar's mate, one move short: 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? and
        // now Qxf7#. The bishop on c4 is what makes it mate rather than a
        // blunder — without it the king just takes the queen.
        'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 1',
      );
    });

    white.send({ t: 'lift', from: 'h5', pos: at('h5') });
    await white.next((m) => m.t === 'state' && (m.game as Msg).carry !== null);
    await walked(stub);
    white.send({ t: 'place', to: 'f7', pos: at('f7') });

    const ended = await white.next(
      (m) => m.t === 'state' && ((m.game as Msg).result as Msg | null) !== null,
    );
    expect((ended.game as Msg).result).toMatchObject({ outcome: '1-0', reason: 'checkmate' });
    expect(await stub.peek()).toMatchObject({ status: 'finished' });
    // No clock runs on a finished game, and no flag can fall.
    expect((await stub.clocks()).running).toBe(false);
    const timers = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ kind: string }>(`SELECT kind FROM timers`)].map((r) => r.kind),
    );
    expect(timers).not.toContain('flag');
    // No `gc` either. Decision 0025: once two people have played, the game is
    // theirs to keep until one of them clears it — a timer that deletes it
    // saves a few kilobytes and costs the only record of an afternoon.
    expect(timers).not.toContain('gc');

    white.close();
    black.close();
  });
});

describe('suspension puts the piece back (decision 0009)', () => {
  it('clears a pending carry when a disconnect suspends the game', async () => {
    const { white, black, stub } = await startedGame();

    white.send({ t: 'lift', from: 'e2', pos: at('e2') });
    await white.next((m) => m.t === 'state' && (m.game as Msg).carry !== null);

    // Black walks behind a building and the grace period expires. The object
    // schedules that deadline itself; all this does is bring it forward, once the
    // object has actually scheduled it (see `closeAndSettle`).
    await closeAndSettle(black, stub);
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO timers (kind, due_at) VALUES ('disconnect', ?)`,
        Date.now() - 1,
      );
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await stub.peek()).toMatchObject({ status: 'suspended' });

    // The whole point: whoever resumes will be standing somewhere else, so a
    // pending lift would be unfinishable.
    const carry = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec(`SELECT * FROM carry WHERE id = 1`)],
    );
    expect(carry).toHaveLength(0);

    // And the board still has the pawn on e2 — it was never moved.
    const [game] = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ fen: string }>(`SELECT fen FROM game WHERE id = 1`)],
    );
    expect(game.fen).toContain('PPPPPPPP');

    white.close();
  });

  it('leaves the clock alone — nothing refunded, nothing charged', async () => {
    const { white, black, stub } = await startedGame({ initialMs: 600_000, incrementMs: 0 });

    white.send({ t: 'lift', from: 'e2', pos: at('e2') });
    await white.next((m) => m.t === 'state' && (m.game as Msg).carry !== null);
    await new Promise((r) => setTimeout(r, 150));

    await closeAndSettle(black, stub);
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO timers (kind, due_at) VALUES ('disconnect', ?)`,
        Date.now() - 1,
      );
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const clocks = await stub.clocks();
    expect(clocks.running).toBe(false);
    // White was charged for the time spent holding the piece, and no more.
    expect(clocks.w).toBeLessThan(600_000);
    expect(clocks.w).toBeGreaterThan(599_000);
    expect(clocks.b).toBe(600_000);

    white.close();
  });
});

/**
 * Play one move the way a player would: lift near the origin, walk, place near
 * the destination. Resolves once the mover's own socket has seen the move land.
 */
async function move(
  client: Client,
  stub: DurableObjectStub<GameDO>,
  from: string,
  to: string,
  opts: { promotion?: string } = {},
): Promise<Msg> {
  // Clear first, and match on *this* lift rather than on "a carry exists".
  // `next()` searches already-received messages, and both players see every
  // broadcast — so a state left over from the opponent's carry would satisfy a
  // looser predicate instantly, `walked()` would backdate a row that does not
  // exist yet, and the place would then read as a teleport. That failure is
  // intermittent and blames the wrong thing, so it is worth being precise here.
  client.clear();
  client.send({ t: 'lift', from, pos: at(from) });
  await client.next(
    (m) => m.t === 'state' && ((m.game as Msg).carry as Msg | null)?.from === from,
  );
  await walked(stub);
  client.send({ t: 'place', to, pos: at(to), ...opts });
  // Both ends, not just the destination. `to` alone is not unique across a game:
  // black's d7-d5 makes `lastMove.to === 'd5'` true, so a later white e4xd5
  // matched the opponent's stale broadcast and reported the wrong move.
  const state = await client.next(
    (m) =>
      m.t === 'error' ||
      (m.t === 'state' &&
        ((m.game as Msg).lastMove as Msg | null)?.to === to &&
        ((m.game as Msg).lastMove as Msg).from === from),
  );
  if (state.t === 'error') {
    throw new Error(`${from}-${to} rejected: ${state.code} ${state.message}`);
  }
  client.clear();
  return state;
}

/** Overwrite the position, for reaching an interesting one without playing to it. */
async function setFen(stub: DurableObjectStub<GameDO>, fen: string): Promise<void> {
  await runInDurableObject(stub, (_i, state) => {
    state.storage.sql.exec(`UPDATE game SET fen = ?, active_color = ? WHERE id = 1`, fen, fen.split(' ')[1]);
  });
}

async function fenOf(stub: DurableObjectStub<GameDO>): Promise<string> {
  const [row] = await runInDurableObject(stub, (_i, state) =>
    [...state.storage.sql.exec<{ fen: string }>(`SELECT fen FROM game WHERE id = 1`)],
  );
  return row.fen;
}

describe('a whole game, played on foot', () => {
  it('plays Scholar\'s mate move by move and ends properly', async () => {
    const { white, black, stub } = await startedGame();

    await move(white, stub, 'e2', 'e4');
    await move(black, stub, 'e7', 'e5');
    await move(white, stub, 'f1', 'c4');
    await move(black, stub, 'b8', 'c6');
    await move(white, stub, 'd1', 'h5');
    await move(black, stub, 'g8', 'f6');
    await move(white, stub, 'h5', 'f7');

    expect(await stub.peek()).toMatchObject({ status: 'finished' });

    const moves = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ san: string }>(`SELECT san FROM moves ORDER BY seq`)].map((r) => r.san),
    );
    expect(moves).toEqual(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#']);

    // Every move stored both ends of its carry, which is what the distance
    // record and the replay are built from.
    const fixes = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ lift_lat: number; place_lat: number; carried_m: number }>(
        `SELECT lift_lat, place_lat, carried_m FROM moves ORDER BY seq`,
      )],
    );
    expect(fixes).toHaveLength(7);
    expect(fixes.every((f) => f.lift_lat !== f.place_lat)).toBe(true);
    expect(fixes.every((f) => f.carried_m > 0)).toBe(true);

    white.close();
    black.close();
  });

  it('refuses to carry on once the game is over', async () => {
    const { white, black, stub } = await startedGame();
    await setFen(stub, 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 1');
    await move(white, stub, 'h5', 'f7');

    black.send({ t: 'lift', from: 'e8', pos: at('e8') });
    const err = await black.next((m) => m.t === 'error');
    expect(String(err.message)).toMatch(/finished|over/i);

    white.close();
    black.close();
  });
});

describe('the special moves (decision 0001)', () => {
  it('castles on the king\'s two squares alone — the rook is never carried', async () => {
    const { white, black, stub } = await startedGame();
    // Everything between king and rook cleared, castling rights intact.
    await setFen(stub, 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1');

    // Only ever e1 and g1 are supplied. If the rule required the rook's square
    // this would have to mention h1, and it does not.
    await move(white, stub, 'e1', 'g1');

    const fen = await fenOf(stub);
    // King on g1, rook on f1 — chess.js moved the rook, the player did not.
    expect(fen.split(' ')[0]).toContain('RNBQ1RK1');

    const [row] = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ san: string; from_sq: string; to_sq: string }>(
        `SELECT san, from_sq, to_sq FROM moves WHERE seq = 1`,
      )],
    );
    expect(row.san).toBe('O-O');
    expect([row.from_sq, row.to_sq]).toEqual(['e1', 'g1']);

    white.close();
    black.close();
  });

  it('takes en passant without ever going near the captured pawn', async () => {
    const { white, black, stub } = await startedGame();
    // Black has just played f7-f5; white's e5 pawn may take on f6.
    await setFen(stub, 'rnbqkbnr/ppppp1pp/8/4Pp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3');

    // The captured pawn is on f5. The player only visits e5 and f6.
    await move(white, stub, 'e5', 'f6');

    const fen = await fenOf(stub);
    const ranks = fen.split(' ')[0].split('/');
    // Rank 6 has the capturing pawn; rank 5 is now empty of the black pawn.
    expect(ranks[2]).toContain('P');
    expect(ranks[3]).toBe('8');

    const [row] = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ san: string }>(`SELECT san FROM moves WHERE seq = 1`)],
    );
    expect(row.san).toBe('exf6');

    white.close();
    black.close();
  });

  it('promotes at the destination, with no extra travel', async () => {
    const { white, black, stub } = await startedGame();
    await setFen(stub, 'k7/4P3/8/8/8/8/8/K7 w - - 0 1');

    await move(white, stub, 'e7', 'e8', { promotion: 'q' });

    const fen = await fenOf(stub);
    expect(fen.split(' ')[0]).toContain('Q');
    const [row] = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ san: string }>(`SELECT san FROM moves WHERE seq = 1`)],
    );
    expect(row.san).toMatch(/^e8=Q/);

    white.close();
    black.close();
  });

  it('defaults an unspecified promotion to a queen rather than failing', async () => {
    const { white, black, stub } = await startedGame();
    await setFen(stub, 'k7/4P3/8/8/8/8/8/K7 w - - 0 1');
    await move(white, stub, 'e7', 'e8');
    expect(await fenOf(stub)).toContain('Q');
    white.close();
    black.close();
  });
});

describe('resign and draw (stage 4.4)', () => {
  it('resigning hands the game to the opponent', async () => {
    const { white, black, stub } = await startedGame();
    white.send({ t: 'resign' });
    const ended = await black.next(
      (m) => m.t === 'state' && ((m.game as Msg).result as Msg | null) !== null,
    );
    expect((ended.game as Msg).result).toMatchObject({ outcome: '0-1', reason: 'resignation' });
    expect(await stub.peek()).toMatchObject({ status: 'finished' });
    expect((await stub.clocks()).running).toBe(false);
    white.close();
    black.close();
  });

  it('lets you resign on the opponent\'s turn — conceding is not a move', async () => {
    const { white, black, stub } = await startedGame();
    await move(white, stub, 'e2', 'e4');
    // It is black's turn; white gives up anyway.
    white.send({ t: 'resign' });
    const ended = await white.next(
      (m) => m.t === 'state' && ((m.game as Msg).result as Msg | null) !== null,
    );
    expect((ended.game as Msg).result).toMatchObject({ outcome: '0-1' });
    white.close();
    black.close();
  });

  it('offers, shows the offer to both, and draws on acceptance', async () => {
    const { white, black, stub } = await startedGame();

    white.send({ t: 'draw', action: 'offer' });
    const seen = await black.next(
      (m) => m.t === 'state' && (m.game as Msg).drawOfferFrom === 'w',
    );
    expect((seen.game as Msg).drawOfferFrom).toBe('w');

    black.send({ t: 'draw', action: 'accept' });
    const ended = await white.next(
      (m) => m.t === 'state' && ((m.game as Msg).result as Msg | null) !== null,
    );
    expect((ended.game as Msg).result).toMatchObject({ outcome: '1/2-1/2', reason: 'agreement' });
    expect(await stub.peek()).toMatchObject({ status: 'finished' });
    white.close();
    black.close();
  });

  it('clears the offer when declined, and the game plays on', async () => {
    const { white, black, stub } = await startedGame();
    white.send({ t: 'draw', action: 'offer' });
    await black.next((m) => m.t === 'state' && (m.game as Msg).drawOfferFrom === 'w');

    black.send({ t: 'draw', action: 'decline' });
    await white.next((m) => m.t === 'state' && (m.game as Msg).drawOfferFrom === null);

    expect(await stub.peek()).toMatchObject({ status: 'active' });
    await move(white, stub, 'e2', 'e4');
    white.close();
    black.close();
  });

  it('refuses to accept an offer nobody made', async () => {
    const { white, black } = await startedGame();
    black.send({ t: 'draw', action: 'accept' });
    const err = await black.next((m) => m.t === 'error');
    expect(err.code).toBe('no_draw_offer');
    white.close();
    black.close();
  });

  it('will not let you accept your own offer', async () => {
    const { white, black } = await startedGame();
    white.send({ t: 'draw', action: 'offer' });
    await white.next((m) => m.t === 'state' && (m.game as Msg).drawOfferFrom === 'w');
    white.clear();

    white.send({ t: 'draw', action: 'accept' });
    const err = await white.next((m) => m.t === 'error');
    expect(err.code).toBe('no_draw_offer');
    white.close();
    black.close();
  });

  it('treats offering into an open offer as agreement', async () => {
    const { white, black, stub } = await startedGame();
    white.send({ t: 'draw', action: 'offer' });
    await black.next((m) => m.t === 'state' && (m.game as Msg).drawOfferFrom === 'w');

    // Both players tapping "offer a draw" at once is agreement by any reading.
    black.send({ t: 'draw', action: 'offer' });
    const ended = await white.next(
      (m) => m.t === 'state' && ((m.game as Msg).result as Msg | null) !== null,
    );
    expect((ended.game as Msg).result).toMatchObject({ reason: 'agreement' });
    expect(await stub.peek()).toMatchObject({ status: 'finished' });
    white.close();
    black.close();
  });

  it('rejects a draw with no action rather than guessing', async () => {
    const { white, black } = await startedGame();
    white.send({ t: 'draw' });
    const err = await white.next((m) => m.t === 'error');
    expect(err.code).toBe('bad_message');
    white.close();
    black.close();
  });

  it('refuses to resign a game that has already finished', async () => {
    const { white, black } = await startedGame();
    white.send({ t: 'resign' });
    await white.next((m) => m.t === 'state' && ((m.game as Msg).result as Msg | null) !== null);
    white.clear();

    white.send({ t: 'resign' });
    const err = await white.next((m) => m.t === 'error');
    expect(err.code).toBe('not_active');
    white.close();
    black.close();
  });
});

describe('capturing a piece', () => {
  it('takes an enemy piece off the board on an ordinary capture', async () => {
    const { white, black, stub } = await startedGame();
    await move(white, stub, 'e2', 'e4');
    await move(black, stub, 'd7', 'd5');

    // exd5 — placing onto an occupied square, which is the case the carry rule
    // has to get right without any special handling: the victim's square *is*
    // the destination, so it is already covered (decision 0001).
    const state = await move(white, stub, 'e4', 'd5');
    expect(((state.game as Msg).lastMove as Msg).san).toBe('exd5');

    const placement = (await fenOf(stub)).split(' ')[0];
    const board = placement.split('/');
    // White pawn now on d5, and the square it came from is empty.
    expect(board[3]).toBe('3P4');
    expect(board[4]).toBe('8');
    // And material really left the board, rather than chess.js merely printing
    // an 'x': black had 8 pawns and now has 7.
    expect((placement.match(/p/g) ?? []).length).toBe(7);
    expect((placement.match(/P/g) ?? []).length).toBe(8);

    white.close();
    black.close();
  });

  it('allows the recapture, so a trade costs two walks', async () => {
    const { white, black, stub } = await startedGame();
    await move(white, stub, 'e2', 'e4');
    await move(black, stub, 'd7', 'd5');
    await move(white, stub, 'e4', 'd5');
    const recapture = await move(black, stub, 'd8', 'd5');

    expect(((recapture.game as Msg).lastMove as Msg).san).toBe('Qxd5');
    const moves = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ san: string }>(`SELECT san FROM moves ORDER BY seq`)].map((r) => r.san),
    );
    expect(moves).toEqual(['e4', 'd5', 'exd5', 'Qxd5']);

    white.close();
    black.close();
  });

  it('charges a capture exactly what the same quiet move would cost', async () => {
    // Decision 0001 claims a capture costs the same walking as a quiet move to
    // the same square, because only the destination is required. Worth checking
    // rather than assuming: if capturing were more expensive, players would
    // avoid it and the game would be strange.
    const quiet = await startedGame();
    await move(quiet.white, quiet.stub, 'e2', 'e4');
    await move(quiet.black, quiet.stub, 'h7', 'h6');
    await move(quiet.white, quiet.stub, 'e4', 'e5');
    const quietCarry = await runInDurableObject(quiet.stub, (_i, state) =>
      [...state.storage.sql.exec<{ carried_m: number }>(`SELECT carried_m FROM moves WHERE seq = 3`)][0],
    );

    const taking = await startedGame();
    await move(taking.white, taking.stub, 'e2', 'e4');
    await move(taking.black, taking.stub, 'd7', 'd5');
    await move(taking.white, taking.stub, 'e4', 'd5');
    const captureCarry = await runInDurableObject(taking.stub, (_i, state) =>
      [...state.storage.sql.exec<{ carried_m: number }>(`SELECT carried_m FROM moves WHERE seq = 3`)][0],
    );

    // e4-e5 is one square straight; e4-d5 is one square diagonally. Both are a
    // single square's walk, and neither ever visits a third square.
    expect(captureCarry.carried_m).toBeGreaterThan(0);
    expect(Math.abs(captureCarry.carried_m - quietCarry.carried_m)).toBeLessThan(SQUARE_M);

    quiet.white.close();
    quiet.black.close();
    taking.white.close();
    taking.black.close();
  });

  it('lists a capture among the destinations offered at lift time', async () => {
    const { white, black, stub } = await startedGame();
    await move(white, stub, 'e2', 'e4');
    await move(black, stub, 'd7', 'd5');

    white.clear();
    white.send({ t: 'lift', from: 'e4', pos: at('e4') });
    const lifted = await white.next(
      (m) => m.t === 'state' && ((m.game as Msg).carry as Msg | null)?.from === 'e4',
    );
    // The client draws these; a capture must appear or a player would think the
    // move were illegal.
    expect((((lifted.game as Msg).carry as Msg).destinations as string[])).toContain('d5');

    white.close();
    black.close();
  });

  it('refuses a capture of your own piece', async () => {
    const { white, black, stub } = await startedGame();
    white.clear();
    white.send({ t: 'lift', from: 'a1', pos: at('a1') });
    // The rook on a1 is boxed in by its own pawn, so there is nothing to lift for.
    const err = await white.next((m) => m.t === 'error');
    expect(err.code).toBe('no_legal_moves');
    white.close();
    black.close();
  });
});

describe('the start handshake is positional (decision 0005)', () => {
  it('starts when both players simply stand on their back ranks', async () => {
    // Neither player ever sends `ready`. Decision 0005 makes the condition
    // "standing in your own start zone, verified server-side" — an observable
    // state, not a button press. This was half-applied: a relayed position set
    // `in_start_zone` but never re-checked whether that completed the handshake,
    // so two players who both just walked to their ends waited forever. Only an
    // end-to-end run through the browser exposed it, because every other test
    // sends `ready` explicitly.
    const joinCode = nextCode();
    const stub = env.GAME.getByName(joinCode);
    await stub.create({
      joinCode, creatorPlayerId: WHITE, creatorColor: 'w', field: FIELD,
      initialMs: 600_000, incrementMs: 0,
    });
    await stub.join(BLACK);

    const white = await openSocket(joinCode, WHITE);
    const black = await openSocket(joinCode, BLACK);
    await white.next((m) => m.t === 'state');
    await black.next((m) => m.t === 'state');

    const e1 = at('e1');
    const e8 = at('e8');
    white.send({ t: 'pos', lat: e1.lat, lng: e1.lng, acc: e1.acc });
    // Past the server's own relay backstop, or the second fix is discarded.
    await new Promise((r) => setTimeout(r, POS_SERVER_MIN_INTERVAL_MS + 50));
    black.send({ t: 'pos', lat: e8.lat, lng: e8.lng, acc: e8.acc });

    await white.next((m) => m.t === 'state' && (m.game as Msg).status === 'active');
    expect(await stub.peek()).toMatchObject({ status: 'active' });
    expect((await stub.clocks()).running).toBe(true);

    white.close();
    black.close();
  });

  it('does not start on a position outside your own zone', async () => {
    const joinCode = nextCode();
    const stub = env.GAME.getByName(joinCode);
    await stub.create({
      joinCode, creatorPlayerId: WHITE, creatorColor: 'w', field: FIELD,
      initialMs: 600_000, incrementMs: 0,
    });
    await stub.join(BLACK);
    const white = await openSocket(joinCode, WHITE);
    const black = await openSocket(joinCode, BLACK);
    await white.next((m) => m.t === 'state');
    await black.next((m) => m.t === 'state');

    const e1 = at('e1');
    const d4 = at('d4');
    white.send({ t: 'pos', lat: e1.lat, lng: e1.lng, acc: e1.acc });
    await new Promise((r) => setTimeout(r, POS_SERVER_MIN_INTERVAL_MS + 50));
    black.send({ t: 'pos', lat: d4.lat, lng: d4.lng, acc: d4.acc });
    await new Promise((r) => setTimeout(r, 200));

    expect(await stub.peek()).toMatchObject({ status: 'staging' });
    white.close();
    black.close();
  });
});

describe('pause, and claiming a game nobody came back to (decision 0025)', () => {
  /** Wind the suspension into the past, rather than waiting a month. */
  async function suspendedFor(stub: DurableObjectStub<GameDO>, ms: number): Promise<void> {
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(`UPDATE game SET suspended_at = suspended_at - ? WHERE id = 1`, ms);
    });
  }

  it('freezes both clocks on a requested pause', async () => {
    const { white, black, stub } = await startedGame({ initialMs: 600_000, incrementMs: 0 });
    white.send({ t: 'pause' });
    await white.next((m) => m.t === 'state' && (m.game as Msg).status === 'suspended');

    expect((await stub.clocks()).running).toBe(false);
    const timers = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ kind: string }>(`SELECT kind FROM timers`)].map((r) => r.kind),
    );
    expect(timers).not.toContain('flag');
    white.close();
    black.close();
  });

  it('puts a carried piece back when paused (decision 0009)', async () => {
    const { white, black, stub } = await startedGame();
    white.send({ t: 'lift', from: 'e2', pos: at('e2') });
    await white.next((m) => m.t === 'state' && ((m.game as Msg).carry as Msg | null)?.from === 'e2');

    white.send({ t: 'pause' });
    await white.next((m) => m.t === 'state' && (m.game as Msg).status === 'suspended');
    const carry = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec(`SELECT * FROM carry WHERE id = 1`)],
    );
    expect(carry).toHaveLength(0);
    white.close();
    black.close();
  });

  it('tells each player whether they may claim, and when', async () => {
    const { white, black, stub } = await startedGame();
    white.send({ t: 'pause' });
    const paused = await white.next((m) => m.t === 'state' && (m.game as Msg).status === 'suspended');

    // White stopped it, so white may never claim it.
    const mine = (paused.game as Msg).suspension as Msg;
    expect(mine).toMatchObject({ by: 'w', canClaim: false, claimableInMs: 0 });

    const theirs = (
      (await black.next((m) => m.t === 'state' && (m.game as Msg).status === 'suspended'))
        .game as Msg
    ).suspension as Msg;
    // Black may, eventually — roughly a month away.
    expect(theirs.canClaim).toBe(false);
    expect(theirs.claimableInMs).toBeGreaterThan(29 * 24 * 3600_000);

    white.close();
    black.close();
  });

  it('refuses a claim before the month is up, and says how long is left', async () => {
    const { white, black, stub } = await startedGame();
    white.send({ t: 'pause' });
    await black.next((m) => m.t === 'state' && (m.game as Msg).status === 'suspended');
    black.clear();

    black.send({ t: 'claim' });
    const err = await black.next((m) => m.t === 'error');
    expect(err.code).toBe('cannot_claim');
    expect(String(err.message)).toMatch(/\d+ days?/);
    white.close();
    black.close();
  });

  it('lets the other player claim once the month has passed', async () => {
    const { white, black, stub } = await startedGame();
    white.send({ t: 'pause' });
    await black.next((m) => m.t === 'state' && (m.game as Msg).status === 'suspended');
    await suspendedFor(stub, CLAIM_AFTER_MS + 1000);
    black.clear();

    black.send({ t: 'claim' });
    const ended = await black.next(
      (m) => m.t === 'state' && ((m.game as Msg).result as Msg | null) !== null,
    );
    // A real loss for the player who stopped it, labelled honestly.
    expect((ended.game as Msg).result).toMatchObject({ outcome: '0-1', reason: 'abandoned' });
    expect(await stub.peek()).toMatchObject({ status: 'finished' });
    white.close();
    black.close();
  });

  it('will not let the player who stopped the game claim it', async () => {
    // The whole point: "claim if your opponent is offline" would invert the
    // rule, because after a month nobody is connected — so the player who
    // walked off could claim the win against the one who waited.
    const { white, black, stub } = await startedGame();
    white.send({ t: 'pause' });
    await white.next((m) => m.t === 'state' && (m.game as Msg).status === 'suspended');
    await suspendedFor(stub, CLAIM_AFTER_MS + 1000);
    white.clear();

    white.send({ t: 'claim' });
    const err = await white.next((m) => m.t === 'error');
    expect(err.code).toBe('cannot_claim');
    expect(String(err.message)).toMatch(/you stopped this game/i);
    expect(await stub.peek()).toMatchObject({ status: 'suspended' });
    white.close();
    black.close();
  });

  it('lets the opponent resume right up until the button is pressed', async () => {
    const { white, black, stub } = await startedGame();
    white.send({ t: 'pause' });
    await black.next((m) => m.t === 'state' && (m.game as Msg).status === 'suspended');
    // Forty days late, with an apology.
    await suspendedFor(stub, CLAIM_AFTER_MS + 10 * 24 * 3600_000);

    white.send({ t: 'ready', pos: at('e1') });
    black.send({ t: 'ready', pos: at('e8') });
    await white.next((m) => m.t === 'state' && (m.game as Msg).status === 'active');

    expect(await stub.peek()).toMatchObject({ status: 'active' });
    // And the suspension record is gone, so a later pause starts its own month.
    const [row] = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ suspended_at: number | null }>(
        `SELECT suspended_at FROM game WHERE id = 1`,
      )],
    );
    expect(row.suspended_at).toBeNull();
    white.close();
    black.close();
  });

  it('credits a disconnect to whoever went missing', async () => {
    const { white, black, stub } = await startedGame();
    black.close();
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec(`UPDATE presence SET connected = 0 WHERE color = 'b'`);
      state.storage.sql.exec(
        `INSERT OR REPLACE INTO timers (kind, due_at) VALUES ('disconnect', ?)`,
        Date.now() - 1,
      );
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });
    await runDurableObjectAlarm(stub);

    const [row] = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ suspended_by: string | null }>(
        `SELECT suspended_by FROM game WHERE id = 1`,
      )],
    );
    // Black walked off, so white is the one who may claim.
    expect(row.suspended_by).toBe('b');
    white.close();
  });

  it('refuses a pause on a game that is not running', async () => {
    const { white, black } = await startedGame();
    white.send({ t: 'resign' });
    await white.next((m) => m.t === 'state' && ((m.game as Msg).result as Msg | null) !== null);
    white.clear();

    white.send({ t: 'pause' });
    const err = await white.next((m) => m.t === 'error');
    expect(err.code).toBe('not_active');
    white.close();
    black.close();
  });
});
