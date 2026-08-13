import { Money } from '@arc/money';
import { ReviewQueue } from '@arc/risk';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  corridorSummary,
  credit,
  debit,
  floatPosition,
  InMemoryLedgerStore,
  internalRecordsFrom,
  PostingEngine,
  profitAndLoss,
  raiseCases,
  Reconciler,
  statement,
  SYSTEM_ACCOUNTS,
  trialBalance,
  type CaseOpener,
  type ExternalRecord,
  type InternalRecord,
} from '../src/index.js';

const NOW = new Date('2026-06-01T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 60 * 60 * 1000;
const eur = (v: string) => Money.parse(v, 'EUR');

const internal = (reference: string, amount: string, at = ago(24 * HOUR)): InternalRecord => ({
  reference,
  amount: eur(amount),
  at,
  accountCode: SYSTEM_ACCOUNTS.bankFloat('EUR'),
});

const external = (reference: string, amount: string, at = ago(24 * HOUR)): ExternalRecord => ({
  source: 'bank',
  externalId: `SEPA-${reference}`,
  reference,
  amount: eur(amount),
  at,
  accountCode: SYSTEM_ACCOUNTS.bankFloat('EUR'),
});

describe('three-way reconciliation', () => {
  const reconciler = new Reconciler({ now: () => NOW, settlementWindowMs: 6 * HOUR });

  it('matches records that agree', () => {
    const result = reconciler.reconcile(
      'bank',
      [internal('t_1', '100.00'), internal('t_2', '250.00')],
      [external('t_1', '100.00'), external('t_2', '250.00')],
      'EUR',
    );

    expect(result.matched).toBe(2);
    expect(result.breaks).toEqual([]);
    expect(result.difference.isZero).toBe(true);
  });

  it('detects a payout the ledger recorded but the bank never made', () => {
    const result = reconciler.reconcile('bank', [internal('t_1', '100.00')], [], 'EUR');

    expect(result.breaks).toHaveLength(1);
    expect(result.breaks[0]!.kind).toBe('missing_external');
    expect(result.breaks[0]!.severity).toBe('high');
    expect(result.breaks[0]!.internal!.toDecimalString()).toBe('100.00');
  });

  it('detects money the bank moved that the ledger never recorded', () => {
    const result = reconciler.reconcile('bank', [], [external('t_9', '75.00')], 'EUR');

    expect(result.breaks[0]!.kind).toBe('missing_internal');
    expect(result.breaks[0]!.external!.toDecimalString()).toBe('75.00');
  });

  it('detects an amount mismatch and reports the difference', () => {
    const result = reconciler.reconcile(
      'bank',
      [internal('t_1', '100.00')],
      [external('t_1', '99.50')],
      'EUR',
    );

    const found = result.breaks[0]!;
    expect(found.kind).toBe('amount_mismatch');
    expect(found.difference!.toDecimalString()).toBe('0.50');
    expect(found.detail).toContain('100.00');
    expect(found.detail).toContain('99.50');
  });

  it('detects a duplicate external record — a double payout', () => {
    const result = reconciler.reconcile(
      'bank',
      [internal('t_1', '100.00')],
      [external('t_1', '100.00'), { ...external('t_1', '100.00'), externalId: 'SEPA-dup' }],
      'EUR',
    );

    expect(result.breaks[0]!.kind).toBe('duplicate_external');
    expect(result.breaks[0]!.external!.toDecimalString()).toBe('200.00');
  });

  it('does not raise a break for a transfer still inside the settlement window', () => {
    const result = reconciler.reconcile('bank', [internal('t_1', '100.00', ago(HOUR))], [], 'EUR');

    // A rail that has not reported in an hour is normal, not a break.
    expect(result.breaks).toEqual([]);
    expect(result.pending).toBe(1);
  });

  it('raises a break once the settlement window has passed', () => {
    const result = reconciler.reconcile(
      'bank',
      [internal('t_1', '100.00', ago(12 * HOUR))],
      [],
      'EUR',
    );
    expect(result.breaks[0]!.kind).toBe('missing_external');
    expect(result.pending).toBe(0);
  });

  it('reconciles the chain source independently of the bank', () => {
    const chainRecord: ExternalRecord = {
      source: 'chain',
      externalId: '0xabc',
      reference: 't_1',
      amount: Money.parse('100.000000', 'USDC'),
      at: ago(24 * HOUR),
      accountCode: SYSTEM_ACCOUNTS.chainFloat('USDC'),
    };

    const result = reconciler.reconcile(
      'chain',
      [
        {
          reference: 't_1',
          amount: Money.parse('100.000000', 'USDC'),
          at: ago(24 * HOUR),
          accountCode: SYSTEM_ACCOUNTS.chainFloat('USDC'),
        },
      ],
      [chainRecord, external('t_1', '100.00')],
      'USDC',
    );

    // The bank record for the same reference is ignored by a chain run.
    expect(result.matched).toBe(1);
    expect(result.breaks).toEqual([]);
  });

  it('refuses ambiguous input rather than guessing', () => {
    expect(() =>
      reconciler.reconcile('bank', [internal('t_1', '10.00'), internal('t_1', '20.00')], [], 'EUR'),
    ).toThrow(/appears twice/);
  });

  it('reports totals on both sides so the gap is visible at a glance', () => {
    const result = reconciler.reconcile(
      'bank',
      [internal('t_1', '100.00'), internal('t_2', '50.00')],
      [external('t_1', '100.00')],
      'EUR',
    );

    expect(result.internalTotal.toDecimalString()).toBe('150.00');
    expect(result.externalTotal.toDecimalString()).toBe('100.00');
    expect(result.difference.toDecimalString()).toBe('50.00');
  });
});

describe('breaks become cases', () => {
  let queue: ReviewQueue;
  let opener: CaseOpener;

  beforeEach(() => {
    queue = new ReviewQueue({ now: () => NOW });
    // The risk context supplies the queue; the ledger only knows this interface.
    opener = { open: (request) => queue.open(request) };
  });

  it('opens an urgent case for a high-severity break', () => {
    const reconciler = new Reconciler({ now: () => NOW });
    const result = reconciler.reconcile(
      'bank',
      [internal('t_1', '100.00', ago(48 * HOUR))],
      [],
      'EUR',
    );

    const raised = raiseCases(result, opener);

    expect(raised).toHaveLength(1);
    const record = queue.get(raised[0]!.caseId);
    expect(record.queue).toBe('reconciliation');
    expect(record.priority).toBe('urgent');
    expect(record.subjectId).toBe('t_1');
    expect(record.reasons[0]).toContain('missing_external');
    expect(record.audit[0]!.action).toBe('opened');
  });

  it('opens one case per break', () => {
    const reconciler = new Reconciler({ now: () => NOW });
    const result = reconciler.reconcile(
      'bank',
      [internal('t_1', '100.00', ago(48 * HOUR)), internal('t_2', '50.00', ago(48 * HOUR))],
      [external('t_2', '49.00')],
      'EUR',
    );

    expect(raiseCases(result, opener)).toHaveLength(2);
    expect(queue.list('reconciliation')).toHaveLength(2);
  });

  it('a clean run opens nothing', () => {
    const reconciler = new Reconciler({ now: () => NOW });
    const result = reconciler.reconcile(
      'bank',
      [internal('t_1', '100.00')],
      [external('t_1', '100.00')],
      'EUR',
    );

    expect(raiseCases(result, opener)).toEqual([]);
    expect(queue.list()).toHaveLength(0);
  });

  it('a case can be worked to a close, which is the runbook resolution path', () => {
    const reconciler = new Reconciler({ now: () => NOW });
    const result = reconciler.reconcile(
      'bank',
      [internal('t_1', '100.00', ago(48 * HOUR))],
      [],
      'EUR',
    );
    const [raised] = raiseCases(result, opener);

    queue.assign(raised!.caseId, 'ops_a');
    queue.decide(raised!.caseId, 'ops_a', 'approved', 'rail confirmed the payout was never sent');

    const closed = queue.get(raised!.caseId);
    // reconciliation is not a four-eyes queue, so one decision closes it.
    expect(closed.status).toBe('closed');
    expect(closed.audit.map((a) => a.action)).toEqual(['opened', 'assigned', 'decided:approved']);
  });
});

describe('projecting ledger entries for reconciliation', () => {
  it('nets a reference to a single signed amount', async () => {
    const store = new InMemoryLedgerStore();
    const engine = new PostingEngine(store);

    await store.createAccount({
      code: SYSTEM_ACCOUNTS.bankFloat('EUR'),
      name: 'float',
      type: 'asset',
      currency: 'EUR',
      overdraftFloor: -(10n ** 12n),
    });
    await store.createAccount({
      code: SYSTEM_ACCOUNTS.customer('va_1', 'EUR'),
      name: 'customer',
      type: 'liability',
      currency: 'EUR',
      overdraftFloor: -(10n ** 12n),
    });

    await engine.post({
      kind: 'transfer',
      referenceId: 'ref_1',
      entries: [
        debit(SYSTEM_ACCOUNTS.bankFloat('EUR'), eur('100.00')),
        credit(SYSTEM_ACCOUNTS.customer('va_1', 'EUR'), eur('100.00')),
      ],
    });

    const journals = store.allJournals();
    const entries = store.allEntries();

    const records = internalRecordsFrom(entries, {
      accountCode: SYSTEM_ACCOUNTS.bankFloat('EUR'),
      referenceOf: () => journals[0]!.referenceId,
      at: () => journals[0]!.postedAt,
    });

    expect(records).toHaveLength(1);
    expect(records[0]!.reference).toBe('ref_1');
    expect(records[0]!.amount.toDecimalString()).toBe('100.00');
  });
});

describe('reporting', () => {
  let store: InMemoryLedgerStore;
  let engine: PostingEngine;

  beforeEach(async () => {
    store = new InMemoryLedgerStore();
    engine = new PostingEngine(store);

    const wide = -(10n ** 12n);
    for (const [code, type] of [
      [SYSTEM_ACCOUNTS.bankFloat('EUR'), 'asset'],
      [SYSTEM_ACCOUNTS.customer('va_1', 'EUR'), 'liability'],
      [SYSTEM_ACCOUNTS.inTransit('EUR'), 'liability'],
      [SYSTEM_ACCOUNTS.corridorFee('EUR'), 'revenue'],
      [SYSTEM_ACCOUNTS.networkFee('EUR'), 'expense'],
    ] as const) {
      await store.createAccount({
        code,
        name: code,
        type,
        currency: 'EUR',
        overdraftFloor: wide,
      });
    }

    await engine.post({
      kind: 'transfer',
      referenceId: 'deposit',
      entries: [
        debit(SYSTEM_ACCOUNTS.bankFloat('EUR'), eur('1000.00')),
        credit(SYSTEM_ACCOUNTS.customer('va_1', 'EUR'), eur('1000.00')),
      ],
    });

    await engine.post({
      kind: 'transfer',
      referenceId: 'transfer_1',
      description: 'corridor transfer',
      entries: [
        debit(SYSTEM_ACCOUNTS.customer('va_1', 'EUR'), eur('100.00')),
        credit(SYSTEM_ACCOUNTS.inTransit('EUR'), eur('94.00')),
        credit(SYSTEM_ACCOUNTS.corridorFee('EUR'), eur('6.00')),
      ],
    });

    await engine.post({
      kind: 'fee',
      referenceId: 'transfer_1',
      entries: [
        debit(SYSTEM_ACCOUNTS.networkFee('EUR'), eur('1.50')),
        credit(SYSTEM_ACCOUNTS.bankFloat('EUR'), eur('1.50')),
      ],
    });
  });

  it('reports P&L per currency', () => {
    const pnl = profitAndLoss(store.allEntries()).get('EUR')!;

    expect(pnl.revenue.toDecimalString()).toBe('6.00');
    expect(pnl.expenses.toDecimalString()).toBe('1.50');
    expect(pnl.net.toDecimalString()).toBe('4.50');
  });

  it('answers whether Arc holds what it owes', () => {
    const position = floatPosition(store.allEntries()).get('EUR')!;

    // Holds 998.50 of float; owes 900.00 to the customer and 94.00 in transit.
    expect(position.assets.toDecimalString()).toBe('998.50');
    expect(position.liabilities.toDecimalString()).toBe('994.00');
    expect(position.surplus.toDecimalString()).toBe('4.50');
    expect(position.covered).toBe(true);
  });

  it('flags an uncovered currency even though the ledger balances', async () => {
    // A loss: float leaves as an expense, so assets fall while what Arc owes
    // customers does not. Equity absorbs the difference, so the books still
    // balance — which is exactly why the trial balance cannot catch this.
    await engine.post({
      kind: 'fee',
      referenceId: 'loss',
      entries: [
        debit(SYSTEM_ACCOUNTS.networkFee('EUR'), eur('500.00')),
        credit(SYSTEM_ACCOUNTS.bankFloat('EUR'), eur('500.00')),
      ],
    });

    const entries = store.allEntries();

    // The books still balance …
    for (const [, totals] of trialBalance(entries)) {
      expect(totals.difference.isZero).toBe(true);
    }

    // … but Arc now owes more than it holds.
    const position = floatPosition(entries).get('EUR')!;
    expect(position.covered).toBe(false);
    expect(position.surplus.isNegative).toBe(true);
  });

  it('produces a statement with a running balance', () => {
    const result = statement(
      SYSTEM_ACCOUNTS.customer('va_1', 'EUR'),
      'liability',
      'EUR',
      store.allJournals(),
    );

    expect(result.opening.isZero).toBe(true);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]!.runningBalance.toDecimalString()).toBe('1000.00');
    expect(result.lines[1]!.runningBalance.toDecimalString()).toBe('900.00');
    expect(result.closing.toDecimalString()).toBe('900.00');
  });

  it('summarises volume and revenue by corridor', () => {
    const summary = corridorSummary(
      store.allJournals(),
      (journal) => (journal.referenceId === 'transfer_1' ? 'DE-KE' : undefined),
      'EUR',
    );

    expect(summary).toHaveLength(1);
    expect(summary[0]!.corridor).toBe('DE-KE');
    expect(summary[0]!.transfers).toBe(1);
    expect(summary[0]!.volume.toDecimalString()).toBe('100.00');
    expect(summary[0]!.revenue.toDecimalString()).toBe('6.00');
    expect(summary[0]!.expenses.toDecimalString()).toBe('1.50');
    expect(summary[0]!.net.toDecimalString()).toBe('4.50');
  });
});

describe('the runbook resolves an injected break, end to end', () => {
  /**
   * The Phase 8 acceptance criterion. A payout the ledger recorded but the bank
   * never made: detected, cased, and resolved by following
   * docs/runbooks/reconciliation-break.md Resolution A — with no edit to any
   * existing entry.
   */
  it('detects, cases, and resolves a payout the bank never made', async () => {
    const store = new InMemoryLedgerStore();
    const engine = new PostingEngine(store);
    const wide = -(10n ** 12n);

    for (const [code, type] of [
      [SYSTEM_ACCOUNTS.bankFloat('EUR'), 'asset'],
      [SYSTEM_ACCOUNTS.customer('va_1', 'EUR'), 'liability'],
      [SYSTEM_ACCOUNTS.inTransit('EUR'), 'liability'],
    ] as const) {
      await store.createAccount({ code, name: code, type, currency: 'EUR', overdraftFloor: wide });
    }

    // Fund, then pay out. The ledger believes the money left.
    await engine.post({
      kind: 'transfer',
      referenceId: 'deposit',
      entries: [
        debit(SYSTEM_ACCOUNTS.bankFloat('EUR'), eur('1000.00')),
        credit(SYSTEM_ACCOUNTS.customer('va_1', 'EUR'), eur('1000.00')),
      ],
    });
    await engine.post({
      kind: 'transfer',
      referenceId: 'payout_1',
      entries: [
        debit(SYSTEM_ACCOUNTS.customer('va_1', 'EUR'), eur('400.00')),
        credit(SYSTEM_ACCOUNTS.inTransit('EUR'), eur('400.00')),
      ],
    });
    await engine.post({
      kind: 'settlement',
      referenceId: 'payout_1',
      description: 'Payout to beneficiary',
      entries: [
        debit(SYSTEM_ACCOUNTS.inTransit('EUR'), eur('400.00')),
        credit(SYSTEM_ACCOUNTS.bankFloat('EUR'), eur('400.00')),
      ],
    });

    // The books balance and Arc looks covered — the break is invisible here.
    for (const [, totals] of trialBalance(store.allEntries())) {
      expect(totals.difference.isZero).toBe(true);
    }

    // The bank statement arrives with no record of the payout.
    const reconciler = new Reconciler({ now: () => NOW, settlementWindowMs: 6 * HOUR });
    const ledgerView: InternalRecord[] = [
      {
        reference: 'payout_1',
        amount: eur('400.00'),
        at: ago(24 * HOUR),
        accountCode: SYSTEM_ACCOUNTS.bankFloat('EUR'),
      },
    ];

    const before = reconciler.reconcile('bank', ledgerView, [], 'EUR');

    // 1. Detected.
    expect(before.breaks).toHaveLength(1);
    expect(before.breaks[0]!.kind).toBe('missing_external');
    expect(before.difference.toDecimalString()).toBe('400.00');

    // 2. Cased, with an SLA and an audit trail.
    const queue = new ReviewQueue({ now: () => NOW });
    const [raised] = raiseCases(before, { open: (request) => queue.open(request) });
    const opened = queue.get(raised!.caseId);
    expect(opened.priority).toBe('urgent');
    expect(opened.slaExpiresAt.getTime() - NOW.getTime()).toBe(HOUR);

    // 3. Resolution A: reverse the payout. A new journal, never an edit.
    const correction = await engine.post({
      kind: 'reversal',
      referenceId: 'payout_1',
      description: 'Runbook resolution A: payout never left the rail',
      entries: [
        debit(SYSTEM_ACCOUNTS.bankFloat('EUR'), eur('400.00')),
        credit(SYSTEM_ACCOUNTS.inTransit('EUR'), eur('400.00')),
      ],
    });

    // 4. Re-reconcile. The ledger no longer claims the payout left.
    const after = reconciler.reconcile('bank', [], [], 'EUR');
    expect(after.breaks).toEqual([]);
    expect(after.difference.isZero).toBe(true);

    // 5. Both health checks pass — they are different questions.
    const entries = store.allEntries();
    for (const [, totals] of trialBalance(entries)) {
      expect(totals.difference.isZero).toBe(true);
    }
    expect(floatPosition(entries).get('EUR')!.covered).toBe(true);

    // The obligation to the beneficiary is back where it belongs.
    const position = floatPosition(entries).get('EUR')!;
    expect(position.assets.toDecimalString()).toBe('1000.00');
    expect(position.liabilities.toDecimalString()).toBe('1000.00');

    // 6. Close the case, citing the correcting journal.
    queue.assign(raised!.caseId, 'ops_a');
    const closed = queue.decide(
      raised!.caseId,
      'ops_a',
      'approved',
      `reversed by journal ${correction.id}`,
    );

    expect(closed.status).toBe('closed');
    expect(closed.audit.at(-1)!.detail).toContain(correction.id);

    // Nothing was edited: the original settlement journal is still in the record.
    expect(store.allJournals().map((j) => j.kind)).toEqual([
      'transfer',
      'transfer',
      'settlement',
      'reversal',
    ]);
  });
});
