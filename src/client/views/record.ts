/**
 * The permanent record, and the privacy statement beside it (stages 2.3.5,
 * 2.3.5.1). Both are drawn on the account screen.
 *
 * The record leads with **meters walked**, and games played never does
 * (decision 0019): the distance is the largest thing on the screen, and the
 * count of games sits in the sentence underneath it, as what the distance was
 * made of. The sentences about how far to trust that distance (O-03, O-12) are
 * on the screen rather than behind a tap, because the record is the one place a
 * player reads the number as a fact about themselves.
 *
 * The privacy statement is here because the record is where a player sees what
 * we kept, and the natural next question is what else we kept. Players are
 * handing us their whereabouts, so it says so plainly — including the two
 * things that are not possible yet.
 */

import type { RecordSummary } from '../../shared/record.js';
import {
  DISTANCE_HONESTY,
  type RecordTransport,
  coverageWords,
  dateWords,
  distanceWords,
  lineWords,
  resultsWords,
} from '../record.js';

/** The section as first drawn, before the account has answered. */
export function recordSectionHtml(): string {
  return `<section class="record" data-record>
    <h2>Your record</h2>
    <div data-record-body><p class="dim" data-record-loading>Loading your record…</p></div>
  </section>`;
}

/**
 * Ask the account for the record and draw it into the section.
 *
 * Returns a teardown that stops a late answer from drawing into a screen that
 * has gone — the same `live` flag a join needs (`gotchas.md`), for the same
 * reason: a request outlives its screen.
 */
export function mountRecord(root: HTMLElement, transport: RecordTransport): () => void {
  let live = true;
  const body = root.querySelector<HTMLElement>('[data-record-body]');
  if (body === null) return () => undefined;

  const load = (): void => {
    body.innerHTML = `<p class="dim" data-record-loading>Loading your record…</p>`;
    void transport.read().then((result) => {
      if (!live) return;
      if (result.kind === 'ok') {
        body.innerHTML = recordHtml(result.record);
        return;
      }
      body.innerHTML =
        result.kind === 'signed_out'
          ? `<p class="dim" data-record-unavailable="signed_out">Sign in to see your record. It is kept on your account.</p>`
          : `<p class="dim" data-record-unavailable="offline">
               Your record is kept on your account, and this phone cannot reach it right now.
             </p>
             <p><button class="secondary" data-record-retry>Try again</button></p>`;
      body.querySelector('[data-record-retry]')?.addEventListener('click', load);
    });
  };
  load();

  return () => {
    live = false;
  };
}

/** The record itself. Pure, so a test can read what a player would. */
export function recordHtml(record: RecordSummary, now: number = Date.now()): string {
  const { totals } = record;
  const nothingYet = totals.games === 0 && record.recent.length === 0;
  if (nothingYet) {
    return `<p class="record-headline" data-record-distance>${distanceWords(0)}</p>
      <p class="dim" data-record-empty>
        No finished games yet. Your record starts with your first one, and it
        leads with how far you walk.
      </p>
      ${honestyHtml()}`;
  }

  const biggest =
    totals.biggestBoard === null
      ? '—'
      : `${Math.round(totals.biggestBoard.boardM)} m${
          totals.biggestBoard.fieldName ? ` · ${escapeHtml(totals.biggestBoard.fieldName)}` : ''
        }`;

  return `<p class="record-headline" data-record-distance>${distanceWords(totals.travelM)}</p>
    <p class="record-sub">walked playing chess</p>
    <p class="dim" data-record-coverage>${escapeHtml(coverageWords(record))}</p>
    <dl class="record-stats">
      <div><dt>Results</dt><dd data-record-results>${resultsWords(totals)}</dd></div>
      <div><dt>Longest carry</dt><dd data-record-carry>${distanceWords(totals.longestCarryM)}</dd></div>
      <div><dt>Biggest board</dt><dd data-record-biggest>${biggest}</dd></div>
      <div><dt>Fields played on</dt><dd data-record-fields>${totals.fields}</dd></div>
    </dl>
    ${fieldsHtml(record)}
    ${recentHtml(record, now)}
    ${honestyHtml()}`;
}

function fieldsHtml(record: RecordSummary): string {
  if (record.fields.length < 2) return '';
  return `<h3>By field</h3>
    <ul class="games" data-record-by-field>
      ${record.fields
        .map(
          (field) => `<li>
            <strong>${escapeHtml(field.name ?? 'Unnamed field')}</strong>
            <span class="dim">${distanceWords(field.travelM)} in ${field.games} game${
              field.games === 1 ? '' : 's'
            }</span>
          </li>`,
        )
        .join('')}
    </ul>`;
}

function recentHtml(record: RecordSummary, now: number): string {
  if (record.recent.length === 0) return '';
  return `<h3>Recent games</h3>
    <ul class="games" data-record-games>
      ${record.recent
        .map((line) => {
          const words = lineWords(line);
          return `<li data-record-game="${escapeHtml(line.joinCode)}" data-standing="${line.standing}">
            <strong>${escapeHtml(words.title)}</strong>
            <span class="dim">${escapeHtml(words.detail)} · ${escapeHtml(dateWords(line.finishedAt, now))}</span>
          </li>`;
        })
        .join('')}
    </ul>`;
}

function honestyHtml(): string {
  return `<div class="record-honesty dim" data-record-honesty>
    ${DISTANCE_HONESTY.map((sentence) => `<p>${escapeHtml(sentence)}</p>`).join('')}
  </div>`;
}

/**
 * What is kept about where a player has been, who can see it, and what never
 * leaves their account (stage 2.3.5.1, decisions 0017 and 0018).
 *
 * Every sentence here is a claim about the code, so each is worth re-reading
 * whenever what is stored changes. The uncomfortable ones — a code opens its
 * field until the game is joined, and a player cannot delete anything yet —
 * are stated rather than left out, because a privacy statement that is only
 * reassuring is not one. Since stage 8.4 (decision 0042) a finished game's
 * field and fixes are deleted once it has gone unopened for a day — "at least",
 * because the delete waits for the record and can give up and keep the game —
 * and what stays is on the board, plus the field's name (the PGN's Site tag).
 */
export function privacyHtml(): string {
  return `<details class="privacy" data-privacy>
    <summary>What this app keeps about where you have been</summary>
    <ul>
      <li><strong>On your phone.</strong> GPS is read only while the app is open.
        Outside a game your position stays on the phone. The exceptions are
        fields: the corners of a field you save go to your account, so your
        other phones have it too, and a field you share goes wherever you send
        it.</li>
      <li><strong>During a game.</strong> Your phone sends its position when you
        lift or place a piece, and every few seconds while you are moving, so your
        opponent can see you on the board. Your opponent sees where you are while
        the game is open, and your last position after that.</li>
      <li><strong>Kept with each game.</strong> The field, and where and when each
        piece was lifted and placed. Until someone joins, anyone with a game's code
        can see which field it is on, so share a code the way you would share the
        place. After that, only the two players can. Once a finished game has
        gone unopened for at least a day, its field's corners and those
        positions are deleted. What stays is the field's name, the moves, and
        each walk as squares on the board, with no coordinates. Only its two
        players can open it.</li>
      <li><strong>On your account, seen only by you.</strong> Your saved fields,
        your list of games, and this record, which holds distances, field names
        and board sizes but no coordinates. Signing in stores your Google account
        ID and email address, and nothing about where you are.</li>
      <li><strong>Never.</strong> No public profile, no list of who plays on a
        field, no map of your walks, and no place names worked out from your
        position. A field link carries the field's corners and name, and nothing
        about you.</li>
      <li><strong>Not possible yet.</strong> Deleting your account, your record
        or a finished game's moves. Forgetting a game takes it off your list, not
        off the server.</li>
    </ul>
  </details>`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
