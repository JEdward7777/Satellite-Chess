/**
 * One opponent's head-to-head (stage 8.5.4, decision 0054): what the two of
 * you have done against each other, and a name for them that only you see.
 *
 * Reached from "Against each opponent" on the account screen, and from a
 * game's review ("Your record against this player"). It is laid out as the
 * record is (decision 0019): **meters walked between you is the headline**,
 * your share and theirs under it, and the results are the sentence under
 * that. Then every game, newest first.
 *
 * There is no picture, no profile and nothing to look the opponent up by.
 * The screen says so, because a player naming somebody deserves to know the
 * name goes nowhere.
 */

import type { OpponentDetail } from '../../shared/head-to-head.js';
import { MAX_OPPONENT_NAME_CHARS } from '../../shared/head-to-head.js';
import { SMALL_SQUARE_M } from '../../shared/field.js';
import type { Units } from '../../shared/units.js';
import {
  HEAD_TO_HEAD_EXPLANATION,
  type OpponentQuery,
  type OpponentTransport,
  opponentLabel,
  opponentLineWords,
  pairDistanceWords,
  pairLeftOutWords,
  pairResultsWords,
  sinceWords,
} from '../head-to-head.js';
import { DISTANCE_HONESTY, dateWords } from '../record.js';
import { type UnitsStore, displayUnits } from '../units.js';

export interface OpponentViewDeps {
  query: OpponentQuery;
  transport: OpponentTransport;
  onBack(): void;
  /** The account's display units. The page's own store when omitted. */
  units?: Pick<UnitsStore, 'get'>;
}

export function mountOpponent(root: HTMLElement, deps: OpponentViewDeps): () => void {
  let live = true;
  const units = deps.units ?? displayUnits();
  root.innerHTML = `<section class="screen opponent" data-opponent-screen>
    <h1>Head to head</h1>
    <div data-opponent-body><p class="dim" data-opponent-loading>Reading your record…</p></div>
    <p><button class="secondary" data-opponent-back>Back</button></p>
  </section>`;
  const body = root.querySelector<HTMLElement>('[data-opponent-body]')!;
  root.querySelector<HTMLButtonElement>('[data-opponent-back]')?.addEventListener('click', () => deps.onBack());

  const load = (): void => {
    body.innerHTML = `<p class="dim" data-opponent-loading>Reading your record…</p>`;
    void deps.transport.read(deps.query).then((result) => {
      if (!live) return;
      if (result.kind === 'ok') {
        draw(result.detail);
        return;
      }
      body.innerHTML = unavailableHtml(result.kind);
      body.querySelector('[data-opponent-retry]')?.addEventListener('click', load);
    });
  };

  function draw(detail: OpponentDetail): void {
    body.innerHTML = opponentHtml(detail, Date.now(), units.get());
    const form = body.querySelector<HTMLFormElement>('[data-opponent-rename]');
    const input = body.querySelector<HTMLInputElement>('[data-opponent-input]');
    const said = body.querySelector<HTMLElement>('[data-opponent-said]');
    const say = (words: string): void => {
      if (said === null) return;
      said.textContent = words;
      said.hidden = words === '';
    };
    const save = (name: string | null): void => {
      const buttons = form?.querySelectorAll<HTMLButtonElement>('button') ?? [];
      for (const button of buttons) button.disabled = true;
      void deps.transport.rename(detail.opponent.id, name).then((outcome) => {
        if (!live) return;
        for (const button of buttons) button.disabled = false;
        if (outcome.kind !== 'ok') {
          say(
            outcome.kind === 'signed_out'
              ? 'Sign in to name an opponent.'
              : 'This phone cannot reach your account right now, so the name was not saved.',
          );
          return;
        }
        detail.opponent.name = outcome.name;
        const heading = body.querySelector<HTMLElement>('[data-opponent-name]');
        if (heading) heading.textContent = opponentLabel(detail.opponent);
        if (input) input.value = outcome.name ?? '';
        const clear = body.querySelector<HTMLButtonElement>('[data-opponent-clear]');
        if (clear) clear.hidden = outcome.name === null;
        say(outcome.name === null ? 'Name cleared.' : 'Saved.');
      });
    };
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      save(input?.value ?? '');
    });
    body.querySelector<HTMLButtonElement>('[data-opponent-clear]')?.addEventListener('click', () => save(null));
  }

  load();
  return () => {
    live = false;
  };
}

function unavailableHtml(kind: 'earlier' | 'unknown' | 'signed_out' | 'unavailable'): string {
  switch (kind) {
    case 'earlier':
      return `<p class="dim" data-opponent-unavailable="earlier">
        This game was recorded before the app kept track of who you played, so it
        is not in a head-to-head record. Games you finish from now on are.
      </p>`;
    case 'unknown':
      return `<p class="dim" data-opponent-unavailable="unknown">
        There is nothing in your record against this player yet. A game is added
        once it has a result.
      </p>`;
    case 'signed_out':
      return `<p class="dim" data-opponent-unavailable="signed_out">Sign in to see your record. It is kept on your account.</p>`;
    default:
      return `<p class="dim" data-opponent-unavailable="offline">
          Your record is kept on your account, and this phone cannot reach it right now.
        </p>
        <p><button class="secondary" data-opponent-retry>Try again</button></p>`;
  }
}

/** The screen itself. Pure, so a test can read what a player would. */
export function opponentHtml(detail: OpponentDetail, now: number = Date.now(), units: Units = 'metric'): string {
  const { opponent } = detail;
  const distance = pairDistanceWords(opponent, units);
  const leftOut = pairLeftOutWords(opponent, SMALL_SQUARE_M, units);
  return `<p class="opponent-title" data-opponent-name>${escapeHtml(opponentLabel(opponent))}</p>
    <p class="dim" data-opponent-since>${escapeHtml(sinceWords(opponent, now))}</p>
    <p class="record-headline" data-opponent-together>${keepUnit(escapeHtml(distance.together))}</p>
    <p class="record-sub">walked between you, playing each other</p>
    <p data-opponent-split>${keepUnit(escapeHtml(distance.split))}</p>
    <p class="dim" data-opponent-results>${escapeHtml(pairResultsWords(opponent))}</p>
    ${leftOut === '' ? '' : `<p class="dim" data-opponent-left-out>${escapeHtml(leftOut)}</p>`}
    <form class="opponent-name" data-opponent-rename>
      <label class="dim" for="opponent-name-input">Your name for them</label>
      <input id="opponent-name-input" data-opponent-input type="text" autocomplete="off"
             maxlength="${MAX_OPPONENT_NAME_CHARS}" value="${escapeHtml(opponent.name ?? '')}"
             placeholder="A name only you will see">
      <button type="submit" data-opponent-save>Save</button>
      <button type="button" class="secondary" data-opponent-clear ${opponent.name === null ? 'hidden' : ''}>Clear</button>
    </form>
    <p class="dim" data-opponent-said hidden></p>
    <div class="dim" data-opponent-explain>
      ${HEAD_TO_HEAD_EXPLANATION.map((sentence) => `<p>${escapeHtml(sentence)}</p>`).join('')}
    </div>
    <h3>Your games together</h3>
    <ul class="games" data-opponent-games>
      ${detail.games
        .map((line) => {
          const words = opponentLineWords(line, units);
          return `<li data-opponent-game="${escapeHtml(line.joinCode)}" data-standing="${line.standing}">
            <strong>${escapeHtml(words.title)}</strong>
            <span class="dim">${keepUnit(escapeHtml(words.detail))} · ${escapeHtml(dateWords(line.finishedAt, now))}</span>
          </li>`;
        })
        .join('')}
    </ul>
    <div class="record-honesty dim">
      ${DISTANCE_HONESTY.map((sentence) => `<p>${escapeHtml(sentence)}</p>`).join('')}
    </div>`;
}

/** Every number held on one line with its unit, as the review does. */
function keepUnit(html: string): string {
  return html.replace(/(\d) (km|m|mi|yd|ft)\b/g, '$1&nbsp;$2');
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
