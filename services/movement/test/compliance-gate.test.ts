import { Money } from '@arc/money';
import {
  AmlRuleEngine,
  InMemoryHistory,
  ReviewQueue,
  SanctionsScreener,
  ScreeningService,
  type SubjectProfile,
} from '@arc/risk';
import { describe, expect, it } from 'vitest';
import { SettlementSaga } from '../src/index.js';
import { ACCOUNTS, createHarness } from './harness.js';

/**
 * The real risk engine driving the real saga. Neither context imports the other:
 * `ScreeningService` structurally satisfies movement's `CompliancePort`, and the
 * two are wired together here, at the composition root.
 */

const NOW = new Date('2026-06-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const eur = (v: string) => Money.parse(v, 'EUR');

function buildCompliance(legalName = 'Amina Wanjiru') {
  const queue = new ReviewQueue({ now: () => NOW });
  const history = new InMemoryHistory();
  const profiles = new Map<string, SubjectProfile>([
    [ACCOUNTS.senderCustomer, { accountId: ACCOUNTS.senderCustomer, legalName, tier: 2 }],
  ]);

  const screening = new ScreeningService(
    new SanctionsScreener(),
    new AmlRuleEngine(),
    queue,
    history,
    profiles,
    { now: () => NOW },
  );

  return { screening, queue, history };
}

async function run(compliance: ReturnType<typeof buildCompliance>, sendAmount = '1000.00') {
  const harness = await createHarness({ fundSender: '50000.00' });
  const quote = await harness.quotes.quote({
    sendAmount: eur(sendAmount),
    receiveCurrency: 'KES',
    settlementAsset: 'USDC',
    corridor: 'DE-KE',
  });

  const saga = new SettlementSaga({
    ledger: harness.ledger,
    compliance: compliance.screening,
    chain: harness.chain,
    rail: harness.rail,
    advanceChain: harness.advanceChain,
  });

  const before = await harness.senderBalance();
  const result = await saga.execute({
    quote,
    accounts: ACCOUNTS,
    chain: 'base',
    settlementFrom: '0xarc',
    settlementTo: '0xpartner',
  });

  return { harness, result, before };
}

describe('the real compliance engine gates the real saga', () => {
  it('lets a clean transfer through', async () => {
    const compliance = buildCompliance();
    const { harness, result } = await run(compliance);

    expect(result.status).toBe('completed');
    expect(compliance.queue.list()).toHaveLength(0);
    harness.assertBalancedLedger();
  });

  it('a sanctions hit blocks the transfer, moves no money, and opens a case', async () => {
    const compliance = buildCompliance('Vorlan Krestomayer');
    const { harness, result, before } = await run(compliance);

    expect(result.status).toBe('compensated');
    expect(result.failedStep).toBe('compliance');
    expect(result.completedSteps).toEqual([]);
    expect(result.reason).toContain('sanctions_hit');

    // Not a single journal was posted beyond the seed deposit.
    expect((await harness.senderBalance()).equals(before)).toBe(true);
    harness.assertBalancedLedger();

    const cases = compliance.queue.list('sanctions');
    expect(cases).toHaveLength(1);
    expect(cases[0]!.priority).toBe('urgent');
    expect(cases[0]!.reasons.join(' ')).toContain('SYN-0001');
    expect(cases[0]!.audit[0]!.action).toBe('opened');
  });

  it('a structuring pattern blocks the transfer and opens an AML case', async () => {
    const compliance = buildCompliance();

    for (const [i, amount] of ['9500.00', '9700.00'].entries()) {
      compliance.history.record({
        transferId: `prior_${i}`,
        accountId: ACCOUNTS.senderCustomer,
        beneficiary: ACCOUNTS.beneficiaryIdentifier,
        amountEur: eur(amount),
        corridor: 'DE-KE',
        at: new Date(NOW.getTime() - (i + 1) * DAY),
      });
    }

    const { harness, result, before } = await run(compliance, '9800.00');

    expect(result.status).toBe('compensated');
    expect(result.failedStep).toBe('compliance');
    expect(result.reason).toContain('structuring');
    expect((await harness.senderBalance()).equals(before)).toBe(true);
    harness.assertBalancedLedger();

    const cases = compliance.queue.list('aml');
    expect(cases).toHaveLength(1);
    expect(cases[0]!.riskScore).toBeGreaterThanOrEqual(80);
    expect(cases[0]!.reasons.join(' ')).toContain('reporting threshold');
  });

  it('a case can be worked to a close with four-eyes approval and a full audit trail', async () => {
    const compliance = buildCompliance('Vorlan Krestomayer');
    await run(compliance);

    const record = compliance.queue.list('sanctions')[0]!;
    compliance.queue.assign(record.id, 'analyst_a');
    compliance.queue.decide(record.id, 'analyst_a', 'rejected', 'confirmed true positive');

    expect(compliance.queue.get(record.id).status).toBe('awaiting_second_approval');
    expect(() => compliance.queue.decide(record.id, 'analyst_a', 'rejected')).toThrow(
      /second, different approver/,
    );

    const closed = compliance.queue.decide(record.id, 'supervisor_b', 'rejected');
    expect(closed.status).toBe('closed');
    expect(closed.outcome).toBe('rejected');

    expect(closed.audit.map((a) => `${a.actor}:${a.action}`)).toEqual([
      'system:opened',
      'analyst_a:assigned',
      'analyst_a:decided:rejected',
      'supervisor_b:decided:rejected',
    ]);
  });

  it('an unknown sender is rejected outright', async () => {
    const queue = new ReviewQueue({ now: () => NOW });
    const screening = new ScreeningService(
      new SanctionsScreener(),
      new AmlRuleEngine(),
      queue,
      new InMemoryHistory(),
      new Map(),
      { now: () => NOW },
    );

    const { harness, result } = await run({
      screening,
      queue,
      history: new InMemoryHistory(),
    });

    expect(result.failedStep).toBe('compliance');
    expect(result.reason).toContain('unknown_sender');
    expect(queue.list('kyc')).toHaveLength(1);
    harness.assertBalancedLedger();
  });
});
