import { Money, sum, type CurrencyCode } from '@arc/money';
import { PartnerError, type PartnerTier } from './partners.js';

export type MeteredEvent =
  'api_call' | 'transfer_completed' | 'quote_created' | 'webhook_delivered';

export interface UsageRecord {
  readonly partnerId: string;
  readonly event: MeteredEvent;
  readonly at: Date;
  /** Transfer value in EUR minor units, for value-based pricing. Zero for calls. */
  readonly valueEurMinor: bigint;
}

export interface PricingTier {
  readonly tier: PartnerTier;
  /** Monthly platform fee. */
  readonly platformFee: Money;
  /** Included transfers before per-transfer pricing applies. */
  readonly includedTransfers: number;
  readonly perTransferFee: Money;
  /** Share of corridor revenue rebated to the partner, in basis points. */
  readonly revShareBps: bigint;
  /** Value-based fee on transfer volume, in basis points. */
  readonly volumeBps: bigint;
}

export const PRICING: Record<PartnerTier, PricingTier> = {
  starter: {
    tier: 'starter',
    platformFee: Money.parse('99.00', 'EUR'),
    includedTransfers: 100,
    perTransferFee: Money.parse('0.45', 'EUR'),
    revShareBps: 0n,
    volumeBps: 15n,
  },
  growth: {
    tier: 'growth',
    platformFee: Money.parse('499.00', 'EUR'),
    includedTransfers: 2_000,
    perTransferFee: Money.parse('0.28', 'EUR'),
    revShareBps: 1_000n,
    volumeBps: 10n,
  },
  scale: {
    tier: 'scale',
    platformFee: Money.parse('2500.00', 'EUR'),
    includedTransfers: 25_000,
    perTransferFee: Money.parse('0.14', 'EUR'),
    revShareBps: 2_500n,
    volumeBps: 6n,
  },
};

export interface InvoiceLine {
  readonly description: string;
  readonly quantity: number;
  readonly amount: Money;
}

export interface Invoice {
  readonly partnerId: string;
  readonly tier: PartnerTier;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly lines: readonly InvoiceLine[];
  readonly subtotal: Money;
  readonly revShareCredit: Money;
  readonly total: Money;
  readonly transfers: number;
  readonly apiCalls: number;
}

export interface BillingOptions {
  now?: () => Date;
}

/**
 * Usage metering and billing.
 *
 * Every figure is exact integer arithmetic on minor units — an invoice is money,
 * and the same rules apply to it as to a transfer.
 */
export class UsageMeter {
  private readonly records: UsageRecord[] = [];
  private readonly now: () => Date;

  constructor(options: BillingOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  record(partnerId: string, event: MeteredEvent, valueEur?: Money): UsageRecord {
    if (valueEur && valueEur.currency !== 'EUR') {
      throw new PartnerError(`metered value must be EUR, got ${valueEur.currency}`);
    }
    const entry: UsageRecord = {
      partnerId,
      event,
      at: this.now(),
      valueEurMinor: valueEur?.amount ?? 0n,
    };
    this.records.push(entry);
    return entry;
  }

  recordsFor(partnerId: string, from?: Date, to?: Date): UsageRecord[] {
    return this.records.filter(
      (r) =>
        r.partnerId === partnerId &&
        (!from || r.at.getTime() >= from.getTime()) &&
        (!to || r.at.getTime() < to.getTime()),
    );
  }

  countOf(partnerId: string, event: MeteredEvent, from?: Date, to?: Date): number {
    return this.recordsFor(partnerId, from, to).filter((r) => r.event === event).length;
  }

  volumeEur(partnerId: string, from?: Date, to?: Date): Money {
    return sum(
      this.recordsFor(partnerId, from, to).map((r) => Money.of(r.valueEurMinor, 'EUR')),
      'EUR' as CurrencyCode,
    );
  }
}

export class BillingEngine {
  constructor(private readonly meter: UsageMeter) {}

  invoice(input: {
    partnerId: string;
    tier: PartnerTier;
    periodStart: Date;
    periodEnd: Date;
    /** Corridor revenue Arc earned on this partner's traffic, for rev-share. */
    corridorRevenue?: Money;
  }): Invoice {
    const pricing = PRICING[input.tier];
    const { partnerId, periodStart, periodEnd } = input;

    const transfers = this.meter.countOf(partnerId, 'transfer_completed', periodStart, periodEnd);
    const apiCalls = this.meter.countOf(partnerId, 'api_call', periodStart, periodEnd);
    const volume = this.meter.volumeEur(partnerId, periodStart, periodEnd);

    const billableTransfers = Math.max(0, transfers - pricing.includedTransfers);

    const lines: InvoiceLine[] = [
      { description: `${input.tier} platform fee`, quantity: 1, amount: pricing.platformFee },
    ];

    if (billableTransfers > 0) {
      lines.push({
        description: `transfers beyond the ${pricing.includedTransfers} included`,
        quantity: billableTransfers,
        amount: pricing.perTransferFee.multiply(BigInt(billableTransfers)),
      });
    }

    if (pricing.volumeBps > 0n && volume.isPositive) {
      lines.push({
        description: `${pricing.volumeBps}bp on ${volume.toDecimalString()} EUR of volume`,
        quantity: 1,
        amount: volume.applyBps(pricing.volumeBps, 'HALF_EVEN'),
      });
    }

    const subtotal = sum(
      lines.map((l) => l.amount),
      'EUR' as CurrencyCode,
    );

    const corridorRevenue = input.corridorRevenue ?? Money.zero('EUR');
    const revShareCredit = corridorRevenue.applyBps(pricing.revShareBps, 'HALF_EVEN');

    return {
      partnerId,
      tier: input.tier,
      periodStart,
      periodEnd,
      lines,
      subtotal,
      revShareCredit,
      total: subtotal.subtract(revShareCredit),
      transfers,
      apiCalls,
    };
  }
}

export interface RevShareEntry {
  readonly account: string;
  readonly direction: 'debit' | 'credit';
  readonly amount: Money;
}

/**
 * Ledger entries for an invoice.
 *
 * Partner billing is revenue, and a rev-share rebate is a reduction of it — both
 * belong in the ledger rather than in a spreadsheet beside it.
 */
export function invoiceJournalEntries(
  invoice: Invoice,
  partnerReceivable: string,
): RevShareEntry[] {
  const entries: RevShareEntry[] = [];

  if (invoice.subtotal.isPositive) {
    entries.push({ account: partnerReceivable, direction: 'debit', amount: invoice.subtotal });
    entries.push({
      account: 'revenue.partner.platform.EUR',
      direction: 'credit',
      amount: invoice.subtotal,
    });
  }

  if (invoice.revShareCredit.isPositive) {
    entries.push({
      account: 'revenue.partner.rev_share.EUR',
      direction: 'debit',
      amount: invoice.revShareCredit,
    });
    entries.push({
      account: partnerReceivable,
      direction: 'credit',
      amount: invoice.revShareCredit,
    });
  }

  return entries;
}
