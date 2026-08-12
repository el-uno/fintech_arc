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

/** What a journal records — the business reason a set of entries exists. */
export type JournalKind = 'transfer' | 'fee' | 'fx' | 'reversal' | 'rounding' | 'settlement';

export interface EntryDraft {
  /** The account's stable code, e.g. `asset.float.bank.EUR`. */
  readonly account: string;
  readonly direction: Direction;
  /** Always positive. Direction carries the sign, not the amount. */
  readonly amount: Money;
}

export interface JournalDraft {
  readonly kind: JournalKind;
  /** The domain object this journal records — a transfer id, a payout id. */
  readonly referenceId: string;
  readonly description?: string;
  readonly entries: readonly EntryDraft[];
}

/** Readable constructors, so a journal reads like the accounting it represents. */
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

/**
 * Total debits and credits per currency.
 *
 * Balance is checked **per currency, independently**. A journal that converts EUR
 * to USDC has two halves, and each must close on its own — you cannot offset a
 * EUR debit against a USDC credit, because they are not the same quantity of
 * anything. The FX position accounts are what close each half.
 */
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

/**
 * The central invariant: in every currency it touches, a journal's debits equal
 * its credits exactly.
 *
 * Exactly — not within a tolerance. This is why money is an integer count of
 * minor units: with floats, an epsilon would be unavoidable here, and a ledger
 * with an epsilon is not a ledger.
 */
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

/**
 * Reverse a set of entries by flipping every direction.
 *
 * This is how Arc undoes anything. A reversal is a *new, opposite journal*, never
 * a deletion or an edit — the original stays in the record, and the correction
 * sits beside it. If a balanced journal is reversed, the reversal is balanced too,
 * which is what makes unwinding a failed transfer safe by construction.
 */
export function reverseEntries(entries: readonly EntryDraft[]): EntryDraft[] {
  return entries.map((entry) => ({
    account: entry.account,
    direction: entry.direction === 'debit' ? 'credit' : 'debit',
    amount: entry.amount,
  }));
}
