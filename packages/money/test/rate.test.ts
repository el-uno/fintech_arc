import { describe, expect, it } from 'vitest';
import { applySpread, convert, convertAmount, Money, MoneyError, Rate } from '../src/index.js';

describe('Rate', () => {
  it('parses a provider rate exactly', () => {
    const rate = Rate.parse('1650.25', 'EUR', 'NGN');
    expect(rate.numerator).toBe(165_025n);
    expect(rate.denominator).toBe(100n);
  });

  it('rejects malformed and non-positive rates', () => {
    expect(() => Rate.parse('abc', 'EUR', 'NGN')).toThrow(MoneyError);
    expect(() => Rate.parse('-1.5', 'EUR', 'NGN')).toThrow(MoneyError);
    expect(() => Rate.of(1n, 0n, 'EUR', 'NGN')).toThrow(MoneyError);
    expect(() => Rate.of(0n, 1n, 'EUR', 'NGN')).toThrow(MoneyError);
  });
});

describe('conversion across the corridor', () => {
  it('converts EUR to NGN at the same scale', () => {
    const result = convert(
      Money.parse('100.00', 'EUR'),
      Rate.parse('1650.25', 'EUR', 'NGN'),
      'HALF_EVEN',
    );
    expect(result.converted.toDecimalString()).toBe('165025.00');
    expect(result.residual).toBe(0n);
  });

  it('converts EUR (2dp) to USDC (6dp), correcting for scale', () => {
    const result = convert(
      Money.parse('100.00', 'EUR'),
      Rate.parse('1.08', 'EUR', 'USDC'),
      'HALF_EVEN',
    );
    expect(result.converted.toDecimalString()).toBe('108.000000');
    expect(result.converted.amount).toBe(108_000_000n);
  });

  it('converts USDC (6dp) down to KES (2dp)', () => {
    const result = convert(
      Money.parse('100.000000', 'USDC'),
      Rate.parse('129.45', 'USDC', 'KES'),
      'HALF_EVEN',
    );
    expect(result.converted.toDecimalString()).toBe('12945.00');
  });

  it('reports the exact residual when a conversion cannot land on a whole minor unit', () => {
    // 1 cent at a rate that does not divide evenly.
    const result = convert(
      Money.parse('0.01', 'EUR'),
      Rate.parse('1650.257', 'EUR', 'NGN'),
      'DOWN',
    );
    expect(result.residual).not.toBe(0n);
    // The residual reconstructs the exact pre-rounding value.
    expect(result.converted.amount * result.residualDenominator + result.residual).toBe(
      1n * 1_650_257n * 100n,
    );
  });

  it('refuses a rate for the wrong currency', () => {
    expect(() =>
      convertAmount(Money.parse('100.00', 'GBP'), Rate.parse('1650.25', 'EUR', 'NGN'), 'HALF_EVEN'),
    ).toThrow(MoneyError);
  });

  it('models the full corridor: EUR -> USDC -> KES', () => {
    const sent = Money.parse('1000.00', 'EUR');
    const usdc = convertAmount(sent, Rate.parse('1.08', 'EUR', 'USDC'), 'HALF_EVEN');
    const received = convertAmount(usdc, Rate.parse('129.45', 'USDC', 'KES'), 'HALF_EVEN');

    expect(usdc.toDecimalString()).toBe('1080.000000');
    expect(received.toDecimalString()).toBe('139806.00');
  });
});

describe('spread', () => {
  it('moves the rate against the customer by the stated basis points', () => {
    const mid = Rate.parse('1650.00', 'EUR', 'NGN');
    const quoted = applySpread(mid, 50n, 'HALF_EVEN'); // 50bp = 0.5%

    const atMid = convertAmount(Money.parse('100.00', 'EUR'), mid, 'HALF_EVEN');
    const atQuoted = convertAmount(Money.parse('100.00', 'EUR'), quoted, 'HALF_EVEN');

    expect(atQuoted.lessThan(atMid)).toBe(true);
    expect(atMid.subtract(atQuoted).toDecimalString()).toBe('825.00'); // 0.5% of 165,000
  });

  it('a zero spread is a no-op', () => {
    const mid = Rate.parse('1650.00', 'EUR', 'NGN');
    expect(applySpread(mid, 0n, 'HALF_EVEN').numerator).toBe(mid.numerator);
  });

  it('rejects a negative spread', () => {
    expect(() => applySpread(Rate.parse('1650.00', 'EUR', 'NGN'), -1n, 'HALF_EVEN')).toThrow(
      MoneyError,
    );
  });
});
