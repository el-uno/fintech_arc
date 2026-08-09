import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CURRENCY_CODES,
  convert,
  type CurrencyCode,
  divResidual,
  divRound,
  Money,
  Rate,
  type RoundingMode,
  sum,
} from '../src/index.js';

const ROUNDING_MODES: RoundingMode[] = [
  'DOWN',
  'UP',
  'FLOOR',
  'CEIL',
  'HALF_UP',
  'HALF_DOWN',
  'HALF_EVEN',
];

const anyCurrency = fc.constantFrom<CurrencyCode>(...CURRENCY_CODES);
const anyMode = fc.constantFrom<RoundingMode>(...ROUNDING_MODES);

/** Amounts spanning far past the float safe-integer range in both directions. */
const anyAmount = fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n });

const anyMoney = fc.tuple(anyAmount, anyCurrency).map(([amount, code]) => Money.of(amount, code));

const sameCurrencyPair = anyCurrency.chain((code) =>
  fc.tuple(
    anyAmount.map((a) => Money.of(a, code)),
    anyAmount.map((a) => Money.of(a, code)),
  ),
);

describe('property: allocation conserves value', () => {
  it('parts always sum to exactly the original amount', () => {
    fc.assert(
      fc.property(
        anyMoney,
        fc.array(fc.bigInt({ min: 0n, max: 10_000n }), { minLength: 1, maxLength: 25 }),
        (money, weights) => {
          fc.pre(weights.reduce((a, b) => a + b, 0n) > 0n);
          const parts = money.allocate(weights);
          expect(sum(parts).equals(money)).toBe(true);
          expect(parts).toHaveLength(weights.length);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('split into n parts always sums to exactly the original amount', () => {
    fc.assert(
      fc.property(anyMoney, fc.integer({ min: 1, max: 50 }), (money, parts) => {
        expect(sum(money.split(parts)).equals(money)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('no two parts of an equal split differ by more than one minor unit', () => {
    fc.assert(
      fc.property(anyMoney, fc.integer({ min: 1, max: 50 }), (money, parts) => {
        const amounts = money.split(parts).map((p) => p.amount);
        const max = amounts.reduce((a, b) => (a > b ? a : b));
        const min = amounts.reduce((a, b) => (a < b ? a : b));
        expect(max - min <= 1n).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe('property: arithmetic laws hold exactly', () => {
  it('addition is commutative', () => {
    fc.assert(
      fc.property(sameCurrencyPair, ([a, b]) => {
        expect(a.add(b).equals(b.add(a))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('addition is associative — the law floats violate', () => {
    fc.assert(
      fc.property(
        anyCurrency.chain((code) =>
          fc.tuple(
            anyAmount.map((x) => Money.of(x, code)),
            anyAmount.map((x) => Money.of(x, code)),
            anyAmount.map((x) => Money.of(x, code)),
          ),
        ),
        ([a, b, c]) => {
          expect(
            a
              .add(b)
              .add(c)
              .equals(a.add(b.add(c))),
          ).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('subtraction inverts addition', () => {
    fc.assert(
      fc.property(sameCurrencyPair, ([a, b]) => {
        expect(a.add(b).subtract(b).equals(a)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('decimal rendering round-trips without loss', () => {
    fc.assert(
      fc.property(anyMoney, (money) => {
        expect(Money.parse(money.toDecimalString(), money.currency).equals(money)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('JSON round-trips without loss', () => {
    fc.assert(
      fc.property(anyMoney, (money) => {
        expect(Money.fromJSON(money.toJSON()).equals(money)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe('property: rounding is exact and bounded', () => {
  it('the residual always reconstructs the original numerator', () => {
    fc.assert(
      fc.property(
        anyAmount,
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        anyMode,
        (numerator, denominator, mode) => {
          const { quotient, residual } = divResidual(numerator, denominator, mode);
          // This is what lets a rounding residual become a balancing ledger entry.
          expect(quotient * denominator + residual).toBe(numerator);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('never rounds by a whole unit or more', () => {
    fc.assert(
      fc.property(
        anyAmount,
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        anyMode,
        (numerator, denominator, mode) => {
          const { residual } = divResidual(numerator, denominator, mode);
          const magnitude = residual < 0n ? -residual : residual;
          expect(magnitude < denominator).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('FLOOR <= DOWN/HALF_* <= CEIL for every input', () => {
    fc.assert(
      fc.property(anyAmount, fc.bigInt({ min: 1n, max: 10n ** 12n }), (n, d) => {
        const floor = divRound(n, d, 'FLOOR');
        const ceil = divRound(n, d, 'CEIL');
        for (const mode of ROUNDING_MODES) {
          const value = divRound(n, d, mode);
          expect(value >= floor && value <= ceil).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe('property: conversion is auditable', () => {
  const anyRate = fc
    .tuple(fc.bigInt({ min: 1n, max: 10n ** 12n }), fc.bigInt({ min: 1n, max: 10n ** 6n }))
    .map(([numerator, denominator]) => ({ numerator, denominator }));

  it('a conversion plus its residual reproduces the exact input', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }),
        anyRate,
        anyMode,
        (amount, { numerator, denominator }, mode) => {
          const rate = Rate.of(numerator, denominator, 'EUR', 'NGN');
          const money = Money.of(amount, 'EUR');
          const result = convert(money, rate, mode);

          // converted * denominator + residual === the exact unrounded numerator
          const exactNumerator = amount * numerator * 10n ** 2n; // NGN has 2 decimals
          expect(result.converted.amount * result.residualDenominator + result.residual).toBe(
            exactNumerator,
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it('inverting a rate twice returns the original', () => {
    fc.assert(
      fc.property(anyRate, ({ numerator, denominator }) => {
        const rate = Rate.of(numerator, denominator, 'EUR', 'NGN');
        const round = rate.invert().invert();
        expect(round.numerator).toBe(rate.numerator);
        expect(round.denominator).toBe(rate.denominator);
        expect(round.from).toBe(rate.from);
      }),
      { numRuns: 500 },
    );
  });
});
