import { type CurrencyCode, scaleOf } from './currency.js';
import { Money, MoneyError } from './money.js';
import { divResidual, divRound, type RoundingMode } from './rounding.js';

/**
 * An FX rate held as an exact rational, not a decimal approximation.
 *
 * A rate of 1650.25 NGN per EUR is `165025 / 100` — stored exactly, so that a
 * conversion and its inverse are mathematically well-defined rather than
 * "close enough". Rates arrive from providers as decimal strings and are parsed
 * without loss.
 */
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

  /** Parse a provider rate such as `'1650.25'` — exact, no float involved. */
  static parse(decimal: string, from: CurrencyCode, to: CurrencyCode): Rate {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
    if (!match) throw new MoneyError(`not a valid rate: ${JSON.stringify(decimal)}`);
    const [, whole, fraction = ''] = match;
    return Rate.of(BigInt(`${whole}${fraction}`), 10n ** BigInt(fraction.length), from, to);
  }

  /** The reciprocal rate, exact by construction. */
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
  /** The converted amount, in the target currency's minor units. */
  readonly converted: Money;
  /** The rate applied. Retained so a conversion can be re-derived and audited. */
  readonly rate: Rate;
  /**
   * The exact fraction of a minor unit lost or gained to rounding, expressed as
   * a numerator over `residualDenominator`. Arc posts this to a rounding account
   * so the journal still balances.
   */
  readonly residual: bigint;
  readonly residualDenominator: bigint;
}

/**
 * Convert between currencies with an explicit rounding policy.
 *
 * Both operands are counts of minor units at different scales, so the
 * conversion carries a scale correction:
 *
 *   result = amount × (numerator / denominator) × 10^(toDecimals − fromDecimals)
 *
 * evaluated as a single exact integer division so there is no intermediate
 * rounding step to accumulate error.
 */
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

/** Convenience wrapper when the residual is being handled elsewhere. */
export function convertAmount(money: Money, rate: Rate, mode: RoundingMode): Money {
  return convert(money, rate, mode).converted;
}

/**
 * Apply a spread to a mid-market rate, in basis points, always in the direction
 * that favours Arc. The spread is the revenue line on a corridor transfer, so it
 * is applied explicitly and never folded silently into the quoted rate.
 */
export function applySpread(rate: Rate, basisPoints: bigint, mode: RoundingMode): Rate {
  if (basisPoints < 0n) throw new MoneyError('spread must be non-negative');
  // Customer receives less of the target currency: scale the numerator down.
  const adjusted = divRound(rate.numerator * (10_000n - basisPoints), 10_000n, mode);
  return Rate.of(adjusted, rate.denominator, rate.from, rate.to);
}
