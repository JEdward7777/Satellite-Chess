#!/usr/bin/env node
/**
 * SessionStart hook: put the project's current position into a fresh thread's
 * context before anyone types anything.
 *
 * Deliberately terse. This runs at the top of every session, so every line costs
 * context on every session forever. It orients and points; it does not explain.
 * The files themselves are the detail.
 *
 * Never exits non-zero — a broken hook must not block a session. Worst case it
 * prints nothing and CLAUDE.md tells the assistant to read the files by hand.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const HARNESS = join(ROOT, 'harness');

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** The "Left at" line from STATE.md, which is the single most useful sentence. */
function stateSummary() {
  const text = safe(() => readFileSync(join(HARNESS, 'STATE.md'), 'utf8'), '');
  if (!text) return null;
  const lines = [];
  for (const line of text.split('\n')) {
    // "Last session" is read authoritatively from the sessions directory below.
    const m = /^\*\*(Active stage|Next action|Tree state)\*\*:?\s*(.+)$/.exec(line);
    if (m) lines.push(`${m[1]}: ${m[2].trim()}`);
  }
  return lines.length ? lines : null;
}

function newestSession() {
  const files = safe(
    () => readdirSync(join(HARNESS, 'sessions')).filter((f) => /^\d{4}-\d{2}-\d{2}-\d+\.md$/.test(f)),
    [],
  );
  if (!files.length) return null;
  files.sort();
  const name = files[files.length - 1];
  const text = safe(() => readFileSync(join(HARNESS, 'sessions', name), 'utf8'), '');
  const left = /^\*\*Left at:\*\*\s*(.+)$/m.exec(text);
  return { name, left: left ? left[1].trim() : null };
}

function openObservations() {
  const text = safe(() => readFileSync(join(HARNESS, 'observations', 'open.md'), 'utf8'), '');
  const ids = [...text.matchAll(/^### (O-\d+)\s+—\s+(.+)$/gm)];
  return ids.map((m) => ({ id: m[1], title: m[2] }));
}

function planBrief() {
  return safe(
    () => execFileSync(process.execPath, [join(ROOT, 'scripts', 'plan.mjs'), '--brief'], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    }).trimEnd(),
    null,
  );
}

function gitDirty() {
  const out = safe(
    () => execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }),
    '',
  );
  return out.trim().split('\n').filter(Boolean).length;
}

function main() {
  const out = [];
  out.push('── Satellite-Chess ─────────────────────────────────────────');
  out.push('Chess on a real field. Rules: harness/AGENTS.md (read it first).');

  const state = stateSummary();
  if (state) {
    out.push('');
    for (const line of state) out.push(line);
  }

  const session = newestSession();
  if (session) {
    out.push('');
    out.push(`Last session: harness/sessions/${session.name}`);
    if (session.left) out.push(`  left at: ${session.left}`);
  }

  const plan = planBrief();
  if (plan) {
    out.push('');
    out.push(plan);
  }

  const obs = openObservations();
  if (obs.length) {
    out.push('');
    out.push(`${obs.length} open observation(s) — harness/observations/open.md`);
    for (const o of obs) out.push(`  ${o.id} ${o.title}`);
  }

  const dirty = gitDirty();
  if (dirty) {
    out.push('');
    out.push(`! ${dirty} uncommitted file(s) — a previous session may not have finished cleanly.`);
  }

  out.push('────────────────────────────────────────────────────────────');
  process.stdout.write(out.join('\n') + '\n');
}

try {
  main();
} catch {
  // A hook that throws must not stop a session starting.
}
