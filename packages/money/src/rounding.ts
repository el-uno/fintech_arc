export type RoundingMode = 'DOWN' | 'UP' | 'FLOOR' | 'CEIL' | 'HALF_UP' | 'HALF_DOWN' | 'HALF_EVEN';

export class RoundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoundingError';
  }
}

export function divRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) {
    throw new RoundingError('division by zero');
  }

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
      if (mode === 'HALF_UP') return awayFromZero;
      if (mode === 'HALF_DOWN') return quotient;
      return quotient % 2n === 0n ? quotient : awayFromZero;
    }
  }
}

export function divResidual(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode,
): { quotient: bigint; residual: bigint } {
  const quotient = divRound(numerator, denominator, mode);
  return { quotient, residual: numerator - quotient * denominator };
}
