import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeFieldSpec } from '../../src/shared/field.js';
import { fromLocal } from '../../src/shared/geo.js';
import { CLAIM_AFTER_MS } from '../../src/shared/protocol.js';
import type { ListedGame } from '../../src/shared/game-index.js';
import type { GameDO } from '../../src/worker/game-do.js';

/**
 * The game index, end to end in the real runtime (stage 2.3.4).
 *
 * What needs `workerd` here is the part no node test can fake: the **game
 * writing into an account's Durable Object**. `GameDO` calls `UserDO` over the
 * `USER` binding when a game changes state, and the whole design rests on that
 * being the only way a row is ever written (decision 0033) — so the tests are
 * mostly "make a game do something, then look in somebody's list".
 *
 * The second thing that only shows up here is stage 3.5.2: a seat belongs to an
 * **account**, not to a phone. That is what makes the list actionable rather
 * than merely readable, and it is invisible until there are two cookies for one
 * `sub`.
 */

const SECRET = 'test-dev-auth-secret';
const LOCAL = 'http://127.0.0.1';
const A1 = { lat: 51.4779, lng: -0.0015 };
const SQUARE_M = 8;
const FIELD = makeFieldSpec('The common', {
  a1: A1,
  h8: fromLocal(A1, { e: 7 * SQUARE_M, n: 7 * SQUARE_M }),
});

const mutableEnv = env as unknown as Record<string, unknown>;

async function signIn(sub: string): Promise<string> {
  mutableEnv.DEV_AUTH_SECRET = SECRET;
  const response = await SELF.fetch(`${LOCAL}/api/dev/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dev-auth-secret': SECRET },
    body: JSON.stringify({ sub }),
  });
  expect(response.status).toBe(200);
  return (response.headers.get('set-cookie') as string).split(';')[0];
}

let phone = 0;
/** A player id per call, standing in for a phone that has never signed in. */
function nextPhone(): string {
  phone += 1;
  return `phone-${String(phone).padStart(8, '0')}`;
}

async function createGame(
  cookie: string | null,
  colour: 'w' | 'b' = 'w',
): Promise<{ joinCode: string; color: string }> {
  const response = await SELF.fetch(`${LOCAL}/api/game`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === null ? {} : { cookie }),
    },
    body: JSON.stringify({ playerId: nextPhone(), field: FIELD, color: colour }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { joinCode: string; color: string };
}

async function join(
  joinCode: string,
  cookie: string | null,
): Promise<{ status: number; body: { color?: string; message?: string } }> {
  const response = await SELF.fetch(`${LOCAL}/api/game/${joinCode}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === null ? {} : { cookie }),
    },
    body: JSON.stringify({ playerId: nextPhone() }),
  });
  return { status: response.status, body: (await response.json()) as { color?: string } };
}

async function listGames(cookie: string | null): Promise<ListedGame[]> {
  const response = await SELF.fetch(`${LOCAL}/api/games`, {
    headers: cookie === null ? {} : { cookie },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { games: ListedGame[] }).games;
}

async function forget(
  cookie: string,
  joinCodes: string[],
): Promise<{ forgotten: string[]; kept: { joinCode: string; reason: string }[] }> {
  const response = await SELF.fetch(`${LOCAL}/api/games/forget`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ joinCodes }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    forgotten: string[];
    kept: { joinCode: string; reason: string }[];
  };
}

/** Reach into a game and set what phase 4 and 5 would have set by playing it. */
async function forceGame(joinCode: string, sql: string, ...bindings: unknown[]): Promise<void> {
  const stub = env.GAME.getByName(joinCode) as DurableObjectStub<GameDO>;
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(sql, ...(bindings as never[]));
  });
}

let account = 0;
function nextSub(): string {
  account += 1;
  return `index-tester-${account}`;
}

beforeEach(() => {
  mutableEnv.DEV_AUTH_SECRET = SECRET;
});

describe('a game writes itself into its players’ indexes', () => {
  it('indexes a game from the moment it is created, before anyone joins', async () => {
    // The case the index most exists for: a code created, shared and then lost
    // when the tab closed is otherwise unrecoverable even by its author.
    const cookie = await signIn(nextSub());
    const { joinCode } = await createGame(cookie);

    const games = await listGames(cookie);
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({
      joinCode,
      color: 'w',
      status: 'waiting',
      fieldName: 'The common',
    });
  });

  it('gives both players a line once the second seat is taken', async () => {
    const alice = await signIn(nextSub());
    const bob = await signIn(nextSub());
    const { joinCode } = await createGame(alice);
    expect((await join(joinCode, bob)).body.color).toBe('b');

    const [hers] = await listGames(alice);
    const [his] = await listGames(bob);
    expect(hers).toMatchObject({ joinCode, color: 'w', status: 'staging' });
    expect(his).toMatchObject({ joinCode, color: 'b', status: 'staging' });
  });

  it('keeps one account’s games out of another’s list', async () => {
    const alice = await signIn(nextSub());
    const stranger = await signIn(nextSub());
    await createGame(alice);
    expect(await listGames(stranger)).toEqual([]);
  });

  it('never indexes a game played without a session', async () => {
    // Not a bug: nothing about a signed-out seat says which account it belongs
    // to, and inventing one for a phone's UUID would be worse than a short list.
    // Stage 2.5.1 removes the case entirely.
    const { joinCode } = await createGame(null);
    const latecomer = await signIn(nextSub());
    expect(await listGames(latecomer)).toEqual([]);
    // The game itself is untouched and perfectly playable.
    expect(await env.GAME.getByName(joinCode).peek()).toMatchObject({ status: 'waiting' });
  });

  it('records a result from each player’s own point of view', async () => {
    const alice = await signIn(nextSub());
    const bob = await signIn(nextSub());
    const { joinCode } = await createGame(alice);
    await join(joinCode, bob);

    // Phase 4 owns the path into a result; what matters here is that the index
    // hears about it, so the state is forced and the game is asked to re-sync by
    // being rejoined.
    const at = Date.now();
    await forceGame(
      joinCode,
      `UPDATE game SET status = 'finished', result_outcome = '1-0',
                       result_reason = 'checkmate', result_at = ?, updated_at = ? WHERE id = 1`,
      at,
      at,
    );
    await join(joinCode, alice);
    await join(joinCode, bob);

    const [hers] = await listGames(alice);
    const [his] = await listGames(bob);
    expect(hers.result).toMatchObject({ outcome: '1-0', reason: 'checkmate' });
    expect(hers.color).toBe('w');
    expect(his.result).toMatchObject({ outcome: '1-0', reason: 'checkmate' });
    expect(his.color).toBe('b');
  });

  it('carries a suspension and its countdown into the list', async () => {
    const alice = await signIn(nextSub());
    const bob = await signIn(nextSub());
    const { joinCode } = await createGame(alice);
    await join(joinCode, bob);

    // Make it active, then let the disconnect grace period expire with nobody
    // connected — the real path by which a game freezes on a field.
    await forceGame(
      joinCode,
      `UPDATE game SET status = 'active', last_clock_start_at = ? WHERE id = 1`,
      Date.now() - 5000,
    );
    await forceGame(
      joinCode,
      `UPDATE presence SET connected = 0 WHERE 1 = 1`,
    );
    const stub = env.GAME.getByName(joinCode) as DurableObjectStub<GameDO>;
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO timers (kind, due_at) VALUES ('disconnect', ?)
           ON CONFLICT (kind) DO UPDATE SET due_at = excluded.due_at`,
        Date.now() - 1,
      );
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const [hers] = await listGames(alice);
    expect(hers.status).toBe('suspended');
    expect(hers.suspendedAt).not.toBeNull();
    // Both were gone, so decision 0025 credits nobody and nobody may claim.
    expect(hers.suspendedBy).toBe(null);
    expect(hers.canClaim).toBe(false);
  });

  it('counts down for the player who was left standing there', async () => {
    const alice = await signIn(nextSub());
    const bob = await signIn(nextSub());
    const { joinCode } = await createGame(alice);
    await join(joinCode, bob);

    const at = Date.now() - CLAIM_AFTER_MS / 2;
    await forceGame(
      joinCode,
      `UPDATE game SET status = 'suspended', suspended_at = ?, suspended_by = 'b',
                       updated_at = ? WHERE id = 1`,
      at,
      at,
    );
    await join(joinCode, alice);
    await join(joinCode, bob);

    const [hers] = await listGames(alice);
    const [his] = await listGames(bob);
    // White did not stop it, so white is the one on the countdown.
    expect(hers.canClaim).toBe(false);
    expect(hers.claimableInMs).toBeGreaterThan(0);
    // Black stopped it and may never claim, however long it has been.
    expect(his.claimableInMs).toBe(0);
    expect(his.canClaim).toBe(false);
  });

  it('takes a garbage-collected game back out of the list', async () => {
    const alice = await signIn(nextSub());
    const { joinCode } = await createGame(alice);
    expect(await listGames(alice)).toHaveLength(1);

    const stub = env.GAME.getByName(joinCode) as DurableObjectStub<GameDO>;
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`UPDATE timers SET due_at = ? WHERE kind = 'gc'`, Date.now() - 1);
      await state.storage.setAlarm(Date.now() + 3_600_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // A row pointing at a code that resolves to nothing is worse than no row.
    expect(await listGames(alice)).toEqual([]);
  });
});

describe('a seat belongs to an account, not to a phone (stage 3.5.2)', () => {
  it('lets a second phone of the same account take the same seat', async () => {
    const sub = nextSub();
    const firstPhone = await signIn(sub);
    const secondPhone = await signIn(sub);
    const bob = await signIn(nextSub());

    const { joinCode } = await createGame(firstPhone);
    await join(joinCode, bob);

    // Idempotent for the same player, and "the same player" now means the same
    // account. Before this, the second phone would have been a third player and
    // the answer would have been `game_full`.
    const resumed = await join(joinCode, secondPhone);
    expect(resumed.status).toBe(200);
    expect(resumed.body.color).toBe('w');

    // And it is the same one game, not two lines in one list.
    expect(await listGames(secondPhone)).toHaveLength(1);
  });

  it('still refuses a genuine third player', async () => {
    const alice = await signIn(nextSub());
    const bob = await signIn(nextSub());
    const gatecrasher = await signIn(nextSub());
    const { joinCode } = await createGame(alice);
    await join(joinCode, bob);

    expect((await join(joinCode, gatecrasher)).status).toBe(409);
  });
});

describe('forgetting games (stage 2.3.4.2)', () => {
  it('refuses to remove a game that is not over', async () => {
    const alice = await signIn(nextSub());
    const bob = await signIn(nextSub());
    const { joinCode } = await createGame(alice);
    await join(joinCode, bob);

    const result = await forget(alice, [joinCode]);
    expect(result.forgotten).toEqual([]);
    expect(result.kept).toEqual([{ joinCode, reason: 'in_play' }]);
    expect(await listGames(alice)).toHaveLength(1);
  });

  it('refuses a suspended game however long it has been suspended', async () => {
    // The row is the only handle on a game that can still be claimed or
    // resigned; losing it would leave the game undecidable for ever.
    const alice = await signIn(nextSub());
    const bob = await signIn(nextSub());
    const { joinCode } = await createGame(alice);
    await join(joinCode, bob);
    const at = Date.now() - 10 * CLAIM_AFTER_MS;
    await forceGame(
      joinCode,
      `UPDATE game SET status = 'suspended', suspended_at = ?, suspended_by = 'b',
                       updated_at = ? WHERE id = 1`,
      at,
      at,
    );
    await join(joinCode, alice);

    expect((await forget(alice, [joinCode])).kept).toEqual([
      { joinCode, reason: 'suspended' },
    ]);
  });

  it('removes a finished game, and only from the list that asked', async () => {
    const alice = await signIn(nextSub());
    const bob = await signIn(nextSub());
    const { joinCode } = await createGame(alice);
    await join(joinCode, bob);
    const at = Date.now();
    await forceGame(
      joinCode,
      `UPDATE game SET status = 'finished', result_outcome = '0-1',
                       result_reason = 'resignation', result_at = ?, updated_at = ? WHERE id = 1`,
      at,
      at,
    );
    await join(joinCode, alice);
    await join(joinCode, bob);

    expect((await forget(alice, [joinCode])).forgotten).toEqual([joinCode]);
    expect(await listGames(alice)).toEqual([]);
    // Bob's copy of the same game is his own row and is untouched.
    expect(await listGames(bob)).toHaveLength(1);
  });

  it('applies what it can and names what it kept', async () => {
    const alice = await signIn(nextSub());
    const bob = await signIn(nextSub());
    const over = await createGame(alice);
    const going = await createGame(alice);
    await join(over.joinCode, bob);
    await join(going.joinCode, bob);
    const at = Date.now();
    await forceGame(
      over.joinCode,
      `UPDATE game SET status = 'finished', result_outcome = '1-0',
                       result_reason = 'checkmate', result_at = ?, updated_at = ? WHERE id = 1`,
      at,
      at,
    );
    await join(over.joinCode, alice);

    const result = await forget(alice, [over.joinCode, going.joinCode]);
    expect(result.forgotten).toEqual([over.joinCode]);
    expect(result.kept.map((k) => k.joinCode)).toEqual([going.joinCode]);
  });

  it('puts a forgotten game back when the player opens it again', async () => {
    // Deliberate: forgetting is tidying, not blocking. Walking back into the
    // game is the clearest possible statement that it belongs on the list, and
    // the same path is what heals a line that a failed push never delivered.
    const alice = await signIn(nextSub());
    const { joinCode } = await createGame(alice);
    expect((await forget(alice, [joinCode])).forgotten).toEqual([joinCode]);
    expect(await listGames(alice)).toEqual([]);

    await join(joinCode, alice);
    expect((await listGames(alice)).map((g) => g.joinCode)).toEqual([joinCode]);
  });

  it('treats a code it has never heard of as already forgotten', async () => {
    const alice = await signIn(nextSub());
    expect((await forget(alice, ['ZZZZZZ'])).forgotten).toEqual(['ZZZZZZ']);
  });
});

describe('the index is private and needs a session', () => {
  it('401s a signed-out list', async () => {
    const response = await SELF.fetch(`${LOCAL}/api/games`);
    expect(response.status).toBe(401);
  });

  it('401s a signed-out forget', async () => {
    const response = await SELF.fetch(`${LOCAL}/api/games/forget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ joinCodes: ['ABC123'] }),
    });
    expect(response.status).toBe(401);
  });

  it('refuses the wrong method rather than falling through to the shell', async () => {
    const cookie = await signIn(nextSub());
    const response = await SELF.fetch(`${LOCAL}/api/games`, { method: 'DELETE', headers: { cookie } });
    expect(response.status).toBe(405);
  });
});
