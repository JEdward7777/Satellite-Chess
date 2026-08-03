/**
 * The model half of camera scanning (stage 6.2.3, decision 0026).
 *
 * Three things are worth testing without a camera: what we decide the browser
 * can do, what we tell someone whose browser cannot, and what we make of
 * whatever the camera read. The last is a filter before it is a parser — a phone
 * held up in a park sees posters, bus stops and other people's wifi.
 *
 * `startScan` is here too, driven through fakes, for one reason: releasing the
 * camera. A track that outlives its screen leaves the lens on, and no assertion
 * about scanning would catch it.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type BarcodeDetectorCtor,
  type ScanEnv,
  classifyScanError,
  codeFromScan,
  describeScanFailure,
  detectScanSupport,
  scanAdvice,
  startScan,
} from '../src/client/scan.js';
import { scanStatus } from '../src/client/views/scan.js';

/** A detector constructor that reports whatever formats it is given. */
function fakeDetector(formats: string[] | Error | null): BarcodeDetectorCtor {
  const ctor = function () {
    return { detect: async () => [] };
  } as unknown as BarcodeDetectorCtor;
  if (formats === null) return ctor; // no `getSupportedFormats` at all
  ctor.getSupportedFormats = async () => {
    if (formats instanceof Error) throw formats;
    return formats;
  };
  return ctor;
}

const withQr = (): ScanEnv => ({ detector: fakeDetector(['qr_code', 'ean_13']), camera: true });

describe('detectScanSupport', () => {
  it('reports no detector where there is none — every iPhone', async () => {
    expect(await detectScanSupport({ detector: undefined, camera: true })).toBe('no_detector');
  });

  it('reports ready when the detector does QR and there is a camera', async () => {
    expect(await detectScanSupport(withQr())).toBe('ready');
  });

  it('reports no camera when the detector exists but getUserMedia does not', async () => {
    // Plain http is the likeliest cause, and it is not the same problem as a
    // browser that cannot decode — the advice differs, so the answer must too.
    expect(await detectScanSupport({ ...withQr(), camera: false })).toBe('no_camera');
  });

  it('refuses a detector that does not do QR', async () => {
    const env: ScanEnv = { detector: fakeDetector(['ean_13', 'code_128']), camera: true };
    expect(await detectScanSupport(env)).toBe('no_qr');
  });

  it('assumes QR when the browser has no getSupportedFormats to ask', async () => {
    // Absent is not a refusal. Older implementations shipped without it, and
    // every one of them read QR.
    const env: ScanEnv = { detector: fakeDetector(null), camera: true };
    expect(await detectScanSupport(env)).toBe('ready');
  });

  it('treats a throwing getSupportedFormats as no QR rather than crashing boot', async () => {
    const env: ScanEnv = { detector: fakeDetector(new Error('no barcode module')), camera: true };
    expect(await detectScanSupport(env)).toBe('no_qr');
  });
});

describe('codeFromScan', () => {
  it('reads the code out of the URL our own encoder produces', () => {
    expect(codeFromScan('https://satellite-chess.example/j/ABC123')).toBe('ABC123');
  });

  it('reads a code from any host, because the code is the payload', () => {
    // A preview deployment's QR scanned by a phone on production still names a
    // game; if it is not there, "no game with that code" is the honest answer.
    expect(codeFromScan('https://staging.example.com/j/ABC123')).toBe('ABC123');
  });

  it('folds a scanned link through the same normaliser typed codes use', () => {
    // The link may have been retyped by hand, and an O for a 0 must still work.
    expect(codeFromScan('https://example.com/j/abc12o')).toBe('ABC120');
  });

  it('accepts a bare code, for one written on paper', () => {
    expect(codeFromScan('ABC123')).toBe('ABC123');
    expect(codeFromScan('  abc 123 ')).toBe('ABC123');
  });

  it('refuses a QR that is not ours, without comment', () => {
    expect(codeFromScan('https://example.com/')).toBeNull();
    expect(codeFromScan('WIFI:S:TheCommon;T:WPA;P:hunter2;;')).toBeNull();
    expect(codeFromScan('https://example.com/j/not-a-code')).toBeNull();
    expect(codeFromScan('tel:+441234567890')).toBeNull();
    expect(codeFromScan('')).toBeNull();
    expect(codeFromScan('   ')).toBeNull();
  });

  it('refuses a field link, which is a different route and a different screen', () => {
    // `/f/<blob>` parses as an app route, so a looser check would have joined a
    // game with a field's blob as its code.
    expect(codeFromScan('https://example.com/f/AAAABBBBCCCCDDDD')).toBeNull();
  });
});

describe('scanAdvice', () => {
  it('says nothing at all when scanning works', () => {
    expect(scanAdvice('ready', 'android')).toBeNull();
  });

  it('sends an iPhone to the Camera app, which does this better than we would', () => {
    const advice = scanAdvice('no_detector', 'ios') ?? '';
    expect(advice).toMatch(/Camera app/);
    // And never leaves the typed code unmentioned: it is the path that always works.
    expect(advice).toMatch(/type/i);
  });

  it('never blames the player, and always names a next step', () => {
    for (const support of ['no_detector', 'no_qr', 'no_camera'] as const) {
      for (const platform of ['ios', 'android', 'other'] as const) {
        const advice = scanAdvice(support, platform);
        expect(advice, `${support}/${platform}`).not.toBeNull();
        expect(advice as string, `${support}/${platform}`).toMatch(/type|Camera app/i);
      }
    }
  });

  it('explains the http case, because it looks like a broken camera', () => {
    expect(scanAdvice('no_camera', 'android') ?? '').toMatch(/https/);
  });

  it('gives a detector that cannot do QR the same words as no detector at all', () => {
    // To the player these are one condition: this browser will not read a QR.
    expect(scanAdvice('no_qr', 'ios')).toBe(scanAdvice('no_detector', 'ios'));
  });
});

describe('scan failures', () => {
  it('separates a refused permission from a missing camera', () => {
    expect(classifyScanError({ name: 'NotAllowedError' })).toBe('denied');
    expect(classifyScanError({ name: 'SecurityError' })).toBe('denied');
    expect(classifyScanError({ name: 'NotFoundError' })).toBe('no_camera');
    expect(classifyScanError({ name: 'OverconstrainedError' })).toBe('no_camera');
    expect(classifyScanError(new Error('who knows'))).toBe('failed');
    expect(classifyScanError(null)).toBe('failed');
  });

  it('names the setting per platform, as the GPS errors do', () => {
    expect(describeScanFailure('denied', 'ios')).toMatch(/Safari/);
    expect(describeScanFailure('denied', 'android')).toMatch(/padlock/);
    expect(describeScanFailure('denied', 'other')).not.toMatch(/Safari|padlock/);
  });

  it('offers the typed code on every failure, since it is always available', () => {
    for (const failure of ['denied', 'no_camera', 'failed'] as const) {
      expect(describeScanFailure(failure, 'ios'), failure).toMatch(/type/i);
    }
  });
});

describe('scanStatus', () => {
  it('does not treat a poster as an error', () => {
    const status = scanStatus({ failure: null, sawForeign: true }, 'android');
    expect(status).toMatch(/not an invitation/i);
    expect(status).not.toMatch(/failed|error|blocked/i);
  });

  it('lets a real failure outrank a foreign code', () => {
    const status = scanStatus({ failure: 'denied', sawForeign: true }, 'android');
    expect(status).toBe(describeScanFailure('denied', 'android'));
  });
});

/** A video element, reduced to the four things `startScan` touches. */
function fakeVideo() {
  return {
    srcObject: null as MediaStream | null,
    muted: false,
    setAttribute: () => undefined,
    play: async () => undefined,
  } as unknown as HTMLVideoElement;
}

function fakeStream() {
  const track = { stop: vi.fn() };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}

/** Installs a `navigator.mediaDevices.getUserMedia` for the duration of a test. */
function withCamera(open: () => Promise<MediaStream>): () => void {
  const previous = (globalThis as { navigator?: unknown }).navigator;
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: open }, userAgent: '', maxTouchPoints: 0 },
    configurable: true,
    writable: true,
  });
  return () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: previous,
      configurable: true,
      writable: true,
    });
  };
}

describe('startScan', () => {
  it('hands the camera back when the screen is torn down during the permission prompt', async () => {
    // The case that leaves a lens on: `getUserMedia` is still resolving when the
    // player taps Back, so the stream arrives with nothing left to display it.
    const { stream, track } = fakeStream();
    let grant: (s: MediaStream) => void = () => undefined;
    const restore = withCamera(() => new Promise<MediaStream>((resolve) => (grant = resolve)));
    try {
      const stop = startScan({
        video: fakeVideo(),
        env: withQr(),
        onCode: () => undefined,
        onError: () => undefined,
      });
      stop();
      grant(stream);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(track.stop).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('reports a refused permission rather than failing silently', async () => {
    const restore = withCamera(() => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })));
    try {
      const failures: string[] = [];
      startScan({
        video: fakeVideo(),
        env: withQr(),
        onCode: () => undefined,
        onError: (f) => failures.push(f),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(failures).toEqual(['denied']);
    } finally {
      restore();
    }
  });

  it('stops the camera before handing over the code', async () => {
    // Order matters: the next screen mounts inside `onCode`, and the camera must
    // already be off by then rather than one microtask later.
    const { stream, track } = fakeStream();
    const restore = withCamera(async () => stream);
    try {
      const env: ScanEnv = {
        camera: true,
        detector: (function () {
          return { detect: async () => [{ rawValue: 'https://example.com/j/ABC123' }] };
        }) as unknown as BarcodeDetectorCtor,
      };
      let stoppedFirst = false;
      await new Promise<void>((resolve) => {
        startScan({
          video: fakeVideo(),
          env,
          intervalMs: 1,
          onCode: (code) => {
            stoppedFirst = track.stop.mock.calls.length > 0;
            expect(code).toBe('ABC123');
            resolve();
          },
          onError: () => resolve(),
        });
      });
      expect(stoppedFirst).toBe(true);
    } finally {
      restore();
    }
  });

  it('keeps scanning past a QR that is not ours', async () => {
    const { stream } = fakeStream();
    const restore = withCamera(async () => stream);
    try {
      let frames = 0;
      const env: ScanEnv = {
        camera: true,
        detector: (function () {
          return {
            detect: async () => {
              frames += 1;
              // A poster, then the invite.
              return frames < 3
                ? [{ rawValue: 'https://example.com/menu' }]
                : [{ rawValue: 'https://example.com/j/ABC123' }];
            },
          };
        }) as unknown as BarcodeDetectorCtor,
      };
      let foreign = 0;
      const code = await new Promise<string>((resolve) => {
        startScan({
          video: fakeVideo(),
          env,
          intervalMs: 1,
          onForeign: () => (foreign += 1),
          onCode: resolve,
          onError: () => resolve('error'),
        });
      });
      expect(code).toBe('ABC123');
      expect(foreign).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it('gives up on a detector that rejects every frame, instead of looping forever', async () => {
    // Android exposes the API before the Play Services barcode module is
    // downloaded, and then fails on every frame four times a second.
    const { stream, track } = fakeStream();
    const restore = withCamera(async () => stream);
    try {
      const env: ScanEnv = {
        camera: true,
        detector: (function () {
          return { detect: async () => Promise.reject(new Error('module missing')) };
        }) as unknown as BarcodeDetectorCtor,
      };
      const failure = await new Promise<string>((resolve) => {
        startScan({
          video: fakeVideo(),
          env,
          intervalMs: 1,
          onCode: () => resolve('code'),
          onError: resolve,
        });
      });
      expect(failure).toBe('failed');
      expect(track.stop).toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
