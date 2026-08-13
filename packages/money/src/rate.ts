import { type CurrencyCode, scaleOf } from './currency.js';
import { Money, MoneyError } from './money.js';
import { divResidual, divRound, type RoundingMode } from './rounding.js';

export class Rate {
  private constructor(
    readonly numerator: bigint,
    readonly denominator: bigint,
    readonly from: CurrencyCode,
    readonly to: CurrencyCode,
  ) {
    Object.freeze(this);
  }

  static of(numerator: bigint, denominator: bigint, from: CurrencyCode, to: CurrencyCode): Rate {
    if (denominator === 0n) throw new MoneyError('rate denominator must not be zero');
    if (numerator <= 0n || denominator < 0n) throw new MoneyError('rate must be positive');
    return new Rate(numerator, denominator, from, to);
  }

  static parse(decimal: string, from: CurrencyCode, to: CurrencyCode): Rate {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
    if (!match) throw new MoneyError(`not a valid rate: ${JSON.stringify(decimal)}`);
    const [, whole, fraction = ''] = match;
    return Rate.of(BigInt(`${whole}${fraction}`), 10n ** BigInt(fraction.length), from, to);
  }

  invert(): Rate {
    return new Rate(this.denominator, this.numerator, this.to, this.from);
  }

  toString(): string {
    return `${this.from}/${this.to} ${this.numerator}/${this.denominator}`;
  }

  toJSON(): { numerator: string; denominator: string; from: CurrencyCode; to: CurrencyCode } {
    return {
      numerator: this.numerator.toString(),
      denominator: this.denominator.toString(),
      from: this.from,
      to: this.to,
    };
  }
}

export interface ConversionResult {
  readonly converted: Money;
  readonly rate: Rate;
  readonly residual: bigint;
  readonly residualDenominator: bigint;
}

export function convert(money: Money, rate: Rate, mode: RoundingMode): ConversionResult {
  if (money.currency !== rate.from) {
    throw new MoneyError(`rate converts ${rate.from}, not ${money.currency}`);
  }

  const numerator = money.amount * rate.numerator * scaleOf(rate.to);
  const denominator = rate.denominator * scaleOf(rate.from);

  const { quotient, residual } = divResidual(numerator, denominator, mode);

  return {
    converted: Money.of(quotient, rate.to),
    rate,
    residual,
    residualDenominator: denominator,
  };
}

export function convertAmount(money: Money, rate: Rate, mode: RoundingMode): Money {
  return convert(money, rate, mode).converted;
}

export function applySpread(rate: Rate, basisPoints: bigint, mode: RoundingMode): Rate {
  if (basisPoints < 0n) throw new MoneyError('spread must be non-negative');
  const adjusted = divRound(rate.numerator * (10_000n - basisPoints), 10_000n, mode);
  return Rate.of(adjusted, rate.denominator, rate.from, rate.to);
}
