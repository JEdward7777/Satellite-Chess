import { describe, expect, it } from 'vitest';

import {
  ADVICE,
  METERS_PER_FOOT,
  METERS_PER_MILE,
  METERS_PER_YARD,
  accuracyWords,
  asUnits,
  boardNumber,
  boardWords,
  lengthFigure,
  lengthNumber,
  lengthUnit,
  lengthWords,
  unitsForLocale,
  walkedWords,
} from '../src/shared/units.js';

/**
 * The one place a meter becomes a foot (O-21, decision 0049).
 *
 * Two things matter most. **Metric must be exactly what the screens said
 * before**, so a player who never touches the setting sees nothing change;
 * and **null is never zero**, because a game nobody measured is not a game in
 * which nobody walked (decision 0040).
 */

const ft = (feet: number) => feet * METERS_PER_FOOT;
const yd = (yards: number) => yards * METERS_PER_YARD;
const mi = (miles: number) => miles * METERS_PER_MILE;

describe('the conversion constants', () => {
  it('are the international definitions', () => {
    expect(METERS_PER_FOOT).toBe(0.3048);
    expect(METERS_PER_YARD).toBeCloseTo(3 * METERS_PER_FOOT, 12);
    expect(METERS_PER_MILE).toBeCloseTo(1760 * METERS_PER_YARD, 9);
  });
});

describe('asUnits', () => {
  it('knows the two, and nothing else', () => {
    expect(asUnits('metric')).toBe('metric');
    expect(asUnits('us')).toBe('us');
    for (const other of ['US', 'imperial', '', null, undefined, 1, {}]) {
      expect(asUnits(other)).toBeNull();
    }
  });
});

describe('unitsForLocale', () => {
  it('is US for an American locale, whatever the language', () => {
    expect(unitsForLocale('en-US')).toBe('us');
    expect(unitsForLocale('es-US')).toBe('us');
    expect(unitsForLocale('en-us')).toBe('us');
    expect(unitsForLocale('zh-Hant-US')).toBe('us');
  });

  it('is metric everywhere else, and when the region is not said', () => {
    for (const locale of ['en-GB', 'en-CA', 'en-AU', 'fr-FR', 'en', 'es', '', null, undefined, 'garbage']) {
      expect(unitsForLocale(locale)).toBe('metric');
    }
  });

  it('counts the two other countries usually named', () => {
    expect(unitsForLocale('en-LR')).toBe('us');
    expect(unitsForLocale('my-MM')).toBe('us');
  });
});

describe('lengthWords — short distances on the board', () => {
  it('writes metric exactly as the game screen always has', () => {
    expect(lengthWords(4.26, 'metric')).toBe('4.3 m');
    expect(lengthWords(41.6, 'metric')).toBe('42 m');
    expect(lengthWords(0, 'metric')).toBe('0.0 m');
    // With a precision asked for, metric uses it; that is how the reach
    // readout ("3.2 m") and a square ("8.0 m") have always been written.
    expect(lengthWords(3.2, 'metric', 1)).toBe('3.2 m');
    expect(lengthWords(12, 'metric', 1)).toBe('12.0 m');
    expect(lengthWords(12.4, 'metric', 0)).toBe('12 m');
  });

  it('writes feet, with a tenth only under ten feet', () => {
    expect(lengthWords(ft(3.24), 'us')).toBe('3.2 ft');
    expect(lengthWords(ft(9.94), 'us')).toBe('9.9 ft');
    expect(lengthWords(8, 'us')).toBe('26 ft');
    expect(lengthWords(3.2, 'us')).toBe('10 ft');
    // Feet ignore the metric precision: a square is "26 ft", never "26.2 ft".
    expect(lengthWords(8, 'us', 1)).toBe('26 ft');
  });

  it('decides "under ten" on the rounded value, so there is never a "10.0 ft"', () => {
    expect(lengthWords(ft(9.96), 'us')).toBe('10 ft');
    expect(lengthWords(ft(9.949), 'us')).toBe('9.9 ft');
  });

  it('groups thousands in feet', () => {
    expect(lengthWords(ft(1234.4), 'us')).toBe('1,234 ft');
  });

  it('says nothing silly for a negative or unmeasurable length', () => {
    for (const bad of [-3, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(lengthWords(bad, 'metric')).toBe('0.0 m');
      expect(lengthWords(bad, 'us')).toBe('0.0 ft');
    }
  });

  it('splits into a number and a unit for sentences that share one', () => {
    expect(lengthNumber(12.14, 'metric', 1)).toBe('12.1');
    expect(lengthNumber(12.14, 'us', 1)).toBe('40');
    expect(lengthUnit('metric')).toBe('m');
    expect(lengthUnit('us')).toBe('ft');
  });
});

describe('accuracyWords', () => {
  it('is ±whole meters, or ±whole feet', () => {
    expect(accuracyWords(5, 'metric')).toBe('±5 m');
    expect(accuracyWords(4.6, 'metric')).toBe('±5 m');
    expect(accuracyWords(5, 'us')).toBe('±16 ft');
    expect(accuracyWords(25, 'us')).toBe('±82 ft');
    expect(accuracyWords(0, 'us')).toBe('±0 ft');
  });

  it('is "unknown" when the phone did not say, and never negative', () => {
    expect(accuracyWords(null, 'metric')).toBe('unknown');
    expect(accuracyWords(Number.POSITIVE_INFINITY, 'us')).toBe('unknown');
    expect(accuracyWords(Number.NaN, 'us')).toBe('unknown');
    expect(accuracyWords(-4, 'metric')).toBe('±0 m');
  });
});

describe('boardWords — a board is measured in yards', () => {
  it('is whole meters, or whole yards', () => {
    expect(boardWords(64, 'metric')).toBe('64 m');
    expect(boardWords(64, 'us')).toBe('70 yd');
    expect(boardWords(yd(80), 'us')).toBe('80 yd');
    expect(boardNumber(yd(80.4), 'us')).toBe(80);
  });

  it('leaves metric ungrouped, as it always was, and groups yards', () => {
    expect(boardWords(2345, 'metric')).toBe('2345 m');
    expect(boardWords(yd(2345), 'us')).toBe('2,345 yd');
  });

  it('is zero for nonsense', () => {
    expect(boardWords(-1, 'us')).toBe('0 yd');
    expect(boardWords(Number.NaN, 'metric')).toBe('0 m');
  });
});

describe('walkedWords — the headline', () => {
  it('writes metric as the record always has', () => {
    expect(walkedWords(0, 'metric')).toBe('0 m');
    expect(walkedWords(840.4, 'metric')).toBe('840 m');
    expect(walkedWords(2430, 'metric')).toBe('2.4 km');
    expect(walkedWords(126_400, 'metric')).toBe('126 km');
  });

  it('goes from yards to miles at a mile, with one decimal', () => {
    expect(walkedWords(yd(840.4), 'us')).toBe('840 yd');
    expect(walkedWords(yd(1759.4), 'us')).toBe('1,759 yd');
    expect(walkedWords(mi(1), 'us')).toBe('1.0 mi');
    expect(walkedWords(mi(1.44), 'us')).toBe('1.4 mi');
    expect(walkedWords(mi(126.4), 'us')).toBe('126 mi');
  });

  it('switches unit on the rounded value, so there is no "1000 m" or "1,760 yd"', () => {
    expect(walkedWords(999.4, 'metric')).toBe('999 m');
    expect(walkedWords(999.6, 'metric')).toBe('1.0 km');
    expect(walkedWords(yd(1759.6), 'us')).toBe('1.0 mi');
  });

  it('switches to whole long units on the rounded value too', () => {
    expect(walkedWords(99_940, 'metric')).toBe('99.9 km');
    expect(walkedWords(99_970, 'metric')).toBe('100 km');
    expect(walkedWords(mi(99.97), 'us')).toBe('100 mi');
    expect(walkedWords(mi(1234.4), 'us')).toBe('1,234 mi');
  });

  it('says "not measured" for null, which is not zero (decision 0040)', () => {
    expect(walkedWords(null, 'metric')).toBe('not measured');
    expect(walkedWords(null, 'us')).toBe('not measured');
  });

  it('reads a negative or broken figure as nothing walked', () => {
    expect(walkedWords(-50, 'metric')).toBe('0 m');
    expect(walkedWords(Number.NaN, 'us')).toBe('0 yd');
    expect(walkedWords(Number.POSITIVE_INFINITY, 'us')).toBe('0 yd');
  });
});

describe('ADVICE — sizes offered, rounded in the player’s own units', () => {
  it('has a round value for every piece of advice in both units', () => {
    for (const pair of Object.values(ADVICE)) {
      expect(pair.metric).toMatch(/^\d+( to \d+)? m$/);
      expect(pair.us).toMatch(/^\d+( to \d+)? (ft|yards)$/);
    }
  });

  it('never advises a square below the practice floor it warns about (4 m)', () => {
    expect(ft(15)).toBeGreaterThan(4);
    expect(yd(5)).toBeGreaterThan(4);
  });
});

describe('lengthFigure', () => {
  it('is the number lengthNumber shows, in either units', () => {
    expect(lengthFigure(7.19999999998, 'metric', 1)).toBe(7.2);
    expect(lengthFigure(3, 'us', 1)).toBe(9.8);
    expect(lengthFigure(7.2, 'us', 1)).toBe(24);
    // Grouped in US units, and still a number.
    expect(lengthFigure(1000, 'us')).toBe(3281);
    for (let i = 0; i <= 5000; i += 7) {
      for (const units of ['metric', 'us'] as const) {
        expect(String(lengthFigure(i / 100, units, 1))).toBe(
          String(Number(lengthNumber(i / 100, units, 1).replace(/,/g, ''))),
        );
      }
    }
  });
});
