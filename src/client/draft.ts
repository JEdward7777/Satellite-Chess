/**
 * What somebody has typed into a text box, carried across a redraw.
 *
 * Screens here draw with `innerHTML`, which replaces every element, and a text
 * box replaced mid-word loses its text, its focus and its caret. Home's join
 * box is the one that matters (O-51 round 2): home redraws when a field sync
 * lands or "Show more" is tapped, and a player reading a code off somebody
 * else's phone in a park should not have to type it twice.
 *
 * The cheaper fix is not to redraw the box at all, and home does that for GPS
 * fixes, which are the frequent case. This covers the redraws that are left.
 */

export interface InputDraft {
  value: string;
  focused: boolean;
  start: number | null;
  end: number | null;
}

/** The box's state, or null when there is no box or nothing in or on it. */
export function readDraft(input: HTMLInputElement | null): InputDraft | null {
  if (!input) return null;
  const focused = document.activeElement === input;
  if (input.value === '' && !focused) return null;
  return {
    value: input.value,
    focused,
    start: input.selectionStart,
    end: input.selectionEnd,
  };
}

/** Put a draft back into a freshly drawn box. Harmless with either missing. */
export function restoreDraft(input: HTMLInputElement | null, draft: InputDraft | null): void {
  if (!input || !draft) return;
  input.value = draft.value;
  if (!draft.focused) return;
  // No scroll: a box near the top of a page somebody has scrolled down would
  // otherwise yank the page back to it on a redraw they did not ask for.
  input.focus({ preventScroll: true });
  if (draft.start !== null && draft.end !== null) {
    input.setSelectionRange(draft.start, draft.end);
  }
}
