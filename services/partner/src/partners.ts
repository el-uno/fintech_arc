import { randomBytes, randomUUID } from 'node:crypto';

export type Environment = 'sandbox' | 'live';

export type PartnerStatus = 'onboarding' | 'sandbox_ready' | 'live' | 'suspended';

export type PartnerTier = 'starter' | 'growth' | 'scale';

export class PartnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PartnerError';
  }
}

export type KybRequirement =
  | 'certificate_of_incorporation'
  | 'ubo_declaration'
  | 'proof_of_address'
  | 'regulatory_licence'
  | 'signed_agreement';

export const KYB_REQUIREMENTS: readonly KybRequirement[] = [
  'certificate_of_incorporation',
  'ubo_declaration',
  'proof_of_address',
  'regulatory_licence',
  'signed_agreement',
];

export interface Partner {
  readonly id: string;
  readonly name: string;
  readonly countryCode: string;
  readonly tier: PartnerTier;
  readonly status: PartnerStatus;
  readonly submitted: readonly KybRequirement[];
  readonly corridors: readonly string[];
  readonly createdAt: Date;
  readonly liveAt?: Date;
}

export interface ApiCredential {
  readonly partnerId: string;
  readonly environment: Environment;
  readonly clientId: string;
  /** Returned once at issuance and never stored in the clear. */
  readonly secret: string;
}

export interface GoLiveCheck {
  readonly requirement: KybRequirement | 'sandbox_traffic' | 'webhook_endpoint';
  readonly satisfied: boolean;
}

export interface GoLiveReadiness {
  readonly ready: boolean;
  readonly checks: readonly GoLiveCheck[];
  readonly outstanding: readonly string[];
}

export interface PartnerOnboardingOptions {
  now?: () => Date;
  /** Sandbox calls a partner must make before live access is granted. */
  minimumSandboxCalls?: number;
}

/**
 * Partner onboarding.
 *
 * Sandbox credentials are issued immediately — a partner should be able to
 * integrate before any paperwork clears. Live credentials require the full KYB
 * pack, a registered webhook endpoint, and evidence of real sandbox traffic.
 */
export class PartnerOnboarding {
  private readonly partners = new Map<string, Partner>();
  private readonly credentials = new Map<string, ApiCredential[]>();
  private readonly sandboxCalls = new Map<string, number>();
  private readonly webhookEndpoints = new Map<string, number>();
  private readonly now: () => Date;
  private readonly minimumSandboxCalls: number;

  constructor(options: PartnerOnboardingOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.minimumSandboxCalls = options.minimumSandboxCalls ?? 5;
  }

  register(input: {
    name: string;
    countryCode: string;
    tier?: PartnerTier;
    corridors?: readonly string[];
  }): { partner: Partner; sandbox: ApiCredential } {
    if (!/^[A-Z]{2}$/.test(input.countryCode)) {
      throw new PartnerError(`countryCode must be ISO-3166 alpha-2, got ${input.countryCode}`);
    }

    const partner: Partner = {
      id: randomUUID(),
      name: input.name,
      countryCode: input.countryCode,
      tier: input.tier ?? 'starter',
      status: 'sandbox_ready',
      submitted: [],
      corridors: input.corridors ?? ['DE-KE'],
      createdAt: this.now(),
    };

    this.partners.set(partner.id, partner);
    const sandbox = this.issueCredential(partner.id, 'sandbox');
    return { partner, sandbox };
  }

  get(partnerId: string): Partner {
    const partner = this.partners.get(partnerId);
    if (!partner) throw new PartnerError(`no such partner: ${partnerId}`);
    return partner;
  }

  submitDocument(partnerId: string, requirement: KybRequirement): Partner {
    const partner = this.get(partnerId);
    if (partner.submitted.includes(requirement)) return partner;
    const updated = { ...partner, submitted: [...partner.submitted, requirement] };
    this.partners.set(partnerId, updated);
    return updated;
  }

  registerWebhookEndpoint(partnerId: string): void {
    this.get(partnerId);
    this.webhookEndpoints.set(partnerId, (this.webhookEndpoints.get(partnerId) ?? 0) + 1);
  }

  recordSandboxCall(partnerId: string): void {
    this.sandboxCalls.set(partnerId, (this.sandboxCalls.get(partnerId) ?? 0) + 1);
  }

  readiness(partnerId: string): GoLiveReadiness {
    const partner = this.get(partnerId);

    const checks: GoLiveCheck[] = KYB_REQUIREMENTS.map((requirement) => ({
      requirement,
      satisfied: partner.submitted.includes(requirement),
    }));

    checks.push({
      requirement: 'webhook_endpoint',
      satisfied: (this.webhookEndpoints.get(partnerId) ?? 0) > 0,
    });
    checks.push({
      requirement: 'sandbox_traffic',
      satisfied: (this.sandboxCalls.get(partnerId) ?? 0) >= this.minimumSandboxCalls,
    });

    const outstanding = checks.filter((c) => !c.satisfied).map((c) => c.requirement);
    return { ready: outstanding.length === 0, checks, outstanding };
  }

  /** Promote to live. Refuses while anything on the checklist is outstanding. */
  goLive(partnerId: string): { partner: Partner; live: ApiCredential } {
    const readiness = this.readiness(partnerId);
    if (!readiness.ready) {
      throw new PartnerError(
        `partner ${partnerId} is not ready for live access; outstanding: ${readiness.outstanding.join(', ')}`,
      );
    }

    const partner = { ...this.get(partnerId), status: 'live' as const, liveAt: this.now() };
    this.partners.set(partnerId, partner);
    return { partner, live: this.issueCredential(partnerId, 'live') };
  }

  suspend(partnerId: string, _reason: string): Partner {
    const partner = { ...this.get(partnerId), status: 'suspended' as const };
    this.partners.set(partnerId, partner);
    return partner;
  }

  credentialsFor(partnerId: string): readonly ApiCredential[] {
    return this.credentials.get(partnerId) ?? [];
  }

  private issueCredential(partnerId: string, environment: Environment): ApiCredential {
    const credential: ApiCredential = {
      partnerId,
      environment,
      clientId: `${environment === 'live' ? 'ak_live' : 'ak_test'}_${randomBytes(9).toString('hex')}`,
      secret: `${environment === 'live' ? 'sk_live' : 'sk_test'}_${randomBytes(24).toString('hex')}`,
    };
    const list = this.credentials.get(partnerId) ?? [];
    list.push(credential);
    this.credentials.set(partnerId, list);
    return credential;
  }
}
