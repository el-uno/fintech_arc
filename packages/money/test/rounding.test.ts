import { describe, expect, it } from 'vitest';
import { divResidual, divRound, RoundingError, type RoundingMode } from '../src/index.js';

describe('divRound', () => {
  // numerator, denominator, expected result per mode
  const cases: Array<[bigint, bigint, Record<RoundingMode, bigint>]> = [
    [7n, 2n, { DOWN: 3n, UP: 4n, FLOOR: 3n, CEIL: 4n, HALF_UP: 4n, HALF_DOWN: 3n, HALF_EVEN: 4n }],
    [5n, 2n, { DOWN: 2n, UP: 3n, FLOOR: 2n, CEIL: 3n, HALF_UP: 3n, HALF_DOWN: 2n, HALF_EVEN: 2n }],
    [
      -5n,
      2n,
      { DOWN: -2n, UP: -3n, FLOOR: -3n, CEIL: -2n, HALF_UP: -3n, HALF_DOWN: -2n, HALF_EVEN: -2n },
    ],
    [
      -7n,
      2n,
      { DOWN: -3n, UP: -4n, FLOOR: -4n, CEIL: -3n, HALF_UP: -4n, HALF_DOWN: -3n, HALF_EVEN: -4n },
    ],
    [1n, 3n, { DOWN: 0n, UP: 1n, FLOOR: 0n, CEIL: 1n, HALF_UP: 0n, HALF_DOWN: 0n, HALF_EVEN: 0n }],
    [2n, 3n, { DOWN: 0n, UP: 1n, FLOOR: 0n, CEIL: 1n, HALF_UP: 1n, HALF_DOWN: 1n, HALF_EVEN: 1n }],
  ];

  for (const [numerator, denominator, expected] of cases) {
    for (const [mode, result] of Object.entries(expected) as Array<[RoundingMode, bigint]>) {
      it(`${numerator}/${denominator} ${mode} -> ${result}`, () => {
        expect(divRound(numerator, denominator, mode)).toBe(result);
      });
    }
  }

  it('is exact when the division has no remainder', () => {
    for (const mode of ['DOWN', 'UP', 'FLOOR', 'CEIL', 'HALF_UP', 'HALF_EVEN'] as RoundingMode[]) {
      expect(divRound(10n, 5n, mode)).toBe(2n);
      expect(divRound(-10n, 5n, mode)).toBe(-2n);
    }
  });

  it('normalises a negative denominator', () => {
    expect(divRound(7n, -2n, 'FLOOR')).toBe(divRound(-7n, 2n, 'FLOOR'));
  });

  it('rejects division by zero', () => {
    expect(() => divRound(1n, 0n, 'HALF_EVEN')).toThrow(RoundingError);
  });

  it('HALF_EVEN breaks ties toward the even neighbour', () => {
    expect(divRound(5n, 2n, 'HALF_EVEN')).toBe(2n); // 2.5 -> 2
    expect(divRound(7n, 2n, 'HALF_EVEN')).toBe(4n); // 3.5 -> 4
    expect(divRound(9n, 2n, 'HALF_EVEN')).toBe(4n); // 4.5 -> 4
    expect(divRound(11n, 2n, 'HALF_EVEN')).toBe(6n); // 5.5 -> 6
  });

  it('stays exact far beyond the float safe-integer range', () => {
    const huge = 10n ** 30n + 1n;
    expect(divRound(huge * 7n, 7n, 'HALF_EVEN')).toBe(huge);
  });
});

describe('divResidual', () => {
  it('returns the exact leftover', () => {
    expect(divResidual(7n, 2n, 'DOWN')).toEqual({ quotient: 3n, residual: 1n });
    expect(divResidual(7n, 2n, 'UP')).toEqual({ quotient: 4n, residual: -1n });
  });

  it('reports a zero residual on an exact division', () => {
    expect(divResidual(10n, 5n, 'HALF_EVEN')).toEqual({ quotient: 2n, residual: 0n });
  });
});
