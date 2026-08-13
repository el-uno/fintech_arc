export const CURRENCIES = {
  EUR: { code: 'EUR', decimals: 2, kind: 'fiat', name: 'Euro' },
  GBP: { code: 'GBP', decimals: 2, kind: 'fiat', name: 'Pound Sterling' },
  USD: { code: 'USD', decimals: 2, kind: 'fiat', name: 'US Dollar' },
  NGN: { code: 'NGN', decimals: 2, kind: 'fiat', name: 'Nigerian Naira' },
  KES: { code: 'KES', decimals: 2, kind: 'fiat', name: 'Kenyan Shilling' },
  GHS: { code: 'GHS', decimals: 2, kind: 'fiat', name: 'Ghanaian Cedi' },
  ZAR: { code: 'ZAR', decimals: 2, kind: 'fiat', name: 'South African Rand' },
  USDC: { code: 'USDC', decimals: 6, kind: 'crypto', name: 'USD Coin' },
  USDT: { code: 'USDT', decimals: 6, kind: 'crypto', name: 'Tether USD' },
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

export function scaleOf(code: CurrencyCode): bigint {
  return 10n ** BigInt(CURRENCIES[code].decimals);
}
