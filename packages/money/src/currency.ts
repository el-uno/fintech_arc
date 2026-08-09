/**
 * Currency registry.
 *
 * `decimals` is the number of minor units per major unit, expressed as a power
 * of ten. A EUR amount is stored as an integer count of cents (decimals = 2);
 * a USDC amount as an integer count of its 6-decimal base unit.
 *
 * This is the only place the scale of a currency is defined. Nothing else in
 * the codebase may hardcode `100`.
 */

export const CURRENCIES = {
  // Fiat — EU / UK
  EUR: { code: 'EUR', decimals: 2, kind: 'fiat', name: 'Euro' },
  GBP: { code: 'GBP', decimals: 2, kind: 'fiat', name: 'Pound Sterling' },
  USD: { code: 'USD', decimals: 2, kind: 'fiat', name: 'US Dollar' },

  // Fiat — Africa corridor
  NGN: { code: 'NGN', decimals: 2, kind: 'fiat', name: 'Nigerian Naira' },
  KES: { code: 'KES', decimals: 2, kind: 'fiat', name: 'Kenyan Shilling' },
  GHS: { code: 'GHS', decimals: 2, kind: 'fiat', name: 'Ghanaian Cedi' },
  ZAR: { code: 'ZAR', decimals: 2, kind: 'fiat', name: 'South African Rand' },

  // Stablecoins — settlement assets
  USDC: { code: 'USDC', decimals: 6, kind: 'crypto', name: 'USD Coin' },
  USDT: { code: 'USDT', decimals: 6, kind: 'crypto', name: 'Tether USD' },

  // Native assets — held only to pay network fees
  ETH: { code: 'ETH', decimals: 18, kind: 'crypto', name: 'Ether' },
  MATIC: { code: 'MATIC', decimals: 18, kind: 'crypto', name: 'Polygon' },
  SOL: { code: 'SOL', decimals: 9, kind: 'crypto', name: 'Solana' },
  TRX: { code: 'TRX', decimals: 6, kind: 'crypto', name: 'Tron' },
} as const satisfies Record<string, CurrencyDefinition>;

export interface CurrencyDefinition {
  readonly code: string;
  readonly decimals: number;
  readonly kind: 'fiat' | 'crypto';
  readonly name: string;
}

export type CurrencyCode = keyof typeof CURRENCIES;

export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, value);
}

export function currency(code: CurrencyCode): CurrencyDefinition {
  return CURRENCIES[code];
}

export function decimalsOf(code: CurrencyCode): number {
  return CURRENCIES[code].decimals;
}

/** 10 ** decimals, as a bigint. The scale factor between major and minor units. */
export function scaleOf(code: CurrencyCode): bigint {
  return 10n ** BigInt(CURRENCIES[code].decimals);
}
