/**
 * Point the camera at an invite (stage 6.2.3).
 *
 * A screen with one job and a short life: it is on for the couple of seconds
 * between raising the phone and the code being read, and then it is gone. It is
 * only ever reached from a home screen that has already established the browser
 * can do this, so there is no capability check here — the unsupported case never
 * gets this far, and is a line of advice on home instead (decision 0026).
 *
 * The typed-code box is on this screen too. Someone whose camera will not focus,
 * or who is standing in low sun, must not have to go back to find the other way
 * in — the fallback belongs where the failure happens.
 */

import {
  type ScanFailure,
  type StopScan,
  describeScanFailure,
  startScan,
} from '../scan.js';
import { type Platform, detectPlatform } from '../gps.js';

export interface ScanDeps {
  /** A scanned or typed code, unnormalised — `joinGame` folds it either way. */
  onCode(code: string): void;
  onCancel(): void;
  platform?: Platform;
  /** Injected by the browser driver so the camera is not required to test this. */
  start?: typeof startScan;
}

/**
 * What the screen says under the viewfinder.
 *
 * Separated from the DOM because it is the part with decisions in it: a foreign
 * QR is *not* an error and must not look like one — a camera sweeping a park sees
 * posters, and telling someone their scan failed each time would be four lies a
 * second.
 */
export function scanStatus(state: { failure: ScanFailure | null; sawForeign: boolean }, platform: Platform): string {
  if (state.failure !== null) return describeScanFailure(state.failure, platform);
  if (state.sawForeign) return 'That is a QR code, but not an invitation to a game. Keep the camera on your opponent\'s screen.';
  return 'Point the camera at the QR on your opponent\'s phone.';
}

export function mountScan(root: HTMLElement, deps: ScanDeps): () => void {
  const platform = deps.platform ?? detectPlatform(navigator.userAgent, navigator.maxTouchPoints);
  const start = deps.start ?? startScan;
  const state: { failure: ScanFailure | null; sawForeign: boolean } = {
    failure: null,
    sawForeign: false,
  };

  root.innerHTML = `
    <h1>Scan an invite</h1>
    <div class="viewfinder">
      <video data-video playsinline muted></video>
    </div>
    <p class="prompt" data-status>${escapeHtml(scanStatus(state, platform))}</p>
    <p>
      <label>Or type the code<br />
        <input data-code type="text" maxlength="8" placeholder="ABC 123" />
      </label>
    </p>
    <p><button data-join>Join</button></p>
    <p><button data-cancel class="secondary">Back</button></p>
  `;

  const status = root.querySelector<HTMLElement>('[data-status]');
  const repaint = () => {
    if (status !== null) status.textContent = scanStatus(state, platform);
  };

  const video = root.querySelector('[data-video]') as HTMLVideoElement | null;
  let stop: StopScan | null = null;
  if (video !== null) {
    stop = start({
      video,
      onCode: (code) => deps.onCode(code),
      onForeign: () => {
        if (state.sawForeign) return;
        state.sawForeign = true;
        repaint();
      },
      onError: (failure) => {
        state.failure = failure;
        repaint();
      },
    });
  }

  root.querySelector<HTMLButtonElement>('[data-join]')?.addEventListener('click', () => {
    const typed = root.querySelector<HTMLInputElement>('[data-code]')?.value.trim() ?? '';
    if (typed === '') return;
    deps.onCode(typed);
  });
  root.querySelector<HTMLButtonElement>('[data-cancel]')?.addEventListener('click', deps.onCancel);

  return () => {
    // Before the markup goes, so the camera is released even if something below
    // throws. A live track outlives the element that displayed it.
    stop?.();
    root.innerHTML = '';
  };
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
