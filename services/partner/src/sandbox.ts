import type { Money } from '@arc/money';

export type SandboxTrigger =
  | 'success'
  | 'compliance_reject'
  | 'compliance_review'
  | 'insufficient_funds'
  | 'rail_reject'
  | 'rail_timeout'
  | 'chain_stuck'
  | 'chain_reorg';

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

/**
 * Magic amounts.
 *
 * A partner cannot make Arc's rails fail on demand, so the sandbox reads the
 * *last two minor units* of the send amount as an instruction. Sending 100.66
 * always produces a rail rejection; every other amount succeeds.
 *
 * The alternative — a `simulate` flag in the request body — would mean the
 * failure path is exercised through a code path production never takes. Magic
 * amounts keep the request shape identical to live.
 */
export const MAGIC_SUFFIXES: Readonly<Record<number, SandboxTrigger>> = {
  61: 'compliance_reject',
  62: 'compliance_review',
  63: 'insufficient_funds',
  66: 'rail_reject',
  67: 'rail_timeout',
  68: 'chain_stuck',
  69: 'chain_reorg',
};

export function triggerFor(amount: Money): SandboxTrigger {
  const suffix = Number(
    ((amount.amount % 100n) + 100n) % 100n, // positive modulo
  );
  return MAGIC_SUFFIXES[suffix] ?? 'success';
}

export function describeTrigger(trigger: SandboxTrigger): string {
  switch (trigger) {
    case 'success':
      return 'completes normally';
    case 'compliance_reject':
      return 'blocked by compliance; a sanctions case is opened';
    case 'compliance_review':
      return 'held for manual review';
    case 'insufficient_funds':
      return 'the sender cannot fund the transfer';
    case 'rail_reject':
      return 'the payout rail rejects the beneficiary';
    case 'rail_timeout':
      return 'the payout rail times out; the failure is retryable';
    case 'chain_stuck':
      return 'the settlement transaction never reaches finality';
    case 'chain_reorg':
      return 'a reorg rolls the settlement back before it is re-mined';
  }
}

export interface SandboxTenant {
  readonly partnerId: string;
  readonly tenantId: string;
  readonly seededAt: Date;
  /** Bumped on every reset, so a partner can prove which generation they are on. */
  readonly generation: number;
}

export interface SandboxOptions {
  now?: () => Date;
}

/**
 * Sandbox tenants are fully isolated and resettable. Reset is the feature
 * partners use most: integration work means running the same scenario until it
 * is right, and that only works if the slate is genuinely clean.
 */
export class SandboxRegistry {
  private readonly tenants = new Map<string, SandboxTenant>();
  private readonly now: () => Date;

  constructor(options: SandboxOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  provision(partnerId: string): SandboxTenant {
    const existing = this.tenants.get(partnerId);
    if (existing) return existing;

    const tenant: SandboxTenant = {
      partnerId,
      tenantId: `sbx_${partnerId}`,
      seededAt: this.now(),
      generation: 1,
    };
    this.tenants.set(partnerId, tenant);
    return tenant;
  }

  get(partnerId: string): SandboxTenant {
    const tenant = this.tenants.get(partnerId);
    if (!tenant) throw new SandboxError(`no sandbox provisioned for partner ${partnerId}`);
    return tenant;
  }

  reset(partnerId: string): SandboxTenant {
    const tenant = this.get(partnerId);
    const next: SandboxTenant = {
      ...tenant,
      seededAt: this.now(),
      generation: tenant.generation + 1,
    };
    this.tenants.set(partnerId, next);
    return next;
  }

  isSandboxTenant(tenantId: string): boolean {
    return tenantId.startsWith('sbx_');
  }
}
