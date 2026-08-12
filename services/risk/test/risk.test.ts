import { Money } from '@arc/money';
import { describe, expect, it } from 'vitest';
import {
  AmlRuleEngine,
  assessTier,
  InMemoryHistory,
  nameSimilarity,
  resolveBeneficialOwners,
  ReviewQueue,
  RiskError,
  SanctionsScreener,
  ScreeningService,
  SYNTHETIC_SANCTIONS_LIST,
  type SubjectProfile,
  type TransferObservation,
  type UboGraph,
  type VerificationDocument,
} from '../src/index.js';

const eur = (v: string) => Money.parse(v, 'EUR');
const NOW = new Date('2026-06-01T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function doc(
  kind: VerificationDocument['kind'],
  status: VerificationDocument['status'] = 'verified',
  expiresAt?: Date,
): VerificationDocument {
  return {
    id: `doc_${kind}`,
    kind,
    status,
    submittedAt: ago(30 * DAY),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

describe('sanctions screening', () => {
  const screener = new SanctionsScreener();

  it('matches an exact listed name', () => {
    const result = screener.screen('Vorlan Krestomayer');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.entity.id).toBe('SYN-0001');
    expect(result.matches[0]!.score).toBe(1);
  });

  it('matches through a typo', () => {
    expect(screener.isHit('Vorlan Krestomeyer')).toBe(true);
    expect(screener.isHit('Vorlen Krestomayer')).toBe(true);
  });

  it('matches an alias', () => {
    const result = screener.screen('BHZ Group');
    expect(result.matches[0]!.entity.id).toBe('SYN-0002');
  });

  it('matches regardless of word order', () => {
    expect(screener.isHit('Krestomayer Vorlan')).toBe(true);
  });

  it('ignores case, accents and punctuation', () => {
    expect(screener.isHit('  vórlan   krestomayer! ')).toBe(true);
  });

  it('does not match an unrelated name', () => {
    const result = screener.screen('Amina Wanjiru');
    expect(result.matches).toHaveLength(0);
  });

  it('records what it screened against, for the audit trail', () => {
    const result = screener.screen('Amina Wanjiru', NOW);
    expect(result.listSize).toBe(SYNTHETIC_SANCTIONS_LIST.length);
    expect(result.threshold).toBe(0.9);
    expect(result.screenedAt).toBe(NOW);
  });

  it('exposes the threshold so false positives can be tuned', () => {
    const loose = new SanctionsScreener({ threshold: 0.6 });
    const strict = new SanctionsScreener({ threshold: 0.99 });
    expect(loose.isHit('Vorlan Kres')).toBe(true);
    expect(strict.isHit('Vorlan Kres')).toBe(false);
  });

  it('scores similarity between 0 and 1', () => {
    expect(nameSimilarity('abc', 'abc')).toBe(1);
    expect(nameSimilarity('abc', 'xyz')).toBeLessThan(0.6);
    expect(nameSimilarity('', 'abc')).toBe(0);
  });
});

describe('KYC tiering', () => {
  it('grants the requested tier when documents are complete', () => {
    const assessment = assessTier(
      2,
      [doc('passport'), doc('proof_of_address'), doc('selfie')],
      NOW,
    );
    expect(assessment.granted).toBe(2);
    expect(assessment.missing).toEqual([]);
  });

  it('grants a lower tier when documents fall short', () => {
    const assessment = assessTier(2, [doc('national_id')], NOW);
    expect(assessment.granted).toBe(1);
    expect(assessment.missing).toContain('passport');
  });

  it('ignores unverified documents', () => {
    const assessment = assessTier(1, [doc('national_id', 'pending')], NOW);
    expect(assessment.granted).toBe(0);
  });

  it('treats an expired document as missing and reports it', () => {
    const assessment = assessTier(1, [doc('national_id', 'verified', ago(DAY))], NOW);
    expect(assessment.granted).toBe(0);
    expect(assessment.expired).toContain('national_id');
  });

  it('requires source of funds for tier 3', () => {
    const docs = [doc('passport'), doc('proof_of_address'), doc('selfie')];
    expect(assessTier(3, docs, NOW).granted).toBe(2);
    expect(assessTier(3, [...docs, doc('source_of_funds')], NOW).granted).toBe(3);
  });
});

describe('UBO resolution', () => {
  const graph: UboGraph = {
    nodes: [
      { id: 'op', name: 'Kola Imports Ltd', kind: 'company', countryCode: 'NG' },
      { id: 'hold', name: 'Adeyemi Holdings', kind: 'company', countryCode: 'NG' },
      { id: 'off', name: 'Sarn Offshore', kind: 'company', countryCode: 'ZZ' },
      { id: 'p1', name: 'Kola Adeyemi', kind: 'person', countryCode: 'NG' },
      { id: 'p2', name: 'Ada Nwosu', kind: 'person', countryCode: 'NG' },
      { id: 'p3', name: 'Minor Holder', kind: 'person', countryCode: 'GB' },
    ],
    edges: [
      { ownerId: 'hold', ownedId: 'op', percentBps: 6_000 },
      { ownerId: 'p2', ownedId: 'op', percentBps: 3_000 },
      { ownerId: 'p3', ownedId: 'op', percentBps: 1_000 },
      { ownerId: 'p1', ownedId: 'hold', percentBps: 8_000 },
      { ownerId: 'off', ownedId: 'hold', percentBps: 2_000 },
      { ownerId: 'p1', ownedId: 'off', percentBps: 10_000 },
    ],
  };

  it('multiplies ownership down a chain of holding companies', () => {
    const owners = resolveBeneficialOwners(graph, 'op');
    const kola = owners.find((o) => o.node.id === 'p1')!;

    // 80% of 60% = 48%, plus 100% of 20% of 60% = 12%, so 60% in total.
    expect(kola.effectiveBps).toBe(6_000);
  });

  it('sums ownership held through several paths', () => {
    const owners = resolveBeneficialOwners(graph, 'op');
    expect(owners.map((o) => o.node.id)).toContain('p1');
    expect(owners.find((o) => o.node.id === 'p2')!.effectiveBps).toBe(3_000);
  });

  it('excludes holders below the disclosure threshold', () => {
    const owners = resolveBeneficialOwners(graph, 'op', 2_500);
    expect(owners.map((o) => o.node.id)).not.toContain('p3');
  });

  it('reports the ownership path for each owner', () => {
    const owners = resolveBeneficialOwners(graph, 'op');
    expect(owners.find((o) => o.node.id === 'p1')!.path[0]).toBe('op');
  });

  it('refuses an unknown root', () => {
    expect(() => resolveBeneficialOwners(graph, 'nope')).toThrow(RiskError);
  });

  it('terminates on a circular ownership structure', () => {
    const circular: UboGraph = {
      nodes: [
        { id: 'a', name: 'A', kind: 'company', countryCode: 'ZZ' },
        { id: 'b', name: 'B', kind: 'company', countryCode: 'ZZ' },
        { id: 'p', name: 'P', kind: 'person', countryCode: 'ZZ' },
      ],
      edges: [
        { ownerId: 'b', ownedId: 'a', percentBps: 10_000 },
        { ownerId: 'a', ownedId: 'b', percentBps: 5_000 },
        { ownerId: 'p', ownedId: 'b', percentBps: 5_000 },
      ],
    };
    const owners = resolveBeneficialOwners(circular, 'a');
    expect(owners.find((o) => o.node.id === 'p')!.effectiveBps).toBe(5_000);
  });
});

describe('AML rules', () => {
  const engine = new AmlRuleEngine();

  const observation = (over: Partial<TransferObservation> = {}): TransferObservation => ({
    transferId: `t_${Math.random().toString(36).slice(2)}`,
    accountId: 'acct_1',
    beneficiary: 'bene_1',
    amountEur: eur('100.00'),
    corridor: 'DE-KE',
    at: NOW,
    ...over,
  });

  it('flags structuring: repeated transfers just under the reporting threshold', () => {
    const history = [
      observation({ amountEur: eur('9500.00'), at: ago(DAY) }),
      observation({ amountEur: eur('9700.00'), at: ago(2 * DAY) }),
    ];
    const result = engine.evaluate({
      candidate: observation({ amountEur: eur('9800.00') }),
      history,
      now: NOW,
    });

    const hit = result.hits.find((h) => h.rule === 'structuring');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('high');
    expect(hit!.evidence).toHaveLength(3);
    expect(result.riskScore).toBeGreaterThanOrEqual(79);
  });

  it('does not flag structuring for amounts well below the threshold', () => {
    const history = [
      observation({ amountEur: eur('100.00'), at: ago(DAY) }),
      observation({ amountEur: eur('120.00'), at: ago(2 * DAY) }),
    ];
    const result = engine.evaluate({ candidate: observation(), history, now: NOW });
    expect(result.hits.find((h) => h.rule === 'structuring')).toBeUndefined();
  });

  it('does not flag structuring for a single large transfer', () => {
    const result = engine.evaluate({
      candidate: observation({ amountEur: eur('9800.00') }),
      history: [],
      now: NOW,
    });
    expect(result.hits.find((h) => h.rule === 'structuring')).toBeUndefined();
  });

  it('flags velocity on count', () => {
    const history = Array.from({ length: 9 }, (_, i) =>
      observation({ amountEur: eur('10.00'), at: ago(i * HOUR) }),
    );
    const result = engine.evaluate({ candidate: observation(), history, now: NOW });
    expect(result.hits.find((h) => h.rule === 'velocity')).toBeDefined();
  });

  it('ignores activity outside the window', () => {
    const history = Array.from({ length: 12 }, (_, i) =>
      observation({ amountEur: eur('10.00'), at: ago(10 * DAY + i * HOUR) }),
    );
    const result = engine.evaluate({ candidate: observation(), history, now: NOW });
    expect(result.hits.find((h) => h.rule === 'velocity')).toBeUndefined();
  });

  it('flags a first-time corridor once there is a baseline', () => {
    const history = [
      observation({ corridor: 'DE-KE', at: ago(DAY) }),
      observation({ corridor: 'DE-KE', at: ago(2 * DAY) }),
      observation({ corridor: 'DE-KE', at: ago(3 * DAY) }),
    ];
    const result = engine.evaluate({
      candidate: observation({ corridor: 'DE-NG' }),
      history,
      now: NOW,
    });
    expect(result.hits.find((h) => h.rule === 'unusual_corridor')).toBeDefined();
  });

  it('does not flag an unusual corridor without a baseline', () => {
    const result = engine.evaluate({
      candidate: observation({ corridor: 'DE-NG' }),
      history: [],
      now: NOW,
    });
    expect(result.hits.find((h) => h.rule === 'unusual_corridor')).toBeUndefined();
  });

  it('flags round-tripping', () => {
    const history = [observation({ accountId: 'acct_1', beneficiary: 'acct_1', at: ago(DAY) })];
    const result = engine.evaluate({
      candidate: observation({ accountId: 'acct_1', beneficiary: 'acct_1' }),
      history,
      now: NOW,
    });
    expect(result.hits.find((h) => h.rule === 'round_tripping')).toBeDefined();
  });

  it('flags counterparty concentration', () => {
    const history = Array.from({ length: 5 }, (_, i) =>
      observation({ beneficiary: 'bene_1', amountEur: eur('500.00'), at: ago(i * DAY) }),
    );
    const result = engine.evaluate({
      candidate: observation({ beneficiary: 'bene_1', amountEur: eur('500.00') }),
      history,
      now: NOW,
    });
    expect(result.hits.find((h) => h.rule === 'counterparty_concentration')).toBeDefined();
  });

  it('scores a clean transfer at zero', () => {
    const result = engine.evaluate({ candidate: observation(), history: [], now: NOW });
    expect(result.hits).toEqual([]);
    expect(result.riskScore).toBe(0);
  });

  it('lets one strong signal dominate several weak ones', () => {
    const strong = engine.evaluate({
      candidate: observation({ accountId: 'a', beneficiary: 'a' }),
      history: [observation({ accountId: 'a', beneficiary: 'a', at: ago(HOUR) })],
      now: NOW,
    });
    expect(strong.riskScore).toBeGreaterThanOrEqual(80);
    expect(strong.riskScore).toBeLessThanOrEqual(100);
  });
});

describe('review queue', () => {
  it('sets an SLA from the priority', () => {
    const queue = new ReviewQueue({ now: () => NOW });
    const record = queue.open({
      queue: 'aml',
      subjectId: 'acct_1',
      priority: 'urgent',
      reasons: ['structuring'],
      riskScore: 90,
    });
    expect(record.slaExpiresAt.getTime() - NOW.getTime()).toBe(HOUR);
    expect(record.status).toBe('open');
  });

  it('records every action in the audit trail', () => {
    const queue = new ReviewQueue({ now: () => NOW });
    const opened = queue.open({
      queue: 'aml',
      subjectId: 'acct_1',
      priority: 'high',
      reasons: ['velocity'],
      riskScore: 70,
    });

    queue.assign(opened.id, 'reviewer_a');
    queue.decide(opened.id, 'reviewer_a', 'approved', 'looks legitimate');
    const closed = queue.decide(opened.id, 'reviewer_b', 'approved');

    expect(closed.status).toBe('closed');
    expect(closed.audit.map((a) => a.action)).toEqual([
      'opened',
      'assigned',
      'decided:approved',
      'decided:approved',
    ]);
    expect(closed.audit.map((a) => a.actor)).toEqual([
      'system',
      'reviewer_a',
      'reviewer_a',
      'reviewer_b',
    ]);
  });

  it('requires two distinct approvers on a sanctions case', () => {
    const queue = new ReviewQueue({ now: () => NOW });
    const record = queue.open({
      queue: 'sanctions',
      subjectId: 'acct_1',
      priority: 'urgent',
      reasons: ['match'],
      riskScore: 100,
    });

    const staged = queue.decide(record.id, 'reviewer_a', 'approved');
    expect(staged.status).toBe('awaiting_second_approval');
    expect(staged.outcome).toBeUndefined();

    expect(() => queue.decide(record.id, 'reviewer_a', 'approved')).toThrow(
      /second, different approver/,
    );

    const closed = queue.decide(record.id, 'reviewer_b', 'approved');
    expect(closed.status).toBe('closed');
    expect(closed.outcome).toBe('approved');
  });

  it('closes a KYC case on a single decision', () => {
    const queue = new ReviewQueue({ now: () => NOW });
    const record = queue.open({
      queue: 'kyc',
      subjectId: 'acct_1',
      priority: 'normal',
      reasons: ['missing document'],
      riskScore: 40,
    });
    expect(queue.decide(record.id, 'reviewer_a', 'approved').status).toBe('closed');
  });

  it('escalation closes immediately even on a four-eyes queue', () => {
    const queue = new ReviewQueue({ now: () => NOW });
    const record = queue.open({
      queue: 'aml',
      subjectId: 'a',
      priority: 'high',
      reasons: [],
      riskScore: 50,
    });
    expect(queue.decide(record.id, 'reviewer_a', 'escalated').status).toBe('closed');
  });

  it('reports SLA breaches oldest first', () => {
    let clock = NOW;
    const queue = new ReviewQueue({ now: () => clock });
    queue.open({ queue: 'aml', subjectId: 'a', priority: 'urgent', reasons: [], riskScore: 90 });
    queue.open({ queue: 'kyc', subjectId: 'b', priority: 'low', reasons: [], riskScore: 10 });

    expect(queue.breachedSla()).toHaveLength(0);
    clock = new Date(NOW.getTime() + 2 * HOUR);
    expect(queue.breachedSla()).toHaveLength(1);
  });

  it('refuses to reopen a closed case', () => {
    const queue = new ReviewQueue({ now: () => NOW });
    const record = queue.open({
      queue: 'kyc',
      subjectId: 'a',
      priority: 'low',
      reasons: [],
      riskScore: 5,
    });
    queue.decide(record.id, 'r', 'rejected');
    expect(() => queue.decide(record.id, 'r2', 'approved')).toThrow(/already closed/);
    expect(() => queue.assign(record.id, 'r2')).toThrow(/is closed/);
  });

  it('orders the work list by priority', () => {
    const queue = new ReviewQueue({ now: () => NOW });
    queue.open({ queue: 'aml', subjectId: 'a', priority: 'low', reasons: [], riskScore: 10 });
    queue.open({ queue: 'aml', subjectId: 'b', priority: 'urgent', reasons: [], riskScore: 95 });
    queue.open({ queue: 'aml', subjectId: 'c', priority: 'normal', reasons: [], riskScore: 50 });

    expect(queue.list('aml').map((c) => c.priority)).toEqual(['urgent', 'normal', 'low']);
  });
});

describe('the compliance gate', () => {
  function build(profile: Partial<SubjectProfile> = {}) {
    const queue = new ReviewQueue({ now: () => NOW });
    const history = new InMemoryHistory();
    const profiles = new Map<string, SubjectProfile>([
      [
        'acct_1',
        {
          accountId: 'acct_1',
          legalName: 'Amina Wanjiru',
          tier: 2,
          ...profile,
        },
      ],
    ]);

    const service = new ScreeningService(
      new SanctionsScreener(),
      new AmlRuleEngine(),
      queue,
      history,
      profiles,
      { now: () => NOW },
    );
    return { service, queue, history };
  }

  const transfer = {
    transferId: 't_1',
    senderAccount: 'acct_1',
    beneficiary: 'bene_1',
    amount: eur('500.00'),
    corridor: 'DE-KE',
  };

  it('approves a clean transfer', async () => {
    const { service, queue } = build();
    const verdict = await service.screenTransfer(transfer);

    expect(verdict.decision).toBe('approved');
    expect(verdict.riskScore).toBe(0);
    expect(queue.list()).toHaveLength(0);
  });

  it('blocks a sanctions hit and opens an urgent case with a full audit trail', async () => {
    const { service, queue } = build({ legalName: 'Vorlan Krestomayer' });
    const verdict = await service.screenTransfer(transfer);

    expect(verdict.decision).toBe('rejected');
    expect(verdict.reasons).toContain('sanctions_hit');
    expect(verdict.riskScore).toBe(100);
    expect(verdict.sanctionsMatches![0]!.entity.id).toBe('SYN-0001');

    const record = queue.get(verdict.caseId!);
    expect(record.queue).toBe('sanctions');
    expect(record.priority).toBe('urgent');
    expect(record.slaExpiresAt.getTime() - NOW.getTime()).toBe(HOUR);
    expect(record.reasons[0]).toContain('SYN-0001');
    expect(record.audit[0]!.action).toBe('opened');
    expect(record.audit[0]!.actor).toBe('system');
  });

  it('screens the beneficiary as well as the sender', async () => {
    const { service } = build({ beneficiaryName: 'Ondrimo Falquist' });
    const verdict = await service.screenTransfer(transfer);
    expect(verdict.decision).toBe('rejected');
    expect(verdict.reasons).toContain('SYN-0003');
  });

  it('blocks a structuring pattern and opens an AML case', async () => {
    const { service, queue, history } = build();

    for (const [i, amount] of ['9500.00', '9700.00'].entries()) {
      history.record({
        transferId: `prior_${i}`,
        accountId: 'acct_1',
        beneficiary: 'bene_1',
        amountEur: eur(amount),
        corridor: 'DE-KE',
        at: ago((i + 1) * DAY),
      });
    }

    const verdict = await service.screenTransfer({ ...transfer, amount: eur('9800.00') });

    expect(verdict.decision).toBe('rejected');
    expect(verdict.reasons.join(' ')).toContain('structuring');
    expect(verdict.ruleHits!.some((h) => h.rule === 'structuring')).toBe(true);

    const record = queue.get(verdict.caseId!);
    expect(record.queue).toBe('aml');
    // 80-89 is a high-priority case; urgent is reserved for 90+.
    expect(record.priority).toBe('high');
    expect(record.riskScore).toBeGreaterThanOrEqual(80);
    expect(record.reasons.join(' ')).toContain('reporting threshold');
    expect(record.audit).toHaveLength(1);
  });

  it('sends a mid-scoring transfer to review rather than blocking it', async () => {
    const { service, queue, history } = build();
    for (let i = 0; i < 4; i++) {
      history.record({
        transferId: `p_${i}`,
        accountId: 'acct_1',
        beneficiary: 'bene_1',
        amountEur: eur('600.00'),
        corridor: 'DE-KE',
        at: ago(i * DAY),
      });
    }

    const verdict = await service.screenTransfer(transfer);
    expect(verdict.decision).toBe('review');
    expect(queue.get(verdict.caseId!).queue).toBe('aml');
  });

  it('rejects an unknown sender and opens a KYC case', async () => {
    const { service, queue } = build();
    const verdict = await service.screenTransfer({ ...transfer, senderAccount: 'ghost' });

    expect(verdict.decision).toBe('rejected');
    expect(verdict.reasons).toContain('unknown_sender');
    expect(queue.get(verdict.caseId!).queue).toBe('kyc');
  });

  it('sends an under-documented account to review', async () => {
    const { service, queue } = build({ tier: 3, documents: [doc('passport')] });
    const verdict = await service.screenTransfer(transfer);

    expect(verdict.decision).toBe('review');
    expect(verdict.reasons).toContain('kyc_incomplete');
    expect(queue.get(verdict.caseId!).queue).toBe('kyc');
  });

  it('treats a sanctions hit as terminal, never scored against other signals', async () => {
    const { service } = build({ legalName: 'Vorlan Krestomayer' });
    const verdict = await service.screenTransfer({ ...transfer, amount: eur('1.00') });
    // A trivial amount and no AML history, but the hit still blocks it outright.
    expect(verdict.decision).toBe('rejected');
    expect(verdict.riskScore).toBe(100);
  });
});
