import { describe, expect, it } from 'vitest';

import {
  AUTO_READY_MIN_INTERVAL_MS,
  RELAY_CONFIRM_MS,
  AutoReady,
  type AutoReadyInput,
  awaitingHandshake,
  handshakeEpisode,
  myHandshakeLine,
  opponentHandshakeLine,
  walkToBackRankM,
} from '../src/client/handshake.js';
import { type FieldSpec, deriveGeometry, squareCentreLatLng } from '../src/shared/field.js';
import { fromLocal } from '../src/shared/geo.js';
import type { GameSnapshot, PlayerView } from '../src/shared/protocol.js';
import { DEFAULT_REACH } from '../src/shared/reach.js';
import { fromSquare } from '../src/shared/squares.js';

/** An 8 m board, axis-aligned, as in the other model tests. */
const A1 = { lat: 51.4779, lng: -0.0015 };
const SQUARE_M = 8;
const FIELD: FieldSpec = {
  id: 'f',
  name: 'test',
  a1: A1,
  h8: fromLocal(A1, { e: 7 * SQUARE_M, n: 7 * SQUARE_M }),
  version: 1,
  createdAt: 0,
  updatedAt: 0,
};
const GEO = deriveGeometry(FIELD);
const on = (square: string) => squareCentreLatLng(GEO, fromSquare(square));

function player(over: Partial<PlayerView> = {}): PlayerView {
  return {
    color: 'w',
    connected: true,
    reachBonusSquares: 0,
    travelM: 0,
    inStartZone: false,
    lastSeenAt: 1,
    pos: null,
    ...over,
  };
}

const GAME = {
  reach: DEFAULT_REACH,
  players: { w: player(), b: player({ color: 'b' }) },
};

/** A fix standing on a back rank, in a game waiting on the handshake. */
function input(over: Partial<AutoReadyInput> = {}): AutoReadyInput {
  return {
    status: 'staging',
    open: true,
    serverSaysInZone: false,
    localInZone: true,
    relayed: false,
    episode: 'staging|0|-',
    now: 100_000,
    ...over,
  };
}

describe('AutoReady (stage 7.2.1)', () => {
  it('says so on arriving, without anybody tapping', () => {
    expect(new AutoReady().decide(input())).toBe(true);
  });

  it('says it once per arrival, not once per fix', () => {
    const latch = new AutoReady();
    expect(latch.decide(input())).toBe(true);
    // A minute of standing still, one fix a second.
    for (let s = 1; s <= 60; s++) {
      expect(latch.decide(input({ now: 100_000 + s * 1000 }))).toBe(false);
    }
  });

  it('stays quiet when the server already agrees', () => {
    expect(new AutoReady().decide(input({ serverSaysInZone: true }))).toBe(false);
  });

  it('gives a relayed arrival a round trip to be confirmed, rather than sending `ready` as well', () => {
    // The server runs the same zone check on a relay and answers with a
    // snapshot, so a `ready` straight after would say the same thing twice.
    const latch = new AutoReady();
    expect(latch.decide(input({ now: 100_000, relayed: true }))).toBe(false);
    expect(latch.decide(input({ now: 101_000 }))).toBe(false);
    // Confirmed: nothing more is ever needed.
    expect(latch.decide(input({ now: 104_000, serverSaysInZone: true }))).toBe(false);
  });

  it('sends `ready` after all when a relayed arrival is never confirmed', () => {
    // The relay was sent but counted for nothing — the server drops a `pos`
    // inside its interval floor, which a refused `ready` just reset. Standing
    // still, no second relay is coming, so only `ready` can rescue this.
    const latch = new AutoReady();
    expect(latch.decide(input({ now: 100_000, relayed: true }))).toBe(false);
    expect(latch.decide(input({ now: 100_000 + RELAY_CONFIRM_MS - 1 }))).toBe(false);
    expect(latch.decide(input({ now: 100_000 + RELAY_CONFIRM_MS }))).toBe(true);
    // And then once only.
    expect(latch.decide(input({ now: 110_000 + RELAY_CONFIRM_MS }))).toBe(false);
  });

  it('says nothing away from the back rank, or with no fix', () => {
    const latch = new AutoReady();
    expect(latch.decide(input({ localInZone: false }))).toBe(false);
    expect(latch.decide(input({ localInZone: null }))).toBe(false);
  });

  it('says nothing unless the game is waiting on the handshake', () => {
    for (const status of ['waiting', 'active', 'finished'] as const) {
      expect(new AutoReady().decide(input({ status }))).toBe(false);
    }
    expect(new AutoReady().decide(input({ status: 'suspended' }))).toBe(true);
  });

  it('says nothing into a closed socket, and tries again once it opens', () => {
    const latch = new AutoReady();
    expect(latch.decide(input({ open: false }))).toBe(false);
    expect(latch.decide(input())).toBe(true);
  });

  it('says it again after leaving and coming back — but not faster than the floor', () => {
    const latch = new AutoReady();
    expect(latch.decide(input({ now: 0 }))).toBe(true);
    expect(latch.decide(input({ now: 1_000, localInZone: false }))).toBe(false);
    // Jitter across the edge of the zone: back in two seconds later.
    expect(latch.decide(input({ now: 2_000 }))).toBe(false);
    expect(latch.decide(input({ now: AUTO_READY_MIN_INTERVAL_MS }))).toBe(true);
  });

  it('bounds a player dithering on the boundary for a minute', () => {
    const latch = new AutoReady();
    let sent = 0;
    for (let s = 0; s < 60; s++) {
      if (latch.decide(input({ now: s * 1000, localInZone: s % 2 === 0 }))) sent += 1;
    }
    expect(sent).toBeLessThanOrEqual(6);
  });

  it('says it again when the server may have forgotten — a new socket or a new suspension', () => {
    const latch = new AutoReady();
    expect(latch.decide(input({ now: 0 }))).toBe(true);
    // Accepted, then the socket was replaced: the server cleared the flag.
    expect(latch.decide(input({ now: 60_000, episode: 'staging|1|-' }))).toBe(true);
    expect(latch.decide(input({ now: 120_000, status: 'suspended', episode: 'suspended|1|5' }))).toBe(
      true,
    );
  });
});

describe('handshakeEpisode', () => {
  it('changes with the status, the socket, and the suspension', () => {
    const base = { status: 'suspended', suspension: { at: 5 } } as unknown as GameSnapshot;
    const a = handshakeEpisode(base, 0);
    expect(handshakeEpisode(base, 1)).not.toBe(a);
    expect(handshakeEpisode({ ...base, suspension: { at: 6 } } as unknown as GameSnapshot, 0)).not.toBe(a);
    expect(handshakeEpisode({ ...base, status: 'staging' } as GameSnapshot, 0)).not.toBe(a);
    expect(handshakeEpisode(base, 0)).toBe(a);
  });
});

describe('awaitingHandshake', () => {
  it('is the two statuses a back-rank walk can end', () => {
    expect(awaitingHandshake('staging')).toBe(true);
    expect(awaitingHandshake('suspended')).toBe(true);
    expect(awaitingHandshake('active')).toBe(false);
    expect(awaitingHandshake(null)).toBe(false);
  });
});

describe('walkToBackRankM', () => {
  it('is zero, and in the zone, anywhere on your own back rank', () => {
    for (const sq of ['a1', 'e1', 'h1']) {
      expect(walkToBackRankM(GEO, GAME, 'w', on(sq), 3)).toEqual({ inZone: true, walkM: 0 });
    }
    expect(walkToBackRankM(GEO, GAME, 'b', on('d8'), 3).inZone).toBe(true);
  });

  it('agrees with the server about the wrong end', () => {
    expect(walkToBackRankM(GEO, GAME, 'b', on('d1'), 3).inZone).toBe(false);
  });

  it('is the distance past reach, not the distance to the square', () => {
    // e4 is three squares from e1: 24 m to walk, less whatever the circle covers.
    const far = walkToBackRankM(GEO, GAME, 'w', on('e4'), 3);
    expect(far.inZone).toBe(false);
    expect(far.walkM).toBeGreaterThan(0);
    expect(far.walkM).toBeLessThan(3 * SQUARE_M);
  });

  it('counts the handicap, as the server does', () => {
    const plain = walkToBackRankM(GEO, GAME, 'w', on('e4'), 3);
    const helped = walkToBackRankM(
      GEO,
      { ...GAME, players: { ...GAME.players, w: player({ reachBonusSquares: 1 }) } },
      'w',
      on('e4'),
      3,
    );
    expect(helped.walkM).toBeLessThan(plain.walkM);
  });
});

describe('the handshake lines (stage 7.2.2)', () => {
  it('tells me how far I have to go', () => {
    expect(myHandshakeLine(false, { inZone: false, walkM: 23.4 })).toBe(
      'Walk to your own back rank — 23 m to go.',
    );
    expect(myHandshakeLine(false, { inZone: false, walkM: 4.25 })).toContain('4.3 m');
    expect(myHandshakeLine(false, null)).toBe('Walk to your own back rank.');
  });

  it('only says I am there once the server agrees', () => {
    expect(myHandshakeLine(false, { inZone: true, walkM: 0 })).toMatch(/checking/);
    expect(myHandshakeLine(true, { inZone: true, walkM: 0 })).toBe('You are on your back rank.');
  });

  it('says how far away my opponent is', () => {
    expect(opponentHandshakeLine(player(), { inZone: false, walkM: 31 })).toBe(
      'Waiting for your opponent to reach their back rank — about 31 m away.',
    );
  });

  it('never calls my opponent ready on the strength of their relayed dot alone', () => {
    const line = opponentHandshakeLine(player(), { inZone: true, walkM: 0 });
    expect(line).not.toMatch(/is on their back rank/);
    expect(opponentHandshakeLine(player({ inStartZone: true }), null)).toBe(
      'Your opponent is on their back rank.',
    );
  });

  it('says why when there is no distance to give', () => {
    expect(opponentHandshakeLine(player({ connected: false }), null)).toMatch(/come back/);
    expect(opponentHandshakeLine(player(), null)).toBe(
      'Waiting for your opponent to reach their back rank.',
    );
    expect(opponentHandshakeLine(null, null)).toMatch(/join/);
  });
});
