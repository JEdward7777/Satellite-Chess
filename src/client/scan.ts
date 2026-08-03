/**
 * Scanning an invite with the camera, where the browser will do it for free.
 *
 * `BarcodeDetector` is a platform API: Android Chrome hands the frame to Play
 * Services and gives back the string. It costs us nothing to ship. Safari has no
 * such API and no prospect of one, and on iOS every browser is WebKit underneath,
 * so "use a different browser" is not advice — there is no iPhone browser that can
 * do this.
 *
 * We ship no decoder of our own to cover that gap. Decision 0026 records why: the
 * smallest credible one is larger than the entire application, the service worker
 * would precache it onto a phone in a field on one bar, and it would buy nothing
 * that the typed code and the iPhone's own Camera app do not already cover. So the
 * unsupported path is *advice*, and this file's job is as much to say the right
 * thing as it is to scan.
 *
 * The camera itself is the other reason to be careful here. A `MediaStreamTrack`
 * that is not stopped leaves the lens active and the indicator lit after the
 * screen has gone — so `stop()` is not tidying, it is the feature.
 */

import { normaliseJoinCode } from '../shared/joincode.js';
import { parseAppRoute } from '../shared/routes.js';
import type { Platform } from './gps.js';

/**
 * A minimal shape for `BarcodeDetector`, which TypeScript's DOM library does not
 * describe. Declared locally rather than as a global, so nothing else in the app
 * can come to depend on an API that most browsers do not have.
 */
export interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}

export interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}

export type ScanSupport =
  /** The browser can do it, and there is a camera to point. */
  | 'ready'
  /** No `BarcodeDetector`. Every iPhone, and Firefox. */
  | 'no_detector'
  /**
   * A detector, but not for QR. Some desktop builds expose the API with an empty
   * format list, and a detector that cannot read our format is not a detector.
   */
  | 'no_qr'
  /** No `getUserMedia`: no camera, or a page served over plain http. */
  | 'no_camera';

/**
 * What `detectScanSupport` needs, passed in rather than read from globals so the
 * decision can be tested without a browser.
 */
export interface ScanEnv {
  detector: BarcodeDetectorCtor | undefined;
  /** Whether `navigator.mediaDevices.getUserMedia` exists at all. */
  camera: boolean;
}

/** The real environment. Everything here is absent on some real phone. */
export function browserScanEnv(): ScanEnv {
  const scope = globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor };
  return {
    detector: scope.BarcodeDetector,
    camera: typeof navigator?.mediaDevices?.getUserMedia === 'function',
  };
}

/**
 * Can this browser scan?
 *
 * Asynchronous because the only honest answer involves `getSupportedFormats()`.
 * Asked once at boot, so the home screen can render its decision synchronously.
 */
export async function detectScanSupport(env: ScanEnv): Promise<ScanSupport> {
  if (env.detector === undefined) return 'no_detector';
  if (!env.camera) return 'no_camera';
  // Older implementations shipped without the static method. Absent is not a
  // refusal — assume it does the format every implementation was built for, and
  // let the first `detect()` be the thing that fails if not.
  if (typeof env.detector.getSupportedFormats !== 'function') return 'ready';
  try {
    const formats = await env.detector.getSupportedFormats();
    return formats.includes('qr_code') ? 'ready' : 'no_qr';
  } catch {
    return 'no_qr';
  }
}

/**
 * What to tell someone who cannot scan, on the phone they are holding.
 *
 * Never "scanning is unavailable", which is a shrug at a person standing in a
 * park. Every branch names the next thing to do, and on iOS that thing is very
 * good: the Camera app reads QR codes on its own and offers the link, which lands
 * on `/j/CODE` and joins. The web page losing this race to the operating system
 * is the whole reason we do not ship a decoder.
 *
 * `null` when there is nothing to say, so the caller renders nothing at all.
 */
export function scanAdvice(support: ScanSupport, platform: Platform): string | null {
  if (support === 'ready') return null;

  if (support === 'no_camera') {
    return 'No camera here — type the code instead. (If this page is on plain http, the ' +
      'camera is switched off by the browser; https is what turns it back on.)';
  }

  // 'no_detector' and 'no_qr' are the same sentence to a player: this browser
  // will not read a QR from inside a page.
  switch (platform) {
    case 'ios':
      return 'iPhones cannot scan from inside a web page — but the Camera app can. Point it ' +
        'at the QR and tap the link it offers, or type the six characters instead.';
    case 'android':
      return 'This browser cannot scan from inside a web page. Your camera app will read the ' +
        'QR on its own, or you can type the six characters instead.';
    default:
      return 'This browser cannot scan from inside a web page. Most phone camera apps read a ' +
        'QR on their own, or you can type the six characters instead.';
  }
}

/**
 * The join code in something the camera read, or `null` if it was not ours.
 *
 * Most QR codes in the world are not invitations to a chess game, and a camera
 * pointed at a street sees several. So this is a filter first and a parser
 * second: it accepts the URL our own encoder produces (decision 0024) and a bare
 * six-character code — someone may well photograph a code written on paper — and
 * refuses everything else without comment.
 *
 * The host is deliberately not checked. The payload that matters is the code, the
 * failure mode for a foreign one is the same "no game with that code" a typo
 * gets, and refusing on origin would break every scan between a deployment and
 * its preview URL.
 */
export function codeFromScan(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  try {
    const url = new URL(trimmed);
    const route = parseAppRoute(url.pathname);
    return route !== null && route.kind === 'join' ? route.code : null;
  } catch {
    // Not a URL at all — fall through to the bare-code reading.
  }

  return normaliseJoinCode(trimmed);
}

export type ScanFailure = 'denied' | 'no_camera' | 'failed';

export interface ScanHandlers {
  /** A Satellite Chess code. Fires once; the scanner stops itself first. */
  onCode(code: string): void;
  /** Something readable that was not ours — worth saying, not worth stopping for. */
  onForeign?(): void;
  onError(failure: ScanFailure): void;
}

export interface ScanOptions extends ScanHandlers {
  video: HTMLVideoElement;
  /**
   * How often to look at a frame.
   *
   * Not every frame, and not `requestAnimationFrame`. Four looks a second finds a
   * code as fast as a person can hold a phone still, and this runs outdoors on a
   * battery that also has a game and a wake lock on it.
   */
  intervalMs?: number;
  env?: ScanEnv;
}

/** Stops the camera. Safe to call twice, and called on every path out. */
export type StopScan = () => void;

export const SCAN_INTERVAL_MS = 250;

/**
 * Open the rear camera and watch for a code.
 *
 * Returns its stop function *synchronously*, before the camera has opened, which
 * is the point: `getUserMedia` resolves after a permission prompt the player may
 * take a while over, and a screen torn down in the meantime must still be able to
 * shut down a camera that has not opened yet.
 */
export function startScan(options: ScanOptions): StopScan {
  const { video, onCode, onForeign, onError } = options;
  const env = options.env ?? browserScanEnv();
  const intervalMs = options.intervalMs ?? SCAN_INTERVAL_MS;

  let stopped = false;
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop: StopScan = () => {
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    // The tracks, not the element. Clearing `srcObject` alone leaves the camera
    // running with nothing displaying it.
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    video.srcObject = null;
  };

  void (async () => {
    if (env.detector === undefined) {
      onError('no_camera');
      return;
    }
    let detector: BarcodeDetectorLike;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // `ideal`, not `exact`: a laptop with only a front camera should still
        // scan rather than fail, and a phone gets the rear one it needs.
        video: { facingMode: { ideal: 'environment' } },
      });
      if (stopped) {
        // Torn down during the permission prompt. The stream still arrived and is
        // still live, so it still has to be handed back.
        for (const track of stream.getTracks()) track.stop();
        stream = null;
        return;
      }
      video.srcObject = stream;
      // iOS refuses to play an inline video without both of these, and a video
      // that does not play produces frames of nothing on every platform.
      video.muted = true;
      video.setAttribute('playsinline', '');
      await video.play();
      detector = new env.detector({ formats: ['qr_code'] });
    } catch (err) {
      if (stopped) return;
      onError(classifyScanError(err));
      return;
    }

    timer = setInterval(() => {
      void (async () => {
        if (stopped) return;
        let codes: { rawValue: string }[];
        try {
          codes = await detector.detect(video);
        } catch {
          // Android can expose the API before the barcode module has been
          // downloaded, and then rejects every frame. Stop rather than log this
          // four times a second forever.
          stop();
          onError('failed');
          return;
        }
        if (stopped || codes.length === 0) return;

        for (const { rawValue } of codes) {
          const code = codeFromScan(rawValue);
          if (code !== null) {
            // Before the handler, so the camera is already released by the time
            // the next screen mounts.
            stop();
            onCode(code);
            return;
          }
        }
        onForeign?.();
      })();
    }, intervalMs);
  })();

  return stop;
}

/** `getUserMedia`'s failures, reduced to the three that mean different things. */
export function classifyScanError(err: unknown): ScanFailure {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no_camera';
  return 'failed';
}

/**
 * Why the camera did not open, and where to fix it — same rule as
 * `describeGpsError`: name the setting, on the phone in their hand.
 */
export function describeScanFailure(failure: ScanFailure, platform: Platform): string {
  switch (failure) {
    case 'denied':
      return platform === 'ios'
        ? 'The camera is blocked for this site. Tap "AA" in Safari\'s address bar → Website ' +
          'Settings → Camera → Allow, then try again. Or just type the code.'
        : platform === 'android'
          ? 'The camera is blocked for this site. Tap the padlock in the address bar → ' +
            'Permissions → Camera → Allow, then try again. Or just type the code.'
          : 'The camera is blocked for this site. Allow it in your browser\'s site settings, ' +
            'or type the code instead.';
    case 'no_camera':
      return 'No camera to scan with on this device. Type the six characters instead.';
    case 'failed':
      return 'The camera would not start. Type the six characters instead — it is the same ' +
        'game either way.';
  }
}
