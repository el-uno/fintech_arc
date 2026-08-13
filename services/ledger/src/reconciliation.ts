import { sum, type CurrencyCode, type Money } from '@arc/money';
import type { PostedEntry } from './balances.js';
import { LedgerError } from './journal.js';

export type Source = 'bank' | 'chain';

export type BreakKind =
  | 'missing_external'
  | 'missing_internal'
  | 'amount_mismatch'
  | 'duplicate_external'
  | 'currency_mismatch';

export type BreakSeverity = 'low' | 'medium' | 'high';

/** A record as the outside world reports it. */
export interface ExternalRecord {
  readonly source: Source;
  readonly externalId: string;
  /** The ledger reference this should match — a transfer or payout id. */
  readonly reference: string;
  readonly amount: Money;
  readonly at: Date;
  readonly accountCode: string;
}

/** What Arc believes happened, projected from the ledger. */
export interface InternalRecord {
  readonly reference: string;
  readonly amount: Money;
  readonly at: Date;
  readonly accountCode: string;
}

export interface ReconciliationBreak {
  readonly kind: BreakKind;
  readonly severity: BreakSeverity;
  readonly source: Source;
  readonly reference: string;
  readonly internal?: Money;
  readonly external?: Money;
  readonly difference?: Money;
  readonly detail: string;
}

export interface ReconciliationResult {
  readonly source: Source;
  readonly runAt: Date;
  readonly matched: number;
  readonly breaks: readonly ReconciliationBreak[];
  /** Records too recent to expect a counterpart yet. Not breaks. */
  readonly pending: number;
  readonly internalTotal: Money;
  readonly externalTotal: Money;
  readonly difference: Money;
}

export interface ReconciliationOptions {
  now?: () => Date;
  /**
   * How long an external record may lag its ledger entry before the gap counts
   * as a break. Rails settle asynchronously; without this every reconciliation
   * run would raise a break for every in-flight transfer.
   */
  settlementWindowMs?: number;
}

const SEVERITY: Record<BreakKind, BreakSeverity> = {
  missing_external: 'high',
  missing_internal: 'high',
  amount_mismatch: 'high',
  duplicate_external: 'medium',
  currency_mismatch: 'high',
};

/**
 * Three-way reconciliation.
 *
 * The ledger balancing proves Arc's books are internally consistent. It says
 * nothing about whether they match reality — a payout the ledger records but the
 * bank never made leaves the ledger perfectly balanced and the money missing.
 * Reconciliation is the control that catches that class of error.
 */
export class Reconciler {
  private readonly now: () => Date;
  private readonly windowMs: number;

  constructor(options: ReconciliationOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.windowMs = options.settlementWindowMs ?? 6 * 60 * 60 * 1000;
  }

  reconcile(
    source: Source,
    internal: readonly InternalRecord[],
    external: readonly ExternalRecord[],
    currency: CurrencyCode,
  ): ReconciliationResult {
    const runAt = this.now();
    const breaks: ReconciliationBreak[] = [];

    const externalByReference = new Map<string, ExternalRecord[]>();
    for (const record of external) {
      if (record.source !== source) continue;
      const list = externalByReference.get(record.reference) ?? [];
      list.push(record);
      externalByReference.set(record.reference, list);
    }

    const internalByReference = new Map<string, InternalRecord>();
    for (const record of internal) {
      if (internalByReference.has(record.reference)) {
        throw new LedgerError(
          `internal records must be one per reference; ${record.reference} appears twice`,
        );
      }
      internalByReference.set(record.reference, record);
    }

    let matched = 0;
    let pending = 0;

    for (const [reference, record] of internalByReference) {
      const candidates = externalByReference.get(reference) ?? [];

      if (candidates.length === 0) {
        // Still inside the settlement window: the rail has not reported yet.
        if (runAt.getTime() - record.at.getTime() <= this.windowMs) {
          pending += 1;
          continue;
        }
        breaks.push({
          kind: 'missing_external',
          severity: SEVERITY.missing_external,
          source,
          reference,
          internal: record.amount,
          detail: `the ledger records ${record.amount.toString()} but ${source} never reported it`,
        });
        continue;
      }

      if (candidates.length > 1) {
        breaks.push({
          kind: 'duplicate_external',
          severity: SEVERITY.duplicate_external,
          source,
          reference,
          internal: record.amount,
          external: sum(
            candidates.map((c) => c.amount),
            currency,
          ),
          detail: `${source} reported ${candidates.length} records for one ledger entry`,
        });
        continue;
      }

      const counterpart = candidates[0]!;

      if (counterpart.amount.currency !== record.amount.currency) {
        breaks.push({
          kind: 'currency_mismatch',
          severity: SEVERITY.currency_mismatch,
          source,
          reference,
          detail:
            `the ledger says ${record.amount.currency} but ${source} says ` +
            `${counterpart.amount.currency}`,
        });
        continue;
      }

      if (!counterpart.amount.equals(record.amount)) {
        breaks.push({
          kind: 'amount_mismatch',
          severity: SEVERITY.amount_mismatch,
          source,
          reference,
          internal: record.amount,
          external: counterpart.amount,
          difference: record.amount.subtract(counterpart.amount),
          detail:
            `the ledger says ${record.amount.toString()} and ${source} says ` +
            `${counterpart.amount.toString()}`,
        });
        continue;
      }

      matched += 1;
    }

    for (const [reference, records] of externalByReference) {
      if (internalByReference.has(reference)) continue;
      const total = sum(
        records.map((r) => r.amount),
        currency,
      );
      breaks.push({
        kind: 'missing_internal',
        severity: SEVERITY.missing_internal,
        source,
        reference,
        external: total,
        detail: `${source} reported ${total.toString()} with no matching ledger entry`,
      });
    }

    const internalTotal = sum(
      [...internalByReference.values()].map((r) => r.amount),
      currency,
    );
    const externalTotal = sum(
      [...externalByReference.values()].flat().map((r) => r.amount),
      currency,
    );

    return {
      source,
      runAt,
      matched,
      breaks,
      pending,
      internalTotal,
      externalTotal,
      difference: internalTotal.subtract(externalTotal),
    };
  }
}

/** Project ledger entries into the shape reconciliation compares. */
export function internalRecordsFrom(
  entries: readonly PostedEntry[],
  input: {
    accountCode: string;
    referenceOf: (entry: PostedEntry, index: number) => string | undefined;
    at: (entry: PostedEntry, index: number) => Date;
  },
): InternalRecord[] {
  const byReference = new Map<string, { amount: Money; at: Date }>();

  entries.forEach((entry, index) => {
    if (entry.accountCode !== input.accountCode) return;
    const reference = input.referenceOf(entry, index);
    if (!reference) return;

    const existing = byReference.get(reference);
    const signed = entry.direction === 'debit' ? entry.amount : entry.amount.negate();
    byReference.set(reference, {
      amount: existing ? existing.amount.add(signed) : signed,
      at: existing?.at ?? input.at(entry, index),
    });
  });

  return [...byReference.entries()].map(([reference, value]) => ({
    reference,
    amount: value.amount,
    at: value.at,
    accountCode: input.accountCode,
  }));
}

export interface CaseRequest {
  readonly queue: 'reconciliation';
  readonly subjectId: string;
  readonly priority: 'low' | 'normal' | 'high' | 'urgent';
  readonly reasons: readonly string[];
  readonly riskScore: number;
}

/**
 * Opens a case for a break. The ledger does not import the risk context — the
 * composition root supplies something that satisfies this.
 */
export interface CaseOpener {
  open(request: CaseRequest): { id: string };
}

export interface RaisedCase {
  readonly caseId: string;
  readonly break: ReconciliationBreak;
}

/**
 * Every break becomes a case. A break nobody is assigned to is a break nobody
 * resolves, and an unexplained difference is indistinguishable from fraud.
 */
export function raiseCases(result: ReconciliationResult, opener: CaseOpener): RaisedCase[] {
  return result.breaks.map((item) => {
    const opened = opener.open({
      queue: 'reconciliation',
      subjectId: item.reference,
      priority:
        item.severity === 'high' ? 'urgent' : item.severity === 'medium' ? 'high' : 'normal',
      reasons: [`${item.kind}: ${item.detail}`],
      riskScore: item.severity === 'high' ? 90 : item.severity === 'medium' ? 60 : 30,
    });
    return { caseId: opened.id, break: item };
  });
}
