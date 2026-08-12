import { sum, type CurrencyCode, type Money } from '@arc/money';
import type { Direction } from './accounts.js';

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export class UnbalancedJournalError extends LedgerError {
  constructor(
    readonly currency: CurrencyCode,
    readonly debits: Money,
    readonly credits: Money,
  ) {
    super(
      `journal does not balance in ${currency}: ` +
        `debits ${debits.toDecimalString()} vs credits ${credits.toDecimalString()} ` +
        `(difference ${debits.subtract(credits).toDecimalString()})`,
    );
    this.name = 'UnbalancedJournalError';
  }
}

export type JournalKind = 'transfer' | 'fee' | 'fx' | 'reversal' | 'rounding' | 'settlement';

export interface EntryDraft {
  readonly account: string;
  readonly direction: Direction;
  /** Always positive. Direction carries the sign. */
  readonly amount: Money;
}

export interface JournalDraft {
  readonly kind: JournalKind;
  readonly referenceId: string;
  readonly description?: string;
  readonly entries: readonly EntryDraft[];
}

export function debit(account: string, amount: Money): EntryDraft {
  return { account, direction: 'debit', amount };
}

export function credit(account: string, amount: Money): EntryDraft {
  return { account, direction: 'credit', amount };
}

export interface CurrencyBalance {
  readonly currency: CurrencyCode;
  readonly debits: Money;
  readonly credits: Money;
  readonly difference: Money;
}

export function balanceByCurrency(entries: readonly EntryDraft[]): CurrencyBalance[] {
  const debits = new Map<CurrencyCode, Money[]>();
  const credits = new Map<CurrencyCode, Money[]>();

  for (const entry of entries) {
    const bucket = entry.direction === 'debit' ? debits : credits;
    const list = bucket.get(entry.amount.currency);
    if (list) list.push(entry.amount);
    else bucket.set(entry.amount.currency, [entry.amount]);
  }

  const currencies = new Set<CurrencyCode>([...debits.keys(), ...credits.keys()]);

  return [...currencies].sort().map((currency) => {
    const debitTotal = sum(debits.get(currency) ?? [], currency);
    const creditTotal = sum(credits.get(currency) ?? [], currency);
    return {
      currency,
      debits: debitTotal,
      credits: creditTotal,
      difference: debitTotal.subtract(creditTotal),
    };
  });
}

export function assertBalanced(entries: readonly EntryDraft[]): void {
  if (entries.length < 2) {
    throw new LedgerError('a journal needs at least two entries to balance');
  }

  for (const entry of entries) {
    if (entry.amount.isNegative) {
      throw new LedgerError(
        `entry amounts must be positive; direction carries the sign ` +
          `(${entry.account} has ${entry.amount.toDecimalString()})`,
      );
    }
    if (entry.amount.isZero) {
      throw new LedgerError(`zero-amount entry on ${entry.account} records nothing`);
    }
  }

  // Each currency must close on its own; halves are never offset against each other.
  for (const balance of balanceByCurrency(entries)) {
    if (!balance.difference.isZero) {
      throw new UnbalancedJournalError(balance.currency, balance.debits, balance.credits);
    }
  }
}

export function isBalanced(entries: readonly EntryDraft[]): boolean {
  try {
    assertBalanced(entries);
    return true;
  } catch {
    return false;
  }
}

export function reverseEntries(entries: readonly EntryDraft[]): EntryDraft[] {
  return entries.map((entry) => ({
    account: entry.account,
    direction: entry.direction === 'debit' ? 'credit' : 'debit',
    amount: entry.amount,
  }));
}
