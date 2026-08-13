import { randomUUID } from 'node:crypto';
import {
  applySpread,
  convert,
  Money,
  Rate,
  sum,
  type CurrencyCode,
  type RoundingMode,
} from '@arc/money';

export class QuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuoteError';
  }
}

export type FeeKind = 'corridor' | 'fx_spread' | 'network' | 'rounding';

export interface FeeLine {
  readonly kind: FeeKind;
  readonly amount: Money;
  readonly description: string;
}

export interface FeeSchedule {
  readonly corridorBps: bigint;
  readonly corridorFixed: Money;
  readonly fxSpreadBps: bigint;
}

export interface Quote {
  readonly id: string;
  readonly corridor: string;
  readonly sendAmount: Money;
  readonly receiveAmount: Money;
  /** What the customer would receive at mid-market. The gap is Arc's spread. */
  readonly receiveAtMid: Money;
  readonly settlementAmount: Money;
  readonly midRate: Rate;
  readonly quotedRate: Rate;
  readonly fees: readonly FeeLine[];
  readonly totalFees: Money;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface QuoteRequest {
  readonly sendAmount: Money;
  readonly receiveCurrency: CurrencyCode;
  readonly settlementAsset: CurrencyCode;
  readonly corridor: string;
  readonly networkFee?: Money;
}

export interface RateProvider {
  midRate(from: CurrencyCode, to: CurrencyCode): Promise<Rate>;
}

export class StaticRateProvider implements RateProvider {
  constructor(private readonly rates: Record<string, string>) {}

  async midRate(from: CurrencyCode, to: CurrencyCode): Promise<Rate> {
    const direct = this.rates[`${from}/${to}`];
    if (direct) return Rate.parse(direct, from, to);
    const inverse = this.rates[`${to}/${from}`];
    if (inverse) return Rate.parse(inverse, to, from).invert();
    throw new QuoteError(`no rate available for ${from}/${to}`);
  }
}

export const DEFAULT_FEES: FeeSchedule = {
  corridorBps: 45n,
  corridorFixed: Money.parse('0.35', 'EUR'),
  fxSpreadBps: 60n,
};

const ROUNDING: RoundingMode = 'HALF_EVEN';

export interface QuoteEngineOptions {
  ttlMs?: number;
  fees?: FeeSchedule;
  now?: () => Date;
}

export class QuoteEngine {
  private readonly ttlMs: number;
  private readonly fees: FeeSchedule;
  private readonly now: () => Date;

  constructor(
    private readonly rates: RateProvider,
    options: QuoteEngineOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 30_000;
    this.fees = options.fees ?? DEFAULT_FEES;
    this.now = options.now ?? (() => new Date());
  }

  async quote(request: QuoteRequest): Promise<Quote> {
    if (!request.sendAmount.isPositive) {
      throw new QuoteError('send amount must be positive');
    }

    const sendCurrency = request.sendAmount.currency;

    const corridorFee = request.sendAmount
      .applyBps(this.fees.corridorBps, ROUNDING)
      .add(await this.feeInSendCurrency(this.fees.corridorFixed, sendCurrency));

    const networkFee = request.networkFee
      ? await this.feeInSendCurrency(request.networkFee, sendCurrency)
      : Money.zero(sendCurrency);

    const afterFees = request.sendAmount.subtract(corridorFee).subtract(networkFee);
    if (!afterFees.isPositive) {
      throw new QuoteError(
        `fees of ${corridorFee.add(networkFee).toDecimalString()} exceed the send amount`,
      );
    }

    const midRate = await this.rates.midRate(sendCurrency, request.receiveCurrency);
    const quotedRate = applySpread(midRate, this.fees.fxSpreadBps, ROUNDING);

    const atMid = convert(afterFees, midRate, ROUNDING).converted;
    const conversion = convert(afterFees, quotedRate, ROUNDING);
    const receiveAmount = conversion.converted;

    const spreadInReceive = atMid.subtract(receiveAmount);

    const settlementRate = await this.rates.midRate(sendCurrency, request.settlementAsset);
    const settlementAmount = convert(afterFees, settlementRate, ROUNDING).converted;

    const fees: FeeLine[] = [
      {
        kind: 'corridor',
        amount: corridorFee,
        description: `${this.fees.corridorBps}bp + ${this.fees.corridorFixed.toDecimalString()} ${this.fees.corridorFixed.currency}`,
      },
      {
        kind: 'fx_spread',
        amount: spreadInReceive,
        description: `${this.fees.fxSpreadBps}bp against mid-market`,
      },
    ];
    if (networkFee.isPositive) {
      fees.push({ kind: 'network', amount: networkFee, description: 'estimated chain fee' });
    }

    const createdAt = this.now();

    return {
      id: randomUUID(),
      corridor: request.corridor,
      sendAmount: request.sendAmount,
      receiveAmount,
      receiveAtMid: atMid,
      settlementAmount,
      midRate,
      quotedRate,
      fees,
      totalFees: sum(
        fees.filter((f) => f.amount.currency === sendCurrency).map((f) => f.amount),
        sendCurrency,
      ),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + this.ttlMs),
    };
  }

  isExpired(quote: Quote): boolean {
    return this.now().getTime() >= quote.expiresAt.getTime();
  }

  assertUsable(quote: Quote): void {
    if (this.isExpired(quote)) {
      throw new QuoteError(`quote ${quote.id} expired at ${quote.expiresAt.toISOString()}`);
    }
  }

  private async feeInSendCurrency(fee: Money, sendCurrency: CurrencyCode): Promise<Money> {
    if (fee.currency === sendCurrency) return fee;
    const rate = await this.rates.midRate(fee.currency, sendCurrency);
    return convert(fee, rate, ROUNDING).converted;
  }
}
