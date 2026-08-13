import { Money } from '@arc/money';
import { describe, expect, it } from 'vitest';
import { SettlementSaga, type SagaStepName } from '../src/index.js';
import { ACCOUNTS, createHarness } from './harness.js';

const ALL_STEPS: SagaStepName[] = ['compliance', 'reserve', 'swap', 'settle', 'payout'];

async function quoteFor(harness: Awaited<ReturnType<typeof createHarness>>, send = '1000.00') {
  return harness.quotes.quote({
    sendAmount: Money.parse(send, 'EUR'),
    receiveCurrency: 'KES',
    settlementAsset: 'USDC',
    corridor: 'DE-KE',
  });
}

function sagaFor(
  harness: Awaited<ReturnType<typeof createHarness>>,
  failAt?: SagaStepName,
): SettlementSaga {
  return new SettlementSaga({
    ledger: harness.ledger,
    compliance: harness.compliance,
    chain: harness.chain,
    rail: harness.rail,
    advanceChain: harness.advanceChain,
    ...(failAt
      ? {
          hooks: {
            async beforeStep(step) {
              if (step === failAt) throw new Error(`injected failure at ${step}`);
            },
          },
        }
      : {}),
  });
}

const transferInput = (quote: Awaited<ReturnType<typeof quoteFor>>) => ({
  quote,
  accounts: ACCOUNTS,
  chain: 'base' as const,
  settlementFrom: '0xarc',
  settlementTo: '0xpartner',
});

describe('the happy path', () => {
  it('completes every step and pays the beneficiary', async () => {
    const harness = await createHarness();
    const quote = await quoteFor(harness);
    const result = await sagaFor(harness).execute(transferInput(quote));

    expect(result.status).toBe('completed');
    expect(result.completedSteps).toEqual(ALL_STEPS);
    expect(result.chainTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.railReference).toMatch(/^MPESA-/);

    harness.assertBalancedLedger();
  });

  it('debits the sender exactly the send amount', async () => {
    const harness = await createHarness({ fundSender: '5000.00' });
    const quote = await quoteFor(harness, '1000.00');
    await sagaFor(harness).execute(transferInput(quote));

    expect((await harness.senderBalance()).toDecimalString()).toBe('4000.00');
  });

  it('discharges the receive obligation and keeps only the spread as float', async () => {
    const harness = await createHarness();
    const quote = await quoteFor(harness);
    await sagaFor(harness).execute(transferInput(quote));

    const { projectBalance } = await import('@arc/ledger');
    const entries = harness.store.allEntries();

    // The obligation to the beneficiary is fully discharged.
    const inTransit = projectBalance(ACCOUNTS.inTransitReceive, 'liability', 'KES', entries);
    expect(inTransit.posted.isZero).toBe(true);

    // The partner delivered at mid and the beneficiary was paid at the quoted
    // rate, so exactly the spread remains as KES float.
    const float = projectBalance(ACCOUNTS.bankFloatReceive, 'asset', 'KES', entries);
    expect(float.posted.equals(quote.receiveAtMid.subtract(quote.receiveAmount))).toBe(true);

    harness.assertBalancedLedger();
  });

  it('recognises the FX spread as revenue, not as a hidden FX position', async () => {
    const harness = await createHarness();
    const quote = await quoteFor(harness);
    await sagaFor(harness).execute(transferInput(quote));

    const { projectBalance } = await import('@arc/ledger');
    const spread = projectBalance(
      ACCOUNTS.fxSpreadReceive,
      'revenue',
      'KES',
      harness.store.allEntries(),
    );

    // The customer receives the quoted rate; the partner settles at mid. The
    // difference is Arc's margin and must appear as revenue.
    const expected = quote.receiveAtMid.subtract(quote.receiveAmount);
    expect(expected.isPositive).toBe(true);
    expect(spread.posted.equals(expected)).toBe(true);

    harness.assertBalancedLedger();
  });

  it('records the network fee as an expense against chain float', async () => {
    const harness = await createHarness();
    const quote = await quoteFor(harness);
    await sagaFor(harness).execute(transferInput(quote));

    const eth = harness.store.allEntries().filter((e) => e.amount.currency === 'ETH');
    expect(eth.length).toBe(2);
    expect(eth.some((e) => e.accountCode === ACCOUNTS.networkFeeExpense)).toBe(true);
  });
});

describe('chaos: a failure at every step unwinds to a balanced ledger', () => {
  for (const step of ALL_STEPS) {
    it(`fails at "${step}" and leaves the ledger balanced with the sender whole`, async () => {
      const harness = await createHarness({ fundSender: '5000.00' });
      const before = await harness.senderBalance();

      const quote = await quoteFor(harness, '1000.00');
      const result = await sagaFor(harness, step).execute(transferInput(quote));

      expect(result.status).toBe('compensated');
      expect(result.failedStep).toBe(step);
      expect(result.completedSteps).not.toContain(step);

      // The strongest claim this project makes.
      harness.assertBalancedLedger();

      const after = await harness.senderBalance();
      expect(after.equals(before)).toBe(true);
    });
  }

  it('leaves no residue in any intermediate account after compensation', async () => {
    for (const step of ALL_STEPS) {
      const harness = await createHarness();
      const quote = await quoteFor(harness);
      await sagaFor(harness, step).execute(transferInput(quote));

      const entries = harness.store.allEntries();
      const { projectBalance } = await import('@arc/ledger');

      for (const [code, type, currency] of [
        [ACCOUNTS.inTransitSend, 'liability', 'EUR'],
        [ACCOUNTS.inTransitReceive, 'liability', 'KES'],
        [ACCOUNTS.corridorFee, 'revenue', 'EUR'],
        [ACCOUNTS.fxSpread, 'revenue', 'EUR'],
        [ACCOUNTS.fxSpreadReceive, 'revenue', 'KES'],
        [ACCOUNTS.bankFloatReceive, 'asset', 'KES'],
      ] as const) {
        const balance = projectBalance(code, type, currency, entries);
        expect(balance.posted.isZero).toBe(true);
      }

      harness.assertBalancedLedger();
    }
  });
});

describe('compensation runs in reverse order', () => {
  it('unwinds the payout before the settlement, swap and reserve', async () => {
    const harness = await createHarness();
    const quote = await quoteFor(harness);

    // Drive a failure at the final step so every earlier compensation runs.
    const { SimulatedRail } = await import('../src/index.js');
    const failing = new SettlementSaga({
      ledger: harness.ledger,
      compliance: harness.compliance,
      chain: harness.chain,
      rail: new SimulatedRail('mpesa', {
        seed: 'order',
        config: { rejectChanceBps: 10_000, timeoutChanceBps: 0 },
      }),
      advanceChain: harness.advanceChain,
    });

    const result = await failing.execute(transferInput(quote));
    expect(result.status).toBe('compensated');

    const reversals = harness.store
      .allJournals()
      .filter((j) => j.kind === 'reversal')
      .map((j) => j.description ?? '');

    // Each reversal must describe the step it actually undoes, which only holds
    // if compensation walks the completed steps backwards.
    expect(reversals).toEqual([
      'Unwind settlement: funds recovered from partner',
      'Unwind swap',
      'Refund sender: transfer unwound',
    ]);
  });

  it('pairs each reversal with the entries it reverses', async () => {
    const harness = await createHarness();
    const quote = await quoteFor(harness);
    const result = await sagaFor(harness, 'payout').execute(transferInput(quote));
    expect(result.status).toBe('compensated');

    const journals = harness.store.allJournals();
    const settleReversal = journals.find(
      (j) => j.kind === 'reversal' && j.description?.startsWith('Unwind settlement'),
    );
    expect(settleReversal).toBeDefined();

    // The settlement journal touches the receive-currency float; its reversal
    // must touch the same accounts, not some other step's.
    const accountsTouched = settleReversal!.entries.map((e) => e.accountCode).sort();
    expect(accountsTouched).toContain(ACCOUNTS.bankFloatReceive);
    expect(accountsTouched).toContain(ACCOUNTS.chainFloat);
  });
});

describe('compliance is a hard pre-condition', () => {
  it('stops the transfer before any money moves when screening rejects', async () => {
    const harness = await createHarness();
    const quote = await quoteFor(harness);
    const before = await harness.senderBalance();

    const saga = new SettlementSaga({
      ledger: harness.ledger,
      compliance: {
        async screenTransfer() {
          return { decision: 'rejected', reasons: ['sanctions_hit'], riskScore: 95 };
        },
      },
      chain: harness.chain,
      rail: harness.rail,
      advanceChain: harness.advanceChain,
    });

    const result = await saga.execute(transferInput(quote));

    expect(result.status).toBe('compensated');
    expect(result.failedStep).toBe('compliance');
    expect(result.reason).toContain('sanctions_hit');
    expect(result.completedSteps).toEqual([]);
    expect((await harness.senderBalance()).equals(before)).toBe(true);
    harness.assertBalancedLedger();
  });

  it('routes a review verdict to the same halt', async () => {
    const harness = await createHarness();
    const quote = await quoteFor(harness);

    const saga = new SettlementSaga({
      ledger: harness.ledger,
      compliance: {
        async screenTransfer() {
          return { decision: 'review', reasons: ['velocity'], riskScore: 60 };
        },
      },
      chain: harness.chain,
      rail: harness.rail,
      advanceChain: harness.advanceChain,
    });

    expect((await saga.execute(transferInput(quote))).failedStep).toBe('compliance');
  });
});

describe('real failure modes, not just injected ones', () => {
  it('unwinds when the chain never reaches finality', async () => {
    const harness = await createHarness();
    const quote = await quoteFor(harness);
    const before = await harness.senderBalance();

    const saga = new SettlementSaga({
      ledger: harness.ledger,
      compliance: harness.compliance,
      chain: harness.chain,
      rail: harness.rail,
      // Advance far too few blocks for finality.
      advanceChain: () => harness.chain.advance(1),
    });

    const result = await saga.execute(transferInput(quote));

    expect(result.status).toBe('compensated');
    expect(result.failedStep).toBe('settle');
    expect(result.reason).toContain('finality');
    expect((await harness.senderBalance()).equals(before)).toBe(true);
    harness.assertBalancedLedger();
  });

  it('unwinds when the rail rejects the payout', async () => {
    const harness = await createHarness();
    const quote = await quoteFor(harness);
    const before = await harness.senderBalance();

    const { SimulatedRail } = await import('../src/index.js');
    const saga = new SettlementSaga({
      ledger: harness.ledger,
      compliance: harness.compliance,
      chain: harness.chain,
      rail: new SimulatedRail('mpesa', {
        seed: 'reject',
        config: { rejectChanceBps: 10_000, timeoutChanceBps: 0 },
      }),
      advanceChain: harness.advanceChain,
    });

    const result = await saga.execute(transferInput(quote));

    expect(result.status).toBe('compensated');
    expect(result.failedStep).toBe('payout');
    expect((await harness.senderBalance()).equals(before)).toBe(true);
    harness.assertBalancedLedger();
  });

  it('refuses a transfer the sender cannot fund', async () => {
    const harness = await createHarness({ fundSender: '100.00' });
    const quote = await quoteFor(harness, '1000.00');

    const result = await sagaFor(harness).execute(transferInput(quote));

    expect(result.status).toBe('compensated');
    expect(result.failedStep).toBe('reserve');
    expect(result.reason).toContain('below its floor');
    expect((await harness.senderBalance()).toDecimalString()).toBe('100.00');
    harness.assertBalancedLedger();
  });
});

describe('idempotency', () => {
  it('reuses the same chain transaction when a transfer is retried', async () => {
    const harness = await createHarness();
    const quote = await quoteFor(harness);
    const transferId = 'transfer_fixed';

    const first = await sagaFor(harness).execute({ ...transferInput(quote), transferId });
    const second = await sagaFor(harness).execute({ ...transferInput(quote), transferId });

    expect(second.chainTxHash).toBe(first.chainTxHash);
    harness.assertBalancedLedger();
  });
});
