import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { fromLocal } from '../../src/shared/geo.js';
import { makeFieldSpec, snapshotField, squareCentreLatLng, deriveGeometry } from '../../src/shared/field.js';
import { fromSquare } from '../../src/shared/squares.js';
import { DISCONNECT_GRACE_MS, UNCLAIMED_GAME_TTL_MS } from '../../src/shared/protocol.js';
import type { GameDO } from '../../src/worker/game-do.js';
import { Timers } from '../../src/worker/timers.js';

/** An 8 m-square field laid out due east/north, as in the model tests. */
const A1 = { lat: 51.4779, lng: -0.0015 };
const SQUARE_M = 8;
const FIELD = snapshotField(
  makeFieldSpec('Test field', A1, fromLocal(A1, { e: 7 * SQUARE_M, n: 7 * SQUARE_M })),
);
const GEO = deriveGeometry(FIELD);

const WHITE = 'player-white-0001';
const BLACK = 'player-black-0002';
const THIRD = 'player-third-0003';

let code = 0;
/** A fresh join code per test, so objects never share state. */
function nextCode(): string {
  code += 1;
  return `T${String(code).padStart(5, '0')}`;
}

async function createGame(
  joinCode: string,
  opts: { initialMs?: number; incrementMs?: number } = {},
): Promise<DurableObjectStub<GameDO>> {
  const stub = env.GAME.getByName(joinCode);
  const created = await stub.create({
    joinCode,
    creatorPlayerId: WHITE,
    creatorColor: 'w',
    field: FIELD,
    initialMs: opts.initialMs ?? 600_000,
    incrementMs: opts.incrementMs ?? 10_000,
  });
  expect(created).toBe(true);
  return stub;
}

type Msg = Record<string, unknown>;

/**
 * A client socket that buffers everything it receives.
 *
 * Buffering from the moment of `accept()` is not a nicety. The object sends a
 * full snapshot during the upgrade, so a test that attaches its listener after
 * `openSocket` resolves can miss that first message entirely — which shows up as
 * an intermittent timeout rather than an honest failure.
 */
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
        // The keepalive auto-response is the bare string "P", not JSON.
        msg = { t: 'raw', data: String((event as MessageEvent).data) };
      }
      this.received.push(msg);
      const index = this.waiters.findIndex((w) => w.predicate(msg));
      if (index >= 0) this.waiters.splice(index, 1)[0].resolve(msg);
    });
  }

  /** Resolve with the first buffered or future message matching `predicate`. */
  next(predicate: (m: Msg) => boolean = () => true, timeoutMs = 2000): Promise<Msg> {
    const buffered = this.received.find(predicate);
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out; received ${JSON.stringify(this.received.map((m) => m.t))}`)),
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

  /** Drop anything already received, so a later `next` only sees new traffic. */
  clear(): void {
    this.received.length = 0;
  }

  close(): void {
    this.ws.close();
  }
}

/** Open a real WebSocket to a game through the router. */
async function openSocket(joinCode: string, playerId: string): Promise<Client> {
  const res = await SELF.fetch(
    `https://example.com/api/game/${joinCode}/ws?playerId=${playerId}`,
    { headers: { upgrade: 'websocket' } },
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error('no webSocket on the response');
  return new Client(ws);
}

beforeEach(() => {
  code += 1000; // Extra separation between test files sharing the namespace.
});

describe('creating and joining', () => {
  it('creates a game and refuses to create it twice', async () => {
    const joinCode = nextCode();
    const stub = await createGame(joinCode);

    // The second attempt is how a code collision is detected (decision 0007).
    const again = await stub.create({
      joinCode,
      creatorPlayerId: THIRD,
      creatorColor: 'w',
      field: FIELD,
      initialMs: 600_000,
      incrementMs: 0,
    });
    expect(again).toBe(false);
  });

  it('starts as waiting with one seat free', async () => {
    const stub = await createGame(nextCode());
    expect(await stub.peek()).toMatchObject({ exists: true, status: 'waiting', seatsFree: 1 });
  });

  it('reports a code that was never created as nonexistent', async () => {
    const stub = env.GAME.getByName(nextCode());
    expect(await stub.peek()).toEqual({ exists: false });
  });

  it('seats the joiner in the other colour and moves to staging', async () => {
    const stub = await createGame(nextCode());
    expect(await stub.join(BLACK)).toEqual({ ok: true, color: 'b' });
    expect(await stub.peek()).toMatchObject({ status: 'staging', seatsFree: 0 });
  });

  it('is idempotent for a player already seated', async () => {
    const stub = await createGame(nextCode());
    expect(await stub.join(BLACK)).toEqual({ ok: true, color: 'b' });
    // Reopening the link must not be an error, and must not take the other seat.
    expect(await stub.join(BLACK)).toEqual({ ok: true, color: 'b' });
    expect(await stub.join(WHITE)).toEqual({ ok: true, color: 'w' });
  });

  it('refuses a third player', async () => {
    const stub = await createGame(nextCode());
    await stub.join(BLACK);
    expect(await stub.join(THIRD)).toEqual({ ok: false, reason: 'full' });
  });

  it('refuses to join a game that does not exist', async () => {
    const stub = env.GAME.getByName(nextCode());
    expect(await stub.join(BLACK)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('carries the field snapshot, so a joiner needs no field of their own', async () => {
    const stub = await createGame(nextCode());
    const peeked = await stub.peek();
    expect(peeked.field?.a1).toEqual(FIELD.a1);
    expect(peeked.field?.squareM).toBeCloseTo(SQUARE_M, 6);
  });
});

describe('the clock does not start until the game does', () => {
  it('is stopped while waiting and while staging', async () => {
    const stub = await createGame(nextCode(), { initialMs: 600_000 });
    expect(await stub.clocks()).toMatchObject({ w: 600_000, b: 600_000, running: false });
    await stub.join(BLACK);
    expect(await stub.clocks()).toMatchObject({ running: false });
  });

  it('does not drain over time while stopped', async () => {
    const stub = await createGame(nextCode(), { initialMs: 600_000 });
    await stub.join(BLACK);
    await new Promise((r) => setTimeout(r, 30));
    const clocks = await stub.clocks();
    expect(clocks.w).toBe(600_000);
    expect(clocks.b).toBe(600_000);
  });
});

describe('the HTTP routes', () => {
  it('creates a game over POST and returns a usable code', async () => {
    const res = await SELF.fetch('https://example.com/api/game', {
      method: 'POST',
      body: JSON.stringify({
        playerId: WHITE,
        field: makeFieldSpec('f', A1, fromLocal(A1, { e: 56, n: 56 })),
        initialMs: 600_000,
        incrementMs: 10_000,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { joinCode: string; color: string };
    expect(body.color).toBe('w');
    expect(body.joinCode).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);

    const peek = await SELF.fetch(`https://example.com/api/game/${body.joinCode}`);
    expect(await peek.json()).toMatchObject({ exists: true, status: 'waiting' });
  });

  it('folds a mistyped code rather than rejecting it', async () => {
    // Crockford: O reads as 0, I and L as 1. Someone reading a code aloud across
    // a field will get this wrong, and it should still work.
    const res = await SELF.fetch('https://example.com/api/game/0I1234');
    expect(res.status).toBe(200);
    const direct = await SELF.fetch('https://example.com/api/game/011234');
    expect(await direct.json()).toEqual(await res.json());
  });

  it('rejects a code that could not be one', async () => {
    const res = await SELF.fetch('https://example.com/api/game/nope');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_code' });
  });

  it('requires a plausible playerId', async () => {
    const res = await SELF.fetch('https://example.com/api/game', {
      method: 'POST',
      body: JSON.stringify({ playerId: 'x', field: makeFieldSpec('f', A1, fromLocal(A1, { e: 56, n: 56 })) }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a degenerate field instead of storing it', async () => {
    const res = await SELF.fetch('https://example.com/api/game', {
      method: 'POST',
      body: JSON.stringify({
        playerId: WHITE,
        // Both corners in the same place: no square size can be derived.
        field: { id: 'x', name: 'x', a1: A1, h8: A1, version: 1, createdAt: 0, updatedAt: 0 },
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_field' });
  });

  it('refuses a WebSocket route without an upgrade header', async () => {
    const joinCode = nextCode();
    await createGame(joinCode);
    const res = await SELF.fetch(`https://example.com/api/game/${joinCode}/ws?playerId=${WHITE}`);
    expect(res.status).toBe(426);
  });

  it('404s an unknown endpoint rather than serving the shell', async () => {
    const res = await SELF.fetch('https://example.com/api/nonsense');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('WebSockets', () => {
  it('sends a full snapshot on connect', async () => {
    const joinCode = nextCode();
    const stub = await createGame(joinCode);
    await stub.join(BLACK);

    const ws = await openSocket(joinCode, WHITE);
    const msg = await ws.next((m) => m.t === 'state');
    const game = msg.game as Record<string, unknown>;
    expect(game.you).toBe('w');
    expect(game.status).toBe('staging');
    expect(game.fen).toContain('rnbqkbnr');
    expect(game.joinCode).toBe(joinCode);
    ws.close();
  });

  it('refuses a socket for someone not in the game', async () => {
    const joinCode = nextCode();
    await createGame(joinCode);
    const res = await SELF.fetch(
      `https://example.com/api/game/${joinCode}/ws?playerId=${THIRD}`,
      { headers: { upgrade: 'websocket' } },
    );
    expect(res.status).toBe(403);
  });

  it('refuses a socket for a game that does not exist', async () => {
    const res = await SELF.fetch(
      `https://example.com/api/game/${nextCode()}/ws?playerId=${WHITE}`,
      { headers: { upgrade: 'websocket' } },
    );
    expect(res.status).toBe(404);
  });

  it('answers a keepalive ping without waking the object', async () => {
    const joinCode = nextCode();
    const stub = await createGame(joinCode);
    await stub.join(BLACK);
    const ws = await openSocket(joinCode, WHITE);
    await ws.next((m) => m.t === 'state');

    // The runtime auto-responds to this pair, so it costs no request and the
    // handler never runs — which is what makes an idle game free.
    const pong = ws.next((m) => m.t === 'raw');
    ws.ws.send('p');
    expect((await pong).data).toBe('P');
    ws.close();
  });

  it('rejects a malformed frame with a specific error', async () => {
    const joinCode = nextCode();
    const stub = await createGame(joinCode);
    await stub.join(BLACK);
    const ws = await openSocket(joinCode, WHITE);
    await ws.next((m) => m.t === 'state');

    ws.ws.send('{not json');
    const err = await ws.next((m) => m.t === 'error');
    expect(err).toMatchObject({ code: 'bad_message' });
    ws.close();
  });

  it('names an unrecognised message rather than going silent', async () => {
    const joinCode = nextCode();
    const stub = await createGame(joinCode);
    await stub.join(BLACK);
    const ws = await openSocket(joinCode, WHITE);
    await ws.next((m) => m.t === 'state');

    // Silence would look like a dropped message to a client in a field.
    ws.ws.send(JSON.stringify({ t: 'offer_draw' }));
    const err = await ws.next((m) => m.t === 'error');
    expect(err.code).toBe('bad_message');
    // The reply names the message, so a stale client can say what it tried.
    expect(String(err.message)).toContain('offer_draw');
    ws.close();
  });

  it('answers a sync request with current state', async () => {
    const joinCode = nextCode();
    const stub = await createGame(joinCode);
    await stub.join(BLACK);
    const ws = await openSocket(joinCode, WHITE);
    await ws.next((m) => m.t === 'state');

    ws.ws.send(JSON.stringify({ t: 'sync' }));
    const state = await ws.next((m) => m.t === 'state');
    expect((state.game as Record<string, unknown>).you).toBe('w');
    ws.close();
  });
});

describe('position relay', () => {
  it('relays a position to the opponent but not back to the sender', async () => {
    const joinCode = nextCode();
    const stub = await createGame(joinCode);
    await stub.join(BLACK);

    const white = await openSocket(joinCode, WHITE);
    const black = await openSocket(joinCode, BLACK);
    await white.next((m) => m.t === 'state');
    await black.next((m) => m.t === 'state');

    const seenByBlack = black.next((m) => m.t === 'opp_pos');
    const pos = squareCentreLatLng(GEO, fromSquare('e2'));
    white.ws.send(JSON.stringify({ t: 'pos', lat: pos.lat, lng: pos.lng, acc: 4, travelM: 12 }));

    const relayed = await seenByBlack;
    expect(relayed.lat).toBeCloseTo(pos.lat, 9);
    expect(relayed.acc).toBe(4);

    white.close();
    black.close();
  });

  it('repeats the last relayed position in the snapshot, for a socket that missed it', async () => {
    const joinCode = nextCode();
    const stub = await createGame(joinCode);
    await stub.join(BLACK);

    const white = await openSocket(joinCode, WHITE);
    await white.next((m) => m.t === 'state');
    const pos = squareCentreLatLng(GEO, fromSquare('e2'));
    white.ws.send(JSON.stringify({ t: 'pos', lat: pos.lat, lng: pos.lng, acc: 4 }));

    // Black arrives afterwards, so the relay is already history. Without the
    // snapshot carrying it, black has nothing to draw until white next moves —
    // and a player standing still relays once and then says nothing at all.
    const black = await openSocket(joinCode, BLACK);
    const state = await black.next((m) => m.t === 'state');
    const players = (state.game as { players: Record<string, { pos: Record<string, number> | null }> })
      .players;

    expect(players.w.pos?.lat).toBeCloseTo(pos.lat, 9);
    expect(players.w.pos?.acc).toBe(4);
    expect(players.w.pos?.at).toBeGreaterThan(0);
    // And black, who has relayed nothing, is honestly reported as unknown.
    expect(players.b.pos).toBeNull();

    white.close();
    black.close();
  });

  it('rate-limits a client that ignores the send policy', async () => {
    const joinCode = nextCode();
    const stub = await createGame(joinCode);
    await stub.join(BLACK);
    const white = await openSocket(joinCode, WHITE);
    await white.next((m) => m.t === 'state');

    const pos = squareCentreLatLng(GEO, fromSquare('e2'));
    // A misbehaving client could otherwise spend the whole account's daily
    // request budget on one game.
    for (let i = 0; i < 10; i++) {
      white.ws.send(JSON.stringify({ t: 'pos', lat: pos.lat, lng: pos.lng, acc: 4 }));
    }
    await new Promise((r) => setTimeout(r, 100));

    const stored = await runInDurableObject(stub, (_instance, state) => {
      const rows = [...state.storage.sql.exec<{ last_pos_at: number | null }>(
        `SELECT last_pos_at FROM presence WHERE color = 'w'`,
      )];
      return rows[0]?.last_pos_at ?? null;
    });
    expect(stored).not.toBeNull();
    white.close();
  });

  it('ignores an implausible coordinate', async () => {
    const joinCode = nextCode();
    const stub = await createGame(joinCode);
    await stub.join(BLACK);
    const white = await openSocket(joinCode, WHITE);
    await white.next((m) => m.t === 'state');

    white.ws.send(JSON.stringify({ t: 'pos', lat: 999, lng: 0, acc: 4 }));
    await new Promise((r) => setTimeout(r, 60));

    const stored = await runInDurableObject(stub, (_instance, state) =>
      [...state.storage.sql.exec<{ last_lat: number | null }>(
        `SELECT last_lat FROM presence WHERE color = 'w'`,
      )][0]?.last_lat ?? null,
    );
    expect(stored).toBeNull();
    white.close();
  });

  it('records whether a player is standing in their own start zone', async () => {
    const joinCode = nextCode();
    const stub = await createGame(joinCode);
    await stub.join(BLACK);
    const white = await openSocket(joinCode, WHITE);
    await white.next((m) => m.t === 'state');

    // d1 is on white's back rank; the handshake in phase 7 depends on this.
    const onBackRank = squareCentreLatLng(GEO, fromSquare('d1'));
    white.ws.send(JSON.stringify({ t: 'pos', lat: onBackRank.lat, lng: onBackRank.lng, acc: 3 }));
    await new Promise((r) => setTimeout(r, 60));

    const inZone = await runInDurableObject(stub, (_instance, state) =>
      [...state.storage.sql.exec<{ in_start_zone: number }>(
        `SELECT in_start_zone FROM presence WHERE color = 'w'`,
      )][0]?.in_start_zone,
    );
    expect(inZone).toBe(1);
    white.close();
  });

  it('does not count the middle of the board as a start zone', async () => {
    const joinCode = nextCode();
    const stub = await createGame(joinCode);
    await stub.join(BLACK);
    const white = await openSocket(joinCode, WHITE);
    await white.next((m) => m.t === 'state');

    const middle = squareCentreLatLng(GEO, fromSquare('d4'));
    white.ws.send(JSON.stringify({ t: 'pos', lat: middle.lat, lng: middle.lng, acc: 3 }));
    await new Promise((r) => setTimeout(r, 60));

    const inZone = await runInDurableObject(stub, (_instance, state) =>
      [...state.storage.sql.exec<{ in_start_zone: number }>(
        `SELECT in_start_zone FROM presence WHERE color = 'w'`,
      )][0]?.in_start_zone,
    );
    expect(inZone).toBe(0);
    white.close();
  });
});

describe('presence and disconnection', () => {
  it('marks a player connected, and disconnected when their socket closes', async () => {
    const joinCode = nextCode();
    const stub = await createGame(joinCode);
    await stub.join(BLACK);

    const white = await openSocket(joinCode, WHITE);
    await white.next((m) => m.t === 'state');

    const connectedNow = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ connected: number }>(
        `SELECT connected FROM presence WHERE color = 'w'`,
      )][0]?.connected,
    );
    expect(connectedNow).toBe(1);

    white.close();
    await new Promise((r) => setTimeout(r, 120));

    const connectedAfter = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ connected: number }>(
        `SELECT connected FROM presence WHERE color = 'w'`,
      )][0]?.connected,
    );
    expect(connectedAfter).toBe(0);
  });
});

describe('the timer scheduler', () => {
  it('schedules garbage collection for an unclaimed code', async () => {
    const joinCode = nextCode();
    const stub = await createGame(joinCode);

    const timers = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ kind: string; due_at: number }>(
        `SELECT kind, due_at FROM timers`,
      )],
    );
    expect(timers).toHaveLength(1);
    expect(timers[0].kind).toBe('gc');
    // Roughly the TTL away, allowing for the time the test itself took.
    expect(timers[0].due_at - Date.now()).toBeGreaterThan(UNCLAIMED_GAME_TTL_MS - 5_000);
  });

  it('cancels garbage collection once someone joins', async () => {
    const stub = await createGame(nextCode());
    await stub.join(BLACK);
    const timers = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec(`SELECT kind FROM timers`)],
    );
    expect(timers).toHaveLength(0);
  });

  it('points the single alarm at the earliest of several deadlines', async () => {
    const stub = await createGame(nextCode());

    // Exercise `Timers` itself rather than hand-writing SQL, since the whole
    // point of decision 0006 is that feature code never touches `setAlarm`.
    const alarm = await runInDurableObject(stub, async (_i, state) => {
      const timers = new Timers(state);
      // `create` already scheduled `gc`, so clear the slate to make the ordering
      // being asserted unambiguous.
      await timers.cancel('gc');
      await timers.schedule('flag', 5_000_000_000_000);
      await timers.schedule('disconnect', 4_000_000_000_000);
      return state.storage.getAlarm();
    });
    expect(alarm).toBe(4_000_000_000_000);

    // Cancelling the nearer one must move the alarm out to the next, not clear it.
    const afterCancel = await runInDurableObject(stub, async (_i, state) => {
      const timers = new Timers(state);
      await timers.cancel('disconnect');
      return state.storage.getAlarm();
    });
    expect(afterCancel).toBe(5_000_000_000_000);

    // And cancelling the last one clears the alarm entirely.
    const afterAll = await runInDurableObject(stub, async (_i, state) => {
      const timers = new Timers(state);
      await timers.cancel('flag');
      return state.storage.getAlarm();
    });
    expect(afterAll).toBeNull();
  });

  it('claims only the deadlines that are actually due', async () => {
    const stub = await createGame(nextCode());
    const claimed = await runInDurableObject(stub, async (_i, state) => {
      const timers = new Timers(state);
      await timers.cancel('gc');
      await timers.schedule('flag', 1_000);
      await timers.schedule('disconnect', 9_000);
      return {
        due: timers.claimDue(5_000),
        left: timers.list().map((row) => row.kind),
      };
    });
    expect(claimed.due).toEqual(['flag']);
    // Claiming removes what it returns, so a throwing handler cannot leave a
    // deadline firing in a loop.
    expect(claimed.left).toEqual(['disconnect']);
  });

  it('deletes everything when the garbage-collection deadline fires', async () => {
    const joinCode = nextCode();
    const stub = await createGame(joinCode);

    // Bring the deadline forward rather than waiting half an hour. The alarm
    // itself is left in the future: setting it in the past makes the runtime fire
    // it immediately, and then `runDurableObjectAlarm` finds nothing to run.
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec(`UPDATE timers SET due_at = ? WHERE kind = 'gc'`, Date.now() - 1);
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // An object with entirely empty storage ceases to exist, which frees the code.
    expect(await stub.peek()).toEqual({ exists: false });
  });

  it('suspends an active game when the disconnect grace period expires', async () => {
    const joinCode = nextCode();
    const stub = await createGame(joinCode, { initialMs: 600_000 });
    await stub.join(BLACK);

    // Phase 5 owns the transition into `active`; force it here so the grace
    // period has something to suspend.
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(
        `UPDATE game SET status = 'active', last_clock_start_at = ? WHERE id = 1`,
        Date.now() - 5_000,
      );
    });

    const white = await openSocket(joinCode, WHITE);
    await white.next((m) => m.t === 'state');
    white.close();
    await new Promise((r) => setTimeout(r, 120));

    const pending = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ kind: string; due_at: number }>(
        `SELECT kind, due_at FROM timers WHERE kind = 'disconnect'`,
      )][0] ?? null,
    );
    expect(pending).not.toBeNull();
    expect(pending!.due_at - Date.now()).toBeLessThanOrEqual(DISCONNECT_GRACE_MS);

    // Fire it early rather than waiting twenty seconds.
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.sql.exec(`UPDATE timers SET due_at = ? WHERE kind = 'disconnect'`, Date.now() - 1);
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await stub.peek()).toMatchObject({ status: 'suspended' });
    // A dropped connection is a failure, not a decision, so it must not cost time.
    const clocks = await stub.clocks();
    expect(clocks.running).toBe(false);
    expect(clocks.w).toBeGreaterThan(590_000);
    expect(clocks.w).toBeLessThan(600_000);
  });

  it('calls off a pending suspension when the player comes back in time', async () => {
    const joinCode = nextCode();
    const stub = await createGame(joinCode, { initialMs: 600_000 });
    await stub.join(BLACK);
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(
        `UPDATE game SET status = 'active', last_clock_start_at = ? WHERE id = 1`,
        Date.now(),
      );
    });

    const black = await openSocket(joinCode, BLACK);
    await black.next((m) => m.t === 'state');
    const white = await openSocket(joinCode, WHITE);
    await white.next((m) => m.t === 'state');

    white.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(
      await runInDurableObject(stub, (_i, state) =>
        [...state.storage.sql.exec(`SELECT kind FROM timers WHERE kind = 'disconnect'`)].length,
      ),
    ).toBe(1);

    // Walking back out from behind the building.
    const again = await openSocket(joinCode, WHITE);
    await again.next((m) => m.t === 'state');
    expect(
      await runInDurableObject(stub, (_i, state) =>
        [...state.storage.sql.exec(`SELECT kind FROM timers WHERE kind = 'disconnect'`)].length,
      ),
    ).toBe(0);
    expect(await stub.peek()).toMatchObject({ status: 'active' });

    again.close();
    black.close();
  });
});

describe('surviving hibernation', () => {
  it('reconstructs the clock from stored timestamps alone', async () => {
    const joinCode = nextCode();
    const stub = await createGame(joinCode, { initialMs: 600_000 });
    await stub.join(BLACK);

    const startedAt = Date.now() - 30_000;
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(
        `UPDATE game SET status = 'active', last_clock_start_at = ? WHERE id = 1`,
        startedAt,
      );
    });

    // Nothing is cached in memory, so a fresh read has to derive the same answer
    // that a woken object would. This is the property the whole clock design
    // exists to guarantee.
    const clocks = await stub.clocks();
    expect(clocks.running).toBe(true);
    expect(clocks.w).toBeGreaterThan(565_000);
    expect(clocks.w).toBeLessThan(575_000);
    expect(clocks.b).toBe(600_000);
  });

  it('applies the schema idempotently across repeated construction', async () => {
    const joinCode = nextCode();
    const stub = await createGame(joinCode);
    await stub.join(BLACK);

    // Several round trips, each of which may construct the object afresh.
    for (let i = 0; i < 3; i++) {
      expect(await stub.peek()).toMatchObject({ exists: true });
    }
    const tables = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
      )].map((r) => r.name),
    );
    expect(tables).toContain('game');
    expect(tables).toContain('moves');
    expect(tables).toContain('presence');
    expect(tables).toContain('carry');
    expect(tables).toContain('timers');
    // Still exactly one game row.
    const count = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM game`)][0].n,
    );
    expect(count).toBe(1);
  });
});
