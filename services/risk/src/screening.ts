import type { Money } from '@arc/money';
import type { CasePriority, ReviewCase, ReviewQueue } from './cases.js';
import { assessTier, type VerificationTier } from './kyc.js';
import type { AmlRuleEngine, RuleHit, TransferObservation } from './rules.js';
import type { SanctionsMatch, SanctionsScreener } from './sanctions.js';

export type ComplianceDecision = 'approved' | 'rejected' | 'review';

export interface ComplianceVerdict {
  readonly decision: ComplianceDecision;
  readonly reasons: readonly string[];
  readonly riskScore: number;
  readonly caseId?: string;
  readonly sanctionsMatches?: readonly SanctionsMatch[];
  readonly ruleHits?: readonly RuleHit[];
}

export interface ScreenTransferInput {
  readonly transferId: string;
  readonly senderAccount: string;
  readonly beneficiary: string;
  readonly amount: Money;
  readonly corridor: string;
}

export interface SubjectProfile {
  readonly accountId: string;
  readonly legalName: string;
  readonly beneficiaryName?: string;
  readonly tier: VerificationTier;
  readonly documents?: Parameters<typeof assessTier>[1];
}

export interface ScreeningOptions {
  /** Risk score at or above which a transfer is blocked outright. */
  rejectAt?: number;
  /** Risk score at or above which a transfer goes to manual review. */
  reviewAt?: number;
  now?: () => Date;
}

export interface HistoryProvider {
  historyFor(accountId: string): Promise<readonly TransferObservation[]>;
}

export class InMemoryHistory implements HistoryProvider {
  private readonly byAccount = new Map<string, TransferObservation[]>();

  async historyFor(accountId: string): Promise<readonly TransferObservation[]> {
    return this.byAccount.get(accountId) ?? [];
  }

  record(observation: TransferObservation): void {
    const list = this.byAccount.get(observation.accountId) ?? [];
    list.unshift(observation);
    this.byAccount.set(observation.accountId, list);
  }
}

const PRIORITY_BY_SCORE = (score: number): CasePriority =>
  score >= 90 ? 'urgent' : score >= 70 ? 'high' : score >= 40 ? 'normal' : 'low';

/**
 * The compliance gate. Structurally satisfies movement's `CompliancePort` without
 * either context importing the other.
 */
export class ScreeningService {
  private readonly rejectAt: number;
  private readonly reviewAt: number;
  private readonly now: () => Date;

  constructor(
    private readonly sanctions: SanctionsScreener,
    private readonly rules: AmlRuleEngine,
    private readonly queue: ReviewQueue,
    private readonly history: HistoryProvider,
    private readonly profiles: Map<string, SubjectProfile>,
    options: ScreeningOptions = {},
  ) {
    this.rejectAt = options.rejectAt ?? 80;
    this.reviewAt = options.reviewAt ?? 40;
    this.now = options.now ?? (() => new Date());
  }

  async screenTransfer(input: ScreenTransferInput): Promise<ComplianceVerdict> {
    const profile = this.profiles.get(input.senderAccount);
    const now = this.now();
    const reasons: string[] = [];

    if (!profile) {
      const record = this.queue.open({
        queue: 'kyc',
        subjectId: input.senderAccount,
        priority: 'high',
        reasons: ['no verified profile for sender'],
        riskScore: 100,
      });
      return {
        decision: 'rejected',
        reasons: ['unknown_sender'],
        riskScore: 100,
        caseId: record.id,
      };
    }

    // 1. Sanctions. A hit is terminal — it is never scored against other signals.
    const names = [profile.legalName, profile.beneficiaryName ?? input.beneficiary];
    const matches: SanctionsMatch[] = [];
    for (const name of names) {
      matches.push(...this.sanctions.screen(name, now).matches);
    }

    if (matches.length > 0) {
      const record = this.queue.open({
        queue: 'sanctions',
        subjectId: input.senderAccount,
        priority: 'urgent',
        reasons: matches.map((m) => `sanctions_match:${m.entity.id}:${m.matchedOn}`),
        riskScore: 100,
      });
      return {
        decision: 'rejected',
        reasons: ['sanctions_hit', ...matches.map((m) => m.entity.id)],
        riskScore: 100,
        caseId: record.id,
        sanctionsMatches: matches,
      };
    }

    // 2. KYC sufficiency for the tier the account claims.
    if (profile.documents) {
      const assessment = assessTier(profile.tier, profile.documents, now);
      if (assessment.granted < profile.tier) {
        const record = this.queue.open({
          queue: 'kyc',
          subjectId: input.senderAccount,
          priority: 'normal',
          reasons: assessment.missing.map((d) => `missing_document:${d}`),
          riskScore: 60,
        });
        return {
          decision: 'review',
          reasons: ['kyc_incomplete', ...assessment.missing],
          riskScore: 60,
          caseId: record.id,
        };
      }
    }

    // 3. AML rules over the account's recent behaviour.
    const candidate: TransferObservation = {
      transferId: input.transferId,
      accountId: input.senderAccount,
      beneficiary: input.beneficiary,
      amountEur: input.amount,
      corridor: input.corridor,
      at: now,
    };

    const evaluation = this.rules.evaluate({
      candidate,
      history: await this.history.historyFor(input.senderAccount),
      now,
    });

    reasons.push(...evaluation.hits.map((h) => `${h.rule}: ${h.reason}`));

    if (evaluation.riskScore >= this.rejectAt) {
      const record = this.openAmlCase(input, evaluation.riskScore, reasons);
      return {
        decision: 'rejected',
        reasons,
        riskScore: evaluation.riskScore,
        caseId: record.id,
        ruleHits: evaluation.hits,
      };
    }

    if (evaluation.riskScore >= this.reviewAt) {
      const record = this.openAmlCase(input, evaluation.riskScore, reasons);
      return {
        decision: 'review',
        reasons,
        riskScore: evaluation.riskScore,
        caseId: record.id,
        ruleHits: evaluation.hits,
      };
    }

    return {
      decision: 'approved',
      reasons,
      riskScore: evaluation.riskScore,
      ruleHits: evaluation.hits,
    };
  }

  private openAmlCase(
    input: ScreenTransferInput,
    riskScore: number,
    reasons: readonly string[],
  ): ReviewCase {
    return this.queue.open({
      queue: 'aml',
      subjectId: input.senderAccount,
      priority: PRIORITY_BY_SCORE(riskScore),
      reasons,
      riskScore,
    });
  }
}
