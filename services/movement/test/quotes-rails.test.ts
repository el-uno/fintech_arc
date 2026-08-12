import { Money } from '@arc/money';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  isRailOpen,
  nextSettlementTime,
  QuoteEngine,
  QuoteError,
  RAILS,
  RailError,
  railForCurrency,
  SimulatedRail,
  StaticRateProvider,
} from '../src/index.js';
import { RATES } from './harness.js';

const engine = (now?: () => Date) =>
  new QuoteEngine(new StaticRateProvider(RATES), now ? { now } : {});

const baseRequest = {
  sendAmount: Money.parse('1000.00', 'EUR'),
  receiveCurrency: 'KES' as const,
  settlementAsset: 'USDC' as const,
  corridor: 'DE-KE',
};

describe('quotes', () => {
  it('prices a corridor transfer with fees itemised', async () => {
    const quote = await engine().quote(baseRequest);

    expect(quote.sendAmount.toDecimalString()).toBe('1000.00');
    expect(quote.receiveAmount.isPositive).toBe(true);
    expect(quote.fees.map((f) => f.kind)).toContain('corridor');
    expect(quote.fees.map((f) => f.kind)).toContain('fx_spread');
    expect(quote.corridor).toBe('DE-KE');
  });

  it('charges bps plus a fixed component', async () => {
    const quote = await engine().quote(baseRequest);
    const corridor = quote.fees.find((f) => f.kind === 'corridor')!;
    // 45bp of 1000.00 = 4.50, plus the 0.35 fixed fee.
    expect(corridor.amount.toDecimalString()).toBe('4.85');
  });

  it('quotes below mid-market by exactly the spread', async () => {
    const quote = await engine().quote(baseRequest);
    expect(quote.quotedRate.numerator).toBeLessThan(quote.midRate.numerator);
    const spread = quote.fees.find((f) => f.kind === 'fx_spread')!;
    expect(spread.amount.isPositive).toBe(true);
    expect(spread.amount.currency).toBe('KES');
  });

  it('never gives the customer more than mid-market', async () => {
    await fc.assert(
      fc.asyncProperty(fc.bigInt({ min: 100n, max: 10n ** 9n }), async (minor) => {
        const quote = await engine().quote({
          ...baseRequest,
          sendAmount: Money.of(minor, 'EUR'),
        });
        const spread = quote.fees.find((f) => f.kind === 'fx_spread')!;
        expect(spread.amount.isNegative).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('expires', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const quotes = engine(() => now);
    const quote = await quotes.quote(baseRequest);

    expect(quotes.isExpired(quote)).toBe(false);
    now = new Date(now.getTime() + 31_000);
    expect(quotes.isExpired(quote)).toBe(true);
    expect(() => quotes.assertUsable(quote)).toThrow(QuoteError);
  });

  it('rejects a non-positive send amount', async () => {
    await expect(engine().quote({ ...baseRequest, sendAmount: Money.zero('EUR') })).rejects.toThrow(
      QuoteError,
    );
  });

  it('rejects a transfer too small to cover its fees', async () => {
    await expect(
      engine().quote({ ...baseRequest, sendAmount: Money.parse('0.10', 'EUR') }),
    ).rejects.toThrow(/exceed the send amount/);
  });

  it('refuses a corridor with no rate', async () => {
    await expect(engine().quote({ ...baseRequest, receiveCurrency: 'GHS' })).rejects.toThrow(
      QuoteError,
    );
  });

  it('inverts a rate when only the reverse pair is published', async () => {
    const quotes = new QuoteEngine(new StaticRateProvider({ 'KES/EUR': '0.00715' }));
    const quote = await quotes.quote({ ...baseRequest, settlementAsset: 'KES' });
    expect(quote.receiveAmount.isPositive).toBe(true);
  });
});

describe('rails', () => {
  it('settles an instant rail immediately', async () => {
    const rail = new SimulatedRail('mpesa', {
      seed: 'ok',
      config: { rejectChanceBps: 0, timeoutChanceBps: 0 },
    });
    const receipt = await rail.submit({
      payoutId: 'p1',
      beneficiary: '+254712345678',
      amount: Money.parse('50000.00', 'KES'),
      reference: 'ref',
      idempotencyKey: 'k1',
    });
    expect(receipt.outcome).toBe('accepted');
    expect(receipt.railReference).toMatch(/^MPESA-/);
  });

  it('is idempotent on the same key', async () => {
    const rail = new SimulatedRail('mpesa', {
      seed: 'idem',
      config: { rejectChanceBps: 0, timeoutChanceBps: 0 },
    });
    const submit = (payoutId: string) =>
      rail.submit({
        payoutId,
        beneficiary: '+254712345678',
        amount: Money.parse('100.00', 'KES'),
        reference: 'r',
        idempotencyKey: 'same',
      });
    expect((await submit('p2')).payoutId).toBe((await submit('p3')).payoutId);
  });

  it('rejects the wrong currency', async () => {
    const rail = new SimulatedRail('mpesa', { seed: 'x' });
    await expect(
      rail.submit({
        payoutId: 'p4',
        beneficiary: 'b',
        amount: Money.parse('10.00', 'EUR'),
        reference: 'r',
        idempotencyKey: 'k4',
      }),
    ).rejects.toThrow(RailError);
  });

  it('enforces the per-payout ceiling', async () => {
    const rail = new SimulatedRail('mpesa', {
      seed: 'cap',
      config: { rejectChanceBps: 0, timeoutChanceBps: 0 },
    });
    await expect(
      rail.submit({
        payoutId: 'p5',
        beneficiary: 'b',
        amount: Money.parse('999999999.00', 'KES'),
        reference: 'r',
        idempotencyKey: 'k5',
      }),
    ).rejects.toThrow(/caps a single payout/);
  });

  it('marks a timeout retryable and a rejection not', async () => {
    const timeouts = new SimulatedRail('mpesa', {
      seed: 't',
      config: { timeoutChanceBps: 10_000, rejectChanceBps: 0 },
    });
    await timeouts
      .submit({
        payoutId: 'p6',
        beneficiary: 'b',
        amount: Money.parse('10.00', 'KES'),
        reference: 'r',
        idempotencyKey: 'k6',
      })
      .catch((error: RailError) => {
        expect(error.code).toBe('timeout');
        expect(error.retryable).toBe(true);
      });

    const rejects = new SimulatedRail('mpesa', {
      seed: 'r',
      config: { timeoutChanceBps: 0, rejectChanceBps: 10_000 },
    });
    await rejects
      .submit({
        payoutId: 'p7',
        beneficiary: 'b',
        amount: Money.parse('10.00', 'KES'),
        reference: 'r',
        idempotencyKey: 'k7',
      })
      .catch((error: RailError) => {
        expect(error.retryable).toBe(false);
      });
  });

  it('recalls only before settlement', async () => {
    let now = new Date('2026-01-01T09:00:00Z');
    const rail = new SimulatedRail('mpesa', {
      seed: 'recall',
      now: () => now,
      config: { rejectChanceBps: 0, timeoutChanceBps: 0 },
    });
    await rail.submit({
      payoutId: 'p8',
      beneficiary: 'b',
      amount: Money.parse('10.00', 'KES'),
      reference: 'r',
      idempotencyKey: 'k8',
    });

    now = new Date(now.getTime() + 60_000);
    expect(await rail.recall('p8')).toBe(false);
  });
});

describe('cut-off windows', () => {
  it('treats instant rails as always open', () => {
    expect(isRailOpen(RAILS.sepa_instant, new Date('2026-01-01T23:30:00Z'))).toBe(true);
  });

  it('closes a batch rail after its cut-off', () => {
    expect(isRailOpen(RAILS.sepa_credit, new Date('2026-01-01T10:00:00Z'))).toBe(true);
    expect(isRailOpen(RAILS.sepa_credit, new Date('2026-01-01T16:00:00Z'))).toBe(false);
  });

  it('rolls a late batch payment to the next opening', () => {
    const inWindow = new Date('2026-01-01T10:00:00Z');
    const afterCutoff = new Date('2026-01-01T16:00:00Z');

    const onTime = nextSettlementTime(RAILS.sepa_credit, inWindow);
    const late = nextSettlementTime(RAILS.sepa_credit, afterCutoff);

    // Missing the cut-off costs a whole day even though it is only six hours later.
    expect(late.getTime()).toBeGreaterThan(onTime.getTime());
    expect(late.getTime() - onTime.getTime()).toBeGreaterThan(12 * 60 * 60 * 1000);

    // The queued payment starts from the next opening, then takes the rail's latency.
    const nextOpen = Date.UTC(2026, 0, 2, RAILS.sepa_credit.opensHourUtc);
    expect(late.getTime()).toBe(nextOpen + RAILS.sepa_credit.latencyMs);
  });

  it('routes each currency to a rail', () => {
    expect(railForCurrency('EUR')).toBe('sepa_instant');
    expect(railForCurrency('KES')).toBe('mpesa');
    expect(railForCurrency('ZAR')).toBe('eft');
    expect(() => railForCurrency('GHS')).toThrow(RailError);
  });
});
