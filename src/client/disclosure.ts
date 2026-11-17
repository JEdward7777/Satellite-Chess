/**
 * What a player is told before a remote game, and accepts (decision 0060
 * point 4): on every remote create and every remote join, in these words.
 *
 * One place, because the two screens that ask must ask the same thing. Short
 * and plain on purpose: it is read on a phone, often outdoors, and a
 * paragraph is a thing people dismiss unread. Only board space crosses
 * between the two phones (decision 0061), so what is left to disclose is what
 * a determined person can infer from it: timing and movement, and with them
 * where somebody is.
 */

/** The one sentence. */
export const DISCLOSURE_TEXT =
  'In a game on two fields, an opponent with the right tools could work out where you are.';

/** The box that has to be checked. */
export const DISCLOSURE_ACCEPT = 'I accept this';

/** Said beside a button that waits on the box. */
export const DISCLOSURE_NEEDED = 'Accept the note about your location to play on two fields.';

/**
 * The note and its box, as both screens draw them: `data-disclosure` on the
 * box, unchecked unless `accepted`. Every remote game starts unchecked.
 */
export function disclosureHtml(accepted: boolean): string {
  return `
    <div class="notice warning" data-disclosure-note>
      <p>${DISCLOSURE_TEXT}</p>
      <p><label class="switch-row"><input type="checkbox" data-disclosure ${
        accepted ? 'checked' : ''
      }> ${DISCLOSURE_ACCEPT}</label></p>
    </div>`;
}
