#!/usr/bin/env node
/**
 * Read the stage tree out of harness/plan/ and either print it or check it.
 *
 * The Markdown is the source of truth — a generated file that can drift from a
 * database is worse than a file a human can fix in place. So the line format is
 * strict enough to parse and loose enough to write by hand:
 *
 *     - `3.2.4` active: Persist a pending lift across hibernation
 *
 * Anything else in those files is prose for humans and is ignored.
 *
 *   node scripts/plan.mjs            tree with statuses and a rollup
 *   node scripts/plan.mjs --check    validate; non-zero exit on a problem
 *   node scripts/plan.mjs --active   just the active stages
 *   node scripts/plan.mjs --next     the next actionable stages
 *   node scripts/plan.mjs --brief    one-screen summary, for the session hook
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PLAN_DIR = join(import.meta.dirname, '..', 'harness', 'plan');

const STATUSES = ['todo', 'active', 'done', 'blocked', 'dropped'];

const STAGE_RE = /^(\s*)-\s+`(\d+(?:\.\d+)*)`\s+([a-z]+)\s*:\s*(.+?)\s*$/;

const COLOUR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COLOUR ? `[${code}m${s}[0m` : s);

const MARK = {
  done: () => c('32', '✓'),
  active: () => c('36', '▶'),
  todo: () => c('90', '·'),
  blocked: () => c('31', '✗'),
  dropped: () => c('90', '–'),
};

function planFiles() {
  return readdirSync(PLAN_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort();
}

function parse() {
  const stages = [];
  const problems = [];

  for (const file of planFiles()) {
    const lines = readFileSync(join(PLAN_DIR, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = STAGE_RE.exec(line);
      if (!m) {
        // Catch a stage line that is nearly right, so a typo is not silently
        // dropped from the plan.
        if (/^\s*-\s+`\d/.test(line)) {
          problems.push(`${file}:${i + 1}: looks like a stage but does not parse: ${line.trim()}`);
        }
        return;
      }
      const [, indent, id, status, title] = m;
      if (!STATUSES.includes(status)) {
        problems.push(
          `${file}:${i + 1}: unknown status "${status}" (expected ${STATUSES.join(', ')})`,
        );
        return;
      }
      stages.push({
        id,
        status,
        title,
        file,
        line: i + 1,
        depth: id.split('.').length,
        indent: indent.length,
        parts: id.split('.').map(Number),
      });
    });
  }

  return { stages, problems };
}

function byId(stages) {
  return new Map(stages.map((s) => [s.id, s]));
}

function parentId(id) {
  const parts = id.split('.');
  return parts.length > 1 ? parts.slice(0, -1).join('.') : null;
}

function sortStages(stages) {
  return [...stages].sort((a, b) => {
    const n = Math.min(a.parts.length, b.parts.length);
    for (let i = 0; i < n; i++) {
      if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
    }
    return a.parts.length - b.parts.length;
  });
}

function childrenOf(stages) {
  const kids = new Map();
  for (const s of stages) {
    const p = parentId(s.id);
    if (p === null) continue;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(s);
  }
  return kids;
}

function check(stages) {
  const problems = [];
  const seen = new Map();
  const index = byId(stages);
  const kids = childrenOf(stages);

  for (const s of stages) {
    if (seen.has(s.id)) {
      const first = seen.get(s.id);
      problems.push(
        `duplicate stage \`${s.id}\`: ${first.file}:${first.line} and ${s.file}:${s.line}`,
      );
    } else {
      seen.set(s.id, s);
    }

    const p = parentId(s.id);
    if (p !== null && !index.has(p)) {
      problems.push(`${s.file}:${s.line}: \`${s.id}\` has no parent \`${p}\``);
    }

    const children = kids.get(s.id) ?? [];
    if (s.status === 'done') {
      const unfinished = children.filter((k) => k.status !== 'done' && k.status !== 'dropped');
      if (unfinished.length > 0) {
        problems.push(
          `${s.file}:${s.line}: \`${s.id}\` is done but has unfinished children: ` +
            unfinished.map((k) => `${k.id} (${k.status})`).join(', '),
        );
      }
    }
  }

  problems.push(...checkIndentation(stages));

  const active = stages.filter((s) => s.status === 'active' && (kids.get(s.id) ?? []).length === 0);
  if (active.length > 3) {
    problems.push(
      `${active.length} leaf stages are active (${active.map((s) => s.id).join(', ')}). ` +
        'More than about three means the work was not decomposed finely enough.',
    );
  }

  return problems;
}

/**
 * Indentation must agree with nesting, but only *relatively*.
 *
 * We do not require a fixed offset — a phase file that puts its root and its
 * top-level children at column 0 reads perfectly well. What matters is that a
 * reader can trust the shape: within one file, every stage at a given depth is
 * indented the same amount, and deeper stages are indented further. That catches
 * the mistake this is actually for — a stage pasted in at the wrong level, where
 * the id says one thing and the eye says another.
 */
function checkIndentation(stages) {
  const problems = [];
  const files = new Map();
  for (const s of stages) {
    if (!files.has(s.file)) files.set(s.file, []);
    files.get(s.file).push(s);
  }

  for (const [file, group] of files) {
    const indentByDepth = new Map();
    for (const s of sortStages(group)) {
      const known = indentByDepth.get(s.depth);
      if (known === undefined) {
        indentByDepth.set(s.depth, s.indent);
      } else if (known !== s.indent) {
        problems.push(
          `${file}:${s.line}: \`${s.id}\` is indented ${s.indent} but its depth-${s.depth} ` +
            `siblings are indented ${known}`,
        );
      }
    }
    const depths = [...indentByDepth.keys()].sort((a, b) => a - b);
    for (let i = 1; i < depths.length; i++) {
      // A phase file's root stage is its heading, so depth 1 and depth 2 sharing
      // column 0 is the house style rather than an error. Strictness starts below.
      if (depths[i] <= 2) continue;
      const shallower = indentByDepth.get(depths[i - 1]);
      const deeper = indentByDepth.get(depths[i]);
      if (deeper <= shallower) {
        problems.push(
          `${file}: depth-${depths[i]} stages are indented ${deeper}, which is not deeper than ` +
            `depth-${depths[i - 1]} at ${shallower}`,
        );
      }
    }
  }

  return problems;
}

function rollup(stages) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const s of stages) counts[s.status]++;
  return counts;
}

function printTree(stages) {
  const kids = childrenOf(stages);
  for (const s of sortStages(stages)) {
    const indent = '  '.repeat(s.depth - 1);
    const leaf = (kids.get(s.id) ?? []).length === 0;
    const id = s.status === 'active' ? c('1;36', s.id) : s.id;
    const title = s.status === 'done' ? c('90', s.title) : s.title;
    if (s.depth === 1) process.stdout.write('\n');
    console.log(`${indent}${MARK[s.status]()} ${id}${leaf ? '' : ''}  ${title}`);
  }
}

function printRollup(stages) {
  const r = rollup(stages);
  const done = r.done + r.dropped;
  const pct = stages.length ? Math.round((done / stages.length) * 100) : 0;
  console.log(
    `\n${stages.length} stages — ` +
      `${c('32', `${r.done} done`)}, ` +
      `${c('36', `${r.active} active`)}, ` +
      `${r.todo} todo` +
      (r.blocked ? `, ${c('31', `${r.blocked} blocked`)}` : '') +
      (r.dropped ? `, ${r.dropped} dropped` : '') +
      `  (${pct}%)`,
  );
}

/** Leaf stages that are actionable now: the deepest `active`, else the first `todo`. */
function nextStages(stages) {
  const kids = childrenOf(stages);
  const leaves = sortStages(stages).filter((s) => (kids.get(s.id) ?? []).length === 0);
  const active = leaves.filter((s) => s.status === 'active');
  if (active.length > 0) return active;
  const blocked = leaves.filter((s) => s.status === 'blocked');
  const todo = leaves.filter((s) => s.status === 'todo');
  return [...todo.slice(0, 3), ...blocked.slice(0, 2)];
}

function main() {
  const args = process.argv.slice(2);
  const { stages, problems: parseProblems } = parse();
  const problems = [...parseProblems, ...check(stages)];

  if (args.includes('--check')) {
    if (problems.length === 0) {
      console.log(c('32', `✓ plan is consistent — ${stages.length} stages`));
      return;
    }
    console.error(c('31', `✗ ${problems.length} problem(s) in the plan:\n`));
    for (const p of problems) console.error(`  ${p}`);
    process.exitCode = 1;
    return;
  }

  if (args.includes('--active')) {
    const kids = childrenOf(stages);
    const active = stages.filter(
      (s) => s.status === 'active' && (kids.get(s.id) ?? []).length === 0,
    );
    if (active.length === 0) console.log('no active stage');
    for (const s of sortStages(active)) console.log(`${s.id}  ${s.title}`);
    return;
  }

  if (args.includes('--next')) {
    for (const s of nextStages(stages)) console.log(`${s.status.padEnd(7)} ${s.id}  ${s.title}`);
    return;
  }

  if (args.includes('--brief')) {
    const r = rollup(stages);
    const next = nextStages(stages).slice(0, 3);
    console.log(
      `plan: ${r.done}/${stages.length} done, ${r.active} active` +
        (r.blocked ? `, ${r.blocked} blocked` : ''),
    );
    for (const s of next) console.log(`  ${s.status === 'active' ? '▶' : '·'} ${s.id} ${s.title}`);
    if (problems.length) console.log(`  ! ${problems.length} plan problem(s) — run npm run plan:check`);
    return;
  }

  printTree(stages);
  printRollup(stages);
  if (problems.length > 0) {
    console.log(c('31', `\n✗ ${problems.length} problem(s) — run \`npm run plan:check\``));
    process.exitCode = 1;
  }
}

main();
