import { createRng, type Rng } from '@arc/chain';
import type { CurrencyCode, Money } from '@arc/money';

export type RailId = 'sepa_instant' | 'sepa_credit' | 'faster_payments' | 'nip' | 'mpesa' | 'eft';

export type RailOutcome = 'accepted' | 'rejected' | 'timeout';

export type RailFailureCode =
  | 'account_closed'
  | 'invalid_beneficiary'
  | 'beneficiary_limit_exceeded'
  | 'rail_unavailable'
  | 'compliance_hold'
  | 'timeout';

export class RailError extends Error {
  constructor(
    readonly code: RailFailureCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'RailError';
  }
}

export interface RailConfig {
  readonly id: RailId;
  readonly currency: CurrencyCode;
  readonly instant: boolean;
  /** Typical settlement latency once accepted. */
  readonly latencyMs: number;
  /** Cut-off hour in UTC after which non-instant rails queue to the next day. */
  readonly cutoffHourUtc: number | null;
  readonly opensHourUtc: number;
  readonly rejectChanceBps: number;
  readonly timeoutChanceBps: number;
  readonly maxAmountMinor: bigint;
}

export const RAILS: Record<RailId, RailConfig> = {
  sepa_instant: {
    id: 'sepa_instant',
    currency: 'EUR',
    instant: true,
    latencyMs: 4_000,
    cutoffHourUtc: null,
    opensHourUtc: 0,
    rejectChanceBps: 120,
    timeoutChanceBps: 40,
    maxAmountMinor: 10_000_000n,
  },
  sepa_credit: {
    id: 'sepa_credit',
    currency: 'EUR',
    instant: false,
    latencyMs: 86_400_000,
    cutoffHourUtc: 15,
    opensHourUtc: 6,
    rejectChanceBps: 90,
    timeoutChanceBps: 30,
    maxAmountMinor: 100_000_000_00n,
  },
  faster_payments: {
    id: 'faster_payments',
    currency: 'GBP',
    instant: true,
    latencyMs: 6_000,
    cutoffHourUtc: null,
    opensHourUtc: 0,
    rejectChanceBps: 100,
    timeoutChanceBps: 50,
    maxAmountMinor: 100_000_00n,
  },
  nip: {
    id: 'nip',
    currency: 'NGN',
    instant: true,
    latencyMs: 12_000,
    cutoffHourUtc: null,
    opensHourUtc: 0,
    rejectChanceBps: 260,
    timeoutChanceBps: 180,
    maxAmountMinor: 50_000_000_00n,
  },
  mpesa: {
    id: 'mpesa',
    currency: 'KES',
    instant: true,
    latencyMs: 9_000,
    cutoffHourUtc: null,
    opensHourUtc: 0,
    rejectChanceBps: 200,
    timeoutChanceBps: 220,
    maxAmountMinor: 500_000_00n,
  },
  eft: {
    id: 'eft',
    currency: 'ZAR',
    instant: false,
    latencyMs: 172_800_000,
    cutoffHourUtc: 14,
    opensHourUtc: 6,
    rejectChanceBps: 140,
    timeoutChanceBps: 60,
    maxAmountMinor: 10_000_000_00n,
  },
};

export interface PayoutRequest {
  readonly payoutId: string;
  readonly beneficiary: string;
  readonly amount: Money;
  readonly reference: string;
  readonly idempotencyKey: string;
}

export interface PayoutReceipt {
  readonly payoutId: string;
  readonly rail: RailId;
  readonly railReference: string;
  readonly outcome: RailOutcome;
  readonly settlesAt: Date;
  readonly amount: Money;
}

export interface BankRail {
  readonly id: RailId;
  readonly config: RailConfig;
  submit(request: PayoutRequest): Promise<PayoutReceipt>;
  /** Ask the rail to return funds. Returns false when the payout already settled. */
  recall(payoutId: string): Promise<boolean>;
  status(payoutId: string): Promise<PayoutReceipt | undefined>;
}

export interface RailOptions {
  seed?: string;
  now?: () => Date;
  config?: Partial<RailConfig>;
}

export function isRailOpen(config: RailConfig, at: Date): boolean {
  if (config.instant) return true;
  const hour = at.getUTCHours();
  if (config.cutoffHourUtc === null) return true;
  return hour >= config.opensHourUtc && hour < config.cutoffHourUtc;
}

export function nextSettlementTime(config: RailConfig, at: Date): Date {
  if (config.instant) return new Date(at.getTime() + config.latencyMs);
  if (isRailOpen(config, at)) return new Date(at.getTime() + config.latencyMs);

  const next = new Date(at);
  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(config.opensHourUtc, 0, 0, 0);
  return new Date(next.getTime() + config.latencyMs);
}

export class SimulatedRail implements BankRail {
  readonly id: RailId;
  readonly config: RailConfig;

  private readonly rng: Rng;
  private readonly now: () => Date;
  private readonly receipts = new Map<string, PayoutReceipt>();
  private readonly byIdempotencyKey = new Map<string, string>();

  constructor(id: RailId, options: RailOptions = {}) {
    this.id = id;
    this.config = { ...RAILS[id], ...options.config };
    this.rng = createRng(options.seed ?? `arc:rail:${id}`);
    this.now = options.now ?? (() => new Date());
  }

  async submit(request: PayoutRequest): Promise<PayoutReceipt> {
    const existing = this.byIdempotencyKey.get(request.idempotencyKey);
    if (existing) return this.receipts.get(existing)!;

    if (request.amount.currency !== this.config.currency) {
      throw new RailError(
        'invalid_beneficiary',
        `${this.id} settles ${this.config.currency}, not ${request.amount.currency}`,
        false,
      );
    }

    if (request.amount.amount > this.config.maxAmountMinor) {
      throw new RailError(
        'beneficiary_limit_exceeded',
        `${this.id} caps a single payout at ${this.config.maxAmountMinor} minor units`,
        false,
      );
    }

    if (this.rng.chance(this.config.timeoutChanceBps)) {
      throw new RailError('timeout', `${this.id} did not respond`, true);
    }

    if (this.rng.chance(this.config.rejectChanceBps)) {
      const codes: RailFailureCode[] = ['account_closed', 'invalid_beneficiary', 'compliance_hold'];
      const code = codes[this.rng.int(codes.length)]!;
      throw new RailError(code, `${this.id} rejected the payout: ${code}`, false);
    }

    const at = this.now();
    const receipt: PayoutReceipt = {
      payoutId: request.payoutId,
      rail: this.id,
      railReference: `${this.id.toUpperCase()}-${this.rng.hex(12)}`,
      outcome: 'accepted',
      settlesAt: nextSettlementTime(this.config, at),
      amount: request.amount,
    };

    this.receipts.set(request.payoutId, receipt);
    this.byIdempotencyKey.set(request.idempotencyKey, request.payoutId);
    return receipt;
  }

  async recall(payoutId: string): Promise<boolean> {
    const receipt = this.receipts.get(payoutId);
    if (!receipt) return false;
    if (this.now().getTime() >= receipt.settlesAt.getTime()) return false;
    this.receipts.delete(payoutId);
    return true;
  }

  async status(payoutId: string): Promise<PayoutReceipt | undefined> {
    return this.receipts.get(payoutId);
  }
}

export function railForCurrency(currency: CurrencyCode, instant = true): RailId {
  const match = (Object.keys(RAILS) as RailId[]).find(
    (id) => RAILS[id].currency === currency && RAILS[id].instant === instant,
  );
  if (match) return match;
  const fallback = (Object.keys(RAILS) as RailId[]).find((id) => RAILS[id].currency === currency);
  if (!fallback) throw new RailError('rail_unavailable', `no rail settles ${currency}`, false);
  return fallback;
}
