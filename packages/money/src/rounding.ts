/**
 * Exact integer division with an explicit rounding policy.
 *
 * Every place in Arc where precision could be lost routes through `divRound`.
 * There is no default mode: the caller must state what it wants, because
 * "which way did we round?" is a question the ledger has to be able to answer.
 */

export type RoundingMode =
  /** Toward zero. Truncation. */
  | 'DOWN'
  /** Away from zero. */
  | 'UP'
  /** Toward negative infinity. */
  | 'FLOOR'
  /** Toward positive infinity. */
  | 'CEIL'
  /** Nearest; ties away from zero. The intuitive "school" rounding. */
  | 'HALF_UP'
  /** Nearest; ties toward zero. */
  | 'HALF_DOWN'
  /** Nearest; ties to the even neighbour. Banker's rounding — unbiased over many operations. */
  | 'HALF_EVEN';

export class RoundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoundingError';
  }
}

/**
 * Divide `numerator` by `denominator`, rounding per `mode`.
 *
 * Pure bigint arithmetic — exact at any magnitude, with no intermediate float.
 */
export function divRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) {
    throw new RoundingError('division by zero');
  }

  // Normalise so the denominator is positive; the sign rides on the numerator.
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }

  const quotient = n / d; // bigint division truncates toward zero
  const remainder = n % d; // sign follows n

  if (remainder === 0n) {
    return quotient;
  }

  const negative = remainder < 0n;
  const awayFromZero = negative ? quotient - 1n : quotient + 1n;

  switch (mode) {
    case 'DOWN':
      return quotient;
    case 'UP':
      return awayFromZero;
    case 'FLOOR':
      return negative ? quotient - 1n : quotient;
    case 'CEIL':
      return negative ? quotient : quotient + 1n;
    case 'HALF_UP':
    case 'HALF_DOWN':
    case 'HALF_EVEN': {
      const twiceRemainder = remainder < 0n ? -remainder * 2n : remainder * 2n;
      if (twiceRemainder > d) return awayFromZero;
      if (twiceRemainder < d) return quotient;
      // Exact tie.
      if (mode === 'HALF_UP') return awayFromZero;
      if (mode === 'HALF_DOWN') return quotient;
      return quotient % 2n === 0n ? quotient : awayFromZero;
    }
  }
}

/**
 * The exact residual left behind by a rounded division:
 * `numerator - (result * denominator)`, scaled back into the numerator's units.
 *
 * Arc never discards this. A rounding residual becomes its own ledger entry
 * against a rounding account, so that the journal still sums to zero and the
 * fraction of a unit is auditable rather than evaporated.
 */
export function divResidual(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode,
): { quotient: bigint; residual: bigint } {
  const quotient = divRound(numerator, denominator, mode);
  return { quotient, residual: numerator - quotient * denominator };
}
