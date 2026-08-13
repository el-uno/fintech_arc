import { type CurrencyCode, currency, scaleOf } from './currency.js';
import { divRound, type RoundingMode } from './rounding.js';

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export class CurrencyMismatchError extends MoneyError {
  constructor(left: CurrencyCode, right: CurrencyCode) {
    super(`cannot combine ${left} with ${right}`);
    this.name = 'CurrencyMismatchError';
  }
}

export class Money {
  private constructor(
    readonly amount: bigint,
    readonly currency: CurrencyCode,
  ) {
    Object.freeze(this);
  }

  static of(amount: bigint, code: CurrencyCode): Money {
    if (typeof amount !== 'bigint') {
      throw new MoneyError('amount must be a bigint of minor units');
    }
    return new Money(amount, code);
  }

  static zero(code: CurrencyCode): Money {
    return new Money(0n, code);
  }

  static parse(decimal: string, code: CurrencyCode): Money {
    const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
    if (!match) {
      throw new MoneyError(`not a valid decimal amount: ${JSON.stringify(decimal)}`);
    }
    const [, sign, whole, fraction = ''] = match;
    const decimals = currency(code).decimals;

    if (fraction.length > decimals) {
      throw new MoneyError(
        `${decimal} has ${fraction.length} decimal places but ${code} has ${decimals}; ` +
          `round explicitly before parsing`,
      );
    }

    const padded = fraction.padEnd(decimals, '0');
    const magnitude = BigInt(`${whole}${padded}`);
    return new Money(sign === '-' ? -magnitude : magnitude, code);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount + other.amount, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount - other.amount, this.currency);
  }

  negate(): Money {
    return new Money(-this.amount, this.currency);
  }

  abs(): Money {
    return this.amount < 0n ? this.negate() : this;
  }

  multiply(factor: bigint): Money {
    return new Money(this.amount * factor, this.currency);
  }

  applyBps(basisPoints: bigint, mode: RoundingMode): Money {
    return new Money(divRound(this.amount * basisPoints, 10_000n, mode), this.currency);
  }

  allocate(weights: readonly bigint[]): Money[] {
    if (weights.length === 0) {
      throw new MoneyError('allocate requires at least one weight');
    }
    if (weights.some((w) => w < 0n)) {
      throw new MoneyError('allocate weights must be non-negative');
    }
    const total = weights.reduce((a, b) => a + b, 0n);
    if (total === 0n) {
      throw new MoneyError('allocate weights must not sum to zero');
    }

    const shares = weights.map((w) => (this.amount * w) / total); // truncates toward zero
    let remainder = this.amount - shares.reduce((a, b) => a + b, 0n);

    const step = remainder >= 0n ? 1n : -1n;
    for (let i = 0; remainder !== 0n; i = (i + 1) % shares.length) {
      shares[i] = shares[i]! + step;
      remainder -= step;
    }

    return shares.map((s) => new Money(s, this.currency));
  }

  split(parts: number): Money[] {
    if (!Number.isInteger(parts) || parts < 1) {
      throw new MoneyError('split requires a positive integer part count');
    }
    return this.allocate(Array.from({ length: parts }, () => 1n));
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.amount < other.amount) return -1;
    if (this.amount > other.amount) return 1;
    return 0;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount === other.amount;
  }

  greaterThan(other: Money): boolean {
    return this.compare(other) === 1;
  }

  greaterThanOrEqual(other: Money): boolean {
    return this.compare(other) >= 0;
  }

  lessThan(other: Money): boolean {
    return this.compare(other) === -1;
  }

  lessThanOrEqual(other: Money): boolean {
    return this.compare(other) <= 0;
  }

  get isZero(): boolean {
    return this.amount === 0n;
  }

  get isPositive(): boolean {
    return this.amount > 0n;
  }

  get isNegative(): boolean {
    return this.amount < 0n;
  }

  toDecimalString(): string {
    const decimals = currency(this.currency).decimals;
    const negative = this.amount < 0n;
    const digits = (negative ? -this.amount : this.amount).toString().padStart(decimals + 1, '0');
    const whole = digits.slice(0, digits.length - decimals);
    const fraction = decimals === 0 ? '' : `.${digits.slice(digits.length - decimals)}`;
    return `${negative ? '-' : ''}${whole}${fraction}`;
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.currency}`;
  }

  toJSON(): { amount: string; currency: CurrencyCode; decimals: number } {
    return {
      amount: this.amount.toString(),
      currency: this.currency,
      decimals: currency(this.currency).decimals,
    };
  }

  static fromJSON(value: { amount: string; currency: CurrencyCode }): Money {
    return new Money(BigInt(value.amount), value.currency);
  }

  get scale(): bigint {
    return scaleOf(this.currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

export function sum(amounts: readonly Money[], code?: CurrencyCode): Money {
  if (amounts.length === 0) {
    if (!code) throw new MoneyError('cannot sum an empty list without a currency');
    return Money.zero(code);
  }
  return amounts.reduce((a, b) => a.add(b));
}
