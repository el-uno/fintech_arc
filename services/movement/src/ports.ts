import type { CurrencyCode, Money } from '@arc/money';

export type EntryDirection = 'debit' | 'credit';

export interface JournalEntryInput {
  readonly account: string;
  readonly direction: EntryDirection;
  readonly amount: Money;
}

export interface JournalInput {
  readonly kind: 'transfer' | 'fee' | 'fx' | 'reversal' | 'rounding' | 'settlement';
  readonly referenceId: string;
  readonly description?: string;
  readonly entries: readonly JournalEntryInput[];
}

export interface PostedJournalRef {
  readonly id: string;
  readonly entries: readonly JournalEntryInput[];
}

/**
 * Movement's view of the ledger. The ledger context implements this; movement
 * never imports it.
 */
export interface LedgerPort {
  post(journal: JournalInput): Promise<PostedJournalRef>;
  availableBalance(accountCode: string, currency: CurrencyCode): Promise<Money>;
}

export type ComplianceDecision = 'approved' | 'rejected' | 'review';

export interface ComplianceVerdict {
  readonly decision: ComplianceDecision;
  readonly reasons: readonly string[];
  readonly riskScore: number;
}

/**
 * Screening is a hard pre-condition on movement, not a side channel. Phase 5
 * replaces the permissive default with the real rule engine.
 */
export interface CompliancePort {
  screenTransfer(input: {
    transferId: string;
    senderAccount: string;
    beneficiary: string;
    amount: Money;
    corridor: string;
  }): Promise<ComplianceVerdict>;
}

export class AlwaysApprove implements CompliancePort {
  async screenTransfer(): Promise<ComplianceVerdict> {
    return { decision: 'approved', reasons: [], riskScore: 0 };
  }
}
