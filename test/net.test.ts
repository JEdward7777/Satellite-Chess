import { describe, expect, it, vi } from 'vitest';

import { fromLocal } from '../src/shared/geo.js';
import { PING, PONG, POS_MIN_DELTA_M, POS_MIN_INTERVAL_MS } from '../src/shared/protocol.js';
import type { GpsFix } from '../src/client/gps.js';
import { type WebSocketLike, connectToGame } from '../src/client/net.js';

const HOME = { lat: 51.4779, lng: -0.0015 };

function fix(pos: { lat: number; lng: number }, accuracyM = 4, at = 1_000): GpsFix {
  return { pos, accuracyM, at };
}

/** A socket that does exactly what a test says, and records what it was sent. */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }

  /** Complete the handshake, as a real socket would. */
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  /** Drop, as a phone walking behind a building would. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  deliver(msg: unknown): void {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }

  /** Messages parsed back, ignoring the free keepalive traffic. */
  get messages(): Record<string, unknown>[] {
    return this.sent
      .filter((raw) => raw !== PING)
      .map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  get pings(): number {
    return this.sent.filter((raw) => raw === PING).length;
  }
}

/** A harness that hands out fakes and remembers every one. */
function harness(opts: { now?: () => number } = {}) {
  const sockets: FakeSocket[] = [];
  const connection = connectToGame({
    joinCode: 'A1B2C3',
    playerId: 'player-1',
    origin: 'https://example.com',
    pingIntervalMs: 1_000,
    now: opts.now,
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  return { connection, sockets, latest: () => sockets[sockets.length - 1] };
}

const snapshot = (over: Record<string, unknown> = {}) => ({
  t: 'state',
  game: { status: 'active', fen: 'x', ...over },
});

describe('connecting', () => {
  it('builds a ws:// URL from the origin, carrying the join code and player', () => {
    const { latest } = harness();
    expect(latest().url).toBe(
      'wss://example.com/api/game/A1B2C3/ws?playerId=player-1',
    );
  });

  it('reports connecting, then open', () => {
    const { connection, latest } = harness();
    expect(connection.state.status).toBe('connecting');
    latest().open();
    expect(connection.state.status).toBe('open');
  });

  it('asks for a snapshot the moment it opens, since it may have missed some', () => {
    const { latest } = harness();
    latest().open();
    expect(latest().messages).toEqual([{ t: 'sync' }]);
  });

  it('hands snapshots on without interpreting them', () => {
    const { connection, latest } = harness();
    latest().open();
    latest().deliver(snapshot({ fen: 'rnbq' }));
    expect(connection.state.game).toMatchObject({ status: 'active', fen: 'rnbq' });
  });

  it('surfaces a rejection, and clears it on the next good state', () => {
    const { connection, latest } = harness();
    latest().open();
    latest().deliver({ t: 'error', code: 'out_of_reach', message: 'Walk closer.' });
    expect(connection.state.lastError).toMatchObject({ code: 'out_of_reach' });

    latest().deliver(snapshot());
    expect(connection.state.lastError).toBeNull();
  });

  it('keeps the opponent position separate — it is atmosphere, not truth', () => {
    const { connection, latest } = harness();
    latest().open();
    latest().deliver({ t: 'opp_pos', lat: 51.5, lng: -0.001, acc: 9 });
    expect(connection.state.opponent).toMatchObject({ lat: 51.5, acc: 9 });
    expect(connection.state.game).toBeNull();
  });

  it('ignores a frame it cannot parse rather than dropping the game', () => {
    const { connection, latest } = harness();
    latest().open();
    latest().deliver('{not json');
    expect(connection.state.status).toBe('open');
  });
});

/**
 * The relay only speaks on movement, so a client that has just connected would
 * otherwise have no opponent to draw until they happened to walk two metres —
 * and someone waiting on their own back rank never will.
 */
describe('the opponent position a snapshot carries', () => {
  const player = (over: Record<string, unknown> = {}) => ({
    color: 'b',
    connected: true,
    reachBonusM: 0,
    travelM: 0,
    inStartZone: false,
    lastSeenAt: 1,
    pos: null,
    ...over,
  });

  const withOpponentAt = (serverNow: number, at: number) =>
    snapshot({
      you: 'w',
      serverNow,
      players: {
        w: player({ color: 'w', pos: { lat: 1, lng: 1, acc: 1, at } }),
        b: player({ pos: { lat: 51.5, lng: -0.001, acc: 9, at } }),
      },
    });

  it('seeds the dot before the opponent has moved a step', () => {
    const { connection, latest } = harness({ now: () => 100_000 });
    latest().open();
    latest().deliver(withOpponentAt(5_000, 5_000));
    expect(connection.state.opponent).toMatchObject({ lat: 51.5, acc: 9 });
  });

  it('takes the opponent’s, not your own', () => {
    const { connection, latest } = harness({ now: () => 100_000 });
    latest().open();
    latest().deliver(withOpponentAt(5_000, 5_000));
    expect(connection.state.opponent?.lat).not.toBe(1);
  });

  it('ages it on this phone’s clock, since the two have never been synchronised', () => {
    const { connection, latest } = harness({ now: () => 100_000 });
    latest().open();
    // Server said "now is 5000" and "that fix landed at 3000": two seconds old,
    // whatever either clock reads in absolute terms.
    latest().deliver(withOpponentAt(5_000, 3_000));
    expect(connection.state.opponent?.at).toBe(98_000);
  });

  it('does not overwrite a live relay with the older copy in a snapshot', () => {
    let t = 100_000;
    const { connection, latest } = harness({ now: () => t });
    latest().open();
    latest().deliver({ t: 'opp_pos', lat: 51.6, lng: -0.002, acc: 4, at: 4_000 });

    t += 500;
    latest().deliver(withOpponentAt(5_000, 3_000));
    expect(connection.state.opponent).toMatchObject({ lat: 51.6, at: 100_000 });
  });

  it('says nothing when they have never relayed a position', () => {
    const { connection, latest } = harness({ now: () => 100_000 });
    latest().open();
    latest().deliver(snapshot({ you: 'w', serverNow: 5_000, players: { w: player({ color: 'w' }), b: player() } }));
    expect(connection.state.opponent).toBeNull();
  });
});

describe('the free keepalive', () => {
  it('pings on a timer, and a pong is not treated as a message', () => {
    vi.useFakeTimers();
    try {
      const { connection, latest } = harness();
      latest().open();
      vi.advanceTimersByTime(3_500);
      expect(latest().pings).toBe(3);

      // Answered by the runtime, never by the Durable Object.
      latest().deliver(PONG);
      expect(connection.state.game).toBeNull();
      expect(connection.state.lastError).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops pinging once the socket has gone', () => {
    vi.useFakeTimers();
    try {
      const { latest } = harness();
      const first = latest();
      first.open();
      vi.advanceTimersByTime(1_500);
      const before = first.pings;
      first.drop();
      vi.advanceTimersByTime(5_000);
      expect(first.pings).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reconnection', () => {
  it('comes back after a drop, and counts it', () => {
    vi.useFakeTimers();
    try {
      const { connection, sockets, latest } = harness();
      latest().open();
      latest().deliver(snapshot());

      latest().drop();
      expect(connection.state.status).toBe('reconnecting');
      expect(connection.state.reconnects).toBe(1);

      vi.advanceTimersByTime(300);
      expect(sockets).toHaveLength(2);
      latest().open();
      expect(connection.state.status).toBe('open');
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-syncs on every reconnect, because broadcasts were missed', () => {
    vi.useFakeTimers();
    try {
      const { sockets, latest } = harness();
      latest().open();
      latest().drop();
      vi.advanceTimersByTime(300);
      latest().open();
      expect(sockets[1].messages).toEqual([{ t: 'sync' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off, but starts fast enough to beat the disconnect grace', () => {
    vi.useFakeTimers();
    try {
      const { sockets, latest } = harness();
      latest().open();

      // Four failed attempts in a row.
      for (let i = 0; i < 4; i++) {
        latest().drop();
        vi.advanceTimersByTime(10_000);
      }
      // The first retry must land well inside DISCONNECT_GRACE_MS (20 s), or a
      // walk past a building costs both players the back-rank handshake.
      expect(sockets).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays shut once closed on purpose', () => {
    vi.useFakeTimers();
    try {
      const { connection, sockets } = harness();
      sockets[0].open();
      connection.close();
      expect(connection.state.status).toBe('closed');

      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to send while the socket is down, rather than pretending', () => {
    const { connection, latest } = harness();
    latest().open();
    latest().drop();
    expect(connection.send({ t: 'sync' })).toBe(false);
  });
});

describe('the position relay — the client half of the request budget', () => {
  /** A clock the test drives, so the interval rule can be exercised exactly. */
  function clocked() {
    let t = 100_000;
    const h = harness({ now: () => t });
    h.latest().open();
    h.latest().sent.length = 0;
    return { ...h, advance: (ms: number) => { t += ms; } };
  }

  it('sends the first offer', () => {
    const { connection, latest } = clocked();
    expect(connection.offerPosition(fix(HOME), 12)).toBe(true);
    expect(latest().messages[0]).toMatchObject({ t: 'pos', acc: 4, travelM: 12 });
  });

  it('carries no timestamp — the server times everything itself', () => {
    const { connection, latest } = clocked();
    connection.offerPosition(fix(HOME));
    expect(latest().messages[0]).not.toHaveProperty('ts');
  });

  it('refuses a second offer inside the minimum interval', () => {
    const { connection, advance } = clocked();
    connection.offerPosition(fix(HOME));
    advance(POS_MIN_INTERVAL_MS - 1);
    expect(connection.offerPosition(fix(fromLocal(HOME, { e: 50, n: 0 })))).toBe(false);
  });

  it('refuses a move too small to be worth a request', () => {
    const { connection, advance } = clocked();
    connection.offerPosition(fix(HOME));
    advance(POS_MIN_INTERVAL_MS + 1);
    // Under the delta threshold, however long you wait.
    expect(
      connection.offerPosition(fix(fromLocal(HOME, { e: POS_MIN_DELTA_M - 0.5, n: 0 }))),
    ).toBe(false);
  });

  it('sends once both thresholds are met', () => {
    const { connection, advance } = clocked();
    connection.offerPosition(fix(HOME));
    advance(POS_MIN_INTERVAL_MS + 1);
    expect(connection.offerPosition(fix(fromLocal(HOME, { e: 5, n: 0 })))).toBe(true);
  });

  it('costs a fraction of a naive 1 Hz stream over a half-hour game', () => {
    const { connection, latest, advance } = clocked();
    // Walk steadily for thirty minutes, offering a fix every second as the GPS
    // would. The budget doc predicts a few hundred messages, not 1,800.
    for (let second = 0; second < 1_800; second++) {
      connection.offerPosition(fix(fromLocal(HOME, { e: second * 1.4, n: 0 })), second * 1.4);
      advance(1_000);
    }
    const sent = latest().messages.filter((m) => m.t === 'pos').length;
    expect(sent).toBeLessThan(800);
    expect(sent).toBeGreaterThan(400);
  });

  it('sends almost nothing at all while standing still', () => {
    const { connection, latest, advance } = clocked();
    for (let second = 0; second < 1_800; second++) {
      connection.offerPosition(fix(HOME));
      advance(1_000);
    }
    // One opening message, then silence: nothing moved.
    expect(latest().messages.filter((m) => m.t === 'pos')).toHaveLength(1);
  });

  it('does not consume the budget when the socket is down', () => {
    const { connection, advance, latest } = clocked();
    latest().drop();
    expect(connection.offerPosition(fix(HOME))).toBe(false);
    // And the refusal did not count as "sent", so the next real chance is taken.
    advance(POS_MIN_INTERVAL_MS + 1);
    expect(connection.state.status).toBe('reconnecting');
  });
});
