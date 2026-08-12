import { Money, type CurrencyCode } from '@arc/money';

export type AccountKind = 'personal' | 'enterprise';

export type VerificationTier = 0 | 1 | 2 | 3;

export class ProductError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductError';
  }
}

export class TierLimitError extends ProductError {
  constructor(
    readonly tier: VerificationTier,
    readonly attempted: Money,
    readonly limit: Money,
  ) {
    super(
      `tier ${tier} allows at most ${limit.toDecimalString()} ${limit.currency} ` +
        `but ${attempted.toDecimalString()} was requested`,
    );
    this.name = 'TierLimitError';
  }
}

export interface TierPolicy {
  readonly tier: VerificationTier;
  readonly label: string;
  /** Per-transfer ceiling in EUR minor units. `null` means unlimited. */
  readonly perTransferEurMinor: bigint | null;
  readonly dailyEurMinor: bigint | null;
  readonly allowedRails: readonly string[];
  readonly requiresApprovalAbove: bigint | null;
}

export const TIER_POLICIES: Record<VerificationTier, TierPolicy> = {
  0: {
    tier: 0,
    label: 'unverified',
    perTransferEurMinor: 0n,
    dailyEurMinor: 0n,
    allowedRails: [],
    requiresApprovalAbove: null,
  },
  1: {
    tier: 1,
    label: 'basic',
    perTransferEurMinor: 100_000n,
    dailyEurMinor: 250_000n,
    allowedRails: ['sepa', 'mobile_money'],
    requiresApprovalAbove: null,
  },
  2: {
    tier: 2,
    label: 'verified',
    perTransferEurMinor: 1_500_000n,
    dailyEurMinor: 5_000_000n,
    allowedRails: ['sepa', 'faster_payments', 'nip', 'mobile_money', 'eft', 'onchain'],
    requiresApprovalAbove: null,
  },
  3: {
    tier: 3,
    label: 'enhanced',
    perTransferEurMinor: null,
    dailyEurMinor: null,
    allowedRails: ['sepa', 'faster_payments', 'nip', 'mobile_money', 'eft', 'onchain'],
    requiresApprovalAbove: 10_000_000n,
  },
};

export interface Account {
  readonly id: string;
  readonly kind: AccountKind;
  readonly tier: VerificationTier;
  readonly countryCode: string;
  readonly displayName: string;
  readonly createdAt: Date;
}

export function policyFor(tier: VerificationTier): TierPolicy {
  return TIER_POLICIES[tier];
}

export function assertWithinTierLimit(tier: VerificationTier, amountEur: Money): void {
  const policy = TIER_POLICIES[tier];
  if (policy.perTransferEurMinor === null) return;
  const limit = Money.of(policy.perTransferEurMinor, 'EUR');
  if (amountEur.greaterThan(limit)) {
    throw new TierLimitError(tier, amountEur, limit);
  }
}

export function railAllowedForTier(tier: VerificationTier, rail: string): boolean {
  return TIER_POLICIES[tier].allowedRails.includes(rail);
}

/**
 * Enterprise payouts above the tier's threshold need a second approver.
 * Personal accounts never use maker-checker.
 */
export function requiresSecondApproval(
  kind: AccountKind,
  tier: VerificationTier,
  amountEur: Money,
): boolean {
  if (kind !== 'enterprise') return false;
  const threshold = TIER_POLICIES[tier].requiresApprovalAbove;
  if (threshold === null) return false;
  return amountEur.greaterThan(Money.of(threshold, 'EUR'));
}

export const RAIL_BY_CURRENCY: Record<string, string> = {
  EUR: 'sepa',
  GBP: 'faster_payments',
  NGN: 'nip',
  KES: 'mobile_money',
  GHS: 'mobile_money',
  ZAR: 'eft',
  USDC: 'onchain',
  USDT: 'onchain',
};

export function railForCurrency(currency: CurrencyCode): string {
  const rail = RAIL_BY_CURRENCY[currency];
  if (!rail) throw new ProductError(`no rail configured for ${currency}`);
  return rail;
}
