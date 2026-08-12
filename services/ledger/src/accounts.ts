import type { CurrencyCode } from '@arc/money';

/**
 * The chart of accounts.
 *
 * The orientation that matters in a payments business: **a customer's balance is
 * a liability, not an asset**. When someone funds a virtual account, Arc gains an
 * asset (float sitting at a bank or on-chain) and simultaneously owes that person
 * the same amount. Those two facts are the two sides of one journal, and keeping
 * them paired is what makes "do we actually hold what we owe?" an answerable
 * question rather than a hope.
 */

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export type Direction = 'debit' | 'credit';

/**
 * The side on which each account type increases.
 *
 * Debits increase assets and expenses; credits increase liabilities, equity and
 * revenue. This single table is what turns a raw entry into a signed effect on a
 * balance, and it is the only place that mapping is written down.
 */
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

/**
 * The signed effect of an entry on its account's balance.
 *
 * `+1` when the entry moves the account in its natural direction, `-1` against.
 * A debit of €10 raises a bank-float asset by €10 and lowers a customer liability
 * by €10 — same entry, opposite sense, because the account types differ.
 */
export function entrySign(accountType: AccountType, direction: Direction): 1n | -1n {
  return direction === NORMAL_BALANCE[accountType] ? 1n : -1n;
}

export function oppositeOf(direction: Direction): Direction {
  return direction === 'debit' ? 'credit' : 'debit';
}

/**
 * Well-known system accounts.
 *
 * Customer accounts are created per virtual account in Phase 2 and are not listed
 * here; these are the platform-owned accounts every corridor transfer touches.
 */
export const SYSTEM_ACCOUNTS = {
  /** Fiat float held at a partner bank, one per currency. */
  bankFloat: (currency: CurrencyCode) => `asset.float.bank.${currency}`,
  /** Stablecoin or native asset held in a platform wallet, one per asset. */
  chainFloat: (currency: CurrencyCode) => `asset.float.chain.${currency}`,
  /** What Arc owes a customer, one per customer virtual account. */
  customer: (virtualAccountId: string, currency: CurrencyCode) =>
    `liability.customer.${virtualAccountId}.${currency}`,
  /** Funds committed to an in-flight transfer but not yet paid out. */
  inTransit: (currency: CurrencyCode) => `liability.in_transit.${currency}`,
  /** Corridor fee revenue. */
  corridorFee: (currency: CurrencyCode) => `revenue.fee.corridor.${currency}`,
  /** FX spread revenue — the margin between mid-market and the quoted rate. */
  fxSpread: (currency: CurrencyCode) => `revenue.fee.fx_spread.${currency}`,
  /**
   * Where sub-minor-unit rounding residuals land.
   *
   * Every rounded conversion produces a fraction of a minor unit that cannot be
   * represented. Arc posts it here rather than discarding it, so the journal
   * still sums to zero and the drift is a number someone can look at.
   */
  rounding: (currency: CurrencyCode) => `revenue.rounding.${currency}`,
  /** Network fees paid to a chain. */
  networkFee: (currency: CurrencyCode) => `expense.network_fee.${currency}`,
  /**
   * The bridge between the two currency halves of an FX journal.
   *
   * Each currency in a journal must balance on its own, so a conversion cannot be
   * a single two-legged entry. The EUR side closes against FX position in EUR and
   * the USDC side against FX position in USDC; the pair of position accounts is
   * where an unhedged exposure becomes visible.
   */
  fxPosition: (currency: CurrencyCode) => `equity.fx_position.${currency}`,
} as const;

export interface LedgerAccountInput {
  code: string;
  name: string;
  type: AccountType;
  currency: CurrencyCode;
  /**
   * How far below zero this account may go, in minor units, as a non-positive
   * number. Customer accounts are `0` — they cannot be overdrawn. Platform float
   * accounts may be allowed a floor to model intraday credit lines.
   */
  overdraftFloor?: bigint;
}
