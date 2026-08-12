import { Money, type CurrencyCode } from '@arc/money';
import { entrySign, type AccountType, type Direction } from './accounts.js';

export interface PostedEntry {
  readonly accountCode: string;
  readonly accountType: AccountType;
  readonly direction: Direction;
  readonly amount: Money;
}

export interface Hold {
  readonly accountCode: string;
  readonly amount: Money;
  readonly status: 'active' | 'released' | 'captured';
}

export interface AccountBalance {
  readonly accountCode: string;
  readonly currency: CurrencyCode;
  readonly posted: Money;
  readonly reserved: Money;
  readonly available: Money;
}

export function projectPosted(
  accountCode: string,
  accountType: AccountType,
  currency: CurrencyCode,
  entries: readonly PostedEntry[],
): Money {
  let total = 0n;
  for (const entry of entries) {
    if (entry.accountCode !== accountCode) continue;
    if (entry.amount.currency !== currency) {
      throw new Error(
        `entry currency ${entry.amount.currency} does not match account currency ${currency}`,
      );
    }
    total += entrySign(accountType, entry.direction) * entry.amount.amount;
  }
  return Money.of(total, currency);
}

export function projectBalance(
  accountCode: string,
  accountType: AccountType,
  currency: CurrencyCode,
  entries: readonly PostedEntry[],
  holds: readonly Hold[] = [],
): AccountBalance {
  const posted = projectPosted(accountCode, accountType, currency, entries);

  let reservedMinor = 0n;
  for (const hold of holds) {
    if (hold.accountCode !== accountCode) continue;
    if (hold.status !== 'active') continue;
    reservedMinor += hold.amount.amount;
  }
  const reserved = Money.of(reservedMinor, currency);

  return {
    accountCode,
    currency,
    posted,
    reserved,
    available: posted.subtract(reserved),
  };
}

export function trialBalance(
  entries: readonly PostedEntry[],
): Map<CurrencyCode, { debits: Money; credits: Money; difference: Money }> {
  const totals = new Map<CurrencyCode, { debits: bigint; credits: bigint }>();

  for (const entry of entries) {
    const currency = entry.amount.currency;
    const running = totals.get(currency) ?? { debits: 0n, credits: 0n };
    if (entry.direction === 'debit') running.debits += entry.amount.amount;
    else running.credits += entry.amount.amount;
    totals.set(currency, running);
  }

  const result = new Map<CurrencyCode, { debits: Money; credits: Money; difference: Money }>();
  for (const [currency, { debits, credits }] of totals) {
    result.set(currency, {
      debits: Money.of(debits, currency),
      credits: Money.of(credits, currency),
      difference: Money.of(debits - credits, currency),
    });
  }
  return result;
}
