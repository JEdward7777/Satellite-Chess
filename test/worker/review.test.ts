import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeFieldSpec, snapshotField } from '../../src/shared/field.js';
import { fromLocal } from '../../src/shared/geo.js';
import type { GameReport } from '../../src/shared/review.js';
import type { GameDO } from '../../src/worker/game-do.js';
import { applySchema } from '../../src/worker/schema.js';

/**
 * The post-game report and its PGN, end to end in `workerd` (stages 8.1, 8.2,
 * decision 0041).
 *
 * What needs the real runtime is the door: the account check lives inside the
 * Durable Object, the route turns every refusal into the same 404, and the file
 * the route serves is the one that travels — so this is where "no coordinates
 * anywhere in it" is checked against bytes that actually left the Worker.
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
  return `review-tester-${counter}`;
}
function nextCode(): string {
  counter += 1;
  return `V${String(counter).padStart(5, '0')}`;
}

interface Game {
  joinCode: string;
  stub: DurableObjectStub<GameDO>;
  white: string;
  black: string;
}

/** Where a square's centre is on an 8 m field, as a stored fix would hold it. */
function at(file: number, rank: number) {
  return fromLocal(A1, { e: file * 8, n: rank * 8 });
}

/**
 * A game with two accounts seated and three moves stored, each with both of
 * its fixes — set by hand, as `record.test.ts` does, because what is under test
 * is how the stored rows are read back rather than how they got there.
 */
async function activeGame(opts: { name?: string } = {}): Promise<Game> {
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
      field: snapshotField(field(opts.name ?? 'The common', 8)),
      initialMs: 900_000,
      incrementMs: 10_000,
    }),
  ).toBe(true);
  expect(await stub.join(black, black)).toMatchObject({ ok: true, color: 'b' });

  // e2e4, e7e5, g1f3 — each lifted a little off its origin's centre and placed
  // a little off its destination's, so a position that came through the
  // inverse is distinguishable from one that was merely the square's name.
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

async function fetchAs(sub: string | null, path: string): Promise<Response> {
  return SELF.fetch(`${LOCAL}${path}`, {
    headers: sub === null ? {} : { cookie: await cookieFor(sub) },
  });
}

async function reviewOf(game: Game, sub: string): Promise<{ you: string; report: GameReport }> {
  const response = await fetchAs(sub, `/api/game/${game.joinCode}/review`);
  expect(response.status).toBe(200);
  return (await response.json()) as { you: string; report: GameReport };
}

async function pgnOf(game: Game, sub: string): Promise<{ response: Response; text: string }> {
  const response = await fetchAs(sub, `/api/game/${game.joinCode}/pgn`);
  expect(response.status).toBe(200);
  return { response, text: await response.text() };
}

/** A tag's value, or undefined where the file has no such tag. */
function tag(pgn: string, name: string): string | undefined {
  return new RegExp(`^\\[${name} "([^"]*)"\\]$`, 'm').exec(pgn)?.[1];
}

beforeEach(() => {
  mutableEnv.DEV_AUTH_SECRET = SECRET;
});

describe('who may read a game back', () => {
  it('needs a session, for the report and for the file', async () => {
    const game = await activeGame();
    for (const suffix of ['review', 'pgn']) {
      const response = await fetchAs(null, `/api/game/${game.joinCode}/${suffix}`);
      expect(response.status).toBe(401);
    }
  });

  it('answers each seat, and tells it which seat it held', async () => {
    const game = await activeGame();
    expect((await reviewOf(game, game.white)).you).toBe('w');
    expect((await reviewOf(game, game.black)).you).toBe('b');
  });

  it('answers a signed-in stranger exactly as it answers a code that names nothing', async () => {
    const game = await activeGame();
    const stranger = nextSub();
    for (const suffix of ['review', 'pgn']) {
      const refused = await fetchAs(stranger, `/api/game/${game.joinCode}/${suffix}`);
      const missing = await fetchAs(stranger, `/api/game/${nextCode()}/${suffix}`);
      // 404 rather than 403: a refusal must not confirm that the code is real.
      expect(refused.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await refused.text()).toBe(await missing.text());
    }
  });

  it('is read-only', async () => {
    const game = await activeGame();
    const response = await SELF.fetch(`${LOCAL}/api/game/${game.joinCode}/review`, {
      method: 'POST',
      headers: { cookie: await cookieFor(game.white), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(405);
  });
});

describe('the report', () => {
  it('carries each move with its carry, and its fixes in board space', async () => {
    const game = await activeGame();
    const { report: read } = await reviewOf(game, game.white);
    expect(read.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3']);
    expect(read.moves[0]).toMatchObject({ seq: 1, color: 'w', from: 'e2', to: 'e4', carriedM: 16.4 });
    // Squares from a1's centre, recovered through the affine inverse.
    expect(read.moves[0]!.lift!.file).toBeCloseTo(4.1, 3);
    expect(read.moves[0]!.lift!.rank).toBeCloseTo(1, 3);
    expect(read.moves[0]!.lift!.accuracyM).toBe(5);
    expect(read.moves[0]!.place!.rank).toBeCloseTo(3.2, 3);
    expect(read.moves[0]!.place!.accuracyM).toBe(4);
    expect(read.moves[2]!.lift!.file).toBeCloseTo(6, 3);
    expect(read.travelM).toEqual({ w: 420, b: 380 });
    expect(read.boardM).toBeCloseTo(64, 3);
    expect(read.squareM).toBeCloseTo(8, 3);
    expect(read.initialMs).toBe(900_000);
    expect(read.incrementMs).toBe(10_000);
    expect(read.fieldName).toBe('The common');
  });

  it('holds no latitude or longitude, under any name', async () => {
    const game = await activeGame();
    const body = JSON.stringify(await reviewOf(game, game.white));
    expect(body).not.toMatch(/lat|lng|lon/i);
    // Nor the numbers themselves, whatever they might have been renamed to.
    expect(body).not.toContain(String(A1.lat).slice(0, 5));
    expect(body).not.toContain('-0.00');
  });

  it('reads an unfinished game as unfinished', async () => {
    const game = await activeGame();
    const { report } = await reviewOf(game, game.black);
    expect(report).toMatchObject({ outcome: null, reason: null, finishedAt: null });
  });

  it('reads a finished game with its result', async () => {
    const game = await activeGame();
    await resign(game, game.black);
    const { report } = await reviewOf(game, game.black);
    expect(report).toMatchObject({ outcome: '1-0', reason: 'resignation' });
    expect(report.finishedAt).toBeTypeOf('number');
  });
});

describe('the file', () => {
  it('is a PGN attachment named for the day and the field, never the code', async () => {
    const game = await activeGame({ name: 'Riverside Park' });
    const { response, text } = await pgnOf(game, game.white);
    expect(response.headers.get('content-type')).toMatch(/^application\/x-chess-pgn/);
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).toMatch(
      /^attachment; filename="satellite-chess-\d{4}-\d{2}-\d{2}-riverside-park\.pgn"$/,
    );
    expect(disposition).not.toContain(game.joinCode);
    expect(text).not.toContain(game.joinCode);
  });

  it('is the same file whichever seat asks for it', async () => {
    const game = await activeGame();
    const white = (await pgnOf(game, game.white)).text;
    const black = (await pgnOf(game, game.black)).text;
    // Only the export instant could differ, and nothing in the file uses it
    // when the game has a creation time.
    expect(black).toBe(white);
    expect(tag(white, 'White')).toBe('?');
    expect(tag(white, 'Black')).toBe('?');
  });

  it('writes the game and the walk, and no coordinates at all', async () => {
    const game = await activeGame();
    await resign(game, game.black);
    const { text } = await pgnOf(game, game.white);
    expect(tag(text, 'Result')).toBe('1-0');
    expect(tag(text, 'Termination')).toBe('normal');
    expect(tag(text, 'SatelliteEnd')).toBe('resignation');
    expect(tag(text, 'TimeControl')).toBe('900+10');
    expect(tag(text, 'SatelliteWhiteWalkedM')).toBe('420');
    expect(tag(text, 'SatelliteBlackWalkedM')).toBe('380');
    // Wrapped at 80 columns, so a comment may break anywhere it has a space.
    expect(text.replace(/\s+/g, ' ')).toContain(
      '1. e4 {carry 16.4 m in 31 s; lift 4.1,1 acc 5 m; place 4,3.2 acc 4 m} e5',
    );
    expect(text.trimEnd().endsWith('1-0')).toBe(true);

    expect(text).not.toMatch(/lat|lng|lon/i);
    expect(text).not.toContain(String(A1.lat).slice(0, 5));
    // Board positions are written to a hundredth of a square; anything with
    // more places than that did not come from the board.
    expect(text).not.toMatch(/\d\.\d{3,}/);
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
  });

  it('writes * for a game still being played', async () => {
    const game = await activeGame();
    const { text } = await pgnOf(game, game.white);
    expect(tag(text, 'Result')).toBe('*');
    expect(tag(text, 'Termination')).toBeUndefined();
    expect(text.trimEnd().endsWith('*')).toBe(true);
  });

  it('leaves out a distance nobody measured, rather than writing a zero', async () => {
    const game = await activeGame();
    await runInDurableObject(game.stub, (_instance, state) => {
      // Credited under the old rule and never reported by leg (decision 0040, rule 7).
      state.storage.sql.exec(`UPDATE presence SET travel_m = 5200, travel_leg = NULL WHERE color = 'w'`);
    });
    const { report } = await reviewOf(game, game.white);
    expect(report.travelM).toEqual({ w: null, b: 380 });
    const { text } = await pgnOf(game, game.white);
    expect(tag(text, 'SatelliteWhiteWalkedM')).toBeUndefined();
    expect(tag(text, 'SatelliteBlackWalkedM')).toBe('380');
    expect(text).not.toContain('5200');
  });

  it('writes TimeControl "?" for a game whose starting clock nobody kept', async () => {
    const game = await activeGame();
    await runInDurableObject(game.stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE game SET initial_ms = NULL`);
    });
    const { text } = await pgnOf(game, game.white);
    expect(tag(text, 'TimeControl')).toBe('?');
  });
});

describe('a game that predates the starting clock (schema 5)', () => {
  /** Drop the column, spend some of White's clock, and wake through the upgrade. */
  async function throughTheUpgrade(game: Game, opts: { clearMoves: boolean }) {
    return runInDurableObject(game.stub, (_instance, state) => {
      const sql = state.storage.sql;
      if (opts.clearMoves) sql.exec(`DELETE FROM moves`);
      // What a pause before the first move leaves behind: White's clock ran and
      // was banked, Black's has not started.
      sql.exec(`UPDATE game SET white_ms_remaining = 812345, black_ms_remaining = 900000`);
      sql.exec(`ALTER TABLE game DROP COLUMN initial_ms`);
      applySchema(sql);
      return [...sql.exec<{ initial_ms: number | null }>(`SELECT initial_ms FROM game`)][0]!
        .initial_ms;
    });
  }

  it('recovers it from the untouched clock when no move has been played', async () => {
    const game = await activeGame();
    expect(await throughTheUpgrade(game, { clearMoves: true })).toBe(900_000);
  });

  it('leaves it unknown once a move has been played', async () => {
    const game = await activeGame();
    expect(await throughTheUpgrade(game, { clearMoves: false })).toBeNull();
    const { text } = await pgnOf(game, game.white);
    expect(tag(text, 'TimeControl')).toBe('?');
  });
});
