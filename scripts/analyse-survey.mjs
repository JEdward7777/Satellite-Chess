#!/usr/bin/env node
/**
 * Turn a field trace into an answer to stage 1.9.3.
 *
 *   node scripts/analyse-survey.mjs <trace.json>
 *   curl -s -H "x-survey-secret: $S" $URL/api/survey/trace/$ID | node scripts/analyse-survey.mjs -
 *
 * The question this exists to settle: **can consumer GPS tell 8 m squares apart
 * on grass?** Everything else in the project is built on the assumption that it
 * can, and until a real phone has walked a real field that assumption is only a
 * hope with tests around it.
 *
 * Four things are measured, in order of how badly a bad answer would hurt:
 *
 * 1. **Does reported accuracy mean anything?** The reach rule adds reported
 *    accuracy to the circle, and the distance accumulator scales its floor by
 *    it. If the number is decorative, both are built on sand.
 * 2. **Scatter while standing still**, which is what decides whether the square
 *    under your feet is stable or flickers between neighbours.
 * 3. **Would a legitimate move have been refused?** Note that this is *not* the
 *    same question as "can the phone tell which square I am on". Reach grows
 *    with reported accuracy, so a vaguer fix buys a more forgiving circle and
 *    the rule partly compensates for its own input. Square flicker is a
 *    rendering problem; a refused move is a broken game. They are reported
 *    separately because they have different fixes.
 * 4. **Repeatability of a marked point**, which is the error a calibrated board
 *    inherits permanently.
 */

import { readFileSync } from 'node:fs';

const EARTH_RADIUS_M = 6378137;
const DEG = Math.PI / 180;
const M_PER_DEG_LAT = (EARTH_RADIUS_M * Math.PI) / 180;

function metresBetween(a, b) {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos(a.lat * DEG);
  return Math.hypot((b.lng - a.lng) * mPerDegLng, (b.lat - a.lat) * M_PER_DEG_LAT);
}

function meanPosition(fixes) {
  return {
    lat: fixes.reduce((sum, f) => sum + f.lat, 0) / fixes.length,
    lng: fixes.reduce((sum, f) => sum + f.lng, 0) / fixes.length,
  };
}

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

function summarise(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  };
}

const fmt = (x, unit = ' m') => (Number.isFinite(x) ? `${x.toFixed(1)}${unit}` : '—');

/** Fixes recorded between a `<step>:start` marker and the step's completion. */
function fixesForHold(trace, stepId) {
  const start = trace.markers.find((m) => m.step === `${stepId}:start`);
  const end = trace.markers.find((m) => m.step === stepId);
  if (!start || !end) return [];
  return trace.fixes.slice(start.atFix, end.atFix + 1);
}

/** The fix nearest in time to a marker — where the surveyor said they stood. */
function fixAtMarker(trace, stepId) {
  const marker = trace.markers.find((m) => m.step === stepId);
  if (!marker) return null;
  return trace.fixes[Math.min(marker.atFix, trace.fixes.length - 1)] ?? null;
}

function report(trace) {
  const out = [];
  const say = (line = '') => out.push(line);

  const minutes = (trace.endedAt - trace.startedAt) / 60000;
  say(`# ${trace.label || trace.id}`);
  say();
  say(`Device:   ${trace.device}`);
  say(`Duration: ${minutes.toFixed(1)} min, ${trace.fixes.length} fixes, ${trace.markers.length} markers`);

  // --- Fix rate -------------------------------------------------------------
  const gaps = [];
  for (let i = 1; i < trace.fixes.length; i++) {
    const gap = trace.fixes[i].t - trace.fixes[i - 1].t;
    if (gap > 0) gaps.push(gap / 1000);
  }
  const rate = summarise(gaps);
  say(`Fix rate: median ${fmt(rate.median, ' s')} between fixes (p95 ${fmt(rate.p95, ' s')}, worst ${fmt(rate.max, ' s')})`);
  say();
  say(
    rate.median <= 1.5
      ? '  ✓ Roughly 1 Hz, which is what the simulator and the budget assume.'
      : `  ! Slower than the assumed 1 Hz. Re-check SMOOTHING_FIXES and CONFIRM_FIXES in gps.ts —\n    both are counted in fixes, not seconds, so a slower rate changes what they mean.`,
  );

  // --- 1. Is reported accuracy honest? --------------------------------------
  say();
  say('## 1. Does reported accuracy mean anything?');
  say();
  const staticFixes = fixesForHold(trace, 'static');
  if (staticFixes.length < 10) {
    say('  (no usable `static` hold in this trace)');
  } else {
    const centre = meanPosition(staticFixes);
    const errors = staticFixes.map((f) => metresBetween(centre, f));
    const err = summarise(errors);
    const claimed = summarise(staticFixes.map((f) => f.acc));
    const within = errors.filter((e, i) => e <= staticFixes[i].acc).length / errors.length;

    say(`  Claimed accuracy:  median ${fmt(claimed.median)}, p95 ${fmt(claimed.p95)}`);
    say(`  Actual error:      median ${fmt(err.median)}, p95 ${fmt(err.p95)}, worst ${fmt(err.max)}`);
    say(`  Fixes landing inside their own claimed radius: ${(within * 100).toFixed(0)}%`);
    say();
    if (within >= 0.6 && err.median <= claimed.median * 1.5) {
      say('  ✓ Reported accuracy tracks reality closely enough to build on.');
      say('    The reach rule and the distance floor are both sound.');
    } else if (within < 0.4) {
      say('  ✗ The phone is optimistic — it is claiming better than it delivers.');
      say('    Consequences: the reach circle is too small (moves refused that should be legal),');
      say('    and DistanceAccumulator\'s floor is too low, so phantom distance accrues.');
      say('    Fix: scale reported accuracy up by the ratio below before using it.');
      say(`    Suggested multiplier: ${(err.p95 / claimed.p95).toFixed(2)}×`);
    } else {
      say('  ~ Roughly honest but loose. Worth a second trace before changing constants.');
    }
  }

  // --- 2. Scatter while standing still --------------------------------------
  say();
  say('## 2. Scatter while standing still — does the square flicker?');
  say();
  for (const [id, label] of [['static', 'three-minute static hold'], ['B-hold', 'one minute on B']]) {
    const held = fixesForHold(trace, id);
    if (held.length < 10) continue;
    const centre = meanPosition(held);
    const spread = summarise(held.map((f) => metresBetween(centre, f)));
    // A square is 8 m; you are misplaced once you drift more than half a square.
    const misplaced = held.filter((f) => metresBetween(centre, f) > 4).length / held.length;
    say(`  ${label}: median ${fmt(spread.median)}, p95 ${fmt(spread.p95)}, worst ${fmt(spread.max)}`);
    say(`    Fixes more than half a square (4 m) from the truth: ${(misplaced * 100).toFixed(0)}%`);
  }
  say();
  say('  Read this against square size: a scatter p95 of s metres means squares smaller');
  say('  than about 2s will flicker between neighbours while you stand still.');

  // --- 3. Can the game actually be played? ---------------------------------
  say();
  say('## 3. Can the game be played on 8 m squares?');
  say();
  const A1 = fixAtMarker(trace, 'A1');
  const B = fixAtMarker(trace, 'B');
  const C = fixAtMarker(trace, 'C');
  if (A1 && B) {
    const measured = metresBetween(A1, B);
    say(`  A→B: measured ${fmt(measured)} against a paced 8 m (error ${fmt(measured - 8, ' m')})`);
  }
  if (A1 && C) {
    const measured = metresBetween(A1, C);
    say(`  A→C: measured ${fmt(measured)} against a paced 24 m (error ${fmt(measured - 24, ' m')})`);
  }

  if (staticFixes.length >= 10) {
    const truth = meanPosition(staticFixes);
    say();
    // The rule is reach, not square identity, and reach grows with reported
    // accuracy — a vaguer fix buys a more forgiving circle. So the question is
    // not "does the phone know which square I am on" but "would a legitimate
    // move have been refused". Those give very different answers, and only the
    // second one decides whether the game works.
    for (const squareM of [6, 8, 10, 12]) {
      const half = squareM / 2;
      let refused = 0;
      let flickered = 0;
      for (const f of staticFixes) {
        const displaced = metresBetween(truth, f);
        // Reach as `shared/reach.ts` computes it: base 5, plus the reported
        // accuracy, clamped to [4, 15].
        const reach = Math.min(15, Math.max(4, 5 + f.acc));
        // Distance to the nearest point of the square you are really standing
        // on, treating the square as a disc of radius `half` — within a few per
        // cent, and conservative near the corners.
        if (Math.max(0, displaced - half) > reach) refused += 1;
        if (displaced > half) flickered += 1;
      }
      const refusedPct = (refused / staticFixes.length) * 100;
      const flickerPct = (flickered / staticFixes.length) * 100;
      say(
        `  ${String(squareM).padStart(2)} m squares (${squareM * 8} m board): ` +
          `moves refused ${refusedPct.toFixed(1)}%, highlighted square wrong ${flickerPct.toFixed(0)}%`,
      );
    }
    say();

    const half8 = 4;
    const refused8 =
      staticFixes.filter(
        (f) => Math.max(0, metresBetween(truth, f) - half8) > Math.min(15, Math.max(4, 5 + f.acc)),
      ).length / staticFixes.length;
    const flicker8 =
      staticFixes.filter((f) => metresBetween(truth, f) > half8).length / staticFixes.length;

    if (refused8 < 0.02) {
      say('  ✓ 8 m squares play fine. The reach rule absorbs this much noise —');
      say('    a vaguer fix buys a bigger circle, which is exactly what it is for.');
      if (flicker8 > 0.2) {
        say();
        say(`    But the highlighted square is wrong ${(flicker8 * 100).toFixed(0)}% of the time, which will`);
        say('    look broken even though no move is ever refused. That is a rendering');
        say('    problem, not a rules problem: smooth the *displayed* square (a short');
        say('    median filter), and leave the rules on the raw fix. See stage 1.3.5.');
      }
    } else if (refused8 < 0.1) {
      say(`  ~ ${(refused8 * 100).toFixed(1)}% of legitimate moves would be refused on 8 m squares.`);
      say('    Playable but irritating. Either raise the default square size, or raise');
      say('    DEFAULT_REACH.baseM — the second is cheaper and does not need a bigger field.');
    } else {
      say(`  ✗ ${(refused8 * 100).toFixed(1)}% of legitimate moves refused on 8 m squares. Not playable as tuned.`);
      say('    Look at the table above for the square size where the refusal rate falls');
      say('    below 2%, and consider raising DEFAULT_REACH.baseM as well.');
    }
  }

  // --- 4. Calibration repeatability ----------------------------------------
  say();
  say('## 4. Repeatability — the error a board inherits for life');
  say();
  const A2 = fixAtMarker(trace, 'A2');
  if (A1 && A2) {
    const drift = metresBetween(A1, A2);
    say(`  Two readings of point A, ${((A2.t - A1.t) / 60000).toFixed(1)} min apart: ${fmt(drift)} apart`);
    say();
    say(
      drift <= 3
        ? '  ✓ Calibration is repeatable. A board tapped today matches one tapped tomorrow.'
        : `  ! ${fmt(drift)} of drift between two readings of the same stone. Every square on a board`,
    );
    if (drift > 3) {
      say('    calibrated at one moment is offset by roughly this much later. Consider');
      say('    re-calibration prompts, or averaging several fixes per corner rather than taking one.');
    }
  } else {
    say('  (need both A1 and A2 markers)');
  }

  // --- What the distance accumulator would have said ------------------------
  say();
  say('## 5. Distance walked, cross-checked');
  say();
  const walk = fixesForHold(trace, 'walk');
  const still = fixesForHold(trace, 'stand-after-walk');
  if (walk.length > 5) {
    let naive = 0;
    for (let i = 1; i < walk.length; i++) naive += metresBetween(walk[i - 1], walk[i]);
    say(`  Two-minute walk: naive sum of fixes = ${fmt(naive)}`);
    say('    (compare against what you actually walked — decision 0020 predicts the naive');
    say('     sum over-reads, and by how much is the thing worth knowing)');
  }
  if (still.length > 5) {
    let phantom = 0;
    for (let i = 1; i < still.length; i++) phantom += metresBetween(still[i - 1], still[i]);
    const perHour = (phantom / ((still[still.length - 1].t - still[0].t) / 3600000));
    say(`  Standing still afterwards: naive sum = ${fmt(phantom)} → ${fmt(perHour / 1000, ' km')}/hour of phantom distance`);
    say('    This is the number decision 0020 was written against. If it is far from the');
    say('    19-32 km/hour the simulator predicted, the accumulator constants want re-tuning.');
  }

  say();
  return out.join('\n');
}

const arg = process.argv[2];
if (!arg) {
  console.error('usage: node scripts/analyse-survey.mjs <trace.json|->');
  process.exit(2);
}
const raw = arg === '-' ? readFileSync(0, 'utf8') : readFileSync(arg, 'utf8');
const trace = JSON.parse(raw);
console.log(report(trace));
