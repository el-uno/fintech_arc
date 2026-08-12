import type { Money } from '@arc/money';
import { CHAINS, ChainError, type ChainId } from './types.js';

export interface SelectionCriteria {
  /** Chains that actually hold the asset being moved. */
  readonly available: readonly ChainId[];
  /** How much the caller weights settlement speed against cost, 0–100. */
  readonly speedPreference?: number;
  readonly maxFee?: Money;
}

export interface ChainChoice {
  readonly chain: ChainId;
  readonly estimatedSettlementMs: number;
  readonly reason: string;
}

/**
 * Chain-agnostic settlement means the corridor picks a chain per transfer
 * rather than being wired to one.
 */
export function selectChain(criteria: SelectionCriteria): ChainChoice {
  if (criteria.available.length === 0) {
    throw new ChainError('no chains available for this asset');
  }

  const speed = Math.min(100, Math.max(0, criteria.speedPreference ?? 50));

  const scored = criteria.available.map((id) => {
    const config = CHAINS[id];
    const settlementMs = config.blockTimeMs * config.finalityDepth;
    // Normalised so both terms are comparable: lower is better on each.
    const timeScore = settlementMs / 60_000;
    const costScore = Number(config.baseFeeMinor) / Number(10n ** BigInt(18));
    const score = timeScore * (speed / 100) + costScore * (1 - speed / 100);
    return { id, settlementMs, score };
  });

  scored.sort((a, b) => a.score - b.score || a.settlementMs - b.settlementMs);
  const winner = scored[0]!;

  return {
    chain: winner.id,
    estimatedSettlementMs: winner.settlementMs,
    reason:
      speed >= 70
        ? 'fastest finality'
        : speed <= 30
          ? 'lowest network fee'
          : 'balanced cost and finality',
  };
}
