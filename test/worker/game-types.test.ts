import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { deriveGeometry, makeFieldSpec, snapshotField, squareCentreLatLng } from '../../src/shared/field.js';
import { fromLocal } from '../../src/shared/geo.js';
import { fromSquare } from '../../src/shared/squares.js';
import type { GameDO } from '../../src/worker/game-do.js';
import { applySchema } from '../../src/worker/schema.js';

/**
 * Game types in the Durable Object (stage 11.1, decision 0056): chess is
 * stored as chess, and an object, an archive or a message with no type reads
 * as chess; a type the server has no rules for is refused rather than played
 * as chess; and a `waypoint`, defined for checkers, is answered in a chess
 * game exactly as any type the server does not take.
 */

const SECRET = 'test-dev-auth-secret';
const LOCAL = 'http://127.0.0.1';
const A1 = { lat: 51.4779, lng: -0.0015 };
const SQUARE_M = 8;
const SPEC = makeFieldSpec('Typed field', { a1: A1, h8: fromLocal(A1, { e: 7 * SQUARE_M, n: 7 * SQUARE_M }) });
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
const nextSub = () => `types-tester-${++counter}`;
const nextCode = () => `T${String(++counter).padStart(5, '0')}`;

function at(square: string) {
  const p = squareCentreLatLng(GEO, fromSquare(square));
  return { lat: p.lat, lng: p.lng, acc: 3, ts: Date.now() };
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
    const marker = `types-barrier-${++this.barriers}`;
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
    return this.received.filter((m) => m.t === 'error' && !String(m.message).includes('types-barrier'));
  }
}

async function seated(): Promise<{ joinCode: string; stub: DurableObjectStub<GameDO>; white: string; black: string }> {
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
    }),
  ).toBe(true);
  expect(await stub.join(black, black)).toMatchObject({ ok: true, color: 'b' });
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

const gameRow = (stub: DurableObjectStub<GameDO>) =>
  runInDurableObject(stub, (_i, state) => [...state.storage.sql.exec(`SELECT * FROM game WHERE id = 1`)][0] as Msg);

describe('game types (decision 0056)', () => {
  it('stores a new game as chess, with no settings, and leaves the type off everything it sends', async () => {
    const game = await seated();
    const row = await gameRow(game.stub);
    expect(row.game_type).toBe('chess');
    expect(row.options_json).toBeNull();
    // The join answer, the snapshot and the report: no type, which is chess.
    expect(await game.stub.join(game.black, game.black)).not.toHaveProperty('gameType');
    const w = await connect(game.joinCode, game.white);
    const snapshot = w.lastState()!;
    expect(snapshot).not.toHaveProperty('gameType');
    expect(snapshot).not.toHaveProperty('options');
    const report = await game.stub.report(game.white);
    expect(report.ok && report.report).not.toHaveProperty('gameType');
    w.ws.close();
  });

  it('reads an object from before game types as chess, and its carries as having no waypoints', async () => {
    const game = await seated();
    // Schema 8: no type, no settings, no waypoints anywhere.
    await runInDurableObject(game.stub, (_i, state) => {
      const sql = state.storage.sql;
      // Rebuilt first: SQLite's DROP COLUMN chokes on a CREATE with comment
      // lines before its last column (`gotchas.md`).
      for (const table of ['game', 'carry', 'moves']) {
        sql.exec(`CREATE TABLE ${table}_old AS SELECT * FROM ${table}`);
        sql.exec(`DROP TABLE ${table}`);
        sql.exec(`CREATE TABLE ${table} AS SELECT * FROM ${table}_old`);
        sql.exec(`DROP TABLE ${table}_old`);
      }
      sql.exec(`ALTER TABLE game DROP COLUMN game_type`);
      sql.exec(`ALTER TABLE game DROP COLUMN options_json`);
      sql.exec(`ALTER TABLE carry DROP COLUMN via_json`);
      sql.exec(`ALTER TABLE moves DROP COLUMN via_json`);
      applySchema(sql);
    });
    const row = await gameRow(game.stub);
    expect(row.game_type).toBeNull();
    expect(row.options_json).toBeNull();

    const w = await connect(game.joinCode, game.white);
    const b = await connect(game.joinCode, game.black);
    w.send({ t: 'ready', pos: at('e1') });
    b.send({ t: 'ready', pos: at('e8') });
    await w.handled();
    await b.handled();
    await w.handled();
    expect(w.lastState()?.status).toBe('active');
    w.send({ t: 'lift', from: 'e2', pos: at('e2') });
    await w.handled();
    expect(w.lastState()?.carry).toEqual(
      expect.objectContaining({ from: 'e2', destinations: ['e3', 'e4'] }),
    );
    expect(w.lastState()?.carry).not.toHaveProperty('via');
    expect(w.lastState()?.carry).not.toHaveProperty('waypoints');
    // The walk, backdated as `carry.test.ts` does: 8 m in no time is a jump.
    await runInDurableObject(game.stub, (_i, state) => {
      state.storage.sql.exec(`UPDATE carry SET lift_at = lift_at - 10000`);
    });
    w.send({ t: 'place', to: 'e3', pos: at('e3') });
    await w.handled();
    expect(w.errors()).toEqual([]);
    expect(w.lastState()?.moveCount).toBe(1);
    const viaJson = await runInDurableObject(game.stub, (_i, state) =>
      [...state.storage.sql.exec<{ via_json: string | null }>(`SELECT via_json FROM moves`)].map((r) => r.via_json),
    );
    expect(viaJson).toEqual([null]);
    w.ws.close();
    b.ws.close();
  });

  it('answers a waypoint in a chess game as a type it does not take', async () => {
    const game = await seated();
    const w = await connect(game.joinCode, game.white);
    w.send({ t: 'waypoint', to: 'e3', pos: at('e3') });
    await w.handled();
    expect(w.errors()).toEqual([
      expect.objectContaining({ code: 'bad_message', message: 'Unknown message type "waypoint".' }),
    ]);
    w.ws.close();
  });

  it('refuses the moves of a game whose type this server has no rules for', async () => {
    const game = await seated();
    const w = await connect(game.joinCode, game.white);
    const b = await connect(game.joinCode, game.black);
    w.send({ t: 'ready', pos: at('e1') });
    b.send({ t: 'ready', pos: at('e8') });
    await w.handled();
    await b.handled();
    await w.handled();
    await runInDurableObject(game.stub, (_i, state) => {
      state.storage.sql.exec(`UPDATE game SET game_type = 'backgammon'`);
    });
    w.send({ t: 'lift', from: 'e2', pos: at('e2') });
    await w.handled();
    expect(w.errors()).toEqual([expect.objectContaining({ code: 'bad_message' })]);
    expect((await gameRow(game.stub)).fen).toMatch(/^rnbqkbnr\/pppppppp/);
    w.ws.close();
    b.ws.close();
  });

  it('creates chess when no type is asked for, and refuses a type it does not know', async () => {
    const cookie = await cookieFor(nextSub());
    const create = (extra: Msg) =>
      SELF.fetch(`${LOCAL}/api/game`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ field: SPEC, color: 'w', ...extra }),
      });
    const plain = await create({});
    expect(plain.status).toBe(201);
    expect(await plain.json()).not.toHaveProperty('gameType');
    expect((await create({ gameType: 'chess', options: { jumpsRequired: true } })).status).toBe(201);
    const refused = await create({ gameType: 'backgammon' });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'bad_game' });
  });
});
