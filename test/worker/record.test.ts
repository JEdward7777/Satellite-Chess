import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeFieldSpec, snapshotField } from '../../src/shared/field.js';
import { fromLocal } from '../../src/shared/geo.js';
import type { RecordSummary } from '../../src/shared/record.js';
import type { GameDO } from '../../src/worker/game-do.js';
import { applySchema } from '../../src/worker/schema.js';
import type { UserDO } from '../../src/worker/user-do.js';

/**
 * The permanent record, end to end in `workerd` (stage 2.3.5, decision 0040).
 *
 * What needs the real runtime is the hand-over: a game ending in one Durable
 * Object and landing in two others, once each, however often it is reported —
 * and, when an account cannot be reached, landing later through the one alarm
 * rather than through anything held in memory.
 */

const SECRET = 'test-dev-auth-secret';
const LOCAL = 'http://127.0.0.1';
const A1 = { lat: 51.4779, lng: -0.0015 };
const mutableEnv = env as unknown as Record<string, unknown>;

function field(name: string, squareM: number) {
  return makeFieldSpec(name, {
    a1: A1,
    h8: fromLocal(A1, { e: 7 * squareM, n: 7 * squareM }),
  });
}

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
  return `record-tester-${counter}`;
}
function nextCode(): string {
  counter += 1;
  return `R${String(counter).padStart(5, '0')}`;
}

interface Game {
  joinCode: string;
  stub: DurableObjectStub<GameDO>;
  white: string;
  black: string;
}

/**
 * A game with two accounts seated and play under way — set by hand, as
 * `games.test.ts` does, because what is under test is what happens when it ends.
 */
async function activeGame(
  opts: { squareM?: number; name?: string; moves?: { color: 'w' | 'b'; carriedM: number }[] } = {},
): Promise<Game> {
  const joinCode = nextCode();
  const white = nextSub();
  const black = nextSub();
  const stub = env.GAME.getByName(joinCode) as DurableObjectStub<GameDO>;
  const snapshot = {
    ...snapshotField(field(opts.name ?? 'The common', opts.squareM ?? 8)),
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

  const moves = opts.moves ?? [
    { color: 'w', carriedM: 16 },
    { color: 'b', carriedM: 24 },
    { color: 'w', carriedM: 40 },
  ];
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`UPDATE game SET status = 'active' WHERE id = 1`);
    moves.forEach((move, index) => {
      sql.exec(
        `INSERT INTO moves (seq, color, uci, san, fen_after, from_sq, to_sq,
                            carried_m, carried_ms, server_ms, clock_ms_after)
         VALUES (?, ?, 'e2e4', 'e4', 'x', 'e2', 'e4', ?, 1000, ?, 600000)`,
        index + 1,
        move.color,
        move.carriedM,
        Date.now(),
      );
    });
    // `travel_leg` alongside the distance, because that pair is what says the
    // number was credited by difference from a phone's reports rather than
    // inherited from before the rule existed (decision 0040).
    sql.exec(`UPDATE presence SET travel_m = 420, travel_leg = 'w-page' WHERE color = 'w'`);
    sql.exec(`UPDATE presence SET travel_m = 380, travel_leg = 'b-page' WHERE color = 'b'`);
  });
  return { joinCode, stub, white, black };
}

/** Resign over a real socket — the ordinary way a game ends. */
async function resign(game: Game, who: string): Promise<void> {
  const res = await SELF.fetch(`${LOCAL}/api/game/${game.joinCode}/ws`, {
    headers: { upgrade: 'websocket', cookie: await cookieFor(who) },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  const finished = new Promise<void>((resolve) => {
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String((event as MessageEvent).data)) as {
        t: string;
        game?: { status?: string };
      };
      if (msg.t === 'state' && msg.game?.status === 'finished') resolve();
    });
  });
  ws.send(JSON.stringify({ t: 'resign' }));
  await finished;
  ws.close();
}

/** A raw, accepted socket for one seat — what a phone's relay arrives on. */
async function socketFor(game: Game, who: string): Promise<WebSocket> {
  const res = await SELF.fetch(`${LOCAL}/api/game/${game.joinCode}/ws`, {
    headers: { upgrade: 'websocket', cookie: await cookieFor(who) },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  return ws;
}

/** Where a square is, on the 8 m field `activeGame` uses. */
function squareAt(file: number, rank: number) {
  const offset = fromLocal(A1, { e: file * 8, n: rank * 8 });
  return { lat: offset.lat, lng: offset.lng };
}

function relay(ws: WebSocket, pos: { lat: number; lng: number }, travelM: number, leg: string): void {
  ws.send(JSON.stringify({ t: 'pos', ...pos, acc: 3, travelM, leg }));
}

/**
 * Move this game's stored instants into the past, so a relay is neither
 * dropped by the server's interval floor nor capped to nothing by the rate
 * ceiling — without the test sleeping through either.
 */
async function backdate(game: Game, ms: number): Promise<void> {
  await runInDurableObject(game.stub, (_instance, state) => {
    const now = Date.now();
    state.storage.sql.exec(`UPDATE presence SET last_pos_at = ?`, now - ms);
    state.storage.sql.exec(
      `UPDATE game SET last_clock_start_at = ? WHERE id = 1 AND last_clock_start_at IS NOT NULL`,
      now - ms,
    );
  });
}

async function travelOf(game: Game, color: 'w' | 'b'): Promise<number> {
  return runInDurableObject(
    game.stub,
    (_instance, state) =>
      [
        ...state.storage.sql.exec<{ travel_m: number }>(
          `SELECT travel_m FROM presence WHERE color = ?`,
          color,
        ),
      ][0].travel_m,
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

async function readRecord(sub: string): Promise<RecordSummary> {
  const response = await SELF.fetch(`${LOCAL}/api/record`, {
    headers: { cookie: await cookieFor(sub) },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { record: RecordSummary }).record;
}

beforeEach(() => {
  mutableEnv.DEV_AUTH_SECRET = SECRET;
});

describe('a finished game lands in both players’ records', () => {
  it('records the result, the distance and the field for each side', async () => {
    const game = await activeGame();
    await resign(game, game.black);

    const white = await readRecord(game.white);
    expect(white.totals).toMatchObject({
      games: 1,
      wins: 1,
      losses: 0,
      draws: 0,
      travelM: 420,
      moves: 2,
      longestCarryM: 40,
      fields: 1,
    });
    // 8 m squares: a 64 m board with a diagonal of 64√2.
    expect(white.totals.biggestBoard).toMatchObject({ fieldName: 'The common' });
    expect(white.totals.biggestBoard!.boardM).toBeCloseTo(64, 3);
    expect(white.totals.crossings).toBeCloseTo(420 / (64 * Math.SQRT2), 3);
    expect(white.recent).toHaveLength(1);
    expect(white.recent[0]).toMatchObject({
      joinCode: game.joinCode,
      result: 'win',
      reason: 'resignation',
      standing: 'counted',
    });
    // The lineage key the Worker stamped at creation, not a digest of the id.
    expect(white.fields[0].key).toBe('00112233445566ff');

    const black = await readRecord(game.black);
    expect(black.totals).toMatchObject({ games: 1, losses: 1, travelM: 380, moves: 1 });
    expect(black.totals.longestCarryM).toBe(24);
  });

  it('holds no coordinates', async () => {
    const game = await activeGame();
    await resign(game, game.white);
    const stub = env.USER.getByName(game.white) as DurableObjectStub<UserDO>;
    const columns = await runInDurableObject(stub, (_instance, state) =>
      [...state.storage.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('record')`)].map(
        (row) => row.name,
      ),
    );
    expect(columns.length).toBeGreaterThan(5);
    for (const column of columns) {
      expect(column).not.toMatch(/(^|_)(lat|lng|lon|pos|opponent)(_|$)/);
    }
  });

  it('keeps the record when the game is forgotten from the list', async () => {
    const game = await activeGame();
    await resign(game, game.black);
    const response = await SELF.fetch(`${LOCAL}/api/games/forget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await cookieFor(game.white) },
      body: JSON.stringify({ joinCodes: [game.joinCode] }),
    });
    expect(((await response.json()) as { forgotten: string[] }).forgotten).toEqual([game.joinCode]);
    expect((await readRecord(game.white)).totals.games).toBe(1);
  });
});

describe('counted once, however often it is reported', () => {
  it('does not double a game whose end is pushed again', async () => {
    const game = await activeGame();
    await resign(game, game.black);

    // Forget that the push landed, then re-take the seat — which re-pushes a
    // finished game's line. And push it once more straight into the account.
    await runInDurableObject(game.stub, (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM meta WHERE key LIKE 'record_%'`);
    });
    expect(await game.stub.join(game.white, game.white)).toMatchObject({ ok: true });

    const white = await readRecord(game.white);
    expect(white.totals.games).toBe(1);
    expect(white.totals.travelM).toBe(420);
  });

  it('writes the same line twice into one row', async () => {
    const sub = nextSub();
    const user = env.USER.getByName(sub) as DurableObjectStub<UserDO>;
    const line = {
      joinCode: 'DUPE01',
      color: 'w' as const,
      outcome: '1-0' as const,
      reason: 'checkmate' as const,
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
    };
    expect(await user.recordResult(sub, line)).toBe(true);
    expect(await user.recordResult(sub, line)).toBe(true);
    const record = await user.record();
    expect(record.totals).toMatchObject({ games: 1, travelM: 1000, wins: 1 });
  });

  it('does not credit walking done after the game ended', async () => {
    const game = await activeGame();
    await resign(game, game.black);
    const before = (await readRecord(game.white)).totals.travelM;

    // A relay from the same page after the result: the counter moves on, the
    // game does not.
    const res = await SELF.fetch(`${LOCAL}/api/game/${game.joinCode}/ws`, {
      headers: { upgrade: 'websocket', cookie: await cookieFor(game.white) },
    });
    const ws = res.webSocket as WebSocket;
    ws.accept();
    await runInDurableObject(game.stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE presence SET travel_leg = 'p', travel_seen_m = 10, last_pos_at = ? WHERE color = 'w'`,
        Date.now() - 60_000,
      );
    });
    ws.send(JSON.stringify({ t: 'pos', lat: A1.lat, lng: A1.lng, acc: 3, travelM: 500, leg: 'p' }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    ws.close();

    const travel = await runInDurableObject(game.stub, (_instance, state) =>
      [...state.storage.sql.exec<{ travel_m: number }>(`SELECT travel_m FROM presence WHERE color = 'w'`)][0]
        .travel_m,
    );
    expect(travel).toBe(420);
    expect((await readRecord(game.white)).totals.travelM).toBe(before);
  });
});

describe('an account that cannot be reached', () => {
  it('retries on the record timer, through the alarm, until it lands', async () => {
    const game = await activeGame();

    // Break the binding for this one object, and end the game.
    await runInDurableObject(game.stub, async (instance) => {
      const target = instance as unknown as { env: Env; finish(o: string, r: string, n: number): Promise<void> };
      const real = target.env;
      target.env = {
        ...real,
        USER: {
          getByName: () => ({
            recordGame: async () => true,
            recordResult: async () => {
              throw new Error('account unreachable');
            },
          }),
        },
      } as unknown as Env;
      await target.finish('1-0', 'resignation', Date.now());
      target.env = real;
    });

    const scheduled = await runInDurableObject(game.stub, (_instance, state) => ({
      timer: [...state.storage.sql.exec<{ kind: string }>(`SELECT kind FROM timers`)].map((r) => r.kind),
      attempts: [...state.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'record_attempts'`)][0]
        ?.value,
    }));
    expect(scheduled.timer).toEqual(['record']);
    expect(scheduled.attempts).toBe('1');
    expect((await readRecord(game.white)).totals.games).toBe(0);

    // Thirty seconds on, the alarm fires with the binding restored, and the
    // line lands. The deadline is brought forward rather than waited for.
    await runInDurableObject(game.stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE timers SET due_at = ? WHERE kind = 'record'`, Date.now() - 1);
    });
    expect(await runDurableObjectAlarm(game.stub)).toBe(true);
    expect((await readRecord(game.white)).totals).toMatchObject({ games: 1, wins: 1 });
    expect((await readRecord(game.black)).totals).toMatchObject({ games: 1, losses: 1 });

    const after = await runInDurableObject(game.stub, (_instance, state) => ({
      timers: [...state.storage.sql.exec(`SELECT kind FROM timers`)].length,
      attempts: [...state.storage.sql.exec(`SELECT value FROM meta WHERE key = 'record_attempts'`)].length,
    }));
    expect(after).toEqual({ timers: 0, attempts: 0 });
  });
});

describe('what counts toward the totals', () => {
  it('keeps a game on sub-4 m squares as practice, out of every total', async () => {
    const game = await activeGame({ squareM: 3, name: 'Back garden' });
    await resign(game, game.black);
    const record = await readRecord(game.white);
    expect(record.totals).toMatchObject({ games: 0, travelM: 0, wins: 0, fields: 0 });
    expect(record.practiceGames).toBe(1);
    expect(record.recent[0]).toMatchObject({ standing: 'practice', fieldName: 'Back garden' });
  });

  it('does not count a game that ended before anyone moved', async () => {
    const game = await activeGame({ moves: [] });
    await resign(game, game.white);
    const record = await readRecord(game.black);
    expect(record.totals.games).toBe(0);
    expect(record.unplayedGames).toBe(1);
    expect(record.recent[0]).toMatchObject({ standing: 'unplayed', result: 'win' });
  });
});

describe('GET /api/record', () => {
  it('needs a session', async () => {
    const response = await SELF.fetch(`${LOCAL}/api/record`);
    expect(response.status).toBe(401);
  });

  it('is read-only: nothing a phone sends can write a record', async () => {
    const response = await SELF.fetch(`${LOCAL}/api/record`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await cookieFor(nextSub()) },
      body: JSON.stringify({ travelM: 1e9 }),
    });
    expect(response.status).toBe(405);
  });

  it('answers an account with no games with an empty record', async () => {
    const record = await readRecord(nextSub());
    expect(record.totals.games).toBe(0);
    expect(record.recent).toEqual([]);
  });
});

describe('the lineage key a game is filed under', () => {
  async function created(spec: unknown): Promise<string | undefined> {
    const response = await SELF.fetch(`${LOCAL}/api/game`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await cookieFor(nextSub()) },
      body: JSON.stringify({ field: spec, color: 'w' }),
    });
    expect(response.status).toBe(201);
    const { joinCode } = (await response.json()) as { joinCode: string };
    const peek = (await (await SELF.fetch(`${LOCAL}/api/game/${joinCode}`)).json()) as {
      field: { lineageKey?: string };
    };
    return peek.field.lineageKey;
  }

  it('is stamped from the field’s own lineage, so copies of one common are one field', async () => {
    const copy = { ...field('A copy', 8), origin: { key: 'abcdefabcdef0123', version: 1, via: 'link' } };
    expect(await created(copy)).toBe('abcdefabcdef0123');
  });

  it('refuses to park anything that is not a lineage key inside the snapshot', async () => {
    const odd = { ...field('Odd', 8), origin: { key: 'x'.repeat(5000), version: 1, via: 'link' } };
    expect(await created(odd)).toBeUndefined();
  });
});

describe('a game that predates the distance columns', () => {
  /** Strip the schema-4 columns, then wake the object and read the row back. */
  async function throughTheUpgrade(game: Game) {
    const before = await runInDurableObject(game.stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`UPDATE presence SET travel_m = 137 WHERE color = 'w'`);
      sql.exec(`ALTER TABLE presence DROP COLUMN travel_leg`);
      sql.exec(`ALTER TABLE presence DROP COLUMN travel_seen_m`);
      return [...sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('presence')`)].map(
        (row) => row.name,
      );
    });
    expect(before).not.toContain('travel_leg');
    return runInDurableObject(game.stub, (_instance, state) => {
      applySchema(state.storage.sql);
      return [
        ...state.storage.sql.exec<{ travel_m: number; travel_seen_m: number; travel_leg: string | null }>(
          `SELECT travel_m, travel_seen_m, travel_leg FROM presence WHERE color = 'w'`,
        ),
      ][0];
    });
  }

  it('starts a game still in play again from zero, rather than banking a wrong number', async () => {
    // What it held was the phone's whole counter — the walk to the park
    // included — and this game's end would write that into a permanent row.
    expect(await throughTheUpgrade(await activeGame())).toEqual({
      travel_m: 0,
      travel_seen_m: 0,
      travel_leg: null,
    });
  });

  it('leaves a finished game alone, because its line has already been pushed', async () => {
    const game = await activeGame();
    await resign(game, game.black);
    expect(await throughTheUpgrade(game)).toEqual({
      travel_m: 137,
      travel_seen_m: 0,
      travel_leg: null,
    });
  });
});

describe('a game played before distance was measured per game', () => {
  /**
   * The case the owner's phone is actually in: games finished on the deployed
   * app on 2026-09-20 hold a `travel_m` credited under the old rule — the
   * page's whole counter — and have never pushed a record line, because the
   * record ships with this deploy. Their distance is not zero and not theirs;
   * it is unmeasured.
   */
  it('records the result as unmeasured rather than inventing a distance', async () => {
    const game = await activeGame();
    await runInDurableObject(game.stub, (_instance, state) => {
      // What an old row looks like: credited, but never reported by leg.
      state.storage.sql.exec(`UPDATE presence SET travel_m = 5200, travel_leg = NULL`);
      state.storage.sql.exec(`DELETE FROM meta WHERE key LIKE 'record_%'`);
    });
    await resign(game, game.black);

    const white = await readRecord(game.white);
    expect(white.totals).toMatchObject({ games: 0, travelM: 0, wins: 0, fields: 0 });
    expect(white.unmeasuredGames).toBe(1);
    expect(white.recent[0]).toMatchObject({ standing: 'unmeasured', travelM: null, result: 'win' });
  });

  it('records a game zeroed in flight, and never reported since, as measured', async () => {
    // The other half of the upgrade: a game in play had its inherited figure
    // dropped, and then ended without another relay. It is measured — not
    // unmeasured — and what this app knows of the walk is the carries it
    // measured itself, which floor the figure (decision 0041): white carried
    // 16 m and 40 m.
    const game = await activeGame();
    await runInDurableObject(game.stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE presence SET travel_m = 0, travel_leg = NULL`);
    });
    await resign(game, game.black);

    const white = await readRecord(game.white);
    expect(white.unmeasuredGames).toBe(0);
    expect(white.totals).toMatchObject({ games: 1, travelM: 56, wins: 1 });
    expect(white.recent[0]).toMatchObject({ standing: 'counted', travelM: 56 });
  });
});

describe('a finished game’s distance is frozen at the result (decision 0041)', () => {
  /**
   * Re-opening a finished game's board still relays. Before this rule a relay
   * stored its leg even while paying nothing, which turned an unmeasured game
   * — the owner's two real games of 2026-09-20 — into a "measured" one worth
   * the phone's whole page counter, and the next re-join re-pushed that into
   * the permanent record.
   */
  async function afterSync(ws: WebSocket): Promise<void> {
    const answered = new Promise<void>((resolve) => {
      const onMessage = (event: Event) => {
        const data = JSON.parse(String((event as MessageEvent).data)) as { t: string };
        if (data.t === 'state') {
          ws.removeEventListener('message', onMessage);
          resolve();
        }
      };
      ws.addEventListener('message', onMessage);
    });
    ws.send(JSON.stringify({ t: 'sync' }));
    await answered;
  }

  async function presenceOf(game: Game, color: 'w' | 'b') {
    return runInDurableObject(game.stub, (_instance, state) =>
      [
        ...state.storage.sql.exec<{ travel_m: number; travel_leg: string | null; travel_seen_m: number }>(
          `SELECT travel_m, travel_leg, travel_seen_m FROM presence WHERE color = ?`,
          color,
        ),
      ][0]!,
    );
  }

  async function reviewTravel(game: Game, who: string) {
    const response = await SELF.fetch(`${LOCAL}/api/game/${game.joinCode}/review`, {
      headers: { cookie: await cookieFor(who) },
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { report: { travelM: { w: number | null } } }).report.travelM;
  }

  /** An unmeasured game, over: credited under the old rule, never by leg. */
  async function unmeasuredAndOver(): Promise<Game> {
    const game = await activeGame();
    await runInDurableObject(game.stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE presence SET travel_m = 5200, travel_leg = NULL, travel_seen_m = 0 WHERE color = 'w'`,
      );
    });
    await resign(game, game.black);
    return game;
  }

  for (const [what, leg] of [
    ['a relay from a new page', 'new-page'],
    ['a relay with no leg at all, as the deployed build sends', undefined],
  ] as const) {
    it(`keeps an unmeasured game unmeasured after ${what}, through a re-join`, async () => {
      const game = await unmeasuredAndOver();
      const before = await presenceOf(game, 'w');
      const ws = await socketFor(game, game.white);
      await backdate(game, 60_000);
      ws.send(JSON.stringify({ t: 'pos', ...squareAt(4, 1), acc: 3, travelM: 12, ...(leg ? { leg } : {}) }));
      await afterSync(ws);
      ws.close();
      expect(await presenceOf(game, 'w')).toEqual(before);

      // Re-joining a finished game re-pushes its line (`pushRecord({ fresh })`).
      expect(await game.stub.join(game.white, game.white)).toMatchObject({ ok: true });
      expect((await reviewTravel(game, game.white)).w).toBeNull();
      let white = await readRecord(game.white);
      for (let i = 0; i < 20 && white.recent.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        white = await readRecord(game.white);
      }
      expect(white.recent[0]).toMatchObject({ standing: 'unmeasured', travelM: null });
      expect(white.unmeasuredGames).toBe(1);
      expect(white.totals.travelM).toBe(0);
    });
  }

  it('ignores the counter on a lift or place sent after the result', async () => {
    const game = await unmeasuredAndOver();
    const before = await presenceOf(game, 'w');
    const ws = await socketFor(game, game.white);
    await backdate(game, 60_000);
    const fix = { ...squareAt(4, 1), acc: 3, ts: 0 };
    ws.send(JSON.stringify({ t: 'lift', from: 'e2', pos: fix, travelM: 30, leg: 'new-page' }));
    ws.send(JSON.stringify({ t: 'place', to: 'e4', pos: fix, travelM: 60, leg: 'new-page' }));
    await afterSync(ws);
    ws.close();
    expect(await presenceOf(game, 'w')).toEqual(before);
    expect((await reviewTravel(game, game.white)).w).toBeNull();
  });

  it('keeps a measured game’s figure exactly as it ended', async () => {
    const game = await activeGame();
    await resign(game, game.black);
    const before = await presenceOf(game, 'w');
    const ws = await socketFor(game, game.white);
    for (const [travelM, leg] of [
      [5_000, 'w-page'],
      [9_000, 'another-page'],
    ] as const) {
      await backdate(game, 60_000);
      relay(ws, squareAt(4, 1), travelM, leg);
      await afterSync(ws);
    }
    ws.close();
    expect(await presenceOf(game, 'w')).toEqual(before);
    expect((await reviewTravel(game, game.white)).w).toBe(420);
    expect(await game.stub.join(game.white, game.white)).toMatchObject({ ok: true });
    expect((await readRecord(game.white)).recent[0]).toMatchObject({ travelM: 420 });
  });
});

describe('the walk before play starts', () => {
  /**
   * A game taken through the real handshake, so the transition into `active`
   * is the object's own rather than an `UPDATE` in a test.
   */
  async function staged() {
    const joinCode = nextCode();
    const white = nextSub();
    const black = nextSub();
    const stub = env.GAME.getByName(joinCode) as DurableObjectStub<GameDO>;
    await stub.create({
      joinCode,
      creatorPlayerId: white,
      creatorAccount: white,
      creatorColor: 'w',
      field: snapshotField(field('The common', 8)),
      initialMs: 600_000,
      incrementMs: 0,
    });
    await stub.join(black, black);
    const game: Game = { joinCode, stub, white, black };
    const sockets = {
      w: await socketFor(game, white),
      b: await socketFor(game, black),
    };
    await settle();
    return { game, sockets };
  }

  it('credits none of the walk to the back rank, only what came after the start', async () => {
    const { game, sockets } = await staged();

    // Both phones arrive on their own back ranks, having walked a long way to
    // get there. The second arrival starts the clock.
    relay(sockets.w, squareAt(4, 0), 500, 'w-page');
    await settle();
    await backdate(game, 4_000);
    relay(sockets.b, squareAt(4, 7), 400, 'b-page');
    await settle();
    expect(await game.stub.peek()).toMatchObject({ status: 'active' });
    expect(await travelOf(game, 'w')).toBe(0);

    // The first report after the start is a baseline: the same counter, and
    // 30 m further on, but those 30 m were walked before play began.
    await backdate(game, 4_000);
    relay(sockets.w, squareAt(4, 1), 530, 'w-page');
    await settle();
    expect(await travelOf(game, 'w')).toBe(0);

    // From here it counts.
    await backdate(game, 4_000);
    relay(sockets.w, squareAt(4, 2), 545, 'w-page');
    await settle();
    expect(await travelOf(game, 'w')).toBeCloseTo(15, 6);

    sockets.w.close();
    sockets.b.close();
    const white = await readRecord(game.white);
    expect(white.recent).toHaveLength(0); // Still in play: nothing recorded yet.
  });

  it('credits none of the walk back from a pause either', async () => {
    const { game, sockets } = await staged();
    relay(sockets.w, squareAt(4, 0), 100, 'w-page');
    await settle();
    await backdate(game, 4_000);
    relay(sockets.b, squareAt(4, 7), 100, 'b-page');
    await settle();
    expect(await game.stub.peek()).toMatchObject({ status: 'active' });

    // The start re-baselined the counter, so the first report after it counts
    // for nothing and the second is where play's ten meters come from.
    await backdate(game, 4_000);
    relay(sockets.w, squareAt(4, 1), 110, 'w-page');
    await settle();
    expect(await travelOf(game, 'w')).toBe(0);
    await backdate(game, 4_000);
    relay(sockets.w, squareAt(4, 1), 120, 'w-page');
    await settle();
    expect(await travelOf(game, 'w')).toBeCloseTo(10, 6);

    // Then a pause, and a kilometer of walking about.
    sockets.w.send(JSON.stringify({ t: 'pause' }));
    await settle();
    expect(await game.stub.peek()).toMatchObject({ status: 'suspended' });
    await backdate(game, 4_000);
    relay(sockets.w, squareAt(4, 0), 1_120, 'w-page');
    await settle();
    expect(await travelOf(game, 'w')).toBeCloseTo(10, 6);

    // Both walk back to their ranks; the resume re-baselines both counters.
    await backdate(game, 4_000);
    relay(sockets.b, squareAt(4, 7), 1_000, 'b-page');
    await settle();
    expect(await game.stub.peek()).toMatchObject({ status: 'active' });
    await backdate(game, 4_000);
    relay(sockets.w, squareAt(4, 1), 1_140, 'w-page');
    await settle();
    expect(await travelOf(game, 'w')).toBeCloseTo(10, 6);
    await backdate(game, 4_000);
    relay(sockets.w, squareAt(4, 2), 1_160, 'w-page');
    await settle();
    // 20 m since the resume baselined it, and not one of the thousand walked
    // while the game was paused.
    expect(await travelOf(game, 'w')).toBeCloseTo(30, 6);

    sockets.w.close();
    sockets.b.close();
  });

  it('marks a leg that reported, and leaves a never-reported one null', async () => {
    const { game, sockets } = await staged();
    // White never relays: it taps Ready instead, which is the other way into
    // the start zone and touches no distance column at all.
    sockets.w.send(JSON.stringify({ t: 'ready', pos: { ...squareAt(4, 0), acc: 3, ts: 0 } }));
    await settle();
    await backdate(game, 4_000);
    relay(sockets.b, squareAt(4, 7), 50, 'b-page');
    await settle();
    expect(await game.stub.peek()).toMatchObject({ status: 'active' });

    const legs = await runInDurableObject(game.stub, (_instance, state) =>
      Object.fromEntries(
        [
          ...state.storage.sql.exec<{ color: string; travel_leg: string | null }>(
            `SELECT color, travel_leg FROM presence`,
          ),
        ].map((row) => [row.color, row.travel_leg]),
      ),
    );
    // Marked, not cleared — and NULL stays NULL, which is what `recordLine`
    // reads as unmeasured. Clearing instead of marking would make a phone that
    // never reported look like one that reported nothing.
    expect(legs.b).toMatch(/^b-page@\d+$/);
    expect(legs.w).toBeNull();
    sockets.w.close();
    sockets.b.close();
  });

  it('cannot grow the mark without bound over repeated pauses', async () => {
    const { game, sockets } = await staged();
    relay(sockets.w, squareAt(4, 0), 10, 'w-page');
    await settle();
    await backdate(game, 4_000);
    relay(sockets.b, squareAt(4, 7), 10, 'b-page');
    await settle();

    // Pause and resume with no relay in between: `onPause` leaves both players
    // in their start zones, so the cycle is as fast as the buttons can be
    // tapped, and each resume appends a mark.
    for (let i = 0; i < 6; i += 1) {
      sockets.w.send(JSON.stringify({ t: 'pause' }));
      await settle();
      sockets.w.send(JSON.stringify({ t: 'ready', pos: { ...squareAt(4, 0), acc: 3, ts: 0 } }));
      sockets.b.send(JSON.stringify({ t: 'ready', pos: { ...squareAt(4, 7), acc: 3, ts: 0 } }));
      await settle();
    }
    const longest = await runInDurableObject(game.stub, (_instance, state) =>
      Math.max(
        ...[
          ...state.storage.sql.exec<{ travel_leg: string | null }>(
            `SELECT travel_leg FROM presence`,
          ),
        ].map((row) => row.travel_leg?.length ?? 0),
      ),
    );
    expect(longest).toBeLessThanOrEqual(64 + 1 + 20);
    sockets.w.close();
    sockets.b.close();
  });
});

describe('a phone that says nothing for a while', () => {
  it('cannot bank a ceiling and spend it in one message', async () => {
    const game = await activeGame();
    const res = await SELF.fetch(`${LOCAL}/api/game/${game.joinCode}/ws`, {
      headers: { upgrade: 'websocket', cookie: await cookieFor(game.white) },
    });
    const ws = res.webSocket as WebSocket;
    ws.accept();
    // An hour since white last said anything, but the clock started two seconds
    // ago — the window a credit may be paid against.
    const startedAt = Date.now() - 2_000;
    await runInDurableObject(game.stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE game SET last_clock_start_at = ? WHERE id = 1`, startedAt);
      state.storage.sql.exec(
        `UPDATE presence SET travel_m = 0, travel_leg = 'p', travel_seen_m = 0, last_pos_at = ?
          WHERE color = 'w'`,
        Date.now() - 3_600_000,
      );
    });
    ws.send(JSON.stringify({ t: 'pos', lat: A1.lat, lng: A1.lng, acc: 3, travelM: 40_000, leg: 'p' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    ws.close();

    const travel = await runInDurableObject(game.stub, (_instance, state) =>
      [...state.storage.sql.exec<{ travel_m: number }>(`SELECT travel_m FROM presence WHERE color = 'w'`)][0]
        .travel_m,
    );
    // A sprint for the few seconds since the clock started, not for the hour.
    expect(travel).toBeGreaterThan(0);
    expect(travel).toBeLessThan(12 * 5);
  });
});

describe('the walk a move ends (decision 0041)', () => {
  /**
   * `pos` relays go out every few seconds and only on movement, so the walk
   * that ends in a lift or a place is often not relayed before it — and for
   * the move that ends the game, never. Lift and place carry the counter too,
   * through the same rule over the same stored state.
   */
  type Travel = {
    travel_m: number;
    travel_leg: string | null;
    travel_seen_m: number;
    last_pos_at: number | null;
  };

  async function travelRow(game: Game, color: 'w' | 'b'): Promise<Travel> {
    return runInDurableObject(game.stub, (_instance, state) =>
      [
        ...state.storage.sql.exec<Travel>(
          `SELECT travel_m, travel_leg, travel_seen_m, last_pos_at FROM presence WHERE color = ?`,
          color,
        ),
      ][0]!,
    );
  }

  /** Put a known counter in place, with a window of `agoMs` since the last report. */
  async function counter(game: Game, color: 'w' | 'b', leg: string, seenM: number, agoMs: number) {
    await runInDurableObject(game.stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE presence SET travel_m = 10, travel_leg = ?, travel_seen_m = ?, last_pos_at = ?
          WHERE color = ?`,
        leg,
        seenM,
        Date.now() - agoMs,
        color,
      );
    });
  }

  /** Send, then wait for the server's answer to a `sync` behind it. */
  async function sendAndSettle(ws: WebSocket, msg: object): Promise<void> {
    const answered = new Promise<void>((resolve) => {
      const onMessage = (event: Event) => {
        const data = JSON.parse(String((event as MessageEvent).data)) as { t: string; sync?: boolean };
        if (data.t === 'state') {
          ws.removeEventListener('message', onMessage);
          resolve();
        }
      };
      ws.addEventListener('message', onMessage);
    });
    ws.send(JSON.stringify(msg));
    ws.send(JSON.stringify({ t: 'sync' }));
    await answered;
  }

  const fix = (file: number, rank: number) => ({ ...squareAt(file, rank), acc: 3, ts: 0 });

  it('credits a lift and a place once each, and a stale relay after them nothing', async () => {
    const game = await activeGame();
    await counter(game, 'w', 'L', 100, 60_000);
    const ws = await socketFor(game, game.white);

    await sendAndSettle(ws, { t: 'lift', from: 'e2', pos: fix(4, 1), travelM: 130, leg: 'L' });
    expect(await travelRow(game, 'w')).toMatchObject({ travel_m: 40, travel_leg: 'L', travel_seen_m: 130 });

    await backdate(game, 30_000);
    await sendAndSettle(ws, { t: 'place', to: 'e4', pos: fix(4, 3), travelM: 150, leg: 'L' });
    expect(await travelRow(game, 'w')).toMatchObject({ travel_m: 60, travel_seen_m: 150 });

    // A relay that was already on its way, with the same total or an older one,
    // adds nothing and takes nothing away.
    await backdate(game, 30_000);
    relay(ws, squareAt(4, 3), 150, 'L');
    await sendAndSettle(ws, { t: 'sync' });
    await backdate(game, 30_000);
    relay(ws, squareAt(4, 3), 140, 'L');
    await sendAndSettle(ws, { t: 'sync' });
    expect(await travelRow(game, 'w')).toMatchObject({ travel_m: 60, travel_seen_m: 150 });
    ws.close();
  });

  it('credits a refused place, and a burst of them earns only the window they share', async () => {
    const game = await activeGame();
    await counter(game, 'b', 'B', 100, 20_000);
    const ws = await socketFor(game, game.black);
    // Not black's turn and nothing in hand: refused, but the walk was real.
    await sendAndSettle(ws, { t: 'place', to: 'e5', pos: fix(4, 4), travelM: 130, leg: 'B' });
    const after = await travelRow(game, 'b');
    expect(after).toMatchObject({ travel_m: 40, travel_seen_m: 130 });
    expect(after.last_pos_at).toBeGreaterThan(Date.now() - 5_000);

    // At once, claiming a kilometre: the window since the last one is a few
    // milliseconds, so the claim is spent without being paid.
    await sendAndSettle(ws, { t: 'place', to: 'e5', pos: fix(4, 4), travelM: 1130, leg: 'B' });
    const burst = await travelRow(game, 'b');
    expect(burst.travel_m - 40).toBeLessThan(12);
    expect(burst.travel_seen_m).toBe(1130);
    ws.close();
  });

  it('re-baselines a reload between the lift and the place, as a relay would', async () => {
    const game = await activeGame();
    await counter(game, 'w', 'A', 90, 60_000);
    const ws = await socketFor(game, game.white);
    await sendAndSettle(ws, { t: 'lift', from: 'e2', pos: fix(4, 1), travelM: 100, leg: 'A' });
    await backdate(game, 30_000);
    await sendAndSettle(ws, { t: 'place', to: 'e4', pos: fix(4, 3), travelM: 5, leg: 'B' });
    expect(await travelRow(game, 'w')).toMatchObject({ travel_m: 20, travel_leg: 'B', travel_seen_m: 5 });
    ws.close();
  });

  it('ignores a lift or place from a build that sends no counter', async () => {
    const game = await activeGame();
    await counter(game, 'w', 'L', 100, 60_000);
    const before = await travelRow(game, 'w');
    const ws = await socketFor(game, game.white);
    await sendAndSettle(ws, { t: 'lift', from: 'e2', pos: fix(4, 1) });
    await sendAndSettle(ws, { t: 'drop' });
    await sendAndSettle(ws, { t: 'lift', from: 'e2', pos: fix(4, 1), travelM: 'lots', leg: 'L' });
    expect(await travelRow(game, 'w')).toEqual(before);
    ws.close();
  });

  it('puts the mating carry in the record line the game writes as it ends', async () => {
    const game = await activeGame();
    const ago = Date.now() - 60_000;
    // Fool's mate, one move from the end: black's queen already in hand at d8.
    await runInDurableObject(game.stub, (_instance, state) => {
      const sql = state.storage.sql;
      const d8 = squareAt(3, 7);
      sql.exec(
        `UPDATE game SET fen = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2',
                         active_color = 'b', last_clock_start_at = ? WHERE id = 1`,
        ago,
      );
      sql.exec(
        `INSERT OR REPLACE INTO carry (id, color, from_sq, piece, lift_lat, lift_lng, lift_acc, lift_at)
         VALUES (1, 'b', 'd8', 'q', ?, ?, 3, ?)`,
        d8.lat,
        d8.lng,
        ago,
      );
    });
    // The last relay went out at the lift; the whole carry is unreported.
    await counter(game, 'b', 'B', 100, 60_000);
    await runInDurableObject(game.stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE presence SET travel_m = 380 WHERE color = 'b'`);
    });

    const ws = await socketFor(game, game.black);
    const finished = new Promise<void>((resolve) => {
      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(String((event as MessageEvent).data)) as {
          t: string;
          game?: { status?: string };
        };
        if (msg.t === 'state' && msg.game?.status === 'finished') resolve();
      });
    });
    ws.send(JSON.stringify({ t: 'place', to: 'h4', pos: fix(7, 3), travelM: 145.5, leg: 'B' }));
    await finished;
    ws.close();

    // `detectTerminal` does not await the push, so the line lands a moment
    // after the result is broadcast. Polled rather than slept.
    let black = await readRecord(game.black);
    for (let i = 0; i < 40 && black.recent.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      black = await readRecord(game.black);
    }
    expect(black.recent[0]).toMatchObject({ result: 'win', reason: 'checkmate' });
    expect(black.totals.travelM).toBeCloseTo(380 + 45.5, 6);
  });
});

describe('the walked figure is floored by the carries (decision 0041)', () => {
  /**
   * Found in review on exactly this game: 1. e4, Black never moves, White wins
   * on time. White's phone had not confirmed a hop, so the review read "You
   * covered 0 m" above "1. e4 carried 16 m". The carry is a straight line
   * between two fixes and so a lower bound on the walk it is part of.
   */
  it('reads the one-move flag-fall game as at least its carry, everywhere', async () => {
    const game = await activeGame({ moves: [{ color: 'w', carriedM: 16 }] });
    await runInDurableObject(game.stub, async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`UPDATE presence SET travel_m = 0, travel_leg = 'w-page' WHERE color = 'w'`);
      sql.exec(`UPDATE presence SET travel_m = 0, travel_leg = 'b-page' WHERE color = 'b'`);
      // Black on move with five milliseconds left, and the deadline due now.
      sql.exec(
        `UPDATE game SET active_color = 'b', black_ms_remaining = 5, last_clock_start_at = ?
          WHERE id = 1`,
        Date.now() - 1_000,
      );
      sql.exec(`INSERT OR REPLACE INTO timers (kind, due_at) VALUES ('flag', ?)`, Date.now() - 1);
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });
    expect(await runDurableObjectAlarm(game.stub)).toBe(true);

    let white = await readRecord(game.white);
    for (let i = 0; i < 40 && white.recent.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      white = await readRecord(game.white);
    }
    expect(white.recent[0]).toMatchObject({ result: 'win', reason: 'timeout', travelM: 16 });
    expect(white.totals.longestCarryM).toBe(16);
    expect(white.totals.longestCarryM).toBeLessThanOrEqual(white.totals.travelM);

    const response = await SELF.fetch(`${LOCAL}/api/game/${game.joinCode}/review`, {
      headers: { cookie: await cookieFor(game.white) },
    });
    const { report } = (await response.json()) as { report: { travelM: { w: number; b: number } } };
    // White floored to the carry; Black, who never moved, is a measured zero.
    expect(report.travelM).toEqual({ w: 16, b: 0 });

    const pgn = await (
      await SELF.fetch(`${LOCAL}/api/game/${game.joinCode}/pgn`, {
        headers: { cookie: await cookieFor(game.white) },
      })
    ).text();
    expect(pgn).toContain('[SatelliteWhiteWalkedM "16"]');
  });

  it('takes the larger of the two, never their sum', async () => {
    // activeGame: white counted 420 m and carried 16 m + 40 m.
    const game = await activeGame();
    await resign(game, game.black);
    expect((await readRecord(game.white)).recent[0]).toMatchObject({ travelM: 420 });
  });
});
