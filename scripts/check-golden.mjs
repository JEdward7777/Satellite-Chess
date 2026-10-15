#!/usr/bin/env node
/**
 * Golden games: play the same scripted games against two servers and compare
 * what each game leaves behind (stage 11.1, decision 0056).
 *
 * Written for the refactor that moved chess behind the game interface, which
 * promised **no change a player or a file could see**, and kept because every
 * later change to the rules layer (checkers, stage 11.2) makes the same
 * promise about chess. Run it once against a server built from the commit
 * before the change and once against the one after, then compare:
 *
 *   node scripts/check-golden.mjs --base=http://127.0.0.1:9261 --save=old.json \
 *        [--tree=<checkout the server runs from> --persist=<its --persist-to>]
 *   node scripts/check-golden.mjs --base=http://127.0.0.1:9261 --save=new.json [...]
 *   node scripts/check-golden.mjs --compare=old.json,new.json
 *
 * No browser: two signed-in players over HTTP and WebSocket, exactly the
 * messages a phone sends, on a small square field so every carry is a short,
 * plausible walk. Each game records:
 *
 * - **the PGN** as `/api/game/:code/pgn` serves it while the object lives;
 * - **the review report** as `/api/game/:code/review` serves it;
 * - **every frame a watcher was sent**, from before the first move to the
 *   socket closing at the result, and every frame each player was sent;
 * - **the archive**: the raw KV value, read with `wrangler kv key get` when
 *   `--tree` and `--persist` say where (the dev seam hastens collection), and
 *   the PGN and report served from it after the object has gone.
 *
 * What differs between two runs of the *same* code is normalised and nothing
 * else: dates and times of day, durations measured on the clock (and so where
 * the movetext's lines wrap), the join code, and the clocks and server times
 * in watcher frames. Everything else —
 * movetext, comments' distances and positions, tags, results, tracks, frame
 * order, revisions — must match exactly.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { Chess } from 'chess.js';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const i = a.indexOf('=');
    return i < 0 ? [a.replace(/^--/, ''), ''] : [a.slice(2, i), a.slice(i + 1)];
  }),
);

const DEV_SECRET = 'local-dev-secret';

// ---------------------------------------------------------------------------
// Comparing two saved runs
// ---------------------------------------------------------------------------

if (args.has('compare')) {
  const [a, b] = args.get('compare').split(',');
  const left = JSON.parse(readFileSync(a, 'utf8'));
  const right = JSON.parse(readFileSync(b, 'utf8'));
  let failures = 0;
  const names = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  for (const name of names) {
    for (const part of ['meta', 'pgn', 'report', 'frames', 'white', 'black', 'archive', 'archivedPgn', 'archivedReport']) {
      const l = JSON.stringify(left[name]?.[part] ?? null, null, 1);
      const r = JSON.stringify(right[name]?.[part] ?? null, null, 1);
      if (l === r) {
        const size = part === 'frames' ? `${(left[name]?.frames ?? []).length} frames` : `${l.length} bytes`;
        console.log(`  ok    ${name} ${part} (${size})`);
        continue;
      }
      failures += 1;
      const ll = l.split('\n');
      const rl = r.split('\n');
      let at = 0;
      while (at < ll.length && ll[at] === rl[at]) at += 1;
      console.log(`  DIFF  ${name} ${part}, first at line ${at + 1}:`);
      console.log(`        ${a}: ${ll.slice(at, at + 3).join(' ')}`);
      console.log(`        ${b}: ${rl.slice(at, at + 3).join(' ')}`);
    }
  }
  console.log(failures === 0 ? '\nGOLDEN: identical' : `\nGOLDEN: ${failures} difference(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------

const BASE = args.get('base') ?? 'http://127.0.0.1:8799';
const ORIGIN = new URL(BASE).origin;
const SAVE = args.get('save');
const TREE = args.get('tree');
const PERSIST = args.get('persist');
if (!SAVE) {
  console.error('--save=<file> is required (or --compare=a,b)');
  process.exit(2);
}

/** The games. SAN, as a player would read them; the script turns each into squares. */
const GAMES = {
  // Checkmate, Black, in two moves.
  foolsMate: { moves: ['f3', 'e5', 'g4', 'Qh4#'] },
  // Captures, checks, and checkmate by White.
  scholarsMate: { moves: ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'] },
  // Both castlings, en passant both ways, an underpromotion, then a resignation.
  specials: {
    moves: [
      'e4', 'Nf6', 'e5', 'd5', 'exd6', 'Nc6', 'dxc7', 'e6', 'Nf3', 'Be7', 'Be2', 'O-O', 'O-O',
      'b5', 'd4', 'b4', 'c4', 'bxc3', 'Nbd2', 'cxd2', 'cxd8=N', 'dxc1=Q', 'Nb7',
    ],
    end: { by: 'b', t: 'resign' },
  },
  // Stalemate: Sam Loyd's ten moves.
  stalemate: {
    moves: [
      'e3', 'a5', 'Qh5', 'Ra6', 'Qxa5', 'h5', 'h4', 'Rah6', 'Qxc7', 'f6', 'Qxd7+', 'Kf7', 'Qxb7',
      'Qd3', 'Qxb8', 'Qh7', 'Qxc8', 'Kg6', 'Qe6',
    ],
  },
  // A draw by agreement.
  agreed: { moves: ['d4', 'd5', 'c4', 'e6'], end: { by: 'w', t: 'draw' } },
  // Black's flag falls on a short clock, with White able to mate: a loss on time.
  timeout: { moves: ['e4'], initialMs: 4000, end: { wait: 'flag' } },
  // Aborted before each side has moved: no result, no archive.
  aborted: { moves: ['e4'], end: { by: 'b', t: 'abort' }, archived: false },
};

/** One-meter squares, so every carry is under the twice-5-m accuracy allowance and plausible at once. */
const SQUARE_M = 1;
const A1 = { lat: 51.4779, lng: -0.0015 };
const M_PER_DEG_LAT = (6378137 * Math.PI) / 180;
const mPerDegLng = (lat) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
function centre(square) {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return {
    lat: A1.lat + (rank * SQUARE_M) / M_PER_DEG_LAT,
    lng: A1.lng + (file * SQUARE_M) / mPerDegLng(A1.lat),
  };
}
const fix = (square) => ({ ...centre(square), acc: 5, ts: 0 });

const FIELD = {
  id: 'golden-field',
  name: 'Golden field',
  a1: centre('a1'),
  h8: centre('h8'),
  version: 1,
  createdAt: 1,
  updatedAt: 1,
};

async function session(sub) {
  const response = await fetch(`${ORIGIN}/api/dev/session`, {
    method: 'POST',
    headers: { 'x-dev-auth-secret': DEV_SECRET, 'content-type': 'application/json' },
    body: JSON.stringify({ sub }),
  });
  if (!response.ok) throw new Error(`dev session for ${sub}: ${response.status}`);
  const cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { sub, cookie };
}

async function api(player, path, init = {}) {
  const response = await fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie: player.cookie, 'content-type': 'application/json' },
  });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

/** A socket that keeps every message, with a barrier: send an unknown type, wait for its echo. */
function open(url, cookie) {
  const ws = new WebSocket(url, cookie ? { headers: { cookie } } : undefined);
  const socket = { ws, messages: [], closed: null, waiters: [], barriers: 0 };
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    socket.messages.push(msg);
    for (const w of [...socket.waiters]) w();
  });
  ws.addEventListener('close', (event) => {
    socket.closed = event.code;
    for (const w of [...socket.waiters]) w();
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(socket));
    ws.addEventListener('error', () => reject(new Error(`could not open ${url}`)));
  });
}

function until(socket, predicate, label, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        socket.waiters = socket.waiters.filter((w) => w !== check);
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      socket.waiters = socket.waiters.filter((w) => w !== check);
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);
    socket.waiters.push(check);
    check();
  });
}

async function handled(socket) {
  socket.barriers += 1;
  const marker = `golden-barrier-${socket.barriers}`;
  socket.ws.send(JSON.stringify({ t: marker }));
  await until(
    socket,
    () => socket.messages.some((m) => m.t === 'error' && m.message?.includes(`"${marker}"`)),
    marker,
  );
}

const lastState = (socket) => [...socket.messages].reverse().find((m) => m.t === 'state')?.game ?? null;

async function send(socket, msg) {
  socket.ws.send(JSON.stringify(msg));
  await handled(socket);
  const refused = socket.messages.filter((m) => m.t === 'error' && !String(m.message).includes('golden-barrier'));
  if (refused.length > 0) throw new Error(`refused ${JSON.stringify(msg)}: ${JSON.stringify(refused.at(-1))}`);
}

async function play(name, game, index) {
  const run = `${Date.now().toString(36)}-${index}`;
  const white = await session(`golden-w-${run}`);
  const black = await session(`golden-b-${run}`);
  const created = await api(white, '/api/game', {
    method: 'POST',
    body: JSON.stringify({ field: FIELD, color: 'w', initialMs: game.initialMs ?? 1_800_000, incrementMs: 0 }),
  });
  if (created.status !== 201) throw new Error(`${name}: create ${created.status} ${created.text}`);
  const code = JSON.parse(created.text).joinCode;
  const joined = await api(black, `/api/game/${code}`, { method: 'POST', body: '{}' });
  if (joined.status !== 200) throw new Error(`${name}: join ${joined.status} ${joined.text}`);

  const wsBase = ORIGIN.replace(/^http/, 'ws');
  const w = await open(`${wsBase}/api/game/${code}/ws`, white.cookie);
  await handled(w);
  const b = await open(`${wsBase}/api/game/${code}/ws`, black.cookie);
  await handled(b);
  await handled(w);

  // Both agree to be watched, and a watcher is there before the first move.
  await send(w, { t: 'watch', action: 'on' });
  await send(b, { t: 'watch', action: 'on' });
  const link = lastState(b)?.watch?.link;
  if (!link) throw new Error(`${name}: no watch link`);
  const watcher = await open(`${wsBase}/api/watch/${link.split('/').pop()}/ws`);
  await until(watcher, () => watcher.messages.length > 0, 'the first watcher frame');

  // The handshake: each on their own back rank.
  await send(w, { t: 'ready', pos: fix('e1') });
  await send(b, { t: 'ready', pos: fix('e8') });
  await handled(w);
  if (lastState(w)?.status !== 'active') throw new Error(`${name}: not active after the handshake`);

  const chess = new Chess();
  for (const san of game.moves) {
    const move = chess.move(san);
    const mover = move.color === 'w' ? w : b;
    const other = move.color === 'w' ? b : w;
    await send(mover, { t: 'lift', from: move.from, pos: fix(move.from) });
    await send(mover, {
      t: 'place',
      to: move.to,
      pos: fix(move.to),
      ...(move.promotion ? { promotion: move.promotion } : {}),
    });
    await handled(other);
  }

  if (game.end?.t === 'resign') await send(game.end.by === 'w' ? w : b, { t: 'resign' });
  if (game.end?.t === 'abort') await send(game.end.by === 'w' ? w : b, { t: 'abort' });
  if (game.end?.t === 'draw') {
    const [offerer, answerer] = game.end.by === 'w' ? [w, b] : [b, w];
    await send(offerer, { t: 'draw', action: 'offer' });
    await send(answerer, { t: 'draw', action: 'accept' });
  }
  if (game.end?.wait === 'flag') {
    await until(w, () => lastState(w)?.result != null, 'the flag', 30_000);
  }
  await until(watcher, () => watcher.closed !== null, 'the watcher to be closed at the end', 15_000);
  await handled(w);

  const pgn = await api(white, `/api/game/${code}/pgn`);
  const review = await api(white, `/api/game/${code}/review`);
  const out = {
    status: lastState(w)?.status,
    pgn: normalisePgn(pgn.text),
    // The result, how the watcher was let go, and the file's type and name.
    meta: {
      status: lastState(w)?.status,
      result: lastState(w)?.result ? { ...lastState(w).result, at: '#' } : null,
      watcherClosedWith: watcher.closed,
      type: pgn.headers.get('content-type'),
      disposition: pgn.headers.get('content-disposition')?.replace(/\d{4}-\d\d-\d\d/, '#'),
    },
    report: normalise(JSON.parse(review.text)),
    frames: watcher.messages.map(normalise),
    // Every frame each player's own phone was sent (snapshots, with their
    // destinations, and any refusal), bar the script's own barrier echoes.
    white: playerFrames(w),
    black: playerFrames(b),
  };

  w.ws.close();
  b.ws.close();
  if (game.archived === false) return out;

  // Archived and deleted, through the dev seam, once nobody has it open.
  await new Promise((r) => setTimeout(r, 1_500));
  const hastened = await fetch(`${ORIGIN}/api/dev/game/${code}/collect`, {
    method: 'POST',
    headers: { 'x-dev-auth-secret': DEV_SECRET, 'content-type': 'application/json' },
    body: JSON.stringify({ afterMs: 0 }),
  });
  if (!hastened.ok) throw new Error(`${name}: hasten ${hastened.status}`);
  let archived = null;
  for (let i = 0; i < 120 && archived?.archived !== true; i++) {
    await new Promise((r) => setTimeout(r, 500));
    archived = JSON.parse((await api(white, `/api/game/${code}`)).text);
  }
  if (archived?.archived !== true) throw new Error(`${name}: never archived (${JSON.stringify(archived)})`);
  out.archivedPgn = normalisePgn((await api(white, `/api/game/${code}/pgn`)).text);
  out.archivedReport = normalise(JSON.parse((await api(white, `/api/game/${code}/review`)).text));
  if (TREE && PERSIST) {
    const raw = execFileSync(
      'npx',
      ['wrangler', 'kv', 'key', 'get', `game/v1/${code}`, '--binding', 'ARCHIVE', '--local', '--persist-to', PERSIST, '--text'],
      { cwd: TREE, encoding: 'utf8' },
    );
    const value = JSON.parse(raw);
    out.archive = normalise({ ...value, pgn: normalisePgn(value.pgn) });
    out.meta.archiveKeys = Object.keys(value);
  }
  return out;
}

/** What differs between two runs of the same code: when, and for how long. */
const VOLATILE = new Set([
  'at', 'startedAt', 'finishedAt', 'carriedMs', 'joinCode', 'serverNow', 'archivedAt',
  'whiteMs', 'blackMs', 'lastSeenAt', 'createdAt', 'snapshotAt',
  // The watch link holds a fresh random secret each time.
  'link',
]);

function playerFrames(socket) {
  return socket.messages
    .filter((m) => !(m.t === 'error' && String(m.message).includes('golden-barrier')))
    .map(normalise);
}

function normalise(value) {
  if (Array.isArray(value)) return value.map(normalise);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'pgn' && typeof inner === 'string') out[key] = normalisePgn(inner);
    else if (VOLATILE.has(key) && inner !== null) out[key] = '#';
    else out[key] = normalise(inner);
  }
  return out;
}

/**
 * A PGN with its times taken out. The movetext is wrapped at 80 columns, and
 * a carry's seconds ("in 0.4 s", "in 0 s") change where a line breaks, so
 * the movetext is compared as one line of tokens: every token, in order.
 */
function normalisePgn(text) {
  const [head, ...rest] = text.split('\n\n');
  const tags = head.replace(/\[(Date|UTCDate|UTCTime) "[^"]*"\]/g, '[$1 "#"]');
  const moves = rest.join('\n\n').replace(/\s+/g, ' ').replace(/ in [0-9.]+ s/g, ' in # s');
  return `${tags}\n\n${moves}`;
}

const results = {};
let index = 0;
for (const [name, game] of Object.entries(GAMES)) {
  index += 1;
  process.stdout.write(`${name}… `);
  results[name] = await play(name, game, index);
  console.log(`${results[name].status}, ${results[name].frames.length} watcher frames`);
}
writeFileSync(SAVE, JSON.stringify(results, null, 1));
console.log(`saved ${SAVE}`);
