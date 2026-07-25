import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { deriveGeometry, makeFieldSpec, snapshotField, squareCentreLatLng } from '../../src/shared/field.js';
import { fromLocal } from '../../src/shared/geo.js';
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

    white.send({ t: 'lift', from: 'e2', pos: at('e2') });
    await white.next((m) => m.t === 'state' && (m.game as Msg).carry !== null);
    await walked(stub);
    white.send({ t: 'place', to: 'e4', pos: at('e4') });
    await black.next((m) => m.t === 'state' && ((m.game as Msg).clock as Msg).active === 'b');

    black.send({ t: 'lift', from: 'e7', pos: at('e7') });
    await black.next((m) => m.t === 'state' && (m.game as Msg).carry !== null);
    await walked(stub);
    black.send({ t: 'place', to: 'e5', pos: at('e5') });
    await white.next(
      (m) => m.t === 'state' && ((m.game as Msg).lastMove as Msg)?.san === 'e5',
    );

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
    expect(timers).toContain('gc');

    white.close();
    black.close();
  });
});
