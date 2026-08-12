export type VerificationTier = 0 | 1 | 2 | 3;

export type DocumentKind =
  | 'passport'
  | 'national_id'
  | 'proof_of_address'
  | 'selfie'
  | 'certificate_of_incorporation'
  | 'ubo_declaration'
  | 'source_of_funds';

export type DocumentStatus = 'pending' | 'verified' | 'rejected' | 'expired';

export class RiskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RiskError';
  }
}

export interface VerificationDocument {
  readonly id: string;
  readonly kind: DocumentKind;
  readonly status: DocumentStatus;
  readonly submittedAt: Date;
  readonly expiresAt?: Date;
}

export const TIER_REQUIREMENTS: Record<VerificationTier, readonly DocumentKind[]> = {
  0: [],
  1: ['national_id'],
  2: ['passport', 'proof_of_address', 'selfie'],
  3: ['passport', 'proof_of_address', 'selfie', 'source_of_funds'],
};

export const KYB_REQUIREMENTS: readonly DocumentKind[] = [
  'certificate_of_incorporation',
  'ubo_declaration',
  'proof_of_address',
];

export interface TierAssessment {
  readonly granted: VerificationTier;
  readonly requested: VerificationTier;
  readonly missing: readonly DocumentKind[];
  readonly expired: readonly DocumentKind[];
}

export function assessTier(
  requested: VerificationTier,
  documents: readonly VerificationDocument[],
  now = new Date(),
): TierAssessment {
  const required = TIER_REQUIREMENTS[requested];

  const usable = new Set(
    documents
      .filter((d) => d.status === 'verified')
      .filter((d) => !d.expiresAt || d.expiresAt.getTime() > now.getTime())
      .map((d) => d.kind),
  );

  const expired = documents
    .filter((d) => d.status === 'verified' && d.expiresAt && d.expiresAt.getTime() <= now.getTime())
    .map((d) => d.kind);

  const missing = required.filter((kind) => !usable.has(kind));

  let granted: VerificationTier = 0;
  for (const tier of [1, 2, 3] as VerificationTier[]) {
    if (tier > requested) break;
    if (TIER_REQUIREMENTS[tier].every((kind) => usable.has(kind))) granted = tier;
  }

  return { granted, requested, missing, expired: [...new Set(expired)] };
}

export interface UboNode {
  readonly id: string;
  readonly name: string;
  readonly kind: 'person' | 'company';
  readonly countryCode: string;
}

export interface UboEdge {
  readonly ownerId: string;
  readonly ownedId: string;
  /** Ownership in basis points, so 25% is 2500 and stays exact. */
  readonly percentBps: number;
}

export interface BeneficialOwner {
  readonly node: UboNode;
  readonly effectiveBps: number;
  readonly path: readonly string[];
}

export interface UboGraph {
  readonly nodes: readonly UboNode[];
  readonly edges: readonly UboEdge[];
}

/**
 * Effective ownership through a chain of holding companies, multiplying
 * percentages down each path and summing where a person owns through several.
 */
export function resolveBeneficialOwners(
  graph: UboGraph,
  rootId: string,
  thresholdBps = 2_500,
): BeneficialOwner[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  if (!byId.has(rootId)) throw new RiskError(`no such entity in the UBO graph: ${rootId}`);

  const totals = new Map<string, { bps: number; path: string[] }>();

  const walk = (targetId: string, accumulatedBps: number, path: string[], seen: Set<string>) => {
    for (const edge of graph.edges) {
      if (edge.ownedId !== targetId) continue;
      if (seen.has(edge.ownerId)) continue;

      const owner = byId.get(edge.ownerId);
      if (!owner) continue;

      const effective = Math.trunc((accumulatedBps * edge.percentBps) / 10_000);
      const nextPath = [...path, owner.id];

      if (owner.kind === 'person') {
        const existing = totals.get(owner.id);
        if (existing) existing.bps += effective;
        else totals.set(owner.id, { bps: effective, path: nextPath });
      } else {
        walk(owner.id, effective, nextPath, new Set([...seen, edge.ownerId]));
      }
    }
  };

  walk(rootId, 10_000, [rootId], new Set([rootId]));

  return [...totals.entries()]
    .filter(([, v]) => v.bps >= thresholdBps)
    .map(([id, v]) => ({ node: byId.get(id)!, effectiveBps: v.bps, path: v.path }))
    .sort((a, b) => b.effectiveBps - a.effectiveBps);
}
