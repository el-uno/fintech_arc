import type { CurrencyCode, Money } from '@arc/money';

export type ChainId = 'ethereum' | 'base' | 'polygon' | 'solana' | 'tron';

export type TransactionStatus =
  'unknown' | 'pending' | 'included' | 'confirmed' | 'failed' | 'dropped';

export class ChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainError';
  }
}

export interface ChainConfig {
  readonly id: ChainId;
  readonly blockTimeMs: number;
  /** Confirmations before a transaction is treated as final. */
  readonly finalityDepth: number;
  /** Deepest reorg the chain is modelled as producing. */
  readonly maxReorgDepth: number;
  /** Probability per block that a reorg begins, in basis points. */
  readonly reorgChanceBps: number;
  /** Probability a broadcast transaction is dropped from the mempool, in bps. */
  readonly dropChanceBps: number;
  /** Probability a transaction reverts on inclusion, in bps. */
  readonly revertChanceBps: number;
  readonly feeAsset: CurrencyCode;
  /** Base fee per transfer in the fee asset's minor units. */
  readonly baseFeeMinor: bigint;
  /** How far the fee may swing either side of base, in bps. */
  readonly feeVolatilityBps: number;
  readonly maxTransactionsPerBlock: number;
}

export const CHAINS: Record<ChainId, ChainConfig> = {
  ethereum: {
    id: 'ethereum',
    blockTimeMs: 12_000,
    finalityDepth: 12,
    maxReorgDepth: 2,
    reorgChanceBps: 30,
    dropChanceBps: 40,
    revertChanceBps: 20,
    feeAsset: 'ETH',
    baseFeeMinor: 420_000_000_000_000n,
    feeVolatilityBps: 6_000,
    maxTransactionsPerBlock: 4,
  },
  base: {
    id: 'base',
    blockTimeMs: 2_000,
    finalityDepth: 10,
    maxReorgDepth: 1,
    reorgChanceBps: 8,
    dropChanceBps: 10,
    revertChanceBps: 15,
    feeAsset: 'ETH',
    baseFeeMinor: 18_000_000_000_000n,
    feeVolatilityBps: 3_000,
    maxTransactionsPerBlock: 12,
  },
  polygon: {
    id: 'polygon',
    blockTimeMs: 2_000,
    finalityDepth: 128,
    maxReorgDepth: 5,
    reorgChanceBps: 120,
    dropChanceBps: 25,
    revertChanceBps: 20,
    feeAsset: 'MATIC',
    baseFeeMinor: 900_000_000_000_000_000n,
    feeVolatilityBps: 8_000,
    maxTransactionsPerBlock: 12,
  },
  solana: {
    id: 'solana',
    blockTimeMs: 400,
    finalityDepth: 32,
    maxReorgDepth: 3,
    reorgChanceBps: 60,
    dropChanceBps: 90,
    revertChanceBps: 25,
    feeAsset: 'SOL',
    baseFeeMinor: 5_000n,
    feeVolatilityBps: 1_000,
    maxTransactionsPerBlock: 20,
  },
  tron: {
    id: 'tron',
    blockTimeMs: 3_000,
    finalityDepth: 19,
    maxReorgDepth: 2,
    reorgChanceBps: 20,
    dropChanceBps: 15,
    revertChanceBps: 10,
    feeAsset: 'TRX',
    baseFeeMinor: 1_100_000n,
    feeVolatilityBps: 2_000,
    maxTransactionsPerBlock: 10,
  },
};

export interface TransferRequest {
  readonly asset: CurrencyCode;
  readonly amount: Money;
  readonly from: string;
  readonly to: string;
  /** Caller-supplied key; rebroadcasting with the same key returns the same hash. */
  readonly idempotencyKey: string;
}

export interface Block {
  readonly height: number;
  readonly hash: string;
  readonly parentHash: string;
  readonly timestampMs: number;
  readonly transactionHashes: readonly string[];
}

export interface ChainTransaction {
  readonly hash: string;
  readonly chain: ChainId;
  readonly status: TransactionStatus;
  readonly asset: CurrencyCode;
  readonly amount: Money;
  readonly from: string;
  readonly to: string;
  readonly fee: Money;
  readonly blockHeight: number | null;
  readonly blockHash: string | null;
  readonly confirmations: number;
  /** True once confirmations reach the chain's finality depth. */
  readonly final: boolean;
}

export type ChainEvent =
  | { readonly type: 'block'; readonly block: Block }
  | { readonly type: 'included'; readonly hash: string; readonly blockHeight: number }
  | { readonly type: 'confirmed'; readonly hash: string; readonly confirmations: number }
  | { readonly type: 'failed'; readonly hash: string; readonly reason: string }
  | { readonly type: 'dropped'; readonly hash: string }
  | {
      readonly type: 'reorg';
      readonly depth: number;
      readonly fromHeight: number;
      readonly revertedTransactions: readonly string[];
    };

export interface ChainDriver {
  readonly chain: ChainId;
  readonly config: ChainConfig;
  broadcast(request: TransferRequest): Promise<ChainTransaction>;
  getTransaction(hash: string): Promise<ChainTransaction | undefined>;
  getConfirmations(hash: string): Promise<number>;
  estimateFee(request: Pick<TransferRequest, 'asset' | 'amount'>): Promise<Money>;
  head(): Promise<Block>;
  subscribe(listener: (event: ChainEvent) => void): () => void;
}
