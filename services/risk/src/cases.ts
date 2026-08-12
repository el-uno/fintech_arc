import { randomUUID } from 'node:crypto';
import { RiskError } from './kyc.js';

export type CaseQueue = 'kyc' | 'sanctions' | 'aml' | 'reconciliation';

export type CaseStatus = 'open' | 'assigned' | 'awaiting_second_approval' | 'closed';

export type CaseOutcome = 'approved' | 'rejected' | 'escalated';

export type CasePriority = 'low' | 'normal' | 'high' | 'urgent';

export interface AuditEntry {
  readonly at: Date;
  readonly actor: string;
  readonly action: string;
  readonly detail?: string;
}

export interface ReviewCase {
  readonly id: string;
  readonly queue: CaseQueue;
  readonly subjectId: string;
  readonly priority: CasePriority;
  readonly status: CaseStatus;
  readonly openedAt: Date;
  readonly slaExpiresAt: Date;
  readonly assignee?: string;
  readonly firstApprover?: string;
  readonly outcome?: CaseOutcome;
  readonly closedAt?: Date;
  readonly reasons: readonly string[];
  readonly riskScore: number;
  readonly audit: readonly AuditEntry[];
}

export const SLA_MS: Record<CasePriority, number> = {
  urgent: 60 * 60 * 1000,
  high: 4 * 60 * 60 * 1000,
  normal: 24 * 60 * 60 * 1000,
  low: 72 * 60 * 60 * 1000,
};

export interface OpenCaseInput {
  readonly queue: CaseQueue;
  readonly subjectId: string;
  readonly priority: CasePriority;
  readonly reasons: readonly string[];
  readonly riskScore: number;
}

export interface CaseQueueOptions {
  now?: () => Date;
  /** Queues where closing requires two distinct approvers. */
  fourEyesQueues?: readonly CaseQueue[];
}

export class ReviewQueue {
  private readonly cases = new Map<string, ReviewCase>();
  private readonly now: () => Date;
  private readonly fourEyes: ReadonlySet<CaseQueue>;

  constructor(options: CaseQueueOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.fourEyes = new Set(options.fourEyesQueues ?? ['sanctions', 'aml']);
  }

  open(input: OpenCaseInput): ReviewCase {
    const at = this.now();
    const record: ReviewCase = {
      id: randomUUID(),
      queue: input.queue,
      subjectId: input.subjectId,
      priority: input.priority,
      status: 'open',
      openedAt: at,
      slaExpiresAt: new Date(at.getTime() + SLA_MS[input.priority]),
      reasons: input.reasons,
      riskScore: input.riskScore,
      audit: [{ at, actor: 'system', action: 'opened', detail: input.reasons.join('; ') }],
    };
    this.cases.set(record.id, record);
    return record;
  }

  get(id: string): ReviewCase {
    const record = this.cases.get(id);
    if (!record) throw new RiskError(`no such case: ${id}`);
    return record;
  }

  assign(id: string, reviewer: string): ReviewCase {
    const record = this.get(id);
    if (record.status === 'closed') throw new RiskError(`case ${id} is closed`);
    return this.update(id, {
      status: 'assigned',
      assignee: reviewer,
      audit: [...record.audit, this.entry(reviewer, 'assigned')],
    });
  }

  /**
   * Record a decision. On a four-eyes queue the first decision only stages the
   * outcome; a second, different approver is required to close.
   */
  decide(id: string, reviewer: string, outcome: CaseOutcome, note?: string): ReviewCase {
    const record = this.get(id);
    if (record.status === 'closed') throw new RiskError(`case ${id} is already closed`);

    const audit = [...record.audit, this.entry(reviewer, `decided:${outcome}`, note ?? undefined)];

    if (!this.fourEyes.has(record.queue) || outcome === 'escalated') {
      return this.update(id, {
        status: 'closed',
        outcome,
        closedAt: this.now(),
        audit,
      });
    }

    if (!record.firstApprover) {
      return this.update(id, {
        status: 'awaiting_second_approval',
        firstApprover: reviewer,
        audit,
      });
    }

    if (record.firstApprover === reviewer) {
      throw new RiskError(
        `${reviewer} already approved case ${id}; a second, different approver is required`,
      );
    }

    return this.update(id, {
      status: 'closed',
      outcome,
      closedAt: this.now(),
      audit,
    });
  }

  breachedSla(): ReviewCase[] {
    const at = this.now().getTime();
    return [...this.cases.values()]
      .filter((c) => c.status !== 'closed' && c.slaExpiresAt.getTime() < at)
      .sort((a, b) => a.slaExpiresAt.getTime() - b.slaExpiresAt.getTime());
  }

  list(queue?: CaseQueue): ReviewCase[] {
    const all = [...this.cases.values()];
    const filtered = queue ? all.filter((c) => c.queue === queue) : all;
    const order: Record<CasePriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
    return filtered.sort(
      (a, b) =>
        order[a.priority] - order[b.priority] || a.openedAt.getTime() - b.openedAt.getTime(),
    );
  }

  openFor(subjectId: string): ReviewCase[] {
    return [...this.cases.values()].filter(
      (c) => c.subjectId === subjectId && c.status !== 'closed',
    );
  }

  private entry(actor: string, action: string, detail?: string): AuditEntry {
    return { at: this.now(), actor, action, ...(detail ? { detail } : {}) };
  }

  private update(id: string, patch: Partial<ReviewCase>): ReviewCase {
    const updated = { ...this.get(id), ...patch } as ReviewCase;
    this.cases.set(id, updated);
    return updated;
  }
}
