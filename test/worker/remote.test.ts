import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  type FieldGeometry,
  type FieldSnapshot,
  type FieldSpec,
  geometryFromSnapshot,
  makeFieldSpec,
  snapshotField,
  squareCentreLatLng,
  toBoardIndex,
} from '../../src/shared/field.js';
import { add, fromLocal, scale, unitFromBearing } from '../../src/shared/geo.js';
import { DEFAULT_REACH, effectiveReachM, inStartZone } from '../../src/shared/reach.js';
import { playableBoard } from '../../src/shared/remote.js';
import { applySchema } from '../../src/worker/schema.js';
import type { GameReport } from '../../src/shared/review.js';
import { fromSquare } from '../../src/shared/squares.js';

/**
 * A remote game, two players on two fields (stage 12.1, decision 0060),
 * against the real runtime and through the real routes.
 *
 * What has to be true:
 *
 * - **refusals**: a remote create without the disclosure accepted, and a
 *   remote join without the joiner's own field or without the disclosure
 *   accepted, are refused and change nothing;
 * - **one square size**: the shared square is the smaller field's, and the
 *   larger board is shrunk about its center;
 * - **each move judged on the mover's own board**, the back rank included,
 *   with the same reach in meters on both;
 * - **the relay is board space**: the opponent's position arrives as squares
 *   on their board, never as a latitude;
 * - **privacy**: no frame either player is sent, nothing a watcher is sent,
 *   and neither the report, the file nor the game index ever holds the other
 *   player's field, its name, or a coordinate on it.
 */

const SECRET = 'test-dev-auth-secret';
const LOCAL = 'http://127.0.0.1';
const mutableEnv = env as unknown as Record<string, unknown>;

beforeEach(() => {
  mutableEnv.DEV_AUTH_SECRET = SECRET;
});

// Two places a long way apart, each with digits nothing else in a frame could
// produce, so that a leak of either shows up in a scan as itself.
const LOC_A = { lat: 37.123456, lng: -122.654321 };
const LOC_B = { lat: -33.876543, lng: 151.234567 };
const MARK_A = ['Grandma backyard', '37.12', '-122.65', 'field-a'];
const MARK_B = ['Sydney yard', '-33.87', '151.23', 'field-b'];

/** The larger field: four corners, 10 x 8 m squares, its files on a bearing of 30 degrees. */
function fieldA(): FieldSpec {
  const f = scale(unitFromBearing(30), 10);
  const r = scale(unitFromBearing(-60), 8);
  const corner = (file: number, rank: number) => fromLocal(LOC_A, add(scale(f, file), scale(r, rank)));
  return makeFieldSpec(
    'Grandma backyard',
    { a1: corner(0, 0), h1: corner(7, 0), h8: corner(7, 7), a8: corner(0, 7) },
    { id: 'field-a' },
  );
}

/** The smaller: an old two-corner field of 6 m squares. */
function fieldB(): FieldSpec {
  return makeFieldSpec('Sydney yard', { a1: LOC_B, h8: fromLocal(LOC_B, { e: 42, n: 42 }) }, { id: 'field-b' });
}

const cookies = new Map<string, string>();
async function cookieFor(sub: string): Promise<string> {
  const known = cookies.get(sub);
  if (known !== undefined) return known;
  const response = await SELF.fetch(`${LOCAL}/api/dev/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-auth-secret': SECRET },
    body: JSON.stringify({ sub }),
  });
  expect(response.status).toBe(200);
  const cookie = (response.headers.get('set-cookie') as string).split(';')[0]!;
  cookies.set(sub, cookie);
  return cookie;
}

let counter = 0;
function nextSub(): string {
  counter += 1;
  return `remote-tester-${counter}`;
}

async function call(sub: string, path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${LOCAL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie: await cookieFor(sub), ...(init.headers ?? {}) },
  });
}

type Msg = Record<string, unknown>;

class Client {
  readonly received: Msg[] = [];
  readonly raw: string[] = [];
  private readonly waiters: { predicate: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];

  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener('message', (event) => {
      const text = String((event as MessageEvent).data);
      this.raw.push(text);
      const msg = JSON.parse(text) as Msg;
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
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  state(test: (game: Msg) => boolean): Promise<Msg> {
    return this.next((m) => m.t === 'state' && test(m.game as Msg)).then((m) => m.game as Msg);
  }

  last(): Msg {
    const found = [...this.received].reverse().find((m) => m.t === 'state');
    if (found === undefined) throw new Error('no state yet');
    return found.game as Msg;
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  clear(): void {
    this.received.length = 0;
  }
}

/** As in `record.test.ts` (O-52): wait until the object has handled everything sent on `ws`. */
let barriers = 0;
async function handled(ws: WebSocket, timeoutMs = 2_000): Promise<void> {
  barriers += 1;
  const marker = `test-barrier-${barriers}`;
  let onMessage: (event: Event) => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answered = new Promise<void>((resolve, reject) => {
    onMessage = (event: Event) => {
      const data = JSON.parse(String((event as MessageEvent).data)) as { t: string; message?: string };
      if (data.t === 'error' && data.message?.includes(`"${marker}"`)) resolve();
    };
    ws.addEventListener('message', onMessage);
    timer = setTimeout(() => reject(new Error(`barrier reply never came within ${timeoutMs} ms`)), timeoutMs);
  });
  ws.send(JSON.stringify({ t: marker }));
  try {
    await answered;
  } finally {
    clearTimeout(timer);
    ws.removeEventListener('message', onMessage);
  }
}

interface Remote {
  joinCode: string;
  white: string;
  black: string;
}

/** Create a remote game on field A for White, with the disclosure accepted. */
async function create(white: string, extra: Record<string, unknown> = {}): Promise<string> {
  const response = await call(white, '/api/game', {
    method: 'POST',
    body: JSON.stringify({
      field: fieldA(),
      color: 'w',
      remote: true,
      disclosureAccepted: true,
      initialMs: 600_000,
      incrementMs: 0,
      ...extra,
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { joinCode: string }).joinCode;
}

async function join(sub: string, code: string, body: unknown): Promise<Response> {
  return call(sub, `/api/game/${code}`, { method: 'POST', body: JSON.stringify(body) });
}

async function seated(extra: Record<string, unknown> = {}): Promise<Remote> {
  const white = nextSub();
  const black = nextSub();
  const joinCode = await create(white, extra);
  const joined = await join(black, joinCode, { field: fieldB(), disclosureAccepted: true });
  expect(joined.status).toBe(200);
  return { joinCode, white, black };
}

async function openSocket(game: Remote, sub: string): Promise<Client> {
  const res = await SELF.fetch(`${LOCAL}/api/game/${game.joinCode}/ws`, {
    headers: { upgrade: 'websocket', cookie: await cookieFor(sub) },
  });
  expect(res.status).toBe(101);
  const client = new Client(res.webSocket as WebSocket);
  await client.next((m) => m.t === 'state');
  return client;
}

/** Each player's own playable board, from what their own snapshot says. */
function boardOf(client: Client): FieldGeometry {
  const game = client.last();
  return playableBoard(game.field as FieldSnapshot, (game.remote as { squareM: number }).squareM);
}

function on(geo: FieldGeometry, square: string, acc = 3) {
  const p = squareCentreLatLng(geo, fromSquare(square));
  return { lat: p.lat, lng: p.lng, acc, ts: Date.now() };
}

function stub(game: Remote) {
  return env.GAME.getByName(game.joinCode);
}

/** Lift and place, with the lift backdated so that a scripted carry is a plausible walk. */
async function move(game: Remote, client: Client, geo: FieldGeometry, from: string, to: string): Promise<void> {
  client.send({ t: 'lift', from, pos: on(geo, from) });
  await handled(client.ws);
  const refused = client.received.find((m) => m.t === 'error' && !String(m.message).includes('test-barrier'));
  if (refused !== undefined) throw new Error(`lift ${from}: ${refused.code} ${refused.message}`);
  await runInDurableObject(stub(game), (_i, state) => {
    state.storage.sql.exec(`UPDATE carry SET lift_at = lift_at - 60000`);
  });
  client.send({ t: 'place', to, pos: on(geo, to) });
  await handled(client.ws);
  const placeRefused = client.received.find((m) => m.t === 'error' && !String(m.message).includes('test-barrier'));
  if (placeRefused !== undefined) throw new Error(`place ${to}: ${placeRefused.code} ${placeRefused.message}`);
}

function errorsOf(client: Client): Msg[] {
  return client.received.filter((m) => m.t === 'error' && !String(m.message).includes('test-barrier'));
}

/** Every marker of a field that turns up in some text. */
function leaks(texts: readonly string[], marks: readonly string[]): string[] {
  const found: string[] = [];
  for (const text of texts) for (const mark of marks) if (text.includes(mark)) found.push(`${mark} in ${text.slice(0, 120)}`);
  return found;
}

async function peek(sub: string, code: string): Promise<Msg> {
  return (await (await call(sub, `/api/game/${code}`)).json()) as Msg;
}

describe('a remote game refuses what it must not accept', () => {
  it('is not created without the disclosure accepted', async () => {
    const white = nextSub();
    for (const disclosure of [undefined, false, 'yes']) {
      const response = await call(white, '/api/game', {
        method: 'POST',
        body: JSON.stringify({ field: fieldA(), remote: true, disclosureAccepted: disclosure }),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe('disclosure_required');
    }
  });

  it('is not joined without the joiner’s own field, or without the disclosure accepted', async () => {
    const white = nextSub();
    const black = nextSub();
    const code = await create(white);

    // An invitation to a remote game carries no field: the creator's is theirs.
    const invitation = await peek(black, code);
    expect(invitation).toMatchObject({ exists: true, status: 'waiting', seatsFree: 1, remote: true });
    expect(invitation.field).toBeUndefined();
    expect(leaks([JSON.stringify(invitation)], MARK_A)).toEqual([]);

    for (const [body, reason] of [
      [{}, 'field_required'],
      [{ disclosureAccepted: true }, 'field_required'],
      [{ field: fieldB() }, 'disclosure_required'],
      [{ field: fieldB(), disclosureAccepted: false }, 'disclosure_required'],
    ] as const) {
      const response = await join(black, code, body);
      expect(response.status).toBe(400);
      const error = (await response.json()) as { error: string; message: string };
      expect(error.error).toBe(reason);
      expect(leaks([error.message], MARK_A)).toEqual([]);
    }
    // A field that describes no board is refused as at creation.
    const bad = await join(black, code, { field: { a1: LOC_B, h8: LOC_B }, disclosureAccepted: true });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('bad_field');

    // Nothing changed: the seat is still free, and nothing is stored for it.
    expect(await peek(black, code)).toMatchObject({ status: 'waiting', seatsFree: 1 });
    const rows = await runInDurableObject(env.GAME.getByName(code), (_i, state) => [
      ...state.storage.sql.exec(`SELECT color FROM seat_field ORDER BY color`),
    ]);
    expect(rows).toEqual([{ color: 'w' }]);

    // Both, and the seat is taken with the joiner's own field.
    const joined = await join(black, code, { field: fieldB(), disclosureAccepted: true });
    expect(joined.status).toBe(200);
    const answer = (await joined.json()) as { color: string; field: FieldSnapshot; remote?: boolean };
    expect(answer).toMatchObject({ color: 'b', remote: true });
    expect(answer.field.fieldId).toBe('field-b');
    expect(leaks([JSON.stringify(answer)], MARK_A)).toEqual([]);

    // Taking the seat again needs nothing, and answers with the same field.
    const again = await join(black, code, {});
    expect(again.status).toBe(200);
    expect(((await again.json()) as { field: FieldSnapshot }).field.fieldId).toBe('field-b');
    // And each player's peek is their own field.
    expect(((await peek(white, code)).field as FieldSnapshot).fieldId).toBe('field-a');
    expect(((await peek(black, code)).field as FieldSnapshot).fieldId).toBe('field-b');
    // A stranger, once the seats are full, gets no field at all.
    const stranger = await peek(nextSub(), code);
    expect(stranger.field).toBeUndefined();
  });

  it('leaves a same-field join exactly as it was', async () => {
    const white = nextSub();
    const black = nextSub();
    const created = await call(white, '/api/game', {
      method: 'POST',
      body: JSON.stringify({ field: fieldA(), color: 'w' }),
    });
    const code = ((await created.json()) as { joinCode: string }).joinCode;
    expect(await peek(black, code)).not.toHaveProperty('remote');
    // A join body is ignored by a same-field game, whatever it carries: even
    // a field that describes no board, which only a remote seat refuses.
    const joined = await join(black, code, { field: { a1: LOC_B, h8: LOC_B } });
    expect(joined.status).toBe(200);
    const answer = (await joined.json()) as Msg;
    expect(Object.keys(answer).sort()).toEqual(['color', 'field']);
    expect((answer.field as FieldSnapshot).fieldId).toBe('field-a');
  });
});

describe('a remote game on two unequal fields', () => {
  it('shares the smaller square, shrinks the larger board, and sends each player only their own field', async () => {
    const game = await seated();
    const w = await openSocket(game, game.white);
    const b = await openSocket(game, game.black);
    await handled(w.ws);

    const sA = geometryFromSnapshot(w.last().field as FieldSnapshot).meanSquareM;
    const sB = geometryFromSnapshot(b.last().field as FieldSnapshot).meanSquareM;
    expect(sA).toBeCloseTo(Math.sqrt(80), 3);
    expect(sB).toBeCloseTo(6, 3);
    expect((w.last().field as FieldSnapshot).fieldId).toBe('field-a');
    expect((b.last().field as FieldSnapshot).fieldId).toBe('field-b');
    expect(w.last().remote).toEqual({ squareM: sB });
    expect(b.last().remote).toEqual({ squareM: sB });

    // White's board is shrunk to 6 m squares, about its own center.
    const boardA = boardOf(w);
    expect(boardA.meanSquareM).toBe(sB);
    expect(boardA.fileM / boardA.rankM).toBeCloseTo(10 / 8, 6);
    expect(boardOf(b)).toEqual(geometryFromSnapshot(b.last().field as FieldSnapshot));

    expect(leaks(b.raw, MARK_A)).toEqual([]);
    expect(leaks(w.raw, MARK_B)).toEqual([]);
  });

  it('judges the back rank, a lift and a place on the mover’s own board, at one reach in meters', async () => {
    const game = await seated();
    const w = await openSocket(game, game.white);
    const b = await openSocket(game, game.black);
    const boardA = boardOf(w);
    const boardB = boardOf(b);
    const fullA = geometryFromSnapshot(w.last().field as FieldSnapshot);

    // On the unshrunk board's e1, White is well off the shrunk board's back
    // rank, and is told so.
    w.send({ t: 'ready', pos: on(fullA, 'e1') });
    await handled(w.ws);
    const refusal = errorsOf(w)[0]!;
    expect(refusal).toMatchObject({ code: 'out_of_reach' });
    const reachM = effectiveReachM(boardB.meanSquareM, DEFAULT_REACH);
    expect((refusal.refusal as { reachM: number }).reachM).toBe(reachM);
    w.clear();

    // On each player's own e1 and e8, the game starts.
    w.send({ t: 'ready', pos: on(boardA, 'e1') });
    b.send({ t: 'ready', pos: on(boardB, 'e8') });
    await w.state((g) => g.status === 'active');
    w.clear();

    // A lift from the unshrunk e2 is refused, at the same reach Black has.
    w.send({ t: 'lift', from: 'e2', pos: on(fullA, 'e2') });
    await handled(w.ws);
    const lift = errorsOf(w)[0]!;
    expect(lift).toMatchObject({ code: 'out_of_reach', move: { from: 'e2' } });
    expect((lift.refusal as { reachM: number }).reachM).toBe(reachM);
    w.clear();

    // On the shrunk board's own squares, both moves are played.
    await move(game, w, boardA, 'e2', 'e4');
    b.clear();
    // Black's lift from where White's board would put e7 means nothing on hers.
    b.send({ t: 'lift', from: 'e7', pos: on(boardA, 'e7') });
    await handled(b.ws);
    expect(errorsOf(b)[0]).toMatchObject({ code: 'out_of_reach' });
    expect((errorsOf(b)[0]!.refusal as { reachM: number }).reachM).toBe(reachM);
    b.clear();
    await move(game, b, boardB, 'e7', 'e5');
    await handled(w.ws);
    expect(w.last().moveCount).toBe(2);
    expect((w.last().lastMove as Msg).san).toBe('e5');

    // A place just out of reach on the shrunk board is refused: the board
    // that counts is the shrunk one, not the field.
    w.clear();
    w.send({ t: 'lift', from: 'g1', pos: on(boardA, 'g1') });
    await handled(w.ws);
    expect(errorsOf(w)).toEqual([]);
    await runInDurableObject(stub(game), (_i, state) => {
      state.storage.sql.exec(`UPDATE carry SET lift_at = lift_at - 60000`);
    });
    // h3, near the edge, where the field and the shrunk board are furthest apart.
    w.send({ t: 'place', to: 'h3', pos: on(fullA, 'h3') });
    await handled(w.ws);
    expect(errorsOf(w)[0]).toMatchObject({ code: 'out_of_reach', move: { to: 'h3' } });

    // The stored walk is squares on each player's own board: the lift of e2
    // is at e2 on White's, and the place at e5 at e5 on Black's.
    const report = (await (await call(game.white, `/api/game/${game.joinCode}/review`)).json()) as {
      report: GameReport;
    };
    const [e4, e5] = report.report.moves;
    expect(e4!.lift).toMatchObject({ file: expect.closeTo(4, 4), rank: expect.closeTo(1, 4) });
    expect(e4!.place).toMatchObject({ file: expect.closeTo(4, 4), rank: expect.closeTo(3, 4) });
    expect(e5!.lift).toMatchObject({ file: expect.closeTo(4, 4), rank: expect.closeTo(6, 4) });
    expect(e5!.place).toMatchObject({ file: expect.closeTo(4, 4), rank: expect.closeTo(4, 4) });
  });

  it('relays each position as squares on the sender’s own board, never as a latitude', async () => {
    const game = await seated();
    const w = await openSocket(game, game.white);
    const b = await openSocket(game, game.black);
    const boardA = boardOf(w);
    const boardB = boardOf(b);
    b.clear();
    w.clear();

    // White stands a little way into d4 on her board.
    const d4 = squareCentreLatLng(boardA, { file: 3.25, rank: 3 });
    w.send({ t: 'pos', lat: d4.lat, lng: d4.lng, acc: 4 });
    await handled(w.ws);
    await handled(b.ws);
    expect(b.received.some((m) => m.t === 'opp_pos')).toBe(false);
    const relay = b.received.find((m) => m.t === 'opp_spot')!;
    expect(relay).toMatchObject({ t: 'opp_spot', spot: { file: 3.25, rank: 3 }, acc: 4 });
    expect(Object.keys(relay).sort()).toEqual(['acc', 'at', 'spot', 't']);

    // A snapshot says the same: the opponent's `pos` is null and their
    // `spot` is squares; your own view keeps your own fix.
    b.send({ t: 'sync' });
    const synced = await b.state(() => true);
    const players = synced.players as Record<string, Msg>;
    expect(players.w!.pos).toBeNull();
    expect(players.w!.spot).toMatchObject({ spot: { file: 3.25, rank: 3 }, acc: 4 });
    expect(players.b!).not.toHaveProperty('spot');

    // Black, on her own board's h8, is h8 on White's screen.
    const h8 = squareCentreLatLng(boardB, fromSquare('h8'));
    b.send({ t: 'pos', lat: h8.lat, lng: h8.lng, acc: 2 });
    await handled(b.ws);
    await handled(w.ws);
    expect(w.received.find((m) => m.t === 'opp_spot')).toMatchObject({ spot: { file: 7, rank: 7 } });

    // Far off the board, the relay is no position at all.
    w.clear();
    const away = fromLocal(boardB.origin, { e: 500, n: 500 });
    await runInDurableObject(stub(game), (_i, state) => {
      state.storage.sql.exec(`UPDATE presence SET last_relay_at = 0`);
    });
    b.send({ t: 'pos', lat: away.lat, lng: away.lng, acc: 2 });
    await handled(b.ws);
    await handled(w.ws);
    expect(w.received.find((m) => m.t === 'opp_spot')).toMatchObject({ spot: null });

    expect(leaks(b.raw, MARK_A)).toEqual([]);
    expect(leaks(w.raw, MARK_B)).toEqual([]);
  });

  it('keeps each field private through a whole game: frames, watcher, report, file and game index', async () => {
    const game = await seated();
    const w = await openSocket(game, game.white);
    const b = await openSocket(game, game.black);
    const boardA = boardOf(w);
    const boardB = boardOf(b);

    // Both agree to be watched, and a watcher is there throughout.
    w.send({ t: 'watch', action: 'on' });
    await handled(w.ws);
    b.send({ t: 'watch', action: 'on' });
    const link = ((await w.state((g) => (g.watch as Msg).on === true)).watch as Msg).link as string;
    const res = await SELF.fetch(`${LOCAL}/api/watch/${link.replace(/^\/w\//, '')}/ws`, {
      headers: { upgrade: 'websocket' },
    });
    const watcher = new Client(res.webSocket as WebSocket);
    await watcher.next((m) => m.t === 'watch_state');

    w.send({ t: 'ready', pos: on(boardA, 'e1') });
    b.send({ t: 'ready', pos: on(boardB, 'e8') });
    await w.state((g) => g.status === 'active');
    for (const [client, board, from, to] of [
      [w, boardA, 'f2', 'f3'],
      [b, boardB, 'e7', 'e5'],
      [w, boardA, 'g2', 'g4'],
      [b, boardB, 'd8', 'h4'],
    ] as const) {
      // A relay on the way, so the watcher and the opponent see one.
      const mid = squareCentreLatLng(board, fromSquare(from));
      await runInDurableObject(stub(game), (_i, state) => {
        state.storage.sql.exec(`UPDATE presence SET last_relay_at = 0`);
      });
      client.send({ t: 'pos', lat: mid.lat, lng: mid.lng, acc: 3 });
      await move(game, client, board, from, to);
    }
    await w.state((g) => g.status === 'finished');
    await handled(b.ws);

    // The watcher's view is the shared board, eight 6 m squares, and its dots
    // are squares on each player's own board: each one's last relay, made
    // standing on the square their last move came from.
    const view = [...watcher.received].reverse().find((m) => m.t === 'watch_state')!.game as Msg;
    expect(view.boardM).toBeCloseTo(8 * boardB.meanSquareM, 2);
    expect((view.players as Record<string, Msg>).b!.at).toEqual({ file: 3, rank: 7 });
    expect((view.players as Record<string, Msg>).w!.at).toEqual({ file: 6, rank: 1 });

    const reviewOf = async (sub: string) =>
      ((await (await call(sub, `/api/game/${game.joinCode}/review`)).json()) as { report: GameReport }).report;
    const report = await reviewOf(game.white);
    expect(await reviewOf(game.black)).toEqual(report);
    expect(report.fieldName).toBeNull();
    expect(report.squareM).toBe(boardB.meanSquareM);
    expect(report.boardM).toBe(8 * boardB.meanSquareM);
    const pgn = await (await call(game.white, `/api/game/${game.joinCode}/pgn`)).text();
    expect(pgn).toContain('[Site "?"]');
    expect(pgn).toContain('0-1');

    // Each player's own line in the game index names their own field.
    const listed = async (sub: string) =>
      ((await (await call(sub, '/api/games')).json()) as { games: { joinCode: string; fieldName: string | null }[] })
        .games.find((g) => g.joinCode === game.joinCode)!;
    expect((await listed(game.white)).fieldName).toBe('Grandma backyard');
    expect((await listed(game.black)).fieldName).toBe('Sydney yard');

    // And nothing anybody else was sent holds the other's field.
    expect(leaks(b.raw, MARK_A)).toEqual([]);
    expect(leaks(w.raw, MARK_B)).toEqual([]);
    expect(leaks(watcher.raw, [...MARK_A, ...MARK_B])).toEqual([]);
    expect(leaks([JSON.stringify(report), pgn], [...MARK_A, ...MARK_B])).toEqual([]);
    // No latitude or longitude anywhere a watcher or an opponent looks.
    expect(watcher.raw.filter((t) => /"lat"|"lng"/.test(t))).toEqual([]);
    for (const text of b.raw) {
      const msg = JSON.parse(text) as Msg;
      if (msg.t === 'state') {
        expect(((msg.game as Msg).players as Record<string, Msg | null>).w?.pos ?? null).toBeNull();
      }
      expect(msg.t).not.toBe('opp_pos');
    }
  });
});

describe('a remote game of checkers', () => {
  it('is played on each player’s own board too', async () => {
    const game = await seated({ gameType: 'checkers' });
    const w = await openSocket(game, game.white);
    const b = await openSocket(game, game.black);
    expect(w.last()).toMatchObject({ gameType: 'checkers', remote: { squareM: expect.any(Number) } });
    const boardA = boardOf(w);
    const boardB = boardOf(b);
    w.send({ t: 'ready', pos: on(boardA, 'e1') });
    b.send({ t: 'ready', pos: on(boardB, 'd8') });
    await w.state((g) => g.status === 'active');
    await move(game, w, boardA, 'c3', 'd4');
    await move(game, b, boardB, 'f6', 'e5');
    await handled(w.ws);
    expect(w.last().moveCount).toBe(2);
    expect(leaks(b.raw, MARK_A)).toEqual([]);
    expect(leaks(w.raw, MARK_B)).toEqual([]);
  });
});

describe('a same-field game', () => {
  it('sends no remote fields and relays a fix as it always did', async () => {
    const white = nextSub();
    const black = nextSub();
    const created = await call(white, '/api/game', {
      method: 'POST',
      body: JSON.stringify({ field: fieldB(), color: 'w' }),
    });
    const joinCode = ((await created.json()) as { joinCode: string }).joinCode;
    expect((await join(black, joinCode, {})).status).toBe(200);
    const game = { joinCode, white, black };
    const w = await openSocket(game, white);
    const b = await openSocket(game, black);
    const geo = geometryFromSnapshot(w.last().field as FieldSnapshot);
    expect(w.last()).not.toHaveProperty('remote');
    const p = squareCentreLatLng(geo, fromSquare('d4'));
    w.send({ t: 'pos', lat: p.lat, lng: p.lng, acc: 4 });
    await handled(w.ws);
    await handled(b.ws);
    expect(b.received.find((m) => m.t === 'opp_pos')).toMatchObject({ lat: p.lat, lng: p.lng, acc: 4 });
    expect(b.received.some((m) => m.t === 'opp_spot')).toBe(false);
    b.send({ t: 'sync' });
    const synced = await b.state((g) => ((g.players as Record<string, Msg>).w!.pos as Msg | null) !== null);
    expect((synced.players as Record<string, Msg>).w).not.toHaveProperty('spot');
    const tables = await runInDurableObject(env.GAME.getByName(joinCode), (_i, state) => [
      ...state.storage.sql.exec(`SELECT COUNT(*) AS n FROM seat_field`),
    ]);
    expect(tables).toEqual([{ n: 0 }]);
    // Unused here, but the board index is the same affine inverse as ever.
    expect(toBoardIndex(geo, p).file).toBeCloseTo(3, 9);
  });
});

describe('a back rank judged on a board that is about to change', () => {
  /** A remote game on field A with White seated and connected, Black not yet joined. */
  async function waiting(): Promise<{ game: Remote; w: Client }> {
    const white = nextSub();
    const joinCode = await create(white);
    const game = { joinCode, white, black: nextSub() };
    const w = await openSocket(game, white);
    return { game, w };
  }

  async function presenceZone(game: Remote, color: string): Promise<number> {
    return runInDurableObject(stub(game), (_i, state) =>
      Number(
        [...state.storage.sql.exec<{ z: number }>(`SELECT in_start_zone AS z FROM presence WHERE color = ?`, color)][0]!
          .z,
      ),
    );
  }

  it('is judged again when the joiner’s smaller field shrinks the board, so the clock does not start', async () => {
    const { game, w } = await waiting();
    const fullA = geometryFromSnapshot(snapshotField(fieldA()));
    // White waits on e1 of her field as it is before anyone joins.
    const e1 = squareCentreLatLng(fullA, fromSquare('e1'));
    w.send({ t: 'pos', lat: e1.lat, lng: e1.lng, acc: 3 });
    await handled(w.ws);
    expect(await presenceZone(game, 'w')).toBe(1);

    // Black sits down with a smaller field: White's board shrinks under her.
    expect((await join(game.black, game.joinCode, { field: fieldB(), disclosureAccepted: true })).status).toBe(200);
    expect(await presenceZone(game, 'w')).toBe(0);
    const boardA = boardOf(w);
    expect(inStartZone(boardA, e1, 'w', DEFAULT_REACH).ok).toBe(false);

    // Black's one relay from her own e8 must not start the game.
    const b = await openSocket(game, game.black);
    const e8 = squareCentreLatLng(boardOf(b), fromSquare('e8'));
    b.send({ t: 'pos', lat: e8.lat, lng: e8.lng, acc: 3 });
    await handled(b.ws);
    await handled(w.ws);
    expect(w.last().status).toBe('staging');
    expect(((w.last().players as Record<string, Msg>).w as Msg).inStartZone).toBe(false);
    const row = await runInDurableObject(stub(game), (_i, state) =>
      [...state.storage.sql.exec<{ status: string }>(`SELECT status FROM game`)][0]!.status,
    );
    expect(row).toBe('staging');

    // Walking to the shrunk e1 starts it, as ever (past the relay's floor).
    await runInDurableObject(stub(game), (_i, state) => {
      state.storage.sql.exec(`UPDATE presence SET last_relay_at = 0`);
    });
    w.send({ t: 'pos', ...on(boardA, 'e1'), acc: 3 });
    await w.state((g) => g.status === 'active');
  });

  it('keeps the flag of a player standing where both boards put the back rank', async () => {
    const { game, w } = await waiting();
    const fullA = geometryFromSnapshot(snapshotField(fieldA()));
    // Two thirds of a square up from e1's centre: inside e1's reach on the
    // field as it is, and within reach of e1 once the board has shrunk.
    const spot = squareCentreLatLng(fullA, { file: 4, rank: 0.66 });
    expect(inStartZone(fullA, spot, 'w', DEFAULT_REACH).ok).toBe(true);
    w.send({ t: 'pos', lat: spot.lat, lng: spot.lng, acc: 3 });
    await handled(w.ws);
    expect(await presenceZone(game, 'w')).toBe(1);

    expect((await join(game.black, game.joinCode, { field: fieldB(), disclosureAccepted: true })).status).toBe(200);
    await handled(w.ws);
    expect(inStartZone(boardOf(w), spot, 'w', DEFAULT_REACH).ok).toBe(true);
    expect(await presenceZone(game, 'w')).toBe(1);
    expect(((w.last().players as Record<string, Msg>).w as Msg).inStartZone).toBe(true);
  });
});

describe('a back rank and a socket that has gone (decision 0037)', () => {
  it('is not raised again from a stale fix when the joiner sits down', async () => {
    // The creator is on the smaller field, so her board does not change at
    // the join and her old fix would still read as on her back rank.
    const white = nextSub();
    const joinCode = await create(white, { field: fieldB() });
    const game = { joinCode, white, black: nextSub() };
    const w = await openSocket(game, white);
    const boardW = boardOf(w);
    w.send({ t: 'pos', ...on(boardW, 'e1'), acc: 3 });
    await handled(w.ws);
    const flag = () =>
      runInDurableObject(stub(game), (_i, state) =>
        [...state.storage.sql.exec<{ z: number; c: number }>(
          `SELECT in_start_zone AS z, connected AS c FROM presence WHERE color = 'w'`,
        )][0]!,
      );
    expect(await flag()).toMatchObject({ z: 1, c: 1 });

    // She closes the board: the evidence goes with the socket.
    w.ws.close();
    for (let i = 0; i < 200 && (await flag()).c !== 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(await flag()).toMatchObject({ z: 0, c: 0 });

    // The joiner, with the larger field, sits down: her flag stays down.
    expect((await join(game.black, joinCode, { field: fieldA(), disclosureAccepted: true })).status).toBe(200);
    expect(await flag()).toMatchObject({ z: 0, c: 0 });

    // She comes back and says nothing; the joiner relays from his own e8.
    const w2 = await openSocket(game, white);
    const b = await openSocket(game, game.black);
    b.send({ t: 'pos', ...on(boardOf(b), 'e8'), acc: 3 });
    await handled(b.ws);
    await handled(w2.ws);
    expect(w2.last().status).toBe('staging');
    expect(await flag()).toMatchObject({ z: 0, c: 1 });
    const status = await runInDurableObject(stub(game), (_i, state) =>
      [...state.storage.sql.exec<{ status: string }>(`SELECT status FROM game`)][0]!.status,
    );
    expect(status).toBe('staging');
  });
});

describe('a back rank raised only by the socket that is open now (decisions 0037, 0005)', () => {
  it('is not raised from a stale fix for a creator who came back and said nothing', async () => {
    // The creator is on the smaller field, so her board does not change at
    // the join and her old fix would still read as on her back rank.
    const white = nextSub();
    const joinCode = await create(white, { field: fieldB() });
    const game = { joinCode, white, black: nextSub() };
    const w = await openSocket(game, white);
    w.send({ t: 'pos', ...on(boardOf(w), 'e1'), acc: 3 });
    await handled(w.ws);
    const flag = () =>
      runInDurableObject(stub(game), (_i, state) =>
        [...state.storage.sql.exec<{ z: number; c: number }>(
          `SELECT in_start_zone AS z, connected AS c FROM presence WHERE color = 'w'`,
        )][0]!,
      );
    expect(await flag()).toMatchObject({ z: 1, c: 1 });
    w.ws.close();
    for (let i = 0; i < 200 && (await flag()).c !== 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(await flag()).toMatchObject({ z: 0, c: 0 });

    // She reconnects from somewhere else and sends nothing.
    const w2 = await openSocket(game, white);
    expect(await flag()).toMatchObject({ z: 0, c: 1 });

    // The joiner sits down; her flag stays down, and his relay from e8 does
    // not start the game.
    expect((await join(game.black, joinCode, { field: fieldA(), disclosureAccepted: true })).status).toBe(200);
    expect(await flag()).toMatchObject({ z: 0, c: 1 });
    const b = await openSocket(game, game.black);
    b.send({ t: 'pos', ...on(boardOf(b), 'e8'), acc: 3 });
    await handled(b.ws);
    await handled(w2.ws);
    expect(w2.last().status).toBe('staging');
    const status = await runInDurableObject(stub(game), (_i, state) =>
      [...state.storage.sql.exec<{ status: string }>(`SELECT status FROM game`)][0]!.status,
    );
    expect(status).toBe('staging');

    // Her own relay from e1 on this socket is what raises it, and starts it.
    await runInDurableObject(stub(game), (_i, state) => {
      state.storage.sql.exec(`UPDATE presence SET last_relay_at = 0`);
    });
    w2.send({ t: 'pos', ...on(boardOf(w2), 'e1'), acc: 3 });
    await w2.state((g) => g.status === 'active');
  });
});

describe('schema 10', () => {
  it('upgrades a same-field game in play from schema 9, and it plays on as a same-field game', async () => {
    const white = nextSub();
    const black = nextSub();
    const created = await call(white, '/api/game', {
      method: 'POST',
      body: JSON.stringify({ field: fieldB(), color: 'w' }),
    });
    const joinCode = ((await created.json()) as { joinCode: string }).joinCode;
    expect((await join(black, joinCode, {})).status).toBe(200);
    const game = { joinCode, white, black };
    const w = await openSocket(game, white);
    const b = await openSocket(game, black);
    const geo = geometryFromSnapshot(w.last().field as FieldSnapshot);
    w.send({ t: 'ready', pos: on(geo, 'e1') });
    b.send({ t: 'ready', pos: on(geo, 'e8') });
    await w.state((g) => g.status === 'active');
    await move(game, w, geo, 'e2', 'e4');

    // Back to schema 9: no `remote` column and no `seat_field` table. Rebuilt
    // first: SQLite's DROP COLUMN chokes on a CREATE with comment lines
    // before its last column (`gotchas.md`).
    await runInDurableObject(stub(game), (_i, state) => {
      const sql = state.storage.sql;
      sql.exec(`CREATE TABLE game_old AS SELECT * FROM game`);
      sql.exec(`DROP TABLE game`);
      sql.exec(`CREATE TABLE game AS SELECT * FROM game_old`);
      sql.exec(`DROP TABLE game_old`);
      sql.exec(`ALTER TABLE game DROP COLUMN remote`);
      sql.exec(`DROP TABLE seat_field`);
      sql.exec(`UPDATE meta SET value = '9' WHERE key = 'schema_version'`);
      applySchema(sql);
    });
    const upgraded = await runInDurableObject(stub(game), (_i, state) => ({
      remote: [...state.storage.sql.exec(`SELECT remote FROM game`)],
      seats: [...state.storage.sql.exec(`SELECT COUNT(*) AS n FROM seat_field`)],
      version: [...state.storage.sql.exec(`SELECT value FROM meta WHERE key = 'schema_version'`)],
    }));
    expect(upgraded).toEqual({ remote: [{ remote: null }], seats: [{ n: 0 }], version: [{ value: '10' }] });

    b.send({ t: 'sync' });
    const snapshot = await b.state(() => true);
    expect(snapshot).not.toHaveProperty('remote');
    await move(game, b, geo, 'e7', 'e5');
    await handled(w.ws);
    expect(w.last().moveCount).toBe(2);
    expect(w.last()).not.toHaveProperty('remote');
  });
});

describe('the seam', () => {
  it('never reads the game-wide field in a remote game: a corrupt one changes nothing and leaks nothing', async () => {
    const game = await seated();
    await runInDurableObject(stub(game), (_i, state) => {
      state.storage.sql.exec(`UPDATE game SET field_snapshot_json = '{"not a field'`);
    });
    const w = await openSocket(game, game.white);
    const b = await openSocket(game, game.black);
    const boardA = boardOf(w);
    const boardB = boardOf(b);
    w.send({ t: 'ready', pos: on(boardA, 'e1') });
    b.send({ t: 'ready', pos: on(boardB, 'e8') });
    await w.state((g) => g.status === 'active');
    await move(game, w, boardA, 'e2', 'e4');
    await move(game, b, boardB, 'e7', 'e5');
    await handled(w.ws);
    expect(w.last().moveCount).toBe(2);
    expect((w.last().field as FieldSnapshot).fieldId).toBe('field-a');
    expect((b.last().field as FieldSnapshot).fieldId).toBe('field-b');

    const review = (await (await call(game.white, `/api/game/${game.joinCode}/review`)).json()) as {
      report: GameReport;
    };
    expect(review.report.moves).toHaveLength(2);
    expect(review.report.squareM).toBe(boardB.meanSquareM);
    expect(review.report.moves[1]!.place).toMatchObject({ file: expect.closeTo(4, 4), rank: expect.closeTo(4, 4) });
    expect(((await peek(game.white, game.joinCode)).field as FieldSnapshot).fieldId).toBe('field-a');
    expect(((await peek(game.black, game.joinCode)).field as FieldSnapshot).fieldId).toBe('field-b');

    expect(leaks(b.raw, MARK_A)).toEqual([]);
    expect(leaks(w.raw, MARK_B)).toEqual([]);
    expect(leaks([JSON.stringify(review)], [...MARK_A, ...MARK_B])).toEqual([]);
  });
});
