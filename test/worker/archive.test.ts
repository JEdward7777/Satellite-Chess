import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeFieldSpec, snapshotField } from '../../src/shared/field.js';
import { fromLocal } from '../../src/shared/geo.js';
import type { GameReport } from '../../src/shared/review.js';
import { archiveKey } from '../../src/worker/archive.js';
import {
  ARCHIVE_SETTLE_MS,
  FINISHED_GAME_GRACE_MS,
  UNPLAYED_GAME_TTL_MS,
} from '../../src/worker/collection.js';
import type { GameDO } from '../../src/worker/game-do.js';

/**
 * A finished game leaves as an archive, and its object ceases to exist
 * (stages 8.4 and 3.6.2, decision 0042).
 *
 * What needs the real runtime is everything the decision turns on: that
 * `deleteAll` really leaves nothing, that nothing a stray request does can put
 * anything back, that the one alarm walks the steps in order, and that the
 * archive the review reads afterwards is the same file it served before — to
 * the same two people and nobody else.
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
  return `archive-tester-${counter}`;
}
function nextCode(): string {
  counter += 1;
  return `W${String(counter).padStart(5, '0')}`;
}

interface Game {
  joinCode: string;
  stub: DurableObjectStub<GameDO>;
  white: string;
  black: string;
  /** Once aged, always the same age, so a report read after it reads the same. */
  agedTo?: number;
}

function at(file: number, rank: number) {
  return fromLocal(A1, { e: file * 8, n: rank * 8 });
}

/** Two accounts seated and, unless asked otherwise, three moves stored with both fixes. */
async function seatedGame(opts: { moves?: boolean } = {}): Promise<Game> {
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
      field: snapshotField(field('The common', 8)),
      initialMs: 900_000,
      incrementMs: 10_000,
    }),
  ).toBe(true);
  expect(await stub.join(black, black)).toMatchObject({ ok: true, color: 'b' });
  if (opts.moves === false) return { joinCode, stub, white, black };

  const moves = [
    { color: 'w', san: 'e4', from: 'e2', to: 'e4', lift: [4.1, 1], place: [4, 3.2], carriedM: 16.4 },
    { color: 'b', san: 'e5', from: 'e7', to: 'e5', lift: [4, 6], place: [3.9, 4], carriedM: 16 },
    { color: 'w', san: 'Nf3', from: 'g1', to: 'f3', lift: [6, 0], place: [5, 2], carriedM: 18 },
  ];
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`UPDATE game SET status = 'active' WHERE id = 1`);
    moves.forEach((move, index) => {
      const lift = at(move.lift[0]!, move.lift[1]!);
      const place = at(move.place[0]!, move.place[1]!);
      sql.exec(
        `INSERT INTO moves (seq, color, uci, san, fen_after, from_sq, to_sq,
                            lift_lat, lift_lng, lift_acc, place_lat, place_lng, place_acc,
                            carried_m, carried_ms, server_ms, clock_ms_after)
         VALUES (?, ?, ?, ?, 'x', ?, ?, ?, ?, 5, ?, ?, 4, ?, 31000, ?, 600000)`,
        index + 1,
        move.color,
        `${move.from}${move.to}`,
        move.san,
        move.from,
        move.to,
        lift.lat,
        lift.lng,
        place.lat,
        place.lng,
        move.carriedM,
        Date.now(),
      );
    });
    sql.exec(`UPDATE presence SET travel_m = 420, travel_leg = 'w-page' WHERE color = 'w'`);
    sql.exec(`UPDATE presence SET travel_m = 380, travel_leg = 'b-page' WHERE color = 'b'`);
  });
  return { joinCode, stub, white, black };
}

async function openSocket(game: Game, who: string): Promise<WebSocket> {
  const res = await SELF.fetch(`${LOCAL}/api/game/${game.joinCode}/ws`, {
    headers: { upgrade: 'websocket', cookie: await cookieFor(who) },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  return ws;
}

/** Resign over a real socket, then close it and let the close land. */
async function resign(game: Game, who: string): Promise<void> {
  const ws = await openSocket(game, who);
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
  await settled(game, () => true);
}

/** Wait until the object has seen every socket close. */
async function settled(game: Game, extra: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const open = await runInDurableObject(game.stub, (_instance, state) =>
      state.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN).length,
    );
    if (open === 0 && extra()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('sockets never closed');
}

/** Everything this object is holding, as far as anybody could tell. */
async function remains(game: Game) {
  return runInDurableObject(game.stub, async (_instance, state) => ({
    tables: [
      ...state.storage.sql.exec<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`,
      ),
    ].map((row) => row.name),
    kv: (await state.storage.list()).size,
    alarm: await state.storage.getAlarm(),
  }));
}

const GONE = { tables: [], kv: 0, alarm: null };

/**
 * Make a finished game look a day and a bit old, so the real deadline has
 * passed — the handler re-derives it from these columns rather than trusting
 * the timer.
 */
async function age(game: Game, ms = FINISHED_GAME_GRACE_MS + 60_000): Promise<void> {
  game.agedTo ??= Date.now() - ms;
  const then = game.agedTo;
  await runInDurableObject(game.stub, (_instance, state) => {
    state.storage.sql.exec(`UPDATE game SET result_at = ?, updated_at = ?, created_at = ?`, then, then, then);
    state.storage.sql.exec(`DELETE FROM meta WHERE key = 'seen_at'`);
  });
}

/**
 * Fire the `gc` deadline now, through the real alarm handler. The alarm is left
 * in the future: set in the past, the runtime fires it by itself and
 * `runDurableObjectAlarm` then finds nothing to run.
 */
async function fireGc(game: Game): Promise<void> {
  await runInDurableObject(game.stub, async (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO timers (kind, due_at) VALUES ('gc', ?)
         ON CONFLICT (kind) DO UPDATE SET due_at = excluded.due_at`,
      Date.now() - 1,
    );
    await state.storage.setAlarm(Date.now() + 3_600_000);
  });
  expect(await runDurableObjectAlarm(game.stub)).toBe(true);
}

async function meta(game: Game, key: string): Promise<string | null> {
  return runInDurableObject(game.stub, (_instance, state) =>
    [...state.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)][0]
      ?.value ?? null,
  );
}

async function timers(game: Game): Promise<Record<string, number>> {
  return runInDurableObject(game.stub, (_instance, state) =>
    Object.fromEntries(
      [...state.storage.sql.exec<{ kind: string; due_at: number }>(`SELECT kind, due_at FROM timers`)].map(
        (row) => [row.kind, row.due_at],
      ),
    ),
  );
}

/** Walk a finished game through every step: archive, settle, delete. */
async function archiveAndDelete(game: Game): Promise<void> {
  await age(game);
  await fireGc(game);
  expect(await meta(game, 'archive_digest')).not.toBeNull();
  // The settle interval, spent.
  await runInDurableObject(game.stub, (_instance, state) => {
    state.storage.sql.exec(
      `UPDATE meta SET value = ? WHERE key = 'archived_at'`,
      String(Date.now() - ARCHIVE_SETTLE_MS - 1),
    );
  });
  await fireGc(game);
  expect(await remains(game)).toEqual(GONE);
}

async function fetchAs(sub: string | null, path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${LOCAL}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(sub === null ? {} : { cookie: await cookieFor(sub) }) },
  });
}

async function reviewOf(game: Game, sub: string) {
  const response = await fetchAs(sub, `/api/game/${game.joinCode}/review`);
  expect(response.status).toBe(200);
  return (await response.json()) as { you: string; report: GameReport };
}

async function pgnOf(game: Game, sub: string) {
  const response = await fetchAs(sub, `/api/game/${game.joinCode}/pgn`);
  expect(response.status).toBe(200);
  return { disposition: response.headers.get('content-disposition'), text: await response.text() };
}

beforeEach(() => {
  mutableEnv.DEV_AUTH_SECRET = SECRET;
});

describe('a finished game, a day later', () => {
  it('is archived as one value: the file and the report, in board space, naming nobody', async () => {
    const game = await seatedGame();
    await resign(game, game.black);
    await age(game);
    const before = { review: await reviewOf(game, game.white), pgn: await pgnOf(game, game.white) };

    await archiveAndDelete(game);

    const raw = (await env.ARCHIVE.get(archiveKey(game.joinCode), 'text')) as string;
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw) as { v: number; pgn: string; report: Record<string, unknown> };
    expect(stored.v).toBe(1);
    expect(stored.pgn).toBe(before.pgn.text);
    const { joinCode: _code, ...reportWithoutCode } = before.review.report;
    expect(stored.report).toEqual(reportWithoutCode);

    // Nothing that locates, names or opens anything.
    expect(raw).not.toMatch(/lat|lng|lon/i);
    expect(raw).not.toContain(String(A1.lat).slice(0, 5));
    expect(raw).not.toContain('-0.00');
    expect(raw).not.toContain(game.joinCode);
    expect(raw).not.toContain(game.white);
    expect(raw).not.toContain(game.black);
    expect(raw).not.toMatch(/account|player_?id|sub"/i);
  });

  it('then deletes its object entirely: no tables, no storage, no alarm', async () => {
    const game = await seatedGame();
    await resign(game, game.white);
    await archiveAndDelete(game);
    expect(await remains(game)).toEqual(GONE);
    expect(await game.stub.peek()).toEqual({ exists: false });
  });

  it('is kept for a day after the result, and a day after anybody re-opens it', async () => {
    const game = await seatedGame();
    await resign(game, game.white);
    const due = (await timers(game)).gc!;
    expect(due - Date.now()).toBeGreaterThan(FINISHED_GAME_GRACE_MS - 10_000);
    expect(due - Date.now()).toBeLessThanOrEqual(FINISHED_GAME_GRACE_MS);

    // Fired early — the timer is a hint, the columns are the rule.
    await fireGc(game);
    expect(await meta(game, 'archive_digest')).toBeNull();
    expect((await timers(game)).gc! - Date.now()).toBeGreaterThan(FINISHED_GAME_GRACE_MS - 10_000);

    // A day on, the owner re-opens it: another day from now.
    await age(game);
    expect((await fetchAs(game.white, `/api/game/${game.joinCode}`, { method: 'POST' })).status).toBe(200);
    expect((await timers(game)).gc! - Date.now()).toBeGreaterThan(FINISHED_GAME_GRACE_MS - 10_000);
    await fireGc(game);
    expect(await meta(game, 'archive_digest')).toBeNull();
  });

  it('is not pulled out from under a board somebody has open', async () => {
    const game = await seatedGame();
    await resign(game, game.white);
    const ws = await openSocket(game, game.black);
    await age(game);
    await fireGc(game);
    expect(await meta(game, 'archive_digest')).toBeNull();
    expect((await remains(game)).tables).toContain('game');
    ws.close();
  });

  it('waits for the permanent record before it deletes anything', async () => {
    const game = await seatedGame();
    // The account refuses record lines, from before the result until told
    // otherwise, on this one object.
    await runInDurableObject(game.stub, async (instance) => {
      const target = instance as unknown as {
        env: Env;
        realEnv?: Env;
        finish(o: string, r: string, n: number): Promise<void>;
      };
      target.realEnv = target.env;
      target.env = {
        ...target.env,
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
    });
    await age(game);
    await fireGc(game);

    // Nothing archived, nothing deleted, and it will look again tomorrow.
    expect(await env.ARCHIVE.get(archiveKey(game.joinCode))).toBeNull();
    expect((await remains(game)).tables).toContain('game');
    expect(await meta(game, 'delivery_deferrals')).toBe('1');
    const pending = await timers(game);
    expect(pending.gc! - Date.now()).toBeGreaterThan(FINISHED_GAME_GRACE_MS - 10_000);
    expect(pending.record).toBeTypeOf('number');

    // The account comes back. The next look delivers first, then archives.
    await runInDurableObject(game.stub, (instance) => {
      const target = instance as unknown as { env: Env; realEnv: Env };
      target.env = target.realEnv;
    });
    await fireGc(game);
    const record = (await (await fetchAs(game.white, '/api/record')).json()) as {
      record: { totals: { games: number } };
    };
    expect(record.record.totals.games).toBe(1);
    expect(await meta(game, 'archive_digest')).not.toBeNull();
    await runInDurableObject(game.stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE meta SET value = ? WHERE key = 'archived_at'`,
        String(Date.now() - ARCHIVE_SETTLE_MS - 1),
      );
    });
    await fireGc(game);
    expect(await remains(game)).toEqual(GONE);
  });

  it('waits out the settle interval between writing the archive and deleting', async () => {
    const game = await seatedGame();
    await resign(game, game.white);
    await age(game);
    await fireGc(game);
    expect(await meta(game, 'archive_digest')).not.toBeNull();
    // Fired again at once: the archive may not have reached everywhere yet.
    await fireGc(game);
    expect((await remains(game)).tables).toContain('game');
    expect((await timers(game)).gc! - Date.now()).toBeGreaterThan(ARCHIVE_SETTLE_MS - 10_000);
  });

  it('does not delete a game somebody re-opened while the read-back was in flight', async () => {
    const game = await seatedGame();
    await resign(game, game.white);
    await age(game);
    await fireGc(game);
    await runInDurableObject(game.stub, (instance, state) => {
      state.storage.sql.exec(
        `UPDATE meta SET value = ? WHERE key = 'archived_at'`,
        String(Date.now() - ARCHIVE_SETTLE_MS - 1),
      );
      // The read-back is the last await before the delete. A player re-takes
      // their seat during it — exactly what `join` writes.
      const target = instance as unknown as { env: Env; realEnv?: Env };
      const real = target.env;
      target.realEnv = real;
      target.env = {
        ...real,
        ARCHIVE: {
          get: async (...args: Parameters<KVNamespace['get']>) => {
            state.storage.sql.exec(
              `INSERT INTO meta (key, value) VALUES ('seen_at', ?)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
              String(Date.now()),
            );
            return (real.ARCHIVE.get as (...a: unknown[]) => unknown)(...args);
          },
        },
      } as unknown as Env;
    });
    await fireGc(game);
    await runInDurableObject(game.stub, (instance) => {
      const target = instance as unknown as { env: Env; realEnv: Env };
      target.env = target.realEnv;
    });
    expect((await remains(game)).tables).toContain('game');
    expect((await timers(game)).gc! - Date.now()).toBeGreaterThan(FINISHED_GAME_GRACE_MS - 10_000);
  });

  it('stops rewriting an archive whose read-back never agrees', async () => {
    const game = await seatedGame();
    await resign(game, game.white);
    await age(game);
    await runInDurableObject(game.stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('archive_attempts', '11')`,
      );
    });
    await fireGc(game); // written (the count is not reset by a write)
    await env.ARCHIVE.delete(archiveKey(game.joinCode));
    await runInDurableObject(game.stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE meta SET value = ? WHERE key = 'archived_at'`,
        String(Date.now() - ARCHIVE_SETTLE_MS - 1),
      );
    });
    await fireGc(game); // twelfth disagreement: give up, keep the game
    expect(await meta(game, 'archive_attempts')).toBe('12');
    expect(await timers(game)).not.toHaveProperty('gc');
    expect((await remains(game)).tables).toContain('game');
  });

  it('writes the archive again rather than deleting when the read-back disagrees', async () => {
    const game = await seatedGame();
    await resign(game, game.white);
    await age(game);
    await fireGc(game);
    await env.ARCHIVE.delete(archiveKey(game.joinCode));
    await runInDurableObject(game.stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE meta SET value = ? WHERE key = 'archived_at'`,
        String(Date.now() - ARCHIVE_SETTLE_MS - 1),
      );
    });
    await fireGc(game);
    expect((await remains(game)).tables).toContain('game');
    expect(await meta(game, 'archive_digest')).toBeNull();
  });
});

describe('after the object has gone', () => {
  it('serves the review and the file from the archive, byte for byte, to each seat', async () => {
    const game = await seatedGame();
    await resign(game, game.black);
    await age(game);
    const before = {
      white: await reviewOf(game, game.white),
      black: await reviewOf(game, game.black),
      pgn: await pgnOf(game, game.white),
    };
    await archiveAndDelete(game);

    expect(await reviewOf(game, game.white)).toEqual(before.white);
    expect(await reviewOf(game, game.black)).toEqual(before.black);
    const after = await pgnOf(game, game.black);
    expect(after.text).toBe(before.pgn.text);
    expect(after.disposition).toBe(before.pgn.disposition);
    expect(after.disposition).not.toContain(game.joinCode);
  });

  it('refuses everybody else exactly as a code that names nothing, and 401s the signed-out', async () => {
    const game = await seatedGame();
    await resign(game, game.black);
    await archiveAndDelete(game);
    const stranger = nextSub();
    for (const suffix of ['review', 'pgn']) {
      const refused = await fetchAs(stranger, `/api/game/${game.joinCode}/${suffix}`);
      const missing = await fetchAs(stranger, `/api/game/${nextCode()}/${suffix}`);
      expect(refused.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await refused.text()).toBe(await missing.text());
      expect((await fetchAs(null, `/api/game/${game.joinCode}/${suffix}`)).status).toBe(401);
    }
  });

  it('sends a player who re-opens it to the review, and a stranger to "no such game"', async () => {
    const game = await seatedGame();
    await resign(game, game.black);
    await archiveAndDelete(game);

    const mine = await fetchAs(game.black, `/api/game/${game.joinCode}`, { method: 'POST' });
    expect(mine.status).toBe(200);
    expect(await mine.json()).toEqual({ archived: true, color: 'b' });

    const theirs = await fetchAs(nextSub(), `/api/game/${game.joinCode}`, { method: 'POST' });
    expect(theirs.status).toBe(404);
  });

  it('stays gone, whatever is asked of it', async () => {
    const game = await seatedGame();
    await resign(game, game.black);
    await archiveAndDelete(game);

    // Every route there is, from a seat, a stranger and nobody.
    for (const who of [game.white, nextSub(), null]) {
      await fetchAs(who, `/api/game/${game.joinCode}`);
      await fetchAs(who, `/api/game/${game.joinCode}`, { method: 'POST' });
      await fetchAs(who, `/api/game/${game.joinCode}/review`);
      await fetchAs(who, `/api/game/${game.joinCode}/pgn`);
      const ws = await fetchAs(who, `/api/game/${game.joinCode}/ws`, { headers: { upgrade: 'websocket' } });
      expect(ws.status).not.toBe(101);
    }
    // And every method on the object itself.
    expect(await game.stub.join(game.white, game.white)).toEqual({ ok: false, reason: 'not_found' });
    expect(await game.stub.report(game.white)).toEqual({ ok: false, reason: 'not_found' });
    expect(await game.stub.clocks()).toEqual({ w: 0, b: 0, running: false });
    expect(await game.stub.hastenCollection(0)).toBe(false);
    // A new game may never be made on a code that was one.
    expect(
      await game.stub.create({
        joinCode: game.joinCode,
        creatorPlayerId: game.white,
        creatorAccount: game.white,
        creatorColor: 'w',
        field: snapshotField(field('Somewhere else', 8)),
        initialMs: 900_000,
        incrementMs: 0,
      }),
    ).toBe(false);

    expect(await remains(game)).toEqual(GONE);
  });

  it('keeps both players’ rows in "Your games", pointing at the archive', async () => {
    const game = await seatedGame();
    await resign(game, game.black);
    await archiveAndDelete(game);
    for (const sub of [game.white, game.black]) {
      const rows = await env.USER.getByName(sub).listGames();
      expect(rows.map((row) => [row.joinCode, row.status])).toEqual([[game.joinCode, 'finished']]);
    }
  });
});

describe('what a code shows to whom (O-34)', () => {
  async function peek(game: Game | string, who: string | null) {
    const code = typeof game === 'string' ? game : game.joinCode;
    const response = await fetchAs(who, `/api/game/${code}`);
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  it('shows the field to anybody while a seat is free — that is what an invitation is', async () => {
    const joinCode = nextCode();
    const stub = env.GAME.getByName(joinCode) as DurableObjectStub<GameDO>;
    await stub.create({
      joinCode,
      creatorPlayerId: 'creator',
      creatorAccount: 'creator',
      creatorColor: 'w',
      field: snapshotField(field('Open', 8)),
      initialMs: 900_000,
      incrementMs: 0,
    });
    expect(await peek(joinCode, null)).toMatchObject({ exists: true, status: 'waiting', field: { name: 'Open' } });
  });

  it('shows it only to the two players once both seats are taken, and after the result', async () => {
    const game = await seatedGame();
    for (const stage of ['playing', 'finished']) {
      if (stage === 'finished') await resign(game, game.white);
      for (const who of [null, nextSub()]) {
        const seen = await peek(game, who);
        expect(seen.exists).toBe(true);
        expect(seen).not.toHaveProperty('field');
      }
      expect(await peek(game, game.black)).toHaveProperty('field');
    }
  });

  it('once archived, is a finished game to its players and nothing to anybody else', async () => {
    const game = await seatedGame();
    await resign(game, game.white);
    await archiveAndDelete(game);
    expect(await peek(game, game.white)).toEqual({
      exists: true,
      status: 'finished',
      joinCode: game.joinCode,
      seatsFree: 0,
      archived: true,
    });
    expect(await peek(game, null)).toEqual({ exists: false });
    expect(await peek(game, nextSub())).toEqual({ exists: false });
    expect(await remains(game)).toEqual(GONE);
  });

  it('never leaves anything behind for a code that was never a game', async () => {
    const code = nextCode();
    const stub = env.GAME.getByName(code) as DurableObjectStub<GameDO>;
    await peek(code, null);
    await fetchAs(nextSub(), `/api/game/${code}`, { method: 'POST' });
    await fetchAs(nextSub(), `/api/game/${code}/review`);
    expect(await stub.peek()).toEqual({ exists: false });
    expect(await remains({ joinCode: code, stub, white: '', black: '' })).toEqual(GONE);
  });
});

describe('a game nobody played (stage 3.6.2)', () => {
  it('is collected after a month without a move, and leaves both lists', async () => {
    const game = await seatedGame({ moves: false });
    expect((await timers(game)).gc! - Date.now()).toBeGreaterThan(UNPLAYED_GAME_TTL_MS - 10_000);
    await runInDurableObject(game.stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE game SET updated_at = ?`, Date.now() - UNPLAYED_GAME_TTL_MS - 1);
    });
    await fireGc(game);
    expect(await remains(game)).toEqual(GONE);
    expect(await env.ARCHIVE.get(archiveKey(game.joinCode))).toBeNull();
    for (const sub of [game.white, game.black]) {
      expect(await env.USER.getByName(sub).listGames()).toEqual([]);
    }
  });

  /**
   * While `dropIndex` is talking to the accounts, `sideEffect` runs inside the
   * object — standing in for a request let in by that await.
   */
  async function duringDropIndex(game: Game, sideEffect: string, bind: unknown[]): Promise<void> {
    await runInDurableObject(game.stub, (instance, state) => {
      const target = instance as unknown as { env: Env; realEnv?: Env };
      const real = target.env;
      target.realEnv = real;
      target.env = {
        ...real,
        USER: {
          getByName: (name: string) => ({
            dropGame: async (code: string) => {
              state.storage.sql.exec(sideEffect, ...bind.map((v) => (v === 'NOW' ? Date.now() : v)));
              await real.USER.getByName(name).dropGame(code);
            },
          }),
        },
      } as unknown as Env;
    });
  }
  async function restoreEnv(game: Game): Promise<void> {
    await runInDurableObject(game.stub, (instance) => {
      const target = instance as unknown as { env: Env; realEnv: Env };
      target.env = target.realEnv;
    });
  }

  it('is kept if a player re-takes a seat while its index rows are being dropped', async () => {
    const game = await seatedGame({ moves: false });
    await runInDurableObject(game.stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE game SET updated_at = ?`, Date.now() - UNPLAYED_GAME_TTL_MS - 1);
    });
    // Exactly what `join` writes for a seat already held.
    await duringDropIndex(
      game,
      `INSERT INTO meta (key, value) VALUES ('seen_at', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      ['NOW'],
    );
    await fireGc(game);
    await restoreEnv(game);
    expect((await remains(game)).tables).toContain('game');
    expect((await timers(game)).gc! - Date.now()).toBeGreaterThan(UNPLAYED_GAME_TTL_MS - 10_000);
  });

  it('keeps an unclaimed code that somebody joins while it is being collected', async () => {
    const joinCode = nextCode();
    const stub = env.GAME.getByName(joinCode) as DurableObjectStub<GameDO>;
    await stub.create({
      joinCode,
      creatorPlayerId: 'creator-late',
      creatorAccount: 'creator-late',
      creatorColor: 'w',
      field: snapshotField(field('Late', 8)),
      initialMs: 900_000,
      incrementMs: 0,
    });
    const game: Game = { joinCode, stub, white: 'creator-late', black: 'joiner-late' };
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE game SET created_at = ?`, Date.now() - 3_600_000);
    });
    await duringDropIndex(
      game,
      `UPDATE game SET status = 'staging', black_player_id = 'joiner-late', black_account = 'joiner-late', updated_at = ?`,
      ['NOW'],
    );
    await fireGc(game);
    await restoreEnv(game);
    expect((await remains(game)).tables).toContain('game');
    expect(await stub.peek()).toMatchObject({ status: 'staging' });
  });

  it('is not collected early when somebody has been back to it', async () => {
    const game = await seatedGame({ moves: false });
    await runInDurableObject(game.stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE game SET updated_at = ?`, Date.now() - UNPLAYED_GAME_TTL_MS - 1);
    });
    expect((await fetchAs(game.black, `/api/game/${game.joinCode}`, { method: 'POST' })).status).toBe(200);
    await fireGc(game);
    expect((await remains(game)).tables).toContain('game');
  });

  it('never touches a game its opponent could claim, even one paused before any move', async () => {
    const game = await seatedGame({ moves: false });
    await runInDurableObject(game.stub, (_instance, state) => {
      const long = Date.now() - 400 * 24 * 3600_000;
      state.storage.sql.exec(
        `UPDATE game SET status = 'suspended', suspended_at = ?, suspended_by = 'w', updated_at = ?, created_at = ?`,
        long,
        long,
        long,
      );
    });
    await fireGc(game);
    expect((await remains(game)).tables).toContain('game');
    expect(await timers(game)).not.toHaveProperty('gc');
  });

  it('never touches a suspended game with moves on it, however old (decision 0025)', async () => {
    const game = await seatedGame();
    await runInDurableObject(game.stub, (_instance, state) => {
      const long = Date.now() - 400 * 24 * 3600_000;
      state.storage.sql.exec(
        `UPDATE game SET status = 'suspended', suspended_at = ?, suspended_by = 'b', updated_at = ?, created_at = ?`,
        long,
        long,
        long,
      );
    });
    await fireGc(game);
    expect((await remains(game)).tables).toContain('game');
    expect(await timers(game)).not.toHaveProperty('gc');
    expect(await game.stub.peek(game.white)).toMatchObject({ status: 'suspended' });
  });
});

describe('the dev hook that hastens collection', () => {
  async function hasten(code: string, opts: { host?: string; secret?: string | null } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.secret !== null) headers['x-dev-auth-secret'] = opts.secret ?? SECRET;
    return SELF.fetch(`${opts.host ?? LOCAL}/api/dev/game/${code}/collect`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ afterMs: 0 }),
    });
  }

  it('does not exist without both of the dev seam’s locks, and wants the secret', async () => {
    const game = await seatedGame();
    await resign(game, game.white);
    expect((await hasten(game.joinCode, { host: 'https://satellite-chess.example' })).status).toBe(404);
    delete mutableEnv.DEV_AUTH_SECRET;
    expect((await hasten(game.joinCode)).status).toBe(404);
    mutableEnv.DEV_AUTH_SECRET = SECRET;
    expect((await hasten(game.joinCode, { secret: 'wrong' })).status).toBe(401);
    expect((await hasten(game.joinCode, { secret: null })).status).toBe(401);
    expect((await hasten(nextCode())).status).toBe(404);
    expect(await meta(game, 'dev_collect_ms')).toBeNull();
  });

  it('runs the real steps through the real alarm, and the review survives them', async () => {
    const game = await seatedGame();
    await resign(game, game.black);
    const before = await pgnOf(game, game.white);
    expect((await hasten(game.joinCode)).status).toBe(200);
    // A second per step at the fastest (`MIN_OVERRIDE_MS`): grace, write, settle.
    for (let i = 0; i < 400; i++) {
      if ((await remains(game)).tables.length === 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await remains(game)).toEqual(GONE);
    expect((await pgnOf(game, game.white)).text).toBe(before.text);
  });
});
