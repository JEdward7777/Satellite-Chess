/**
 * A QR encoder, written out in full because the alternative is a CDN.
 *
 * Stage 6.1.3 says "self-contained, no CDN", and that constraint is not
 * squeamishness about dependencies. The phone that most needs to *show* an
 * invite is standing in a field on one bar of signal, and the phone scanning it
 * may have no signal at all — the service worker has to be able to cache
 * whatever draws this, so it has to be part of our own bundle. A `<script
 * src="https://cdn…">` is a QR code that works in the café and fails on the
 * grass.
 *
 * Byte mode only. A URL contains lowercase letters, so QR's denser alphanumeric
 * mode (11 bits a character pair against 8 bits a character) is unavailable
 * without uppercasing the whole link — which would work for `/j/CODE`, since a
 * join code folds through `normaliseJoinCode` anyway, but not for the `/f/<blob>`
 * field links of stage 6.4, whose base64url payload is case-sensitive. One mode
 * that always works beats two that disagree about which links they can carry.
 *
 * The tables here are from ISO/IEC 18004 and are the only part that is data
 * rather than derivation: everything with a closed form (alignment pattern
 * positions, raw module counts, the generator polynomials) is computed.
 *
 * Verified against an independent decoder — see `scripts/check-qr.mjs`. A QR
 * encoder is exactly the kind of code that can be wrong in a way that looks
 * perfectly plausible on screen, so "it renders a tidy square of dots" is not
 * evidence of anything.
 */

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/**
 * Error-correction level. Higher recovers from more damage but needs a larger
 * symbol for the same payload.
 */
export type EcLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrCode {
  /** Symbol version, 1–40. The side is `17 + 4 * version` modules. */
  version: number;
  ecLevel: EcLevel;
  /** Modules a side, excluding the quiet zone. */
  size: number;
  /** Row-major, `modules[y][x]`; true is dark. */
  modules: boolean[][];
}

export interface QrOptions {
  ecLevel?: EcLevel;
  /** Force at least this version, so a symbol does not shrink as text shortens. */
  minVersion?: number;
}

/**
 * The largest byte-mode payload we will encode.
 *
 * Version 40 at level L holds a good deal more, but nothing in this app comes
 * close and a URL that did would be unscannable off a phone screen anyway. The
 * limit exists so a bug upstream surfaces as an error here rather than as a
 * 177-module symbol nobody can read.
 */
export const MAX_QR_BYTES = 512;

// ---------------------------------------------------------------------------
// Tables (ISO/IEC 18004, table 9)
// ---------------------------------------------------------------------------

const EC_LEVELS: EcLevel[] = ['L', 'M', 'Q', 'H'];

/** Error-correction codewords per block, indexed by level then version−1. */
const EC_CODEWORDS_PER_BLOCK: Record<EcLevel, number[]> = {
  L: [
    7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30,
    26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  M: [
    10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ],
  Q: [
    13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30,
    30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  H: [
    17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
};

/** Number of error-correction blocks, indexed by level then version−1. */
const EC_BLOCKS: Record<EcLevel, number[]> = {
  L: [
    1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15,
    16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
  ],
  M: [
    1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
    26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
  Q: [
    1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34,
    35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
  ],
  H: [
    1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37,
    40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
  ],
};

/** The two bits each level contributes to the format information. */
const EC_FORMAT_BITS: Record<EcLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

// ---------------------------------------------------------------------------
// Geometry, all derived
// ---------------------------------------------------------------------------

/**
 * Modules available for data and error correction, before the format and
 * version information is subtracted.
 *
 * The closed form is the whole symbol minus the function patterns: the three
 * finders with their separators, the two timing lines, and the alignment
 * patterns, which overlap the timing lines in a way the `25n − 10n − 55` term
 * accounts for.
 */
function rawDataModules(version: number): number {
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const aligns = Math.floor(version / 7) + 2;
    modules -= (25 * aligns - 10) * aligns - 55;
    // Version information, six modules by three, twice over.
    if (version >= 7) modules -= 36;
  }
  return modules;
}

/** Data codewords available at this version and level, after error correction. */
function dataCodewords(version: number, ecLevel: EcLevel): number {
  return (
    Math.floor(rawDataModules(version) / 8) -
    EC_CODEWORDS_PER_BLOCK[ecLevel][version - 1] * EC_BLOCKS[ecLevel][version - 1]
  );
}

/**
 * Centres of the alignment patterns, on both axes.
 *
 * Version 1 has none. Otherwise the first is always at 6 and the last is always
 * seven from the edge, with the rest spaced evenly at an even step — version 32
 * is the one case the general formula gets wrong, and the spec simply states 26.
 */
function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step =
    version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let pos = 17 + 4 * version - 7; positions.length < count; pos -= step) {
    positions.splice(1, 0, pos);
  }
  return positions;
}

// ---------------------------------------------------------------------------
// GF(256) arithmetic for Reed–Solomon
// ---------------------------------------------------------------------------

/**
 * Multiply in GF(256) with the QR field's primitive polynomial, x^8 + x^4 +
 * x^3 + x^2 + 1 (0x11D).
 *
 * Russian-peasant rather than log tables: it is called often enough to matter
 * only for symbols far larger than anything here, and a loop with no
 * precomputed state is much easier to be sure of.
 */
function gfMultiply(a: number, b: number): number {
  let product = 0;
  for (let bit = 7; bit >= 0; bit--) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    product ^= ((b >>> bit) & 1) * a;
  }
  return product & 0xff;
}

/** The divisor polynomial for `degree` error-correction codewords, high term first. */
function generatorPolynomial(degree: number): number[] {
  // Product of (x − 2^i) for i in 0..degree−1, kept without its leading 1.
  const coefficients = new Array<number>(degree).fill(0);
  coefficients[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      coefficients[j] = gfMultiply(coefficients[j], root);
      if (j + 1 < degree) coefficients[j] ^= coefficients[j + 1];
    }
    root = gfMultiply(root, 2);
  }
  return coefficients;
}

/** The remainder of `data` divided by the generator: the error-correction codewords. */
function errorCorrection(data: number[], degree: number): number[] {
  const divisor = generatorPolynomial(degree);
  const remainder = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder.shift() as number);
    remainder.push(0);
    for (let i = 0; i < degree; i++) {
      remainder[i] ^= gfMultiply(divisor[i], factor);
    }
  }
  return remainder;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** A growable bit buffer, most significant bit first, as QR writes everything. */
class BitBuffer {
  readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }
}

/** Byte mode's character-count field is 8 bits up to version 9 and 16 beyond. */
function byteCountBits(version: number): number {
  return version < 10 ? 8 : 16;
}

/** The smallest version that fits `byteCount` bytes, or null if none does. */
function chooseVersion(
  byteCount: number,
  ecLevel: EcLevel,
  minVersion: number,
): number | null {
  for (let version = Math.max(1, minVersion); version <= 40; version++) {
    // Mode indicator, character count, then the payload.
    const needed = 4 + byteCountBits(version) + byteCount * 8;
    if (needed <= dataCodewords(version, ecLevel) * 8) return version;
  }
  return null;
}

/**
 * Data codewords for the payload: the byte-mode segment, a terminator, and the
 * alternating pad bytes the spec names.
 */
function buildDataCodewords(bytes: Uint8Array, version: number, ecLevel: EcLevel): number[] {
  const capacityBits = dataCodewords(version, ecLevel) * 8;
  const buffer = new BitBuffer();
  buffer.push(0b0100, 4); // byte mode
  buffer.push(bytes.length, byteCountBits(version));
  for (const byte of bytes) buffer.push(byte, 8);

  // Terminator: up to four zero bits, fewer if the symbol is nearly full.
  buffer.push(0, Math.min(4, capacityBits - buffer.length));
  // Then to a byte boundary.
  buffer.push(0, (8 - (buffer.length % 8)) % 8);

  const codewords: number[] = [];
  for (let i = 0; i < buffer.length; i += 8) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit++) byte = (byte << 1) | buffer.bits[i + bit];
    codewords.push(byte);
  }
  // 0xEC and 0x11 alternating — chosen by the spec because the pair produces a
  // busy pattern rather than a large blank region.
  for (let i = 0; codewords.length < capacityBits / 8; i++) {
    codewords.push(i % 2 === 0 ? 0xec : 0x11);
  }
  return codewords;
}

/**
 * Split into blocks, compute each block's error correction, and interleave.
 *
 * The interleave is what makes a scratch across the symbol survivable: a burst
 * of damage in the final sequence is spread across every block rather than
 * destroying one of them.
 */
function interleave(data: number[], version: number, ecLevel: EcLevel): number[] {
  const blockCount = EC_BLOCKS[ecLevel][version - 1];
  const ecPerBlock = EC_CODEWORDS_PER_BLOCK[ecLevel][version - 1];
  const totalCodewords = Math.floor(rawDataModules(version) / 8);
  // The shorter blocks come first; the remainder get one codeword each more.
  const shortBlockLength = Math.floor(totalCodewords / blockCount) - ecPerBlock;
  const longBlocks = totalCodewords % blockCount;

  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < blockCount; i++) {
    const length = shortBlockLength + (i < blockCount - longBlocks ? 0 : 1);
    const block = data.slice(offset, offset + length);
    offset += length;
    dataBlocks.push(block);
    ecBlocks.push(errorCorrection(block, ecPerBlock));
  }

  const result: number[] = [];
  for (let i = 0; i < shortBlockLength + 1; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) result.push(block[i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) result.push(block[i]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

/**
 * The symbol under construction.
 *
 * `reserved` marks every module belonging to a function pattern. It is the only
 * thing keeping the data-placement walk from writing over a finder, and it is
 * also what the mask consults — masking must not touch function patterns, since
 * a scanner locates the symbol by them before it knows the mask.
 */
interface Canvas {
  size: number;
  modules: boolean[][];
  reserved: boolean[][];
}

function blankCanvas(size: number): Canvas {
  const grid = (): boolean[][] =>
    Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  return { size, modules: grid(), reserved: grid() };
}

function setModule(canvas: Canvas, x: number, y: number, dark: boolean): void {
  canvas.modules[y][x] = dark;
  canvas.reserved[y][x] = true;
}

/** A finder pattern and its separator, anchored at the given top-left corner. */
function drawFinder(canvas: Canvas, left: number, top: number): void {
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const x = left + dx;
      const y = top + dy;
      if (x < 0 || x >= canvas.size || y < 0 || y >= canvas.size) continue;
      // Concentric rings: 7×7 dark, 5×5 light, 3×3 dark. Chebyshev distance
      // from the centre says which ring a module is in.
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      setModule(canvas, x, y, ring !== 2 && ring <= 3);
    }
  }
}

function drawAlignment(canvas: Canvas, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setModule(canvas, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFunctionPatterns(canvas: Canvas, version: number): void {
  const size = canvas.size;

  // Timing patterns first: the alignment patterns overlap them and win.
  for (let i = 0; i < size; i++) {
    setModule(canvas, 6, i, i % 2 === 0);
    setModule(canvas, i, 6, i % 2 === 0);
  }

  drawFinder(canvas, 0, 0);
  drawFinder(canvas, size - 7, 0);
  drawFinder(canvas, 0, size - 7);

  const positions = alignmentPositions(version);
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < positions.length; j++) {
      // The three corners are occupied by finders.
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === positions.length - 1) ||
        (i === positions.length - 1 && j === 0);
      if (!corner) drawAlignment(canvas, positions[j], positions[i]);
    }
  }

  // The dark module: always set, always here. Reserved before the format
  // information is written so the data walk skips it.
  setModule(canvas, 8, size - 8, true);

  reserveFormatArea(canvas);
  if (version >= 7) drawVersionInfo(canvas, version);
}

/**
 * Reserve the fifteen format modules in each of their two locations.
 *
 * Written blank here and filled in once the mask is chosen — the format
 * information names the mask, so it cannot be known until the mask is.
 */
function reserveFormatArea(canvas: Canvas): void {
  const size = canvas.size;
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setModule(canvas, i, 8, false);
      setModule(canvas, 8, i, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    setModule(canvas, size - 1 - i, 8, false);
  }
  for (let i = 0; i < 7; i++) {
    setModule(canvas, 8, size - 1 - i, false);
  }
  // Except the dark module, which is not part of the format information.
  setModule(canvas, 8, size - 8, true);
}

/** BCH remainder of `value` under `generator`, used by both info fields. */
function bchRemainder(value: number, generator: number, degree: number): number {
  let remainder = value << degree;
  const generatorBits = 32 - Math.clz32(generator);
  while (32 - Math.clz32(remainder) >= generatorBits) {
    remainder ^= generator << (32 - Math.clz32(remainder) - generatorBits);
  }
  return remainder;
}

function drawFormatInfo(canvas: Canvas, ecLevel: EcLevel, mask: number): void {
  const size = canvas.size;
  const data = (EC_FORMAT_BITS[ecLevel] << 3) | mask;
  // BCH(15,5), then XOR by 0x5412 so an all-zero format never reads as blank.
  const bits = ((data << 10) | bchRemainder(data, 0x537, 10)) ^ 0x5412;

  const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;

  // Copy one, around the top-left finder, least significant bit first.
  for (let i = 0; i <= 5; i++) setModule(canvas, 8, i, bit(i));
  setModule(canvas, 8, 7, bit(6));
  setModule(canvas, 8, 8, bit(7));
  setModule(canvas, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setModule(canvas, 14 - i, 8, bit(i));

  // Copy two, split between the other two finders.
  for (let i = 0; i < 8; i++) setModule(canvas, size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setModule(canvas, 8, size - 15 + i, bit(i));
  setModule(canvas, 8, size - 8, true);
}

function drawVersionInfo(canvas: Canvas, version: number): void {
  const size = canvas.size;
  // BCH(18,6). No XOR mask: version 7 upwards is never all-zero.
  const bits = (version << 12) | bchRemainder(version, 0x1f25, 12);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = Math.floor(i / 3);
    const b = (i % 3) + size - 11;
    setModule(canvas, a, b, dark);
    setModule(canvas, b, a, dark);
  }
}

/**
 * Lay the codewords into the symbol.
 *
 * Two modules wide, upward then downward, right to left, skipping the vertical
 * timing pattern at column 6 — the column that would otherwise make the pairs
 * straddle it. Any modules left over when the data runs out stay light; the
 * spec calls them remainder bits and they carry nothing.
 */
function drawCodewords(canvas: Canvas, codewords: number[]): void {
  const size = canvas.size;
  let bitIndex = 0;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let column = 0; column < 2; column++) {
        const x = right - column;
        // Every other pair of columns runs the other way.
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (canvas.reserved[y][x]) continue;
        if (bitIndex < codewords.length * 8) {
          canvas.modules[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex++;
        }
      }
    }
  }
}

/** The eight mask conditions, by their spec numbering. */
function maskCondition(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** Apply (or, called twice, undo) a mask over everything that is not a function pattern. */
function applyMask(canvas: Canvas, mask: number): void {
  for (let y = 0; y < canvas.size; y++) {
    for (let x = 0; x < canvas.size; x++) {
      if (!canvas.reserved[y][x] && maskCondition(mask, x, y)) {
        canvas.modules[y][x] = !canvas.modules[y][x];
      }
    }
  }
}

const PENALTY_RUN = 3;
const PENALTY_BLOCK = 3;
const PENALTY_FINDER_LOOKALIKE = 40;
const PENALTY_IMBALANCE = 10;

/**
 * The last seven run lengths along one line, most recent first.
 *
 * Rule 3 looks for a 1:1:3:1:1 dark-light-dark-light-dark sequence with four
 * light modules beside it, which is seven runs wide once the light margin on
 * either side is counted — hence seven, and hence a history rather than a
 * look-ahead.
 */
type RunHistory = number[];

/**
 * Record a finished run.
 *
 * The first run of a line is padded by a whole line's width, because the quiet
 * zone outside the symbol is light and a finder-lookalike touching the edge is
 * every bit as misleading as one in the middle.
 */
function addRun(history: RunHistory, length: number, size: number): void {
  // Nothing recorded yet means this is the line's first run. Every later run
  // has a nonzero length once padded, so this stays true only once.
  history.pop();
  history.unshift(history[0] === 0 ? length + size : length);
}

/** How many finder-lookalikes end at this point in the history: 0, 1 or 2. */
function countLookalikes(history: RunHistory): number {
  const unit = history[1];
  const core =
    unit > 0 &&
    history[2] === unit &&
    history[3] === unit * 3 &&
    history[4] === unit &&
    history[5] === unit;
  if (!core) return 0;
  // The four-module light margin may be on either side, and a symbol with one
  // on each side is penalised twice.
  return (
    (history[0] >= unit * 4 && history[6] >= unit ? 1 : 0) +
    (history[6] >= unit * 4 && history[0] >= unit ? 1 : 0)
  );
}

/**
 * How bad a masked symbol is, by the spec's four rules.
 *
 * The point of all four is scannability: long runs and 2×2 blocks are hard to
 * clock, anything resembling a finder pattern misleads the locator, and a symbol
 * that is mostly one colour loses contrast headroom. Every mask produces a
 * *valid* symbol, so this only ever picks a better one — but "better" here means
 * the difference between scanning at arm's length and not.
 */
function penalty(canvas: Canvas): number {
  const size = canvas.size;
  const at = (x: number, y: number): boolean => canvas.modules[y][x];
  let score = 0;

  // Rules 1 and 3, run-based, once per row and once per column.
  for (let major = 0; major < size; major++) {
    for (const horizontal of [true, false]) {
      // Lines start light, so the run in progress before the first module is a
      // zero-length light one.
      let runColour = false;
      let runLength = 0;
      const history: RunHistory = [0, 0, 0, 0, 0, 0, 0];

      for (let minor = 0; minor < size; minor++) {
        const dark = horizontal ? at(minor, major) : at(major, minor);
        if (dark === runColour) {
          runLength++;
          if (runLength === 5) score += PENALTY_RUN;
          else if (runLength > 5) score += 1;
          continue;
        }
        addRun(history, runLength, size);
        // Counted only as a light run closes, so the middle of the pattern is
        // always the dark run the rule is about.
        if (!runColour) score += countLookalikes(history) * PENALTY_FINDER_LOOKALIKE;
        runColour = dark;
        runLength = 1;
      }

      // Close the line: the run in progress, then the quiet zone beyond it.
      if (runColour) {
        addRun(history, runLength, size);
        runLength = 0;
      }
      addRun(history, runLength + size, size);
      score += countLookalikes(history) * PENALTY_FINDER_LOOKALIKE;
    }
  }

  // Rule 2: every 2×2 block of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const colour = at(x, y);
      if (colour === at(x + 1, y) && colour === at(x, y + 1) && colour === at(x + 1, y + 1)) {
        score += PENALTY_BLOCK;
      }
    }
  }

  // Rule 4: deviation from an even split, in steps of five per cent.
  let dark = 0;
  for (const row of canvas.modules) for (const module of row) if (module) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * PENALTY_IMBALANCE;

  return score;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Encode text as a QR symbol.
 *
 * Throws when the text cannot fit, because there is no sensible partial answer
 * — a truncated URL is a QR code that scans and goes to the wrong place, which
 * is worse than one that was never drawn.
 */
export function encodeQr(text: string, options: QrOptions = {}): QrCode {
  const ecLevel = options.ecLevel ?? 'M';
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MAX_QR_BYTES) {
    throw new Error(`${bytes.length} bytes is too long for a QR code here`);
  }

  const version = chooseVersion(bytes.length, ecLevel, options.minVersion ?? 1);
  if (version === null) {
    throw new Error(`${bytes.length} bytes does not fit at error correction ${ecLevel}`);
  }

  const codewords = interleave(buildDataCodewords(bytes, version, ecLevel), version, ecLevel);
  const canvas = blankCanvas(17 + 4 * version);
  drawFunctionPatterns(canvas, version);
  drawCodewords(canvas, codewords);

  // Every mask is tried and the least penalised wins. The format information
  // has to be written before scoring, since it is part of the symbol a scanner
  // sees and rule 1 runs straight through it.
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(canvas, mask);
    drawFormatInfo(canvas, ecLevel, mask);
    const score = penalty(canvas);
    if (score < bestScore) {
      bestScore = score;
      best = mask;
    }
    applyMask(canvas, mask); // its own inverse
  }
  applyMask(canvas, best);
  drawFormatInfo(canvas, ecLevel, best);

  return { version, ecLevel, size: canvas.size, modules: canvas.modules };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface QrSvgOptions {
  /**
   * Light modules of margin. Four is the spec's minimum and the reason a QR
   * printed hard against a dark border often will not scan.
   */
  quietZone?: number;
  /** Dark modules. Default black — a scanner wants contrast, not brand colour. */
  dark?: string;
  /** The background. Must be opaque: a transparent QR on a dark app is unscannable. */
  light?: string;
  /** Goes on the `<svg>` element for accessibility. */
  title?: string;
}

/**
 * Draw the symbol as an SVG string.
 *
 * SVG rather than a canvas because it scales to whatever the screen is without
 * resampling, prints sharply for stage 6.4, and can be dropped into `innerHTML`
 * by a view that does not otherwise own a drawing surface. The whole path is one
 * `d` attribute — one node instead of several hundred rectangles, which matters
 * on the phone this is being rendered on.
 *
 * `shape-rendering: crispEdges` is not optional. Antialiased module edges are
 * the difference between a symbol that scans at arm's length and one that does
 * not.
 */
export function qrSvg(qr: QrCode, options: QrSvgOptions = {}): string {
  const quiet = options.quietZone ?? 4;
  const dark = options.dark ?? '#000000';
  const light = options.light ?? '#ffffff';
  const side = qr.size + quiet * 2;

  const path: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    let run = 0;
    for (let x = 0; x <= qr.size; x++) {
      const isDark = x < qr.size && qr.modules[y][x];
      if (isDark) {
        run++;
        continue;
      }
      // Runs are merged so a row of dark modules is one horizontal bar rather
      // than a dozen adjacent squares that a renderer may leave hairlines between.
      if (run > 0) path.push(`M${x - run + quiet} ${y + quiet}h${run}v1h-${run}z`);
      run = 0;
    }
  }

  const title = options.title
    ? `<title>${options.title.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] as string)}</title>`
    : '';

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" ` +
    `width="100%" shape-rendering="crispEdges" role="img">` +
    title +
    `<rect width="${side}" height="${side}" fill="${light}"/>` +
    `<path fill="${dark}" d="${path.join('')}"/>` +
    `</svg>`
  );
}
