import type { CurrencyCode } from '@arc/money';

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export type Direction = 'debit' | 'credit';

export const NORMAL_BALANCE: Record<AccountType, Direction> = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  revenue: 'credit',
};

export function normalBalanceOf(type: AccountType): Direction {
  return NORMAL_BALANCE[type];
}

export function entrySign(accountType: AccountType, direction: Direction): 1n | -1n {
  return direction === NORMAL_BALANCE[accountType] ? 1n : -1n;
}

export function oppositeOf(direction: Direction): Direction {
  return direction === 'debit' ? 'credit' : 'debit';
}

export const SYSTEM_ACCOUNTS = {
  bankFloat: (currency: CurrencyCode) => `asset.float.bank.${currency}`,
  chainFloat: (currency: CurrencyCode) => `asset.float.chain.${currency}`,
  customer: (virtualAccountId: string, currency: CurrencyCode) =>
    `liability.customer.${virtualAccountId}.${currency}`,
  inTransit: (currency: CurrencyCode) => `liability.in_transit.${currency}`,
  corridorFee: (currency: CurrencyCode) => `revenue.fee.corridor.${currency}`,
  fxSpread: (currency: CurrencyCode) => `revenue.fee.fx_spread.${currency}`,
  rounding: (currency: CurrencyCode) => `revenue.rounding.${currency}`,
  networkFee: (currency: CurrencyCode) => `expense.network_fee.${currency}`,
  fxPosition: (currency: CurrencyCode) => `equity.fx_position.${currency}`,
} as const;

export interface LedgerAccountInput {
  code: string;
  name: string;
  type: AccountType;
  currency: CurrencyCode;
  /** Non-positive. How far below zero the account may go, in minor units. */
  overdraftFloor?: bigint;
}
