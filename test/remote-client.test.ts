import { describe, expect, it, vi } from 'vitest';

import { myBoard, spotOnBoard } from '../src/client/my-board.js';
import { type WebSocketLike, connectToGame } from '../src/client/net.js';
import { OpponentTrack } from '../src/client/opponent.js';
import { joinGame } from '../src/client/join.js';
import { inviteShareData } from '../src/client/share.js';
import { inviteFor } from '../src/client/views/invite.js';
import { createGameBody, createRefusal, emptyDraft, reachNote } from '../src/client/views/create.js';
import { canRecalibrate, remoteWords, rescaleNotice } from '../src/client/views/game.js';
import { recalibratePurpose } from '../src/client/views/calibrate.js';
import { handshakeEpisode } from '../src/client/handshake.js';
import {
  forgetRecalibration,
  pendingRecalibration,
  recalibrationApplied,
  rememberRecalibration,
  sendRecalibration,
} from '../src/client/recalibration.js';
import type { GameSnapshot } from '../src/shared/protocol.js';
import { remoteJoinRefusal, startingField } from '../src/client/views/remote-join.js';
import { projectionFor } from '../src/client/render.js';
import { DISCLOSURE_NEEDED, DISCLOSURE_TEXT, disclosureHtml } from '../src/client/disclosure.js';
import {
  SMALL_SQUARE_M,
  checkCalibration,
  deriveGeometry,
  makeFieldSpec,
  smallSquareWarning,
  snapshotField,
  toBoardIndex,
} from '../src/shared/field.js';
import { add, fromLocal, scale, unitFromBearing } from '../src/shared/geo.js';
import { playableBoard } from '../src/shared/remote.js';
import { watchSpot } from '../src/shared/watch.js';

/**
 * The phone's half of a remote game (stage 12.2, decisions 0060 and 0061):
 * the one place it gets its board from, the opponent put on the same squares
 * of it, and the words around create and join. The pixels are checked by
 * `scripts/check-remote.mjs`.
 */

const A1 = { lat: 51.4779, lng: -0.0015 };

/** A four-corner field: `fileM` by `rankM` squares, its files on `bearingDeg`. */
function spec(fileM: number, rankM: number, bearingDeg: number, at = A1) {
  const f = scale(unitFromBearing(bearingDeg), fileM);
  const r = scale(unitFromBearing(bearingDeg - 90), rankM);
  const corner = (file: number, rank: number) => fromLocal(at, add(scale(f, file), scale(r, rank)));
  return makeFieldSpec('Test', { a1: corner(0, 0), h1: corner(7, 0), h8: corner(7, 7), a8: corner(0, 7) });
}
const field = (fileM: number, rankM: number, bearingDeg = 30, at = A1) => snapshotField(spec(fileM, rankM, bearingDeg, at));

describe('myBoard, the one seam', () => {
  it('is the game field exactly in a same-field game, with no outline', () => {
    const f = field(8, 8);
    const board = myBoard({ field: f });
    expect(board.geo).toEqual(deriveGeometry(f));
    expect(board).toMatchObject({ outline: null, sharedSquareM: null, smallSquares: false });
  });

  it('is the field shrunk to the shared square in a remote game, with the field as its outline', () => {
    const f = field(10, 10);
    const board = myBoard({ field: f, remote: { squareM: 6 } });
    expect(board.geo).toEqual(playableBoard(f, 6));
    expect(board.geo.meanSquareM).toBe(6);
    expect(board.outline).toEqual(deriveGeometry(f));
    expect(board.sharedSquareM).toBe(6);
  });

  it('draws no outline round the smaller field, which is played whole', () => {
    const f = field(6, 6);
    const board = myBoard({ field: f, remote: { squareM: 6 } });
    expect(board.outline).toBeNull();
    expect(board.geo).toEqual(deriveGeometry(f));
  });

  it('warns about a thin field shrunk under the small-square line, and never in a same-field game', () => {
    // 12 x 3 m: mean 6. Shrunk to 5, its short step is 2.5 m.
    const thin = field(12, 3);
    expect(myBoard({ field: thin, remote: { squareM: 5 } }).smallSquares).toBe(true);
    expect(myBoard({ field: thin, remote: { squareM: 6 } }).smallSquares).toBe(true);
    expect(myBoard({ field: field(8, 8), remote: { squareM: 4.5 } }).smallSquares).toBe(false);
    expect(myBoard({ field: thin }).smallSquares).toBe(false);
  });

  it('answers once per snapshot', () => {
    const game = { field: field(10, 10), remote: { squareM: 6 } };
    expect(myBoard(game)).toBe(myBoard(game));
  });
});

describe('the opponent, on the same squares of this board', () => {
  it('puts a square of theirs on the same square of mine, whatever the two fields', () => {
    const theirs = playableBoard(field(6, 9, 140, fromLocal(A1, { e: 4000, n: -2500 })), 7);
    const mine = playableBoard(field(10, 10, 30), 7);
    const wrong: unknown[] = [];
    for (const [file, rank] of [
      [0, 0],
      [4, 7],
      [3.37, 5.5],
      [-2, 9.25],
    ]) {
      const there = fromLocal(theirs.origin, add(scale(theirs.fileStep, file), scale(theirs.rankStep, rank)));
      const spot = watchSpot(theirs, there);
      if (spot === null) throw new Error('on the board');
      const here = toBoardIndex(mine, spotOnBoard(mine, spot));
      if (Math.abs(here.file - file) > 0.006 || Math.abs(here.rank - rank) > 0.006) wrong.push({ file, rank, here });
    }
    expect(wrong).toEqual([]);
  });
});

/** A socket a test drives by hand. */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  send(): void {}
  close(): void {}
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

function connection(now: () => number) {
  let socket: FakeSocket | null = null;
  const conn = connectToGame({
    joinCode: 'A1B2C3',
    origin: 'https://example.com',
    now,
    probe: async () => 'unknown',
    socketFactory: () => {
      socket = new FakeSocket();
      return socket;
    },
  });
  socket!.open();
  return { conn, socket: socket! };
}

describe('net: a remote opponent', () => {
  const mine = field(10, 10);
  const remoteGame = (spot: unknown, serverNow = 10_000) => ({
    t: 'state',
    game: {
      status: 'staging',
      you: 'w',
      serverNow,
      field: mine,
      remote: { squareM: 6 },
      players: { w: { pos: null }, b: { pos: null, ...(spot === undefined ? {} : { spot }) } },
    },
  });

  it('puts the snapshot spot on this board', () => {
    let t = 50_000;
    const { conn, socket } = connection(() => t);
    socket.deliver(remoteGame({ spot: { file: 4, rank: 7 }, acc: 5, at: 9_000 }));
    const o = conn.state.opponent!;
    const at = toBoardIndex(myBoard(conn.state.game!).geo, o);
    expect(at.file).toBeCloseTo(4, 6);
    expect(at.rank).toBeCloseTo(7, 6);
    expect(o.acc).toBe(5);
    // Server time converted to local: a second before the snapshot was built.
    expect(o.at).toBe(49_000);
  });

  it('follows the relay, and has no dot while they are off their board', () => {
    let t = 50_000;
    const { conn, socket } = connection(() => t);
    socket.deliver(remoteGame(null));
    expect(conn.state.opponent).toBeNull();
    t = 51_000;
    socket.deliver({ t: 'opp_spot', spot: { file: 2, rank: 3 }, acc: 4, at: 1 });
    expect(toBoardIndex(myBoard(conn.state.game!).geo, conn.state.opponent!).file).toBeCloseTo(2, 6);
    expect(conn.state.opponent!.at).toBe(51_000);
    t = 52_000;
    socket.deliver({ t: 'opp_spot', spot: null, acc: 4, at: 2 });
    expect(conn.state.opponent).toBeNull();
  });

  it('does not let an older snapshot spot overwrite a newer relay', () => {
    let t = 50_000;
    const { conn, socket } = connection(() => t);
    socket.deliver({ ...remoteGame(null) });
    socket.deliver({ t: 'opp_spot', spot: { file: 5, rank: 5 }, acc: 4, at: 1 });
    t = 50_500;
    // A snapshot repeating a fix from before that relay.
    socket.deliver(remoteGame({ spot: { file: 1, rank: 1 }, acc: 4, at: 5_000 }));
    expect(toBoardIndex(myBoard(conn.state.game!).geo, conn.state.opponent!).file).toBeCloseTo(5, 6);
  });

  it('puts them on the same squares again when the board changes shape', () => {
    const t = 50_000;
    const { conn, socket } = connection(() => t);
    socket.deliver(remoteGame({ spot: { file: 7, rank: 7 }, acc: 4, at: 9_000 }));
    const before = conn.state.opponent!;
    socket.deliver({ ...remoteGame({ spot: { file: 7, rank: 7 }, acc: 4, at: 9_000 }), game: { ...remoteGame(undefined).game, remote: { squareM: 8 } } });
    const after = conn.state.opponent!;
    expect(after.lat).not.toBeCloseTo(before.lat, 8);
    expect(toBoardIndex(myBoard(conn.state.game!).geo, after).file).toBeCloseTo(7, 6);
  });
});

describe('net: a recalibration (stage 12.3)', () => {
  it('puts the opponent on the same squares of my recalibrated field', () => {
    const t = 50_000;
    const { conn, socket } = connection(() => t);
    const game = (f: ReturnType<typeof field>, squareM: number) => ({
      t: 'state',
      game: {
        status: 'suspended',
        you: 'w',
        serverNow: 10_000,
        field: f,
        remote: { squareM },
        players: { w: { pos: null }, b: { pos: null, spot: { spot: { file: 2, rank: 5 }, acc: 4, at: 9_000 } } },
      },
    });
    socket.deliver(game(field(10, 10), 6));
    const before = conn.state.opponent!;
    // My field was walked again, twenty meters away and smaller: the shared
    // square moves down with it.
    const moved = field(5, 5, 30, fromLocal(A1, { e: 20, n: 0 }));
    socket.deliver(game(moved, 5));
    const after = conn.state.opponent!;
    expect(after.lng).not.toBeCloseTo(before.lng, 6);
    const at = toBoardIndex(myBoard(conn.state.game!).geo, after);
    expect(at.file).toBeCloseTo(2, 6);
    expect(at.rank).toBeCloseTo(5, 6);
  });
});

describe('net: the opponent’s own board reshaped under them (stage 12.3)', () => {
  const snapshot = (spot: unknown, serverNow: number) => ({
    t: 'state',
    game: {
      status: 'suspended',
      you: 'w',
      serverNow,
      field: field(10, 10),
      remote: { squareM: 6 },
      players: { w: { pos: null }, b: { pos: null, spot } },
    },
  });

  it('takes the same fix on new squares, timed now, and ignores it repeated on the same ones', () => {
    let t = 50_000;
    const { conn, socket } = connection(() => t);
    socket.deliver(snapshot(null, 10_000));
    socket.deliver({ t: 'opp_spot', spot: { file: 3, rank: 4 }, acc: 4, at: 9_500 });
    expect(conn.state.opponent!.at).toBe(50_000);
    // The same fix again, as the next snapshot repeats it: nothing moves.
    t = 60_000;
    socket.deliver(snapshot({ spot: { file: 3, rank: 4 }, acc: 4, at: 9_500 }, 20_000));
    expect(conn.state.opponent!.at).toBe(50_000);
    // Their board was reshaped by a recalibration: the same fix is put on it
    // again, and the dot goes there.
    t = 61_000;
    socket.deliver(snapshot({ spot: { file: 2.93, rank: 4.07 }, acc: 4, at: 9_500 }, 21_000));
    const at = toBoardIndex(myBoard(conn.state.game!).geo, conn.state.opponent!);
    expect(at.file).toBeCloseTo(2.93, 6);
    expect(at.rank).toBeCloseTo(4.07, 6);
    expect(conn.state.opponent!.at).toBe(61_000);
  });
});

describe('sending a recalibration until it lands (stage 12.3, review rounds 1 and 2)', () => {
  const spec0 = spec(8, 8, 30);
  const sent = { ...spec0, version: 2 };
  const applied = snapshotField(sent);
  const old = snapshotField(spec0);
  const snapshot = (field: unknown, status = 'suspended') => ({
    t: 'state',
    game: { status, result: null, you: 'b', serverNow: 1, field, remote: { squareM: 6 }, players: { w: { pos: null }, b: { pos: null } } },
  });

  /** A real connection on fake sockets that keep what they were sent. */
  function wire() {
    const sockets: (FakeSocket & { frames: string[] })[] = [];
    const conn = connectToGame({
      joinCode: 'A1B2C3',
      origin: 'https://example.com',
      probe: async () => 'unknown',
      socketFactory: () => {
        const socket = Object.assign(new FakeSocket(), { frames: [] as string[] });
        (socket as { send: (data: string) => void }).send = (data: string) => void socket.frames.push(JSON.parse(data).t);
        sockets.push(socket);
        return socket;
      },
    });
    return { conn, sockets };
  }

  it('claims no back rank until it is applied: sync, then recalibrate after the snapshot, then ready', () => {
    const { conn, sockets } = wire();
    const done: string[] = [];
    const recalibration = sendRecalibration(conn, sent, { onDone: (o) => done.push(o) });
    // The board, as `considerReady` is: a ready on every update it is allowed one.
    conn.subscribe((state) => {
      if (state.status === 'open' && !recalibration.pending()) conn.send({ t: 'ready', pos: { lat: 0, lng: 0, acc: 3, ts: 0 } });
    });
    sockets[0]!.open();
    expect(sockets[0]!.frames).toEqual(['sync']);
    expect(recalibration.pending()).toBe(true);
    sockets[0]!.deliver(snapshot(old));
    expect(sockets[0]!.frames).toEqual(['sync', 'recalibrate']);
    sockets[0]!.deliver(snapshot(applied));
    expect(done).toEqual(['applied']);
    expect(recalibration.pending()).toBe(false);
    expect(sockets[0]!.frames).toEqual(['sync', 'recalibrate', 'ready']);
  });

  it('goes again on the next socket when the frame was lost with its socket, and still claims nothing first', () => {
    vi.useFakeTimers();
    try {
      const { conn, sockets } = wire();
      const recalibration = sendRecalibration(conn, sent);
      conn.subscribe((state) => {
        if (state.status === 'open' && !recalibration.pending()) conn.send({ t: 'ready', pos: { lat: 0, lng: 0, acc: 3, ts: 0 } });
      });
      sockets[0]!.open();
      sockets[0]!.deliver(snapshot(old));
      // Lost: the socket dies with the game still on the old field.
      sockets[0]!.onclose?.({});
      vi.advanceTimersByTime(1_000);
      sockets[1]!.open();
      expect(sockets[1]!.frames).toEqual(['sync']);
      sockets[1]!.deliver(snapshot(old));
      expect(sockets[1]!.frames).toEqual(['sync', 'recalibrate']);
      sockets[1]!.deliver(snapshot(applied));
      expect(recalibration.pending()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not sent again when the copy before was applied and only its snapshot was lost', () => {
    vi.useFakeTimers();
    try {
      const { conn, sockets } = wire();
      const recalibration = sendRecalibration(conn, sent);
      sockets[0]!.open();
      sockets[0]!.deliver(snapshot(old));
      sockets[0]!.onclose?.({});
      vi.advanceTimersByTime(1_000);
      sockets[1]!.open();
      sockets[1]!.deliver(snapshot(applied));
      expect(sockets[1]!.frames).toEqual(['sync']);
      expect(recalibration.pending()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops, and frees the back rank, on a refusal or a game no longer suspended, and not on any other error', () => {
    const { conn, sockets } = wire();
    const done: string[] = [];
    const recalibration = sendRecalibration(conn, sent, { onDone: (o) => done.push(o) });
    sockets[0]!.open();
    sockets[0]!.deliver(snapshot(old));
    sockets[0]!.deliver({ t: 'error', code: 'out_of_reach', message: 'x' });
    expect(done).toEqual([]);
    sockets[0]!.deliver({ t: 'error', code: 'bad_field', message: 'That field is not usable.' });
    expect(done).toEqual(['refused']);
    expect(recalibration.pending()).toBe(false);

    const second = wire();
    const outcomes: string[] = [];
    sendRecalibration(second.conn, sent, { onDone: (o) => outcomes.push(o) });
    second.sockets[0]!.open();
    second.sockets[0]!.deliver(snapshot(old, 'finished'));
    expect(outcomes).toEqual(['over']);
    expect(second.sockets[0]!.frames).toEqual(['sync']);
  });

  it('does not send an older walk over a newer one, and frees the board', () => {
    const { conn, sockets } = wire();
    const done: string[] = [];
    const recalibration = sendRecalibration(conn, sent, { onDone: (o) => done.push(o) });
    sockets[0]!.open();
    // Another phone of this account applied version 3 meanwhile.
    sockets[0]!.deliver(snapshot(snapshotField({ ...spec0, version: 3 })));
    expect(sockets[0]!.frames).toEqual(['sync']);
    expect(done).toEqual(['superseded']);
    expect(recalibration.pending()).toBe(false);
  });

  it('knows its own field by id, version and corners', () => {
    expect(recalibrationApplied({ field: applied }, sent)).toBe(true);
    expect(recalibrationApplied({ field: old }, sent)).toBe(false);
    expect(recalibrationApplied({ field: { ...applied, a1: { ...applied.a1, lat: applied.a1.lat + 1e-6 } } }, sent)).toBe(false);
  });
});

describe('recalibrating in a pause (stage 12.3)', () => {
  const mine = field(10, 10);
  const snap = (over: Partial<GameSnapshot>): GameSnapshot =>
    ({ status: 'suspended', result: null, field: mine, remote: { squareM: 6 }, suspension: { at: 5 }, ...over }) as GameSnapshot;

  it('is offered only in a remote game, only while suspended, and never once it is over', () => {
    expect(canRecalibrate(snap({}))).toBe(true);
    expect(canRecalibrate(snap({ remote: undefined }))).toBe(false);
    expect(canRecalibrate(snap({ status: 'active' }))).toBe(false);
    expect(canRecalibrate(snap({ status: 'staging' }))).toBe(false);
    expect(canRecalibrate(snap({ result: { outcome: '1-0', reason: 'abandoned', at: 1 } }))).toBe(false);
    expect(canRecalibrate(null)).toBe(false);
  });

  it('says whose recalibration moved the squares, and nothing for a join or a same-field game', () => {
    const before = snap({});
    const recalibrated = snap({ field: { ...before.field, snapshotAt: before.field.snapshotAt + 1 }, remote: { squareM: 4 } });
    expect(rescaleNotice(before, recalibrated)).toBe('Your field is recalibrated. The squares are now 4.0 m on both fields.');
    const sameSize = snap({ field: { ...before.field, snapshotAt: before.field.snapshotAt + 1 } });
    expect(rescaleNotice(before, sameSize)).toBe('Your field is recalibrated. The squares are still 6.0 m on both fields.');
    const theirs = snap({ remote: { squareM: 8 } });
    expect(rescaleNotice(before, theirs, 'us')).toBe('Your opponent recalibrated their field. The squares are now 26 ft on both fields.');
    expect(rescaleNotice(before, snap({}))).toBeNull();
    // The join moves the shared square too, and is nobody's recalibration.
    expect(rescaleNotice(snap({ status: 'waiting' }), snap({ status: 'staging', remote: { squareM: 4 } }))).toBeNull();
    expect(rescaleNotice(snap({ remote: undefined }), snap({ remote: undefined }))).toBeNull();
  });

  it('starts a new handshake episode when the board changes shape, and leaves a same-field episode as it was', () => {
    const before = snap({});
    const episode = handshakeEpisode(before, 0);
    expect(handshakeEpisode(snap({}), 0)).toBe(episode);
    expect(handshakeEpisode(snap({ remote: { squareM: 4 } }), 0)).not.toBe(episode);
    expect(handshakeEpisode(snap({ field: { ...before.field, snapshotAt: 1 } }), 0)).not.toBe(episode);
    // A same-field game's episode is the string it always was.
    const same = snap({ remote: undefined });
    expect(handshakeEpisode(same, 2)).toBe('suspended|2|5');
    expect(handshakeEpisode(snap({ remote: undefined, field: field(5, 5) }), 2)).toBe('suspended|2|5');
  });

  it('tells the player which corners to walk, and that the other board may change', () => {
    const shrunk = recalibratePurpose(true);
    expect(shrunk.title).toBe('Recalibrate your field');
    expect(shrunk.intro).toMatch(/just inside the dashed line/);
    expect(shrunk.intro).toMatch(/not the smaller board inside it/);
    expect(shrunk.intro).toMatch(/Your opponent's board may change size/);
    const whole = recalibratePurpose(false);
    expect(whole.intro).not.toMatch(/dashed/);
    expect(whole.intro).toMatch(/Your opponent's board may change size/);
  });
});

describe('the opponent track can be cleared', () => {
  it('draws nothing after clear, and the next fix appears where it is', () => {
    const track = new OpponentTrack();
    track.push({ lat: 1, lng: 1, acc: 4, at: 1_000 });
    track.clear();
    expect(track.at(2_000)).toBeNull();
    track.push({ lat: 2, lng: 2, acc: 4, at: 500 });
    expect(track.at(600)).toEqual({ pos: { lat: 2, lng: 2 }, acc: 4, moving: false });
  });
});

describe('creating a remote game', () => {
  const fields = [spec(8, 8, 0)];

  it('leaves a same-field body as it was', () => {
    const body = createGameBody(emptyDraft(fields), fields[0], 'w');
    expect(body).not.toHaveProperty('remote');
    expect(body).not.toHaveProperty('disclosureAccepted');
  });

  it('sends remote and the acceptance as booleans', () => {
    const draft = { ...emptyDraft(fields), remote: true, disclosureAccepted: true };
    expect(createGameBody(draft, fields[0], 'w')).toMatchObject({ remote: true, disclosureAccepted: true });
  });

  it('waits on the disclosure, and every draft starts unchecked', () => {
    expect(emptyDraft(fields)).toMatchObject({ remote: false, disclosureAccepted: false });
    expect(createRefusal({ ...emptyDraft(fields), remote: true }, fields)).toBe(DISCLOSURE_NEEDED);
    expect(createRefusal({ ...emptyDraft(fields), remote: true, disclosureAccepted: true }, fields)).toBeNull();
    expect(createRefusal(emptyDraft(fields), fields)).toBeNull();
  });

  it('says the reach may be less on two fields, and nothing new on one', () => {
    const draft = emptyDraft(fields);
    expect(reachNote({ ...draft, remote: true }, fields[0])).toMatch(
      /^Reach 0\.4 squares — about 3\.2 m on this field, or less if your opponent's squares are smaller\. /,
    );
    expect(reachNote(draft, fields[0])).not.toMatch(/opponent/);
  });

  it('says the disclosure plainly, in one sentence, with an unchecked box', () => {
    expect(DISCLOSURE_TEXT).toMatch(/an opponent with the right tools could work out where you are/);
    expect(disclosureHtml(false)).not.toMatch(/checked/);
    expect(disclosureHtml(true)).toMatch(/checked/);
  });
});

describe('joining a remote game', () => {
  const FIELD = field(6, 6);
  const replies = (status: number, body: unknown, seen: RequestInit[] = []) =>
    (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

  it('says each remote refusal in a sentence of its own', async () => {
    for (const [code, words] of [
      ['field_required', /played on two fields\. Choose one of your own fields/],
      ['disclosure_required', /Accept the note about your location/],
      ['bad_field', /could not be used for this game/],
    ] as const) {
      const outcome = await joinGame('abc123', { fetch: replies(400, { error: code, message: 'server words' }) });
      expect(outcome).toMatchObject({ ok: false, reason: code, message: expect.stringMatching(words) });
      if (!outcome.ok) expect(outcome.hint).not.toMatch(/Try again in a moment/);
    }
  });

  it('sends the field and the acceptance only when asked to, and reads remote back', async () => {
    const seen: RequestInit[] = [];
    await joinGame('abc123', { fetch: replies(200, { color: 'b', field: FIELD }, seen) });
    expect(seen[0]).toEqual({ method: 'POST' });
    const s = spec(6, 6, 0);
    const outcome = await joinGame('abc123', {
      fetch: replies(200, { color: 'b', field: FIELD, remote: true }, seen),
      remote: { field: s, disclosureAccepted: true },
    });
    expect(JSON.parse(String(seen[1].body))).toEqual({ field: JSON.parse(JSON.stringify(s)), disclosureAccepted: true });
    expect(outcome).toMatchObject({ ok: true, remote: true, colour: 'b' });
  });

  it('picks the field asked for, else the newest, and waits on both', () => {
    const fields = [spec(8, 8, 0), spec(6, 6, 0)];
    expect(startingField(fields)).toBe(fields[0]);
    expect(startingField(fields, fields[1].id)).toBe(fields[1]);
    expect(startingField(fields, 'gone')).toBe(fields[0]);
    expect(remoteJoinRefusal(undefined, true)).toMatch(/Calibrate a field first/);
    expect(remoteJoinRefusal(fields[0], false)).toBe(DISCLOSURE_NEEDED);
    expect(remoteJoinRefusal(fields[0], true)).toBeNull();
  });
});

describe('the invitation to a remote game', () => {
  it('names no field', () => {
    const invite = inviteFor('ABC123', { name: 'Grandma’s garden' }, 'https://x.test', undefined, true);
    expect(invite).not.toHaveProperty('fieldName');
    const words = inviteShareData(invite);
    expect(words.text).not.toMatch(/garden/);
    expect(words.text).toMatch(/field of our own/);
  });

  it('is unchanged for the same field', () => {
    const invite = inviteFor('ABC123', { name: 'The common' }, 'https://x.test');
    expect(inviteShareData(invite).text).toBe('Come and play chess on a real field at The common. Join code ABC 123.');
  });
});

describe('what the board says about a remote game', () => {
  it('says nothing in a same-field game', () => {
    expect(remoteWords(myBoard({ field: field(8, 8) }), 'active')).toBeNull();
    expect(remoteWords(null, 'active')).toBeNull();
  });

  it('gives the shared square, and explains the outline on a shrunk board', () => {
    const shrunk = myBoard({ field: field(10, 10), remote: { squareM: 6 } });
    expect(remoteWords(shrunk, 'staging')).toEqual({
      squares: '6.0 m on both fields',
      note: "Shrunk to match your opponent's smaller squares. The dashed line is the field you marked out.",
    });
    expect(remoteWords(shrunk, 'active')).toEqual({ squares: '6.0 m on both fields', note: null });
    expect(remoteWords(shrunk, 'active', 'us')?.squares).toMatch(/ft on both fields/);
    expect(remoteWords(myBoard({ field: field(10, 10), remote: { squareM: 10 } }), 'waiting')?.squares).toBe('10.0 m for now');
  });

  it('keeps the small-square warning in play, in the calibration’s own words', () => {
    const thin = myBoard({ field: field(12, 3), remote: { squareM: 5 } });
    const words = remoteWords(thin, 'active');
    expect(words?.note).toBe(smallSquareWarning(Math.min(thin.geo.fileM, thin.geo.rankM)));
  });
});

describe('the small-square warning', () => {
  it('is the calibration check’s sentence exactly', () => {
    const check = checkCalibration(spec(3, 3, 0), {});
    expect(check.warnings).toContain(smallSquareWarning(Math.min(check.fileM, check.rankM)));
    expect(SMALL_SQUARE_M).toBe(4);
  });
});

describe('fitting a shrunk board with its field', () => {
  it('fits the outline on the canvas, and is unchanged without one', () => {
    const f = field(10, 10, 0);
    const shrunk = playableBoard(f, 6);
    const full = deriveGeometry(f);
    expect(projectionFor(shrunk, 'w', 400, 400, null).scale).toBe(projectionFor(shrunk, 'w', 400, 400).scale);
    // The field is 10/6 the board's size, so the board is drawn that much smaller.
    expect(projectionFor(shrunk, 'w', 400, 400, full).scale).toBeCloseTo(projectionFor(shrunk, 'w', 400, 400).scale * 0.6, 6);
  });
});

describe('a recalibration kept on the phone until it lands (stage 12.3, review round 3)', () => {
  const field = { ...spec(8, 8, 30), version: 2 };
  const map = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it('is read back for the same game and account only', () => {
    const storage = map();
    rememberRecalibration(storage, 'ABC123', 'sub-a', field);
    expect(pendingRecalibration(storage, 'ABC123', 'sub-a')).toEqual(field);
    expect(pendingRecalibration(storage, 'ABC123', 'sub-b')).toBeNull();
    expect(pendingRecalibration(storage, 'ABC123', null)).toBeNull();
    expect(pendingRecalibration(storage, 'XYZ789', 'sub-a')).toBeNull();
  });

  it('is forgotten at its ending, but not by an earlier one that a newer recalibration replaced', () => {
    const storage = map();
    rememberRecalibration(storage, 'ABC123', 'sub-a', field);
    const newer = { ...field, version: 3 };
    rememberRecalibration(storage, 'ABC123', 'sub-a', newer);
    forgetRecalibration(storage, 'ABC123', field);
    expect(pendingRecalibration(storage, 'ABC123', 'sub-a')).toEqual(newer);
    forgetRecalibration(storage, 'ABC123', newer);
    expect(pendingRecalibration(storage, 'ABC123', 'sub-a')).toBeNull();
  });

  it('forgets nothing, and does not throw, over a record stored as null', () => {
    const m = new Map<string, string>([['satchess.recalibrations', '{"ABC123":null}']]);
    const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(() => forgetRecalibration(storage, 'ABC123', field)).not.toThrow();
    expect(pendingRecalibration(storage, 'ABC123', 'sub-a')).toBeNull();
  });

  it('reads back nothing from a record whose corners are not places', () => {
    const storage = map();
    rememberRecalibration(storage, 'ABC123', 'sub-a', { ...field, a1: undefined } as unknown as typeof field);
    expect(pendingRecalibration(storage, 'ABC123', 'sub-a')).toBeNull();
    rememberRecalibration(storage, 'ABC123', 'sub-a', { ...field, h8: { lat: '1', lng: 2 } } as unknown as typeof field);
    expect(pendingRecalibration(storage, 'ABC123', 'sub-a')).toBeNull();
    rememberRecalibration(storage, 'ABC123', 'sub-a', field);
    expect(pendingRecalibration(storage, 'ABC123', 'sub-a')).toEqual(field);
  });

  it('never throws on a storage that refuses, holds rubbish, or is not there', () => {
    const refusing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(() => rememberRecalibration(refusing, 'ABC123', 'sub-a', field)).not.toThrow();
    expect(pendingRecalibration(refusing, 'ABC123', 'sub-a')).toBeNull();
    expect(() => forgetRecalibration(refusing, 'ABC123', field)).not.toThrow();
    const rubbish = { getItem: () => '[1,2', setItem: () => undefined };
    expect(pendingRecalibration(rubbish, 'ABC123', 'sub-a')).toBeNull();
    expect(pendingRecalibration(null, 'ABC123', 'sub-a')).toBeNull();
  });
});
