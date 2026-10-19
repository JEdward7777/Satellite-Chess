import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { deriveGeometry, makeFieldSpec, snapshotField, squareCentreLatLng } from '../../src/shared/field.js';
import { CHECKERS_START, type CheckersMan, formatCheckers } from '../../src/shared/games/checkers.js';
import type { GameOptions } from '../../src/shared/games/types.js';
import { fromLocal, pathLengthM } from '../../src/shared/geo.js';
import type { RecordSummary } from '../../src/shared/record.js';
import type { GameReport } from '../../src/shared/review.js';
import { type Color, type Square, fromSquare } from '../../src/shared/squares.js';
import type { GameDO } from '../../src/worker/game-do.js';
import { applyUserSchema } from '../../src/worker/user-schema.js';

/**
 * Checkers in the Durable Object (stage 11.2, decision 0057): a game created
 * as checkers, each hop of a jump walked as a `waypoint`, "jumps are
 * required" both ways, stopping early, crowning ending a move, no moves left
 * losing, the carry summed over its legs, a suspension mid-jump, and the game
 * leaving as PDN with its type everywhere it goes.
 */

const SECRET = 'test-dev-auth-secret';
const LOCAL = 'http://127.0.0.1';
const A1 = { lat: 51.4779, lng: -0.0015 };
const SQUARE_M = 8;
const SPEC = makeFieldSpec('Checkers field', { a1: A1, h8: fromLocal(A1, { e: 7 * SQUARE_M, n: 7 * SQUARE_M }) });
const FIELD = snapshotField(SPEC);
const GEO = deriveGeometry(FIELD);
const mutableEnv = env as unknown as Record<string, unknown>;

beforeEach(() => {
  mutableEnv.DEV_AUTH_SECRET = SECRET;
});

async function cookieFor(sub: string): Promise<string> {
  const response = await SELF.fetch(`${LOCAL}/api/dev/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-auth-secret': SECRET },
    body: JSON.stringify({ sub }),
  });
  expect(response.status).toBe(200);
  return (response.headers.get('set-cookie') as string).split(';')[0]!;
}

let counter = 0;
const nextSub = () => `checkers-tester-${++counter}`;
const nextCode = () => `K${String(++counter).padStart(5, '0')}`;

function at(square: string) {
  const p = squareCentreLatLng(GEO, fromSquare(square as Square));
  return { lat: p.lat, lng: p.lng, acc: 3, ts: Date.now() };
}

/** A position from square lists: `K` before a king; `w` moves first. */
function position(turn: Color, w: string[], b: string[]): string {
  const board = new Map<Square, CheckersMan>();
  for (const [color, list] of [['w', w], ['b', b]] as const) {
    for (const item of list) {
      const king = item.startsWith('K');
      board.set((king ? item.slice(1) : item) as Square, { color, king });
    }
  }
  return formatCheckers({ turn, board });
}

type Msg = Record<string, unknown>;

/** A socket that keeps every message, and the barrier `record.test.ts` uses. */
class Client {
  readonly received: Msg[] = [];
  private barriers = 0;
  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener('message', (event) => {
      this.received.push(JSON.parse(String((event as MessageEvent).data)) as Msg);
    });
  }
  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }
  async handled(): Promise<void> {
    const marker = `checkers-barrier-${++this.barriers}`;
    this.send({ t: marker });
    for (let i = 0; i < 400; i++) {
      if (this.received.some((m) => m.t === 'error' && String(m.message).includes(`"${marker}"`))) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no answer to ${marker}`);
  }
  lastState(): Msg | null {
    return ([...this.received].reverse().find((m) => m.t === 'state')?.game as Msg | undefined) ?? null;
  }
  errors(): Msg[] {
    return this.received.filter((m) => m.t === 'error' && !String(m.message).includes('checkers-barrier'));
  }
  clearErrors(): void {
    for (let i = this.received.length - 1; i >= 0; i--) {
      const m = this.received[i];
      if (m.t === 'error' && !String(m.message).includes('checkers-barrier')) this.received.splice(i, 1);
    }
  }
}

interface Seated {
  joinCode: string;
  stub: DurableObjectStub<GameDO>;
  white: string;
  black: string;
}

async function seated(options: GameOptions): Promise<Seated> {
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
      incrementMs: 0,
      gameType: 'checkers',
      options,
    }),
  ).toBe(true);
  expect(await stub.join(black, black)).toMatchObject({ ok: true, color: 'b', gameType: 'checkers' });
  return { joinCode, stub, white, black };
}

async function connect(joinCode: string, sub: string): Promise<Client> {
  const res = await SELF.fetch(`${LOCAL}/api/game/${joinCode}/ws`, {
    headers: { upgrade: 'websocket', cookie: await cookieFor(sub) },
  });
  expect(res.status).toBe(101);
  const client = new Client(res.webSocket as WebSocket);
  await client.handled();
  return client;
}

/** Both players on their back ranks, the game started, then the board set to `fen`. */
async function started(game: Seated, fen?: string): Promise<{ w: Client; b: Client }> {
  const w = await connect(game.joinCode, game.white);
  const b = await connect(game.joinCode, game.black);
  w.send({ t: 'ready', pos: at('e1') });
  b.send({ t: 'ready', pos: at('d8') });
  await w.handled();
  await b.handled();
  await w.handled();
  expect(w.lastState()?.status).toBe('active');
  if (fen !== undefined) {
    await runInDurableObject(game.stub, (_i, state) => {
      state.storage.sql.exec(`UPDATE game SET fen = ?`, fen);
    });
  }
  return { w, b };
}

/**
 * The walk so far, backdated as `carry.test.ts` does, so each leg reads as a
 * walk rather than a jump in no time: the lift and every waypoint.
 */
async function walkBack(stub: DurableObjectStub<GameDO>, ms = 15_000): Promise<void> {
  await runInDurableObject(stub, (_i, state) => {
    const sql = state.storage.sql;
    const [row] = [...sql.exec<{ via_json: string | null }>(`SELECT via_json FROM carry WHERE id = 1`)];
    const via = row?.via_json ? (JSON.parse(row.via_json) as { at: number }[]) : [];
    sql.exec(
      `UPDATE carry SET lift_at = lift_at - ?, via_json = ?`,
      ms,
      via.length === 0 ? null : JSON.stringify(via.map((w) => ({ ...w, at: w.at - ms }))),
    );
  });
}

const gameRow = (stub: DurableObjectStub<GameDO>) =>
  runInDurableObject(stub, (_i, state) => [...state.storage.sql.exec(`SELECT * FROM game WHERE id = 1`)][0] as Msg);

const moveRows = (stub: DurableObjectStub<GameDO>) =>
  runInDurableObject(stub, (_i, state) => [...state.storage.sql.exec(`SELECT * FROM moves ORDER BY seq`)] as Msg[]);

/** A double jump for `w`: c3 over d4 to e5, over f6 to g7. */
const DOUBLE = position('w', ['c3', 'a1'], ['d4', 'f6', 'b8']);

describe('checkers in the object (decision 0057)', () => {
  it('is created over HTTP with its setting, and says so on the join, the snapshot and the socket', async () => {
    const sub = nextSub();
    const response = await SELF.fetch(`${LOCAL}/api/game`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await cookieFor(sub) },
      body: JSON.stringify({ field: SPEC, color: 'w', gameType: 'checkers', options: { jumpsRequired: true, junk: 1 } }),
    });
    expect(response.status).toBe(201);
    const { joinCode } = (await response.json()) as { joinCode: string };
    const stub = env.GAME.getByName(joinCode) as DurableObjectStub<GameDO>;
    const row = await gameRow(stub);
    expect(row.game_type).toBe('checkers');
    expect(JSON.parse(String(row.options_json))).toEqual({ jumpsRequired: true });
    expect(row.fen).toBe(CHECKERS_START);

    // Left out, the setting is off, and still shown.
    const plain = await seated({});
    const w = await connect(plain.joinCode, plain.white);
    expect(w.lastState()).toMatchObject({ gameType: 'checkers', options: { jumpsRequired: false }, fen: CHECKERS_START });
    w.ws.close();
  });

  it('walks a double jump hop by hop, sums the legs, and writes PDN', async () => {
    const game = await seated({ jumpsRequired: true });
    const { w, b } = await started(game, DOUBLE);

    w.send({ t: 'lift', from: 'c3', pos: at('c3') });
    await w.handled();
    expect(w.errors()).toEqual([]);
    // Jumps required: e5 goes on, so it is a waypoint and not a place.
    expect(w.lastState()?.carry).toMatchObject({ from: 'c3', piece: 'm', destinations: [], waypoints: ['e5'] });

    // A place on e5 straight from the lift would stop a jump that must go on.
    await walkBack(game.stub);
    w.send({ t: 'place', to: 'e5', pos: at('e5') });
    await w.handled();
    expect(w.errors()).toEqual([expect.objectContaining({ code: 'illegal_move' })]);
    w.clearErrors();

    // Not a hop: refused, nothing stored.
    w.send({ t: 'waypoint', to: 'g7', pos: at('g7') });
    await w.handled();
    expect(w.errors()).toEqual([expect.objectContaining({ code: 'illegal_move' })]);
    w.clearErrors();
    // Standing somewhere else: refused for reach, as a place is.
    w.send({ t: 'waypoint', to: 'e5', pos: at('a7') });
    await w.handled();
    expect(w.errors()).toEqual([expect.objectContaining({ code: 'out_of_reach' })]);
    w.clearErrors();
    // The opponent cannot stop someone else's piece.
    b.send({ t: 'waypoint', to: 'e5', pos: at('e5') });
    await b.handled();
    expect(b.errors()).toEqual([expect.objectContaining({ code: 'not_carrying' })]);
    b.clearErrors();

    w.send({ t: 'waypoint', to: 'e5', pos: at('e5') });
    await w.handled();
    expect(w.errors()).toEqual([]);
    const mid = w.lastState()!;
    expect(mid.carry).toMatchObject({ from: 'c3', via: ['e5'], destinations: ['g7'] });
    expect(mid.carry).not.toHaveProperty('waypoints');
    // Nothing on the board has changed: the piece is in hand, d4 still there.
    expect(mid.fen).toBe(DOUBLE);
    expect(b.lastState()?.carry).toMatchObject({ via: ['e5'] });
    // Jumps required: e5 is not a place now either.
    w.send({ t: 'place', to: 'e5', pos: at('e5') });
    await w.handled();
    expect(w.errors()).toEqual([expect.objectContaining({ code: 'illegal_move' })]);
    w.clearErrors();

    await walkBack(game.stub);
    w.send({ t: 'place', to: 'g7', pos: at('g7') });
    await w.handled();
    expect(w.errors()).toEqual([]);
    const [move] = await moveRows(game.stub);
    expect(move).toMatchObject({ san: '11x18x25', uci: 'c3e5g7', from_sq: 'c3', to_sq: 'g7', color: 'w' });
    const via = JSON.parse(String(move.via_json)) as { sq: string }[];
    expect(via.map((s) => s.sq)).toEqual(['e5']);
    // Every leg, lift to waypoint to place: twice a diagonal hop, not once.
    const legs = pathLengthM([at('c3'), at('e5'), at('g7')]);
    expect(Number(move.carried_m)).toBeCloseTo(legs, 6);
    expect(Number(move.carried_m)).toBeGreaterThan(4 * SQUARE_M);
    // The whole time in hand, not the last leg's.
    expect(Number(move.carried_ms)).toBeGreaterThanOrEqual(15_000 * 2);
    const after = w.lastState()!;
    expect(after.fen).toBe(position('b', ['g7', 'a1'], ['b8']));
    expect(after.lastMove).toMatchObject({ from: 'c3', to: 'g7', san: '11x18x25' });

    w.ws.close();
    b.ws.close();
  });

  it('lets a jump stop early, and a plain move beside a jump, with jumps not required', async () => {
    const game = await seated({ jumpsRequired: false });
    const { w, b } = await started(game, DOUBLE);

    w.send({ t: 'lift', from: 'c3', pos: at('c3') });
    await w.handled();
    expect(w.lastState()?.carry).toMatchObject({ destinations: ['e5', 'b4'], waypoints: ['e5'] });
    // Straight away, 16 m in no time is a jump of the phone, not of the man.
    w.send({ t: 'waypoint', to: 'e5', pos: at('e5') });
    await w.handled();
    expect(w.errors()).toEqual([expect.objectContaining({ code: 'implausible' })]);
    w.clearErrors();
    await walkBack(game.stub);
    w.send({ t: 'waypoint', to: 'e5', pos: at('e5') });
    await w.handled();
    expect(w.lastState()?.carry).toMatchObject({ via: ['e5'], destinations: ['g7', 'e5'] });
    await walkBack(game.stub);
    // "Stop here": placed where the waypoint already stood.
    w.send({ t: 'place', to: 'e5', pos: at('e5') });
    await w.handled();
    expect(w.errors()).toEqual([]);
    let rows = await moveRows(game.stub);
    expect(rows[0]).toMatchObject({ san: '11x18', uci: 'c3e5' });
    expect(w.lastState()?.fen).toBe(position('b', ['e5', 'a1'], ['f6', 'b8']));

    // The other side steps away rather than taking e5 back (f6 could jump it).
    b.send({ t: 'lift', from: 'b8', pos: at('b8') });
    await b.handled();
    expect(b.lastState()?.carry).toMatchObject({ destinations: ['c7', 'a7'] });
    await walkBack(game.stub);
    b.send({ t: 'place', to: 'c7', pos: at('c7') });
    await b.handled();
    expect(b.errors()).toEqual([]);
    rows = await moveRows(game.stub);
    expect(rows[1]).toMatchObject({ san: `32-27`, via_json: null });

    w.ws.close();
    b.ws.close();
  });

  it('says why a lift is refused when jumps are required and another piece can jump (stage 11.3)', async () => {
    const game = await seated({ jumpsRequired: true });
    // The w seat to move: g1 could step, but a1 can jump b2.
    const { w, b } = await started(game, position('w', ['g1', 'a1'], ['b2', 'h8']));
    w.send({ t: 'lift', from: 'g1', pos: at('g1') });
    await w.handled();
    expect(w.errors()).toEqual([
      expect.objectContaining({
        code: 'no_legal_moves',
        message: expect.stringMatching(/^Jumps are required, and another of your pieces can jump/),
      }),
    ]);
    w.ws.close();
    b.ws.close();
  });

  it('ends the move of a man crowned mid-jump', async () => {
    const game = await seated({ jumpsRequired: true });
    const { w, b } = await started(game, position('w', ['b6', 'a1'], ['a7', 'c7', 'e7', 'h8']));
    w.send({ t: 'lift', from: 'b6', pos: at('b6') });
    await w.handled();
    expect(w.lastState()?.carry).toMatchObject({ destinations: ['d8'] });
    expect(w.lastState()?.carry).not.toHaveProperty('waypoints');
    // d8 crowns, so it is no waypoint, though a king there could take e7.
    await walkBack(game.stub);
    w.send({ t: 'waypoint', to: 'd8', pos: at('d8') });
    await w.handled();
    expect(w.errors()).toEqual([expect.objectContaining({ code: 'illegal_move' })]);
    w.clearErrors();
    w.send({ t: 'place', to: 'd8', pos: at('d8') });
    await w.handled();
    expect(w.errors()).toEqual([]);
    expect((await moveRows(game.stub))[0]).toMatchObject({ san: '24x31' });
    expect(w.lastState()?.fen).toBe(position('b', ['Kd8', 'a1'], ['a7', 'e7', 'h8']));
    w.ws.close();
    b.ws.close();
  });

  it('puts a half-walked jump back on a pause, captured pieces and all', async () => {
    const game = await seated({ jumpsRequired: true });
    const { w, b } = await started(game, DOUBLE);
    w.send({ t: 'lift', from: 'c3', pos: at('c3') });
    await w.handled();
    await walkBack(game.stub);
    w.send({ t: 'waypoint', to: 'e5', pos: at('e5') });
    await w.handled();
    expect(w.lastState()?.carry).toMatchObject({ via: ['e5'] });
    w.send({ t: 'pause' });
    await w.handled();
    const state = w.lastState()!;
    expect(state.status).toBe('suspended');
    expect(state.carry).toBeNull();
    // d4 was jumped, but the move was never placed: it is still there.
    expect(state.fen).toBe(DOUBLE);
    expect(await moveRows(game.stub)).toEqual([]);
    w.ws.close();
    b.ws.close();
  });

  it('ends when the side to move has no moves, and leaves as PDN with its type everywhere', async () => {
    const game = await seated({ jumpsRequired: false });
    // w takes the last black man.
    const { w, b } = await started(game, position('w', ['c3', 'a1'], ['d4']));
    w.send({ t: 'lift', from: 'c3', pos: at('c3') });
    await w.handled();
    await walkBack(game.stub);
    w.send({ t: 'place', to: 'e5', pos: at('e5') });
    await w.handled();
    expect(w.errors()).toEqual([]);
    const over = w.lastState()!;
    expect(over.status).toBe('finished');
    expect(over.result).toMatchObject({ outcome: '1-0', reason: 'no_moves' });

    const report = await game.stub.report(game.white);
    expect(report.ok).toBe(true);
    const r = (report as { report: GameReport }).report;
    expect(r).toMatchObject({ gameType: 'checkers', options: { jumpsRequired: false }, reason: 'no_moves' });
    expect(r.moves[0]).toMatchObject({ san: '11x18', uci: 'c3e5' });
    expect(r.moves[0]).not.toHaveProperty('via');

    const pdn = await SELF.fetch(`${LOCAL}/api/game/${game.joinCode}/pgn`, {
      headers: { cookie: await cookieFor(game.white) },
    });
    expect(pdn.status).toBe(200);
    expect(pdn.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(pdn.headers.get('content-disposition')).toMatch(/filename="satellite-checkers-\d{4}-\d\d-\d\d-checkers-field\.pdn"/);
    const text = await pdn.text();
    expect(text).toContain('[GameType "21"]');
    expect(text).toContain('[SatelliteJumpsRequired "no"]');
    expect(text).toContain('[Result "1-0"]');
    expect(text).toMatch(/1\. 11x18 \{carry/);

    // The record line and the game list carry the type, for the phone.
    let record: RecordSummary | null = null;
    for (let i = 0; i < 200 && record === null; i++) {
      const response = await SELF.fetch(`${LOCAL}/api/record`, { headers: { cookie: await cookieFor(game.white) } });
      const body = (await response.json()) as { record: RecordSummary };
      if (body.record.recent.length > 0) record = body.record;
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(record?.recent[0]).toMatchObject({ joinCode: game.joinCode, gameType: 'checkers', reason: 'no_moves', result: 'win' });
    const list = await SELF.fetch(`${LOCAL}/api/games`, { headers: { cookie: await cookieFor(game.black) } });
    const games = (await list.json()) as { games: { joinCode: string; gameType?: string }[] };
    expect(games.games.find((g) => g.joinCode === game.joinCode)).toMatchObject({ gameType: 'checkers' });

    w.ws.close();
    b.ws.close();
  });

  it('a multi-jump in the report keeps its waypoint, in squares', async () => {
    const game = await seated({ jumpsRequired: true });
    const { w, b } = await started(game, DOUBLE);
    w.send({ t: 'lift', from: 'c3', pos: at('c3') });
    await w.handled();
    await walkBack(game.stub);
    w.send({ t: 'waypoint', to: 'e5', pos: at('e5') });
    await w.handled();
    await walkBack(game.stub);
    w.send({ t: 'place', to: 'g7', pos: at('g7') });
    await w.handled();
    const report = (await game.stub.report(game.white)) as { report: GameReport };
    const move = report.report.moves[0];
    expect(move.via).toHaveLength(1);
    expect(move.via![0]!.file).toBeCloseTo(4, 6);
    expect(move.via![0]!.rank).toBeCloseTo(4, 6);
    expect(move.carriedM).toBeCloseTo(pathLengthM([at('c3'), at('e5'), at('g7')]), 6);
    w.ws.close();
    b.ws.close();
  });

  it('loses on time whatever is on the board', async () => {
    const game = await seated({});
    const { w, b } = await started(game);
    w.send({ t: 'lift', from: 'c3', pos: at('c3') });
    await w.handled();
    await walkBack(game.stub);
    w.send({ t: 'place', to: 'd4', pos: at('d4') });
    await w.handled();
    expect((await moveRows(game.stub))[0]).toMatchObject({ san: '11-15' });
    // The flag falls with the alarm held off, as `endings.test.ts` does it, so
    // only the next message finds it.
    await runInDurableObject(game.stub, async (_i, state) => {
      const sql = state.storage.sql;
      sql.exec(`UPDATE game SET last_clock_start_at = ? WHERE id = 1`, Date.now() - 3_600_000);
      sql.exec(`UPDATE timers SET due_at = ? WHERE kind = 'flag'`, Date.now() + 3_600_000);
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });
    b.send({ t: 'lift', from: 'd6', pos: at('d6') });
    // Polled rather than `handled`: the flag's ending awaits the accounts
    // before its broadcast, which is the barrier's caveat (`gotchas.md`).
    for (let i = 0; i < 400 && !b.lastState()?.result; i++) await new Promise((r) => setTimeout(r, 5));
    expect(b.lastState()?.result).toMatchObject({ outcome: '1-0', reason: 'timeout' });
    w.ws.close();
    b.ws.close();
  });

  it('adds the type to an older account\'s record and game list, reading their rows as chess', async () => {
    const stub = env.USER.getByName(nextSub());
    const columns = await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      for (const table of ['record', 'game_index']) {
        // Rebuilt first, as `game-types.test.ts` does: DROP COLUMN chokes on
        // a CREATE with comment lines (`gotchas.md`).
        sql.exec(`CREATE TABLE ${table}_old AS SELECT * FROM ${table}`);
        sql.exec(`DROP TABLE ${table}`);
        sql.exec(`CREATE TABLE ${table} AS SELECT * FROM ${table}_old`);
        sql.exec(`DROP TABLE ${table}_old`);
        sql.exec(`ALTER TABLE ${table} DROP COLUMN game_type`);
      }
      applyUserSchema(sql);
      const names = (table: string) =>
        [...sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)].map((r) => r.name);
      return { record: names('record'), index: names('game_index') };
    });
    expect(columns.record).toContain('game_type');
    expect(columns.index).toContain('game_type');
  });

  it('sends a stored type it has no rules for as it is, never as chess', async () => {
    const game = await seated({});
    await runInDurableObject(game.stub, (_i, state) => {
      state.storage.sql.exec(`UPDATE game SET game_type = 'backgammon'`);
    });
    const w = await connect(game.joinCode, game.white);
    expect(w.lastState()?.gameType).toBe('backgammon');
    expect(w.lastState()).not.toHaveProperty('options');
    // And a waypoint in it is answered as a message it does not take.
    w.send({ t: 'waypoint', to: 'e5', pos: at('e5') });
    await w.handled();
    expect(w.errors()).toEqual([expect.objectContaining({ code: 'bad_message', message: 'Unknown message type "waypoint".' })]);
    w.ws.close();
  });
});
