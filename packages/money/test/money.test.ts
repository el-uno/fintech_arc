import { describe, expect, it } from 'vitest';
import { CurrencyMismatchError, Money, MoneyError, sum } from '../src/index.js';

describe('Money construction', () => {
  it('stores minor units, not major', () => {
    expect(Money.parse('100.00', 'EUR').amount).toBe(10_000n);
    expect(Money.parse('1.00', 'USDC').amount).toBe(1_000_000n);
  });

  it('round-trips exact decimal strings', () => {
    for (const value of ['0.00', '0.01', '1234.05', '-1234.05', '-0.01']) {
      expect(Money.parse(value, 'EUR').toDecimalString()).toBe(value);
    }
  });

  it('handles 18-decimal assets beyond the float safe-integer range', () => {
    // 1 ETH = 1e18 wei, which is ~111x larger than Number.MAX_SAFE_INTEGER.
    const oneEth = Money.parse('1.000000000000000000', 'ETH');
    expect(oneEth.amount).toBe(1_000_000_000_000_000_000n);
    expect(oneEth.amount > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(oneEth.toDecimalString()).toBe('1.000000000000000000');
  });

  it('rejects excess precision rather than rounding silently', () => {
    expect(() => Money.parse('1.005', 'EUR')).toThrow(MoneyError);
  });

  it('rejects malformed input', () => {
    for (const value of ['', 'abc', '1.2.3', '1,00', 'NaN', 'Infinity', '1e3']) {
      expect(() => Money.parse(value, 'EUR')).toThrow(MoneyError);
    }
  });

  it('refuses a number amount at runtime', () => {
    // @ts-expect-error - the type system already forbids this; belt and braces.
    expect(() => Money.of(100, 'EUR')).toThrow(MoneyError);
  });
});

describe('the float failures this class exists to prevent', () => {
  it('adds 0.10 + 0.20 to exactly 0.30', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // the problem
    const exact = Money.parse('0.10', 'EUR').add(Money.parse('0.20', 'EUR'));
    expect(exact.toDecimalString()).toBe('0.30'); // the fix
  });

  it('multiplies 1.10 by 3 to exactly 3.30', () => {
    expect(1.1 * 3).not.toBe(3.3);
    expect(Money.parse('1.10', 'EUR').multiply(3n).toDecimalString()).toBe('3.30');
  });

  it('keeps a long chain of additions exact', () => {
    let float = 0;
    let money = Money.zero('EUR');
    const tenCents = Money.parse('0.10', 'EUR');
    for (let i = 0; i < 1000; i++) {
      float += 0.1;
      money = money.add(tenCents);
    }
    expect(float).not.toBe(100); // drifted
    expect(money.toDecimalString()).toBe('100.00'); // did not
  });
});

describe('arithmetic', () => {
  it('adds and subtracts', () => {
    const a = Money.parse('100.00', 'EUR');
    const b = Money.parse('30.50', 'EUR');
    expect(a.add(b).toDecimalString()).toBe('130.50');
    expect(a.subtract(b).toDecimalString()).toBe('69.50');
    expect(b.subtract(a).toDecimalString()).toBe('-69.50');
  });

  it('refuses to mix currencies', () => {
    const eur = Money.parse('100.00', 'EUR');
    const ngn = Money.parse('100.00', 'NGN');
    expect(() => eur.add(ngn)).toThrow(CurrencyMismatchError);
    expect(() => eur.compare(ngn)).toThrow(CurrencyMismatchError);
    expect(eur.equals(ngn)).toBe(false);
  });

  it('applies basis-point fees', () => {
    const amount = Money.parse('100.00', 'EUR');
    expect(amount.applyBps(150n, 'HALF_EVEN').toDecimalString()).toBe('1.50'); // 1.5%
    expect(amount.applyBps(35n, 'HALF_EVEN').toDecimalString()).toBe('0.35');
    expect(amount.applyBps(0n, 'HALF_EVEN').isZero).toBe(true);
  });

  it('is immutable', () => {
    const a = Money.parse('100.00', 'EUR');
    a.add(Money.parse('1.00', 'EUR'));
    expect(a.toDecimalString()).toBe('100.00');
    expect(Object.isFrozen(a)).toBe(true);
  });
});

describe('allocation', () => {
  it('splits without losing a minor unit', () => {
    // The classic case: 0.05 into 3 parts cannot divide evenly.
    const parts = Money.parse('0.05', 'EUR').split(3);
    expect(parts.map((p) => p.toDecimalString())).toEqual(['0.02', '0.02', '0.01']);
    expect(sum(parts).toDecimalString()).toBe('0.05');
  });

  it('allocates by weight, remainder to the earliest weights', () => {
    // A €100.00 transfer split into corridor fee / network fee / net payout.
    const parts = Money.parse('100.00', 'EUR').allocate([1n, 1n, 98n]);
    expect(parts.map((p) => p.toDecimalString())).toEqual(['1.00', '1.00', '98.00']);
    expect(sum(parts).toDecimalString()).toBe('100.00');
  });

  it('handles indivisible weights exactly', () => {
    const parts = Money.parse('100.00', 'EUR').allocate([1n, 1n, 1n]);
    expect(parts.map((p) => p.toDecimalString())).toEqual(['33.34', '33.33', '33.33']);
    expect(sum(parts).toDecimalString()).toBe('100.00');
  });

  it('allocates negative amounts back to exactly the whole', () => {
    const parts = Money.parse('-0.05', 'EUR').split(3);
    expect(sum(parts).toDecimalString()).toBe('-0.05');
  });

  it('tolerates zero weights', () => {
    const parts = Money.parse('10.00', 'EUR').allocate([0n, 1n]);
    expect(parts.map((p) => p.toDecimalString())).toEqual(['0.00', '10.00']);
  });

  it('rejects degenerate weights', () => {
    const amount = Money.parse('10.00', 'EUR');
    expect(() => amount.allocate([])).toThrow(MoneyError);
    expect(() => amount.allocate([0n, 0n])).toThrow(MoneyError);
    expect(() => amount.allocate([-1n, 2n])).toThrow(MoneyError);
  });
});

describe('serialisation', () => {
  it('never emits a JSON number', () => {
    const json = Money.parse('100.00', 'EUR').toJSON();
    expect(json).toEqual({ amount: '10000', currency: 'EUR', decimals: 2 });
    expect(typeof json.amount).toBe('string');
    expect(JSON.stringify(json)).not.toContain('10000,'); // not a bare numeric literal
  });

  it('round-trips through JSON at 18 decimals', () => {
    const original = Money.parse('123.456789012345678', 'ETH');
    expect(Money.fromJSON(original.toJSON()).equals(original)).toBe(true);
  });
});
