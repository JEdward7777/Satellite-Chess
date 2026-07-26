/**
 * The field survey: a guided protocol for finding out what GPS actually does.
 *
 * Reached at `/?survey=<secret>`. Everything else in this project has been
 * verified against a simulator I wrote, which encodes *my* assumptions about
 * GPS noise. This is the one screen whose job is to test those assumptions
 * against the sky.
 *
 * It is a **guided** protocol rather than a passive recorder on purpose. "Walk
 * around for ten minutes" produces a squiggle nobody can draw conclusions from;
 * "stand exactly here for ninety seconds, then walk eight metres and stand
 * still again" produces a scatter with a known truth to compare it against.
 * Every question in `harness/plan/01-field.md` stage 1.9.3 has a step below
 * that answers it.
 *
 * The raw fixes go up untouched — no smoothing, no anchor logic. The whole
 * point is to measure the input those algorithms were tuned against.
 */

import { distanceM } from '../../shared/geo.js';
import { type GpsFix, type GpsProvider, type GpsState, qualityLabel } from '../gps.js';

/** One instruction in the protocol. */
interface Step {
  id: string;
  title: string;
  instruction: string;
  /**
   * `hold` runs a countdown and completes itself; `mark` waits for a tap.
   * A hold is how we measure scatter at a known point; a mark is how we tie a
   * fix to a place on the ground.
   */
  kind: 'hold' | 'mark';
  seconds?: number;
  /** Shown as the reason this step exists, so the surveyor can improvise well. */
  why: string;
}

/**
 * The protocol, in three tiers by how much room they need.
 *
 * Tier 1 needs no space at all and answers the single most important question —
 * does reported accuracy mean anything? Tier 2 needs ten metres. Only tier 3
 * needs a real field, so a wet Sunday still produces useful data.
 */
export const PROTOCOL: Step[] = [
  {
    id: 'settle',
    kind: 'hold',
    seconds: 90,
    title: 'Let the fix settle',
    instruction:
      'Stand in the open, away from walls and trees. Hold the phone in your hand at ' +
      'chest height, screen on. Do not move your feet.',
    why: 'Time-to-first-fix, and whether accuracy tightens as the receiver warms up.',
  },
  {
    id: 'static',
    kind: 'hold',
    seconds: 180,
    title: 'Stand perfectly still',
    instruction:
      'Same spot, same posture. Three minutes. Do not shuffle — this is the measurement ' +
      'everything else is calibrated against.',
    why:
      'The big one: does the reported accuracy match the actual scatter? The distance ' +
      'algorithm assumes it roughly does, and nothing has ever checked.',
  },
  {
    id: 'A1',
    kind: 'mark',
    title: 'Mark point A',
    instruction:
      'Put something on the ground you can find again — a stone, a key, a drink bottle. ' +
      'Stand on it. Tap when you are still.',
    why: 'Gives a known point to return to, so calibration repeatability can be measured.',
  },
  {
    id: 'B',
    kind: 'mark',
    title: 'Walk 8 m and mark B',
    instruction:
      'Pace out about 8 metres in a straight line — roughly 10 adult paces. Leave a marker. ' +
      'Stand still for a few seconds, then tap.',
    why: 'One square on a typical field. If the phone cannot separate A from B, the game does not work.',
  },
  {
    id: 'B-hold',
    kind: 'hold',
    seconds: 60,
    title: 'Hold still on B',
    instruction: 'Stay on B, still, for a minute.',
    why: 'Scatter at a second point, to check the first was not a fluke.',
  },
  {
    id: 'A2',
    kind: 'mark',
    title: 'Walk back to A and mark it again',
    instruction: 'Return to your first marker. Stand on it exactly. Tap.',
    why:
      'Two readings of the same physical point, minutes apart. The gap between them is the ' +
      'error a calibrated board inherits for its whole life.',
  },
  {
    id: 'C',
    kind: 'mark',
    title: 'Walk 24 m from A and mark C',
    instruction:
      'From A, walk about 24 metres in a straight line — three squares, roughly 30 paces. Tap.',
    why: 'A longer baseline, to separate distance error from bearing error.',
  },
  {
    id: 'walk',
    kind: 'hold',
    seconds: 120,
    title: 'Walk a slow lap',
    instruction:
      'Walk at an easy pace in a big loop or a long back-and-forth for two minutes. ' +
      'Do not stop.',
    why:
      'How the track behaves in motion: does it lag, cut corners, or overshoot? And what ' +
      'the distance accumulator does with a real walk rather than a simulated one.',
  },
  {
    id: 'stand-after-walk',
    kind: 'hold',
    seconds: 60,
    title: 'Stop and stand still again',
    instruction: 'Stop dead. Stand still for a minute.',
    why:
      'Does the reported position keep coasting after you stop? That would show up as ' +
      'phantom distance and as a piece placed on the wrong square.',
  },
  {
    id: 'pocket',
    kind: 'hold',
    seconds: 60,
    title: 'Phone in your pocket, walk on',
    instruction: 'Put the phone in a trouser pocket and keep walking for a minute.',
    why:
      'Real players will do this while walking between squares. Body shadowing may be the ' +
      'difference between a playable game and a frustrating one.',
  },
];

export interface SurveyDeps {
  gps: GpsProvider;
  secret: string;
  /** Where to upload. Same origin in practice; injectable for tests. */
  endpoint?: string;
}

interface Marker {
  t: number;
  step: string;
  label: string;
  atFix: number;
  note?: string;
}

/** Survives a reload, because a lost trace means walking the field again. */
const DRAFT_KEY = 'satchess.survey.draft';

export function mountSurvey(root: HTMLElement, deps: SurveyDeps): () => void {
  const endpoint = deps.endpoint ?? '/api/survey/trace';
  const fixes: GpsFix[] = [];
  const markers: Marker[] = [];
  let stepIndex = 0;
  let holdUntil: number | null = null;
  let state: GpsState = deps.gps.state;
  let uploading = false;
  let uploaded: string | null = null;
  const startedAt = Date.now();
  const id = `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const step = () => PROTOCOL[stepIndex];

  const saveDraft = () => {
    try {
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ id, startedAt, stepIndex, fixes, markers }),
      );
    } catch {
      // Quota or private mode. The upload is the real save; this is insurance.
    }
  };

  const unsubscribe = deps.gps.subscribe((next) => {
    state = next;
    // Record every raw fix, deduplicated by timestamp — the provider re-emits
    // its state on non-fix changes too.
    const fix = next.fix;
    if (fix && (fixes.length === 0 || fixes[fixes.length - 1].at !== fix.at)) {
      fixes.push(fix);
      if (fixes.length % 20 === 0) saveDraft();
    }
    paint();
  });

  function advance(note?: string): void {
    const current = step();
    if (!current) return;
    markers.push({
      t: Date.now(),
      step: current.id,
      label: current.title,
      atFix: Math.max(0, fixes.length - 1),
      note,
    });
    stepIndex += 1;
    holdUntil = null;
    saveDraft();
    paint();
  }

  function beginHold(): void {
    const current = step();
    if (!current || current.kind !== 'hold') return;
    holdUntil = Date.now() + (current.seconds ?? 60) * 1000;
    markers.push({
      t: Date.now(),
      step: `${current.id}:start`,
      label: `${current.title} (start)`,
      atFix: Math.max(0, fixes.length - 1),
    });
    saveDraft();
    paint();
  }

  async function upload(): Promise<void> {
    if (uploading) return;
    uploading = true;
    paint();
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-survey-secret': deps.secret },
        body: JSON.stringify({
          id,
          label: `field survey ${new Date(startedAt).toISOString().slice(0, 16)}`,
          startedAt,
          endedAt: Date.now(),
          device: navigator.userAgent,
          fixes: fixes.map((f) => ({ t: f.at, lat: f.pos.lat, lng: f.pos.lng, acc: f.accuracyM })),
          markers,
        }),
      });
      const body = (await response.json()) as { ok?: boolean; message?: string };
      uploaded = response.ok && body.ok
        ? `Uploaded — ${fixes.length} fixes, ${markers.length} markers.`
        : `Upload failed: ${body.message ?? response.status}`;
      if (response.ok && body.ok) localStorage.removeItem(DRAFT_KEY);
    } catch (error) {
      // Almost certainly no signal in the field. The draft is still on the
      // phone, so this can be retried from the car park.
      uploaded = `Upload failed: ${String(error)}. The trace is saved on this phone — tap again when you have signal.`;
    } finally {
      uploading = false;
      paint();
    }
  }

  /** A running estimate of scatter, so the surveyor can see it working. */
  function scatterHint(): string {
    const recent = fixes.slice(-30);
    if (recent.length < 5) return '—';
    const mean = recent.reduce(
      (acc, f) => ({ lat: acc.lat + f.pos.lat / recent.length, lng: acc.lng + f.pos.lng / recent.length }),
      { lat: 0, lng: 0 },
    );
    const spread = recent.map((f) => distanceM(mean, f.pos)).sort((a, b) => a - b);
    return `${spread[Math.floor(spread.length / 2)].toFixed(1)} m median, ${spread[spread.length - 1].toFixed(1)} m worst`;
  }

  function paint(): void {
    const current = step();
    const fix = state.fix;
    const remaining = holdUntil === null ? 0 : Math.max(0, Math.ceil((holdUntil - Date.now()) / 1000));
    if (holdUntil !== null && remaining === 0) {
      advance();
      return;
    }

    root.innerHTML = current
      ? `
      <h1>Field survey</h1>
      <p class="dim">Step ${stepIndex + 1} of ${PROTOCOL.length}</p>
      <h2>${escapeHtml(current.title)}</h2>
      <p>${escapeHtml(current.instruction)}</p>
      <p class="dim"><em>${escapeHtml(current.why)}</em></p>
      <dl class="readout">
        <dt>Signal</dt><dd class="quality-${state.quality}">${fix ? qualityLabel(state.quality) : 'waiting…'}</dd>
        <dt>Accuracy</dt><dd>${fix ? `±${fix.accuracyM.toFixed(0)} m` : '—'}</dd>
        <dt>Scatter</dt><dd>${escapeHtml(scatterHint())}</dd>
        <dt>Fixes</dt><dd>${fixes.length}</dd>
      </dl>
      ${
        current.kind === 'hold'
          ? holdUntil === null
            ? `<p><button data-begin>Start — ${current.seconds}s</button></p>`
            : `<p><button disabled>Holding… ${remaining}s</button></p>`
          : `<p><button data-mark ${fix ? '' : 'disabled'}>Mark this point</button></p>`
      }
      <p><button data-skip class="secondary">Skip this step</button></p>
    `
      : `
      <h1>Survey complete</h1>
      <p>${fixes.length} fixes and ${markers.length} markers over ${
        Math.round((Date.now() - startedAt) / 60000)
      } minutes.</p>
      ${uploaded ? `<p class="notice${uploaded.startsWith('Uploaded') ? ' warning' : ''}">${escapeHtml(uploaded)}</p>` : ''}
      <p><button data-upload ${uploading ? 'disabled' : ''}>${
        uploading ? 'Uploading…' : 'Upload the trace'
      }</button></p>
    `;

    root.querySelector<HTMLButtonElement>('[data-begin]')?.addEventListener('click', beginHold);
    root.querySelector<HTMLButtonElement>('[data-mark]')?.addEventListener('click', () => advance());
    root
      .querySelector<HTMLButtonElement>('[data-skip]')
      ?.addEventListener('click', () => advance('skipped'));
    root.querySelector<HTMLButtonElement>('[data-upload]')?.addEventListener('click', () => void upload());
  }

  // A hold has to tick even when no fix arrives, or the countdown would stall
  // exactly when the signal is worst.
  const ticker = setInterval(() => {
    if (holdUntil !== null) paint();
  }, 1000);

  paint();
  return () => {
    unsubscribe();
    clearInterval(ticker);
    root.innerHTML = '';
  };
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
