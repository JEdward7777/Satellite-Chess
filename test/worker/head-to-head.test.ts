import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeFieldSpec, snapshotField } from '../../src/shared/field.js';
import { fromLocal } from '../../src/shared/geo.js';
import type { HeadToHead, OpponentDetail } from '../../src/shared/head-to-head.js';
import type { RecordGame, RecordSummary } from '../../src/shared/record.js';
import type { GameDO } from '../../src/worker/game-do.js';
import type { UserDO } from '../../src/worker/user-do.js';
import { pairIdFor } from '../../src/worker/user-record.js';
import { applyUserSchema } from '../../src/worker/user-schema.js';

/**
 * Head-to-head, end to end in `workerd` (stage 8.5.4, decision 0054).
 *
 * What needs the real runtime: two players' records, written by one game into
 * two other objects, agreeing about the games between them — once each,
 * however often a game is reported — and nobody else being able to ask.
 */

const SECRET = 'test-dev-auth-secret';
const LOCAL = 'http://127.0.0.1';
const A1 = { lat: 51.4779, lng: -0.0015 };
const mutableEnv = env as unknown as Record<string, unknown>;

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
  return `h2h-tester-${counter}`;
}
function nextCode(): string {
  counter += 1;
  return `H${String(counter).padStart(5, '0')}`;
}

interface Game {
  joinCode: string;
  stub: DurableObjectStub<GameDO>;
  white: string;
  black: string;
}

/** A game between two given accounts, play under way, set by hand as `record.test.ts` does. */
async function activeGame(
  white: string,
  black: string,
  opts: { travel?: [number, number]; moves?: number; squareM?: number } = {},
): Promise<Game> {
  const joinCode = nextCode();
  const stub = env.GAME.getByName(joinCode) as DurableObjectStub<GameDO>;
  const squareM = opts.squareM ?? 8;
  const snapshot = {
    ...snapshotField(
      makeFieldSpec('The common', { a1: A1, h8: fromLocal(A1, { e: 7 * squareM, n: 7 * squareM }) }),
    ),
    lineageKey: '00112233445566ff',
  };
  expect(
    await stub.create({
      joinCode,
      creatorPlayerId: white,
      creatorAccount: white,
      creatorColor: 'w',
      field: snapshot,
      initialMs: 600_000,
      incrementMs: 0,
    }),
  ).toBe(true);
  expect(await stub.join(black, black)).toMatchObject({ ok: true, color: 'b' });
  const [tw, tb] = opts.travel ?? [420.4, 380.4];
  const moves = opts.moves ?? 3;
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`UPDATE game SET status = 'active' WHERE id = 1`);
    for (let i = 0; i < moves; i++) {
      sql.exec(
        `INSERT INTO moves (seq, color, uci, san, fen_after, from_sq, to_sq,
                            carried_m, carried_ms, server_ms, clock_ms_after)
         VALUES (?, ?, 'e2e4', 'e4', 'x', 'e2', 'e4', 10, 1000, ?, 600000)`,
        i + 1,
        i % 2 === 0 ? 'w' : 'b',
        Date.now(),
      );
    }
    sql.exec(`UPDATE presence SET travel_m = ?, travel_leg = 'w-page' WHERE color = 'w'`, tw);
    sql.exec(`UPDATE presence SET travel_m = ?, travel_leg = 'b-page' WHERE color = 'b'`, tb);
  });
  return { joinCode, stub, white, black };
}

/** End a game the way the game itself does, without a socket. */
async function finish(game: Game, outcome: '1-0' | '0-1' | '1/2-1/2'): Promise<void> {
  await runInDurableObject(game.stub, async (instance) => {
    const target = instance as unknown as { finish(o: string, r: string, n: number): Promise<void> };
    await target.finish(outcome, outcome === '1/2-1/2' ? 'agreement' : 'resignation', Date.now());
  });
}

async function send(game: Game, who: string, message: unknown): Promise<void> {
  const res = await SELF.fetch(`${LOCAL}/api/game/${game.joinCode}/ws`, {
    headers: { upgrade: 'websocket', cookie: await cookieFor(who) },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  const over = new Promise<void>((resolve) => {
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String((event as MessageEvent).data)) as { t: string; game?: { status?: string } };
      if (msg.t === 'state' && (msg.game?.status === 'finished' || msg.game?.status === 'aborted')) resolve();
    });
  });
  ws.send(JSON.stringify(message));
  await over;
  ws.close();
}

async function readBoth(sub: string): Promise<{ record: RecordSummary; headToHead: HeadToHead }> {
  const response = await SELF.fetch(`${LOCAL}/api/record`, { headers: { cookie: await cookieFor(sub) } });
  expect(response.status).toBe(200);
  return (await response.json()) as { record: RecordSummary; headToHead: HeadToHead };
}

async function opponent(sub: string, query: string): Promise<Response> {
  return SELF.fetch(`${LOCAL}/api/record/opponent?${query}`, { headers: { cookie: await cookieFor(sub) } });
}

async function rename(sub: string, id: string, name: string | null): Promise<Response> {
  return SELF.fetch(`${LOCAL}/api/record/opponent/name`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: await cookieFor(sub) },
    body: JSON.stringify({ id, name }),
  });
}

async function rowsOf(sub: string): Promise<Record<string, unknown>[]> {
  const stub = env.USER.getByName(sub) as DurableObjectStub<UserDO>;
  return runInDurableObject(stub, (_instance, state) => [
    ...state.storage.sql.exec<Record<string, SqlStorageValue>>(`SELECT * FROM record`),
  ]);
}

beforeEach(() => {
  mutableEnv.DEV_AUTH_SECRET = SECRET;
});

/** Three games between `a` and `b`, with every result, alternating colors. */
async function rivalry(a: string, b: string): Promise<Game[]> {
  const first = await activeGame(a, b, { travel: [420.4, 380.4] });
  await send(first, b, { t: 'resign' }); // a wins as White
  const second = await activeGame(b, a, { travel: [133.3, 266.6] });
  await finish(second, '1-0'); // b wins as White
  const third = await activeGame(a, b, { travel: [25.15, 999.45] });
  await finish(third, '1/2-1/2');
  return [first, second, third];
}

describe('both players see the same head-to-head', () => {
  it('agrees across both accounts, sides swapped', async () => {
    const a = nextSub();
    const b = nextSub();
    const games = await rivalry(a, b);

    const mine = (await readBoth(a)).headToHead;
    const theirs = (await readBoth(b)).headToHead;
    expect(mine.opponents).toHaveLength(1);
    expect(theirs.opponents).toHaveLength(1);
    const [x] = mine.opponents;
    const [y] = theirs.opponents;

    // One pair id, the one the two accounts make.
    expect(x.id).toBe(y.id);
    expect(x.id).toBe(await pairIdFor(a, b));
    expect(x).toMatchObject({ games: 3, wins: 1, losses: 1, draws: 1 });
    expect(y).toMatchObject({ games: 3, wins: 1, losses: 1, draws: 1 });
    // Exactly equal, not close: the same numbers added in the same order.
    expect(x.togetherM).toBe(y.togetherM);
    expect(x.youM).toBe(y.themM);
    expect(x.themM).toBe(y.youM);
    expect(x.youM).toBeCloseTo(420.4 + 266.6 + 25.15, 6);
    expect(x.themM).toBeCloseTo(380.4 + 133.3 + 999.45, 6);
    expect(x.firstAt).toBe(y.firstAt);
    expect(x.lastAt).toBe(y.lastAt);

    // The detail, by id from one side and by game from the other.
    const byId = (await (await opponent(a, `id=${x.id}`)).json()) as OpponentDetail;
    const byGame = (await (await opponent(b, `game=${games[1].joinCode}`)).json()) as OpponentDetail;
    expect(byId.games.map((g) => g.joinCode)).toEqual(byGame.games.map((g) => g.joinCode));
    expect(byId.games.map((g) => g.joinCode)).toEqual(games.map((g) => g.joinCode).reverse());
    expect(byId.opponent.togetherM).toBe(byGame.opponent.togetherM);
    expect(byId.games.map((g) => g.result)).toEqual(['draw', 'loss', 'win']);
    expect(byGame.games.map((g) => g.result)).toEqual(['draw', 'win', 'loss']);
  });

  it('keeps each opponent apart', async () => {
    const a = nextSub();
    const b = nextSub();
    const c = nextSub();
    await finish(await activeGame(a, b), '1-0');
    await finish(await activeGame(c, a), '0-1');
    const head = (await readBoth(a)).headToHead;
    expect(head.opponents).toHaveLength(2);
    expect(new Set(head.opponents.map((o) => o.id))).toEqual(
      new Set([await pairIdFor(a, b), await pairIdFor(a, c)]),
    );
    // b and c each see only a, under the pair they share with a.
    expect((await readBoth(b)).headToHead.opponents.map((o) => o.id)).toEqual([await pairIdFor(a, b)]);
    expect((await readBoth(c)).headToHead.opponents.map((o) => o.id)).toEqual([await pairIdFor(a, c)]);
  });
});

describe('counted once, however often it is reported', () => {
  it('does not double a game whose end is pushed again', async () => {
    const a = nextSub();
    const b = nextSub();
    const games = await rivalry(a, b);
    const before = (await readBoth(a)).headToHead.opponents[0];

    // Forget that the pushes landed, then re-take a seat: the line is sent again.
    await runInDurableObject(games[0].stub, (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM meta WHERE key LIKE 'record_%'`);
    });
    expect(await games[0].stub.join(a, a)).toMatchObject({ ok: true });
    expect(await rowsOf(a)).toHaveLength(3);

    const after = (await readBoth(a)).headToHead.opponents[0];
    expect(after).toEqual(before);
    expect((await readBoth(b)).headToHead.opponents[0].togetherM).toBe(after.togetherM);
  });

  it('writes the same line twice into one row', async () => {
    const sub = nextSub();
    const user = env.USER.getByName(sub) as DurableObjectStub<UserDO>;
    const pair = (await pairIdFor(sub, 'someone-else')) as string;
    const line: RecordGame = {
      joinCode: 'DUPH2H',
      color: 'w',
      outcome: '1-0',
      reason: 'checkmate',
      finishedAt: Date.now(),
      plies: 30,
      moves: 15,
      travelM: 1000,
      longestCarryM: 50,
      fieldName: 'Twice',
      fieldKey: 'aaaaaaaaaaaaaaaa',
      squareM: 8,
      boardM: 64,
      diagonalM: 90.5,
      pairId: pair,
      opponentTravelM: 900,
    };
    expect(await user.recordResult(sub, line)).toBe(true);
    expect(await user.recordResult(sub, line)).toBe(true);
    const { headToHead } = await user.recordWithOpponents();
    expect(headToHead.opponents).toEqual([expect.objectContaining({ id: pair, games: 1, togetherM: 1900 })]);
  });
});

describe('what is left out', () => {
  it('has nothing for an aborted game', async () => {
    const a = nextSub();
    const b = nextSub();
    const game = await activeGame(a, b, { moves: 0 });
    await send(game, a, { t: 'abort' });
    const status = await runInDurableObject(game.stub, (_i, state) =>
      [...state.storage.sql.exec<{ status: string }>(`SELECT status FROM game WHERE id = 1`)][0].status,
    );
    expect(status).toBe('aborted');
    expect((await readBoth(a)).headToHead).toEqual({ opponents: [], earlierGames: 0 });
    expect((await readBoth(b)).headToHead).toEqual({ opponents: [], earlierGames: 0 });
    const response = await opponent(a, `game=${game.joinCode}`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe('not_found');
  });

  it('keeps practice and unplayed games out of the tally, on both sides alike', async () => {
    const a = nextSub();
    const b = nextSub();
    await finish(await activeGame(a, b, { squareM: 3 }), '1-0');
    await finish(await activeGame(a, b, { moves: 0 }), '0-1');
    const [x] = (await readBoth(a)).headToHead.opponents;
    const [y] = (await readBoth(b)).headToHead.opponents;
    expect(x).toMatchObject({ games: 0, togetherM: 0, practiceGames: 1, unplayedGames: 1 });
    expect(y).toMatchObject({ games: 0, togetherM: 0, practiceGames: 1, unplayedGames: 1 });
  });
});

describe('rows from before head-to-head', () => {
  it('counts them apart and never guesses an opponent', async () => {
    const sub = nextSub();
    const user = env.USER.getByName(sub) as DurableObjectStub<UserDO>;
    // A line exactly as the code before 0054 wrote it: no pair, no opponent.
    expect(
      await user.recordResult(sub, {
        joinCode: 'BEF234',
        color: 'b',
        outcome: '0-1',
        reason: 'checkmate',
        finishedAt: Date.now() - 86_400_000,
        plies: 20,
        moves: 10,
        travelM: 300,
        longestCarryM: 30,
        fieldName: 'Before',
        fieldKey: 'bbbbbbbbbbbbbbbb',
        squareM: 8,
        boardM: 64,
        diagonalM: 90.5,
      }),
    ).toBe(true);
    const both = await readBoth(sub);
    expect(both.headToHead).toEqual({ opponents: [], earlierGames: 1 });
    // Still in the record itself, exactly as before.
    expect(both.record.totals).toMatchObject({ games: 1, wins: 1, travelM: 300 });
    const response = await opponent(sub, 'game=BEF234');
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe('earlier');
  });

  it('upgrades an account whose record table predates schema 4', async () => {
    const sub = nextSub();
    const stub = env.USER.getByName(sub) as DurableObjectStub<UserDO>;
    await stub.touch(sub);
    const columns = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      // Back to schema 3's table, with a row in it.
      sql.exec(`DROP TABLE record`);
      sql.exec(`CREATE TABLE record (
         join_code TEXT PRIMARY KEY, color TEXT NOT NULL, outcome TEXT NOT NULL,
         reason TEXT NOT NULL, finished_at INTEGER NOT NULL, plies INTEGER NOT NULL,
         moves INTEGER NOT NULL, travel_m REAL, longest_carry_m REAL NOT NULL,
         field_name TEXT, field_key TEXT, square_m REAL NOT NULL, board_m REAL NOT NULL,
         diagonal_m REAL NOT NULL, recorded_at INTEGER NOT NULL)`);
      sql.exec(
        `INSERT INTO record (join_code, color, outcome, reason, finished_at, plies, moves, travel_m,
                             longest_carry_m, field_name, field_key, square_m, board_m, diagonal_m, recorded_at)
         VALUES ('OLD002', 'w', '1-0', 'checkmate', 1, 20, 10, 250, 20, 'Old', NULL, 8, 64, 90.5, 1)`,
      );
      applyUserSchema(sql);
      return [...sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('record')`)].map((r) => r.name);
    });
    expect(columns).toContain('pair_id');
    expect(columns).toContain('opponent_travel_m');
    const { headToHead, record } = await stub.recordWithOpponents();
    expect(headToHead.earlierGames).toBe(1);
    expect(record.totals.travelM).toBe(250);
  });

  it('fills in the opponent of a finished game still on the server when its line is sent again', async () => {
    const a = nextSub();
    const b = nextSub();
    const game = await activeGame(a, b);
    await finish(game, '1-0');
    // Make it look as it would have before 0054: no pair id in the game, and
    // lines in both accounts without one.
    await runInDurableObject(game.stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`DELETE FROM meta WHERE key = 'pair_id'`);
      // The digests the accounts accepted then: lines without the two new keys.
      for (const row of [...sql.exec<{ key: string; value: string }>(`SELECT key, value FROM meta WHERE key IN ('record_w', 'record_b')`)]) {
        const line = JSON.parse(row.value) as Record<string, unknown>;
        delete line.pairId;
        delete line.opponentTravelM;
        sql.exec(`UPDATE meta SET value = ? WHERE key = ?`, JSON.stringify(line), row.key);
      }
    });
    for (const sub of [a, b]) {
      const stub = env.USER.getByName(sub) as DurableObjectStub<UserDO>;
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(`UPDATE record SET pair_id = NULL, opponent_travel_m = NULL`);
      });
    }
    expect((await readBoth(a)).headToHead).toEqual({ opponents: [], earlierGames: 1 });
    // A re-join finds its lines differ from the ones accepted, and sends them again by itself.
    expect(await game.stub.join(b, b)).toMatchObject({ ok: true });
    const [x] = (await readBoth(a)).headToHead.opponents;
    const [y] = (await readBoth(b)).headToHead.opponents;
    expect(x.id).toBe(await pairIdFor(a, b));
    expect(x.togetherM).toBe(y.togetherM);
    expect((await readBoth(a)).headToHead.earlierGames).toBe(0);
  });
});

describe('nobody can ask about anybody else', () => {
  it('shows a third account nothing, by id, by game, or by naming', async () => {
    const a = nextSub();
    const b = nextSub();
    const c = nextSub();
    const games = await rivalry(a, b);
    const id = (await pairIdFor(a, b)) as string;

    expect((await readBoth(c)).headToHead).toEqual({ opponents: [], earlierGames: 0 });
    for (const query of [`id=${id}`, `game=${games[0].joinCode}`]) {
      const response = await opponent(c, query);
      expect(response.status).toBe(404);
      // The same answer as for an id that does not exist at all.
      expect(((await response.json()) as { error: string }).error).toBe('not_found');
    }
    const fake = await opponent(c, `id=${'0'.repeat(32)}`);
    expect(fake.status).toBe(404);
    expect(((await fake.json()) as { error: string }).error).toBe('not_found');
    expect((await rename(c, id, 'Snoop')).status).toBe(404);
    // Nothing in the query string can point the read at another account.
    const steered = await SELF.fetch(`${LOCAL}/api/record?sub=${encodeURIComponent(a)}`, {
      headers: { cookie: await cookieFor(c) },
    });
    expect(((await steered.json()) as { headToHead: HeadToHead }).headToHead.opponents).toEqual([]);
  });

  it('needs a session, and a well-formed question', async () => {
    expect((await SELF.fetch(`${LOCAL}/api/record/opponent?id=${'a'.repeat(32)}`)).status).toBe(401);
    const sub = nextSub();
    expect((await opponent(sub, 'id=nope')).status).toBe(400);
    expect((await opponent(sub, '')).status).toBe(400);
    const post = await SELF.fetch(`${LOCAL}/api/record/opponent`, {
      method: 'POST',
      headers: { cookie: await cookieFor(sub) },
    });
    expect(post.status).toBe(405);
  });

  it('never stores either account in a row', async () => {
    const a = nextSub();
    const b = nextSub();
    await rivalry(a, b);
    for (const sub of [a, b]) {
      for (const row of await rowsOf(sub)) {
        for (const value of Object.values(row)) {
          expect(String(value)).not.toContain(a);
          expect(String(value)).not.toContain(b);
        }
      }
    }
  });
});

describe('a name only you see', () => {
  it('names an opponent on one account and not the other', async () => {
    const a = nextSub();
    const b = nextSub();
    await rivalry(a, b);
    const id = (await pairIdFor(a, b)) as string;

    const response = await rename(a, id, '  Sam \u0007 from\n the  club  ');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: 'Sam from the club' });
    expect((await readBoth(a)).headToHead.opponents[0].name).toBe('Sam from the club');
    expect((await readBoth(b)).headToHead.opponents[0].name).toBeNull();
    const detail = (await (await opponent(a, `id=${id}`)).json()) as OpponentDetail;
    expect(detail.opponent.name).toBe('Sam from the club');

    // Too long is cut; blank clears.
    await rename(a, id, 'x'.repeat(100));
    expect((await readBoth(a)).headToHead.opponents[0].name).toBe('x'.repeat(40));
    expect(await (await rename(a, id, '   ')).json()).toEqual({ name: null });
    expect((await readBoth(a)).headToHead.opponents[0].name).toBeNull();
    await rename(a, id, 'Sam');
    expect(await (await rename(a, id, null)).json()).toEqual({ name: null });
    expect((await readBoth(a)).headToHead.opponents[0].name).toBeNull();
  });

  it('refuses a cross-site write and a malformed one', async () => {
    const a = nextSub();
    const b = nextSub();
    await rivalry(a, b);
    const id = (await pairIdFor(a, b)) as string;
    const cross = await SELF.fetch(`${LOCAL}/api/record/opponent/name`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie: await cookieFor(a) },
      body: JSON.stringify({ id, name: 'x' }),
    });
    expect(cross.status).toBe(403);
    expect((await rename(a, 'not-an-id', 'x')).status).toBe(400);
    const numeric = await SELF.fetch(`${LOCAL}/api/record/opponent/name`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await cookieFor(a) },
      body: JSON.stringify({ id, name: 7 }),
    });
    expect(numeric.status).toBe(400);
  });
});

describe('the pair id', () => {
  it('is the same from either seat, and different for every pair', async () => {
    const ab = await pairIdFor('alice', 'bob');
    expect(ab).toMatch(/^[0-9a-f]{32}$/);
    expect(await pairIdFor('bob', 'alice')).toBe(ab);
    expect(await pairIdFor('alice', 'carol')).not.toBe(ab);
    expect(await pairIdFor('bob', 'carol')).not.toBe(ab);
    expect(await pairIdFor('alice', 'alice')).toBeNull();
    expect(await pairIdFor('alice', null)).toBeNull();
    expect(await pairIdFor(null, 'bob')).toBeNull();
  });
});
