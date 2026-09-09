/**
 * "Your games" — the home-screen list, and the tidy-up offer (stage 2.3.4).
 *
 * The list exists because a game is addressed by its join code and nothing else
 * (decision 0007). Before this, closing the tab lost the game: not the position,
 * which is safe in the Durable Object, but the *way back to it*. Since decision
 * 0025 a suspended game may sit for a month, so "the way back to it" is a thing
 * a player needs a week after they last thought about it, from a phone that may
 * not be the one they played on.
 *
 * ## What a line says, and why it says it
 *
 * A line is read by somebody deciding whether to walk to a park. So it leads
 * with the ground — the field's name — and then says the one thing that decides
 * the question: whether the game is waiting for them, and how long they have.
 * The join code is on the line too, in full, because it is still the thing you
 * read aloud across a field when the other phone will not scan.
 *
 * ## The model half is pure
 *
 * `describeGame` and `tidyCandidates` take data and return text and lists, with
 * no DOM anywhere near them, because they encode decision 0025's rules about who
 * may claim what and when — and those are worth testing in node rather than
 * through a screenshot.
 */

import { type ListedGame, forgetIsRefused } from '../../shared/game-index.js';
import { formatJoinCode } from '../../shared/joincode.js';
import { CLAIM_AFTER_MS, type ResultReason } from '../../shared/protocol.js';
import type { Color } from '../../shared/squares.js';

/**
 * How many finished games the home screen shows.
 *
 * Home is a way in, not an archive: the list is there so somebody can get back
 * into a game, and a season of results between them and the one they suspended
 * at lunchtime would defeat it. The permanent record (stage 2.3.5) is where
 * history is supposed to live, and it is a screen of its own for that reason.
 */
export const FINISHED_SHOWN = 3;

/**
 * When to offer to tidy up.
 *
 * An offer and never a timer (decision 0025), and the trigger is that the list
 * has *grown* rather than that time has passed. Six is where a list stops being
 * something the eye takes in at once — before that there is nothing to tidy and
 * the button would only be an invitation to lose something.
 */
export const TIDY_SUGGEST_AT = 6;

const DAY_MS = 24 * 3600_000;

/** The two lines of one entry in the list. */
export interface GameLine {
  /** The ground, or the code when a game has somehow lost its field's name. */
  title: string;
  /** Colour, state, and whatever decision 0025 has to say about it. */
  detail: string;
  /** The join code, formatted as it is read aloud. */
  code: string;
}

export function describeGame(game: ListedGame, now: number = Date.now()): GameLine {
  return {
    title: game.fieldName ?? `Game ${formatJoinCode(game.joinCode)}`,
    detail: [colourWord(game.color), stateWords(game, now)].join(' · '),
    code: formatJoinCode(game.joinCode),
  };
}

function colourWord(color: Color): string {
  return color === 'w' ? 'White' : 'Black';
}

function stateWords(game: ListedGame, now: number): string {
  switch (game.status) {
    case 'waiting':
      return 'waiting for an opponent';
    case 'staging':
      return 'about to start';
    case 'active':
      return 'in play';
    case 'suspended':
      return suspendedWords(game, now);
    case 'finished':
      return finishedWords(game);
  }
}

/**
 * The sentence decision 0025 is really about.
 *
 * It always names **who stopped it**, because that is what decides who may end
 * it — and it says so from the reader's side rather than in the abstract. A
 * player who walked off should be told, on their own home screen, that the clock
 * on that is running; a player who was left standing there should be told when
 * they may take the win. Neither is a surprise anybody should get by tapping in.
 */
function suspendedWords(game: ListedGame, now: number): string {
  if (game.suspendedBy === null) {
    // Both were gone, so nobody earned anything and nobody may claim.
    return 'paused — neither of you can claim it';
  }
  const left = claimWindowLeft(game, now);
  return game.suspendedBy === game.color
    ? `you paused it — your opponent can claim the win ${inDays(left)}`
    : `paused by your opponent — you can claim the win ${inDays(left)}`;
}

/**
 * How much of the claim window is left, measured from the suspension itself.
 *
 * Deliberately *not* the entry's own `claimableInMs`. That number answers "when
 * may **you** claim", so it is zero for the player who caused the suspension —
 * correct as a statement of rights, and useless as a countdown, because the one
 * thing that player most needs telling is how long their opponent has to wait
 * before taking the win off them. The window is the same month from both ends;
 * only the entitlement differs. Same constant as the server's, imported rather
 * than restated, so the two cannot drift.
 */
function claimWindowLeft(game: ListedGame, now: number): number {
  if (game.suspendedAt === null) return 0;
  return Math.max(0, CLAIM_AFTER_MS - (now - game.suspendedAt));
}

function inDays(ms: number): string {
  if (ms <= 0) return 'now';
  const days = Math.ceil(ms / DAY_MS);
  return days === 1 ? 'tomorrow' : `in ${days} days`;
}

function finishedWords(game: ListedGame): string {
  if (game.result === null) return 'finished';
  const { outcome, reason } = game.result;
  const verdict =
    outcome === '1/2-1/2'
      ? 'drawn'
      : (outcome === '1-0') === (game.color === 'w')
        ? 'you won'
        : 'you lost';
  return `${verdict} — ${reasonWords(reason)}`;
}

function reasonWords(reason: ResultReason): string {
  switch (reason) {
    case 'checkmate':
      return 'checkmate';
    case 'resignation':
      return 'resignation';
    case 'timeout':
      return 'on time';
    case 'stalemate':
      return 'stalemate';
    case 'insufficient_material':
      return 'not enough material';
    case 'threefold_repetition':
      return 'threefold repetition';
    case 'fifty_move_rule':
      return 'the fifty-move rule';
    case 'agreement':
      return 'agreement';
    case 'abandoned':
      return 'nobody came back';
  }
}

/**
 * The list as home shows it: everything still going, then the last few results.
 *
 * Order comes from the server, which sorts live games above finished ones; this
 * only decides how much of the tail to draw.
 */
export function homeGames(games: readonly ListedGame[]): ListedGame[] {
  const live = games.filter((game) => game.status !== 'finished');
  const finished = games.filter((game) => game.status === 'finished');
  return [...live, ...finished.slice(0, FINISHED_SHOWN)];
}

/**
 * What the tidy-up offer may propose, which is only ever what the server would
 * accept.
 *
 * `forgetIsRefused` is the shared rule and it is asked here rather than
 * re-stated, so the button is never offered for a row the server is about to
 * refuse. A player told "tidy up" and then told "no" would reasonably conclude
 * the app had lost track of which games were which.
 */
export function tidyCandidates(games: readonly ListedGame[]): ListedGame[] {
  return games.filter((game) => forgetIsRefused(game) === null);
}

/** Whether the offer is worth making at all. */
export function shouldOfferTidy(games: readonly ListedGame[]): boolean {
  return tidyCandidates(games).length >= TIDY_SUGGEST_AT;
}

// ---------------------------------------------------------------------------
// The screens
// ---------------------------------------------------------------------------

/** One line of the home-screen list. Exported so home can compose it inline. */
export function gameItemHtml(game: ListedGame, now: number = Date.now()): string {
  const line = describeGame(game, now);
  return `<li data-game="${escapeHtml(game.joinCode)}" tabindex="0" role="button">
    <strong>${escapeHtml(line.title)}</strong>
    <span class="dim">${escapeHtml(line.detail)}</span>
    <span class="dim game-code">${escapeHtml(line.code)}</span>
  </li>`;
}

export interface TidyDeps {
  games: readonly ListedGame[];
  /** Resolves with what actually went; the screen redraws from the answer. */
  onForget(joinCodes: string[]): Promise<{ forgotten: string[]; kept: string[] }>;
  onDone(): void;
}

/**
 * The tidy-up screen (stage 2.3.4.2).
 *
 * **Nothing is ticked to begin with.** The temptation is to pre-select every
 * finished game and let the player untick, which is how a bulk delete is usually
 * built and is the wrong shape here: these are the only record of afternoons
 * somebody spent walking around a field, and nothing server-side will ever
 * delete one (decision 0025), so this button is the single path by which a game
 * disappears. It should require the player to say which, not to notice which.
 */
export function mountTidy(root: HTMLElement, deps: TidyDeps): () => void {
  let games = [...deps.games];
  const chosen = new Set<string>();
  let busy = false;
  let notice: string | null = null;

  const paint = () => {
    const candidates = tidyCandidates(games);
    root.innerHTML = `
      <h1>Tidy up</h1>
      <p class="dim">
        These games are over. Removing one takes it off your list for good —
        nothing else deletes a game you have played.
      </p>
      ${notice ? `<p class="notice" data-notice>${escapeHtml(notice)}</p>` : ''}
      ${
        candidates.length === 0
          ? `<p class="dim" data-none>Nothing to tidy. Every game on your list is still going.</p>`
          : `<ul class="games" data-candidates>
               ${candidates.map((game) => candidateHtml(game, chosen.has(game.joinCode))).join('')}
             </ul>`
      }
      <p>
        <button data-forget ${chosen.size === 0 || busy ? 'disabled' : ''}>
          ${chosen.size === 0 ? 'Remove' : `Remove ${chosen.size} game${chosen.size === 1 ? '' : 's'}`}
        </button>
      </p>
      <p><button data-done class="secondary">Done</button></p>
    `;

    for (const box of root.querySelectorAll<HTMLInputElement>('[data-pick]')) {
      box.addEventListener('change', () => {
        const code = box.dataset.pick as string;
        if (box.checked) chosen.add(code);
        else chosen.delete(code);
        paint();
      });
    }
    root.querySelector<HTMLButtonElement>('[data-done]')?.addEventListener('click', deps.onDone);
    root.querySelector<HTMLButtonElement>('[data-forget]')?.addEventListener('click', () => {
      if (busy || chosen.size === 0) return;
      busy = true;
      notice = null;
      paint();
      void deps.onForget([...chosen]).then((result) => {
        busy = false;
        const forgotten = new Set(result.forgotten);
        games = games.filter((game) => !forgotten.has(game.joinCode));
        for (const code of result.forgotten) chosen.delete(code);
        // A refusal is the server saying the game is not over after all — which
        // it may well have learned since this screen was drawn. Say so rather
        // than silently leaving a ticked box behind.
        notice =
          result.kept.length === 0
            ? null
            : `${result.kept.length} game${result.kept.length === 1 ? ' was' : 's were'} kept: ` +
              `still going, so it can only be finished, claimed or resigned.`;
        paint();
      });
    });
  };

  paint();
  return () => {
    root.innerHTML = '';
  };
}

function candidateHtml(game: ListedGame, checked: boolean): string {
  const line = describeGame(game);
  return `<li>
    <label>
      <input type="checkbox" data-pick="${escapeHtml(game.joinCode)}" ${checked ? 'checked' : ''} />
      <strong>${escapeHtml(line.title)}</strong>
      <span class="dim">${escapeHtml(line.detail)}</span>
    </label>
  </li>`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
