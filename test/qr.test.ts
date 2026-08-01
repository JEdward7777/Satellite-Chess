import { describe, expect, it } from 'vitest';

import { MAX_QR_BYTES, encodeQr, qrSvg } from '../src/shared/qr.js';

/**
 * A QR encoder produces a plausible-looking square of dots whatever it gets
 * wrong, so these tests are deliberately not "does it look like a QR code".
 *
 * The real verification is `scripts/check-qr.mjs`, which decodes the output with
 * jsQR — a decoder that has never seen this code. It passes 351 cases across
 * versions 1–14 and every error-correction level. What lives here is the part
 * that must hold *offline*, with no extra dependency: the structural invariants
 * a scanner relies on to find the symbol at all, and a snapshot of one symbol
 * that decoder has already vouched for, so a regression in the bit-level logic
 * fails a normal `npm test` rather than waiting for someone to run the script.
 */

/** The symbol shape the app actually shows: a join link at the default level. */
const INVITE = 'https://sat.example/j/ABC123';

/**
 * That invite, as verified by jsQR. `#` is dark.
 *
 * Regenerate only after `node scripts/check-qr.mjs` passes — the value of this
 * fixture is entirely that an independent decoder read it back correctly once.
 */
const INVITE_MODULES = [
  '#######...#..###..#.#.#######',
  '#.....#....######.#.#.#.....#',
  '#.###.#.##.#.#.#...##.#.###.#',
  '#.###.#.###.#.##...#..#.###.#',
  '#.###.#.##.#...##.##..#.###.#',
  '#.....#.#...#....##...#.....#',
  '#######.#.#.#.#.#.#.#.#######',
  '........##..#.#.#.##.........',
  '#.#####..#.#....#..#..#####..',
  '#.##.....##..###..#######...#',
  '##..#.#.####.######.#........',
  '##..#..##....#.#...##..#.#.#.',
  '.###.###......##.###.....##..',
  '###.#..##.#.#..##..#..#.#...#',
  '.#.##.#.##........#.###.###..',
  '#....#...###..#.#...##.##..#.',
  '...##.####.#....###....#.##..',
  '##.......#...###...######.#.#',
  '#.##########.######..#.##.#..',
  '#...#..#....##.#..#.#...#..#.',
  '#..#####...#..##.########.###',
  '........#..#...##...#...#####',
  '#######..##......####.#.###..',
  '#.....#.##....#.#..##...#..#.',
  '#.###.#.#.#.....#.#.#####.#.#',
  '#.###.#.###...##.##......##..',
  '#.###.#.##.#..####...#######.',
  '#.....#...#.#.##.####.##.#.#.',
  '#######.##..##.#...#....###..',
];

function render(modules: boolean[][]): string[] {
  return modules.map((row) => row.map((dark) => (dark ? '#' : '.')).join(''));
}

describe('encodeQr', () => {
  it('reproduces a symbol an independent decoder has read', () => {
    const qr = encodeQr(INVITE);
    expect(qr.version).toBe(3);
    expect(qr.size).toBe(29);
    expect(render(qr.modules)).toEqual(INVITE_MODULES);
  });

  it('sizes the symbol to the text', () => {
    // Version n is 17 + 4n modules a side, and a longer URL must not silently
    // truncate — it must grow.
    const short = encodeQr('https://a.example/j/ABC123');
    const long = encodeQr(`https://a.example/j/ABC123?${'x'.repeat(200)}`);
    expect(long.version).toBeGreaterThan(short.version);
    expect(long.size).toBe(17 + 4 * long.version);
  });

  it('needs a bigger symbol for stronger error correction', () => {
    // Same text, more recovery data: the payload has to go somewhere.
    const light = encodeQr('https://satellite-chess.example.workers.dev/j/ABC123', {
      ecLevel: 'L',
    });
    const heavy = encodeQr('https://satellite-chess.example.workers.dev/j/ABC123', {
      ecLevel: 'H',
    });
    expect(heavy.version).toBeGreaterThan(light.version);
  });

  it('honours a version floor so a symbol does not shrink as the text shortens', () => {
    const qr = encodeQr('hi', { minVersion: 5 });
    expect(qr.version).toBe(5);
    expect(qr.size).toBe(37);
  });

  it('refuses text it cannot carry rather than truncating it', () => {
    // A truncated URL is a QR code that scans and goes to the wrong place, which
    // is strictly worse than one that was never drawn.
    expect(() => encodeQr('x'.repeat(MAX_QR_BYTES + 1))).toThrow(/too long/);
  });

  describe('the patterns a scanner locates the symbol by', () => {
    // If any of these is wrong the symbol is undecodable no matter how correct
    // the data underneath is, and nothing about the picture says so.
    const qr = encodeQr(INVITE);
    const at = (x: number, y: number) => qr.modules[y][x];

    it('puts a finder in three corners and not the fourth', () => {
      const finderAt = (left: number, top: number) => {
        for (let dy = 0; dy < 7; dy++) {
          for (let dx = 0; dx < 7; dx++) {
            const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
            if (at(left + dx, top + dy) !== (ring !== 2)) return false;
          }
        }
        return true;
      };
      expect(finderAt(0, 0)).toBe(true);
      expect(finderAt(qr.size - 7, 0)).toBe(true);
      expect(finderAt(0, qr.size - 7)).toBe(true);
      expect(finderAt(qr.size - 7, qr.size - 7)).toBe(false);
    });

    it('separates each finder from the data with a light border', () => {
      for (let i = 0; i < 8; i++) {
        expect(at(7, i)).toBe(false);
        expect(at(i, 7)).toBe(false);
        expect(at(qr.size - 8, i)).toBe(false);
        expect(at(i, qr.size - 8)).toBe(false);
      }
    });

    it('alternates the timing patterns, which are the symbol’s ruler', () => {
      for (let i = 8; i < qr.size - 8; i++) {
        expect(at(i, 6)).toBe(i % 2 === 0);
        expect(at(6, i)).toBe(i % 2 === 0);
      }
    });

    it('sets the dark module, which is dark in every valid symbol', () => {
      expect(at(8, qr.size - 8)).toBe(true);
    });
  });

  it('draws an alignment pattern from version 2 up, and none at version 1', () => {
    const one = encodeQr('hi', { minVersion: 1, ecLevel: 'L' });
    expect(one.version).toBe(1);
    // Version 2's single alignment pattern is centred at (18, 18).
    const two = encodeQr('hi', { minVersion: 2 });
    const ring = (x: number, y: number) =>
      Math.max(Math.abs(x - 18), Math.abs(y - 18)) !== 1;
    for (let y = 16; y <= 20; y++) {
      for (let x = 16; x <= 20; x++) {
        expect(two.modules[y][x]).toBe(ring(x, y));
      }
    }
  });
});

describe('qrSvg', () => {
  const qr = encodeQr(INVITE);

  it('reserves the quiet zone, without which a scanner cannot find the symbol', () => {
    const svg = qrSvg(qr, { quietZone: 4 });
    expect(svg).toContain(`viewBox="0 0 ${qr.size + 8} ${qr.size + 8}"`);
  });

  it('paints an opaque background', () => {
    // A transparent QR over this app's near-black chrome is dark-on-dark and
    // scans as nothing at all.
    expect(qrSvg(qr)).toContain('<rect width=');
    expect(qrSvg(qr)).toContain('fill="#ffffff"');
  });

  it('turns off antialiasing, which blurs module edges at arm’s length', () => {
    expect(qrSvg(qr)).toContain('shape-rendering="crispEdges"');
  });

  it('escapes a title rather than letting it close the tag', () => {
    const svg = qrSvg(qr, { title: 'Field <b>&' });
    expect(svg).toContain('<title>Field &lt;b&gt;&amp;</title>');
  });

  it('merges each run of dark modules into one horizontal bar', () => {
    // One path, not several hundred rects: this is rendered on a phone, and
    // adjacent rects can leave hairlines that confuse a scanner.
    const svg = qrSvg(qr);
    expect(svg.match(/<path/g)?.length).toBe(1);
    // The top-left finder's outer edge is seven modules of one run.
    expect(svg).toContain('M4 4h7v1h-7z');
  });
});
