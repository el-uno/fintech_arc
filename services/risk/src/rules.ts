import { divRound, Money, sum, type CurrencyCode } from '@arc/money';

export type RuleId =
  'structuring' | 'velocity' | 'unusual_corridor' | 'round_tripping' | 'counterparty_concentration';

export type Severity = 'low' | 'medium' | 'high';

export interface TransferObservation {
  readonly transferId: string;
  readonly accountId: string;
  readonly beneficiary: string;
  readonly amountEur: Money;
  readonly corridor: string;
  readonly at: Date;
}

export interface RuleContext {
  readonly candidate: TransferObservation;
  /** Prior transfers for this account, most recent first. */
  readonly history: readonly TransferObservation[];
  readonly now: Date;
}

export interface RuleHit {
  readonly rule: RuleId;
  readonly severity: Severity;
  readonly score: number;
  readonly reason: string;
  readonly evidence: readonly string[];
}

export interface Rule {
  readonly id: RuleId;
  readonly severity: Severity;
  evaluate(context: RuleContext): RuleHit | undefined;
}

export interface RuleThresholds {
  /** Reporting threshold transfers are structured to stay under. */
  readonly reportingThresholdEurMinor: bigint;
  /** How close to the threshold counts as "just under", in bps of the threshold. */
  readonly structuringBandBps: number;
  readonly structuringWindowMs: number;
  readonly structuringMinCount: number;
  readonly velocityWindowMs: number;
  readonly velocityMaxCount: number;
  readonly velocityMaxTotalEurMinor: bigint;
  readonly roundTripWindowMs: number;
  readonly concentrationWindowMs: number;
  readonly concentrationBps: number;
  readonly concentrationMinCount: number;
}

export const DEFAULT_THRESHOLDS: RuleThresholds = {
  reportingThresholdEurMinor: 10_000_00n,
  structuringBandBps: 1_500,
  structuringWindowMs: 7 * 24 * 60 * 60 * 1000,
  structuringMinCount: 3,
  velocityWindowMs: 24 * 60 * 60 * 1000,
  velocityMaxCount: 8,
  velocityMaxTotalEurMinor: 25_000_00n,
  roundTripWindowMs: 3 * 24 * 60 * 60 * 1000,
  concentrationWindowMs: 30 * 24 * 60 * 60 * 1000,
  concentrationBps: 8_000,
  concentrationMinCount: 4,
};

function within(observation: TransferObservation, now: Date, windowMs: number): boolean {
  return now.getTime() - observation.at.getTime() <= windowMs;
}

function eur(minor: bigint): Money {
  return Money.of(minor, 'EUR' as CurrencyCode);
}

export function createRules(thresholds: RuleThresholds = DEFAULT_THRESHOLDS): Rule[] {
  const bandFloor =
    thresholds.reportingThresholdEurMinor -
    (thresholds.reportingThresholdEurMinor * BigInt(thresholds.structuringBandBps)) / 10_000n;

  return [
    {
      id: 'structuring',
      severity: 'high',
      evaluate({ candidate, history, now }) {
        const inBand = [candidate, ...history]
          .filter((o) => within(o, now, thresholds.structuringWindowMs))
          .filter(
            (o) =>
              o.amountEur.amount >= bandFloor &&
              o.amountEur.amount < thresholds.reportingThresholdEurMinor,
          );

        if (inBand.length < thresholds.structuringMinCount) return undefined;

        return {
          rule: 'structuring',
          severity: 'high',
          score: Math.min(100, 60 + inBand.length * 8),
          reason:
            `${inBand.length} transfers just below the ` +
            `${eur(thresholds.reportingThresholdEurMinor).toDecimalString()} EUR reporting threshold`,
          evidence: inBand.map((o) => `${o.transferId}:${o.amountEur.toDecimalString()}`),
        };
      },
    },

    {
      id: 'velocity',
      severity: 'medium',
      evaluate({ candidate, history, now }) {
        const recent = [candidate, ...history].filter((o) =>
          within(o, now, thresholds.velocityWindowMs),
        );
        const total = sum(
          recent.map((o) => o.amountEur),
          'EUR' as CurrencyCode,
        );

        const countBreach = recent.length > thresholds.velocityMaxCount;
        const valueBreach = total.amount > thresholds.velocityMaxTotalEurMinor;
        if (!countBreach && !valueBreach) return undefined;

        return {
          rule: 'velocity',
          severity: 'medium',
          score: countBreach && valueBreach ? 70 : 45,
          reason:
            `${recent.length} transfers totalling ${total.toDecimalString()} EUR ` +
            `in ${Math.trunc(thresholds.velocityWindowMs / 3_600_000)}h`,
          evidence: recent.slice(0, 10).map((o) => o.transferId),
        };
      },
    },

    {
      id: 'unusual_corridor',
      severity: 'low',
      evaluate({ candidate, history }) {
        if (history.length < 3) return undefined;
        const seen = new Set(history.map((o) => o.corridor));
        if (seen.has(candidate.corridor)) return undefined;

        return {
          rule: 'unusual_corridor',
          severity: 'low',
          score: 25,
          reason: `first transfer on corridor ${candidate.corridor}`,
          evidence: [...seen].slice(0, 5).map((c) => `previously: ${c}`),
        };
      },
    },

    {
      id: 'round_tripping',
      severity: 'high',
      evaluate({ candidate, history, now }) {
        const returning = history
          .filter((o) => within(o, now, thresholds.roundTripWindowMs))
          .filter((o) => o.beneficiary === candidate.accountId)
          .filter((o) => candidate.beneficiary === o.accountId);

        if (returning.length === 0) return undefined;

        return {
          rule: 'round_tripping',
          severity: 'high',
          score: 80,
          reason: 'funds returning to a counterparty that recently sent to this account',
          evidence: returning.map((o) => o.transferId),
        };
      },
    },

    {
      id: 'counterparty_concentration',
      severity: 'medium',
      evaluate({ candidate, history, now }) {
        const recent = [candidate, ...history].filter((o) =>
          within(o, now, thresholds.concentrationWindowMs),
        );
        if (recent.length < thresholds.concentrationMinCount) return undefined;

        const toCandidate = recent.filter((o) => o.beneficiary === candidate.beneficiary);
        const total = sum(
          recent.map((o) => o.amountEur),
          'EUR' as CurrencyCode,
        );
        if (total.isZero) return undefined;

        const share = sum(
          toCandidate.map((o) => o.amountEur),
          'EUR' as CurrencyCode,
        );
        const shareBps = Number((share.amount * 10_000n) / total.amount);
        if (shareBps < thresholds.concentrationBps) return undefined;

        return {
          rule: 'counterparty_concentration',
          severity: 'medium',
          score: 50,
          reason: `${divRound(BigInt(shareBps), 100n, 'HALF_EVEN')}% of recent volume goes to one beneficiary`,
          evidence: toCandidate.slice(0, 10).map((o) => o.transferId),
        };
      },
    },
  ];
}

export interface RuleEngineResult {
  readonly hits: readonly RuleHit[];
  readonly riskScore: number;
}

export class AmlRuleEngine {
  private readonly rules: readonly Rule[];

  constructor(rules: readonly Rule[] = createRules()) {
    this.rules = rules;
  }

  evaluate(context: RuleContext): RuleEngineResult {
    const hits: RuleHit[] = [];
    for (const rule of this.rules) {
      const hit = rule.evaluate(context);
      if (hit) hits.push(hit);
    }
    hits.sort((a, b) => b.score - a.score);

    // Highest single hit dominates; additional hits add a quarter of their score,
    // so several weak signals cannot outweigh one strong one. Computed scaled by
    // four and truncated once, to stay in integer arithmetic throughout.
    const scaled = hits.length
      ? hits[0]!.score * 4 + hits.slice(1).reduce((acc, h) => acc + h.score, 0)
      : 0;

    return { hits, riskScore: Math.min(100, Math.trunc(scaled / 4)) };
  }
}
