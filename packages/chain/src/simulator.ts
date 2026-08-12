import { divRound, Money } from '@arc/money';
import { createRng, type Rng } from './random.js';
import {
  CHAINS,
  ChainError,
  type Block,
  type ChainConfig,
  type ChainDriver,
  type ChainEvent,
  type ChainId,
  type ChainTransaction,
  type TransactionStatus,
  type TransferRequest,
} from './types.js';

interface TxRecord {
  hash: string;
  status: TransactionStatus;
  asset: ChainTransaction['asset'];
  amount: Money;
  from: string;
  to: string;
  fee: Money;
  blockHeight: number | null;
  blockHash: string | null;
  failureReason?: string;
  /** Blocks remaining in the mempool before inclusion is attempted. */
  delay: number;
  dropped: boolean;
  reverts: boolean;
}

export interface SimulatorOptions {
  seed?: string;
  startTimestampMs?: number;
  /** Overrides for the chain defaults, for targeted failure testing. */
  config?: Partial<ChainConfig>;
}

export class SimulatedChain implements ChainDriver {
  readonly chain: ChainId;
  readonly config: ChainConfig;

  private readonly rng: Rng;
  private readonly blocks: Block[] = [];
  private readonly transactions = new Map<string, TxRecord>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly mempool: string[] = [];
  private readonly listeners = new Set<(event: ChainEvent) => void>();
  private timestampMs: number;

  constructor(chain: ChainId, options: SimulatorOptions = {}) {
    this.chain = chain;
    this.config = { ...CHAINS[chain], ...options.config };
    this.rng = createRng(options.seed ?? `arc:${chain}`);
    this.timestampMs = options.startTimestampMs ?? 1_700_000_000_000;

    this.blocks.push({
      height: 0,
      hash: `0x${this.rng.hex(64)}`,
      parentHash: `0x${'0'.repeat(64)}`,
      timestampMs: this.timestampMs,
      transactionHashes: [],
    });
  }

  async head(): Promise<Block> {
    return this.blocks[this.blocks.length - 1]!;
  }

  get height(): number {
    return this.blocks[this.blocks.length - 1]!.height;
  }

  async estimateFee(request: Pick<TransferRequest, 'asset' | 'amount'>): Promise<Money> {
    if (request.amount.isNegative || request.amount.isZero) {
      throw new ChainError('transfer amount must be positive');
    }
    const swing = this.rng.int(this.config.feeVolatilityBps * 2 + 1) - this.config.feeVolatilityBps;
    const adjusted = divRound(
      this.config.baseFeeMinor * BigInt(10_000 + swing),
      10_000n,
      'HALF_EVEN',
    );
    return Money.of(adjusted > 0n ? adjusted : 1n, this.config.feeAsset);
  }

  async broadcast(request: TransferRequest): Promise<ChainTransaction> {
    const existing = this.byIdempotencyKey.get(request.idempotencyKey);
    if (existing) return this.toTransaction(this.transactions.get(existing)!);

    if (request.amount.isNegative || request.amount.isZero) {
      throw new ChainError('transfer amount must be positive');
    }
    if (request.amount.currency !== request.asset) {
      throw new ChainError(`amount is ${request.amount.currency} but asset is ${request.asset}`);
    }

    const hash = `0x${this.rng.hex(64)}`;
    const record: TxRecord = {
      hash,
      status: 'pending',
      asset: request.asset,
      amount: request.amount,
      from: request.from,
      to: request.to,
      fee: await this.estimateFee(request),
      blockHeight: null,
      blockHash: null,
      delay: this.rng.int(3),
      dropped: this.rng.chance(this.config.dropChanceBps),
      reverts: this.rng.chance(this.config.revertChanceBps),
    };

    this.transactions.set(hash, record);
    this.byIdempotencyKey.set(request.idempotencyKey, hash);
    this.mempool.push(hash);

    return this.toTransaction(record);
  }

  async getTransaction(hash: string): Promise<ChainTransaction | undefined> {
    const record = this.transactions.get(hash);
    return record ? this.toTransaction(record) : undefined;
  }

  async getConfirmations(hash: string): Promise<number> {
    const record = this.transactions.get(hash);
    if (!record || record.blockHeight === null) return 0;
    return Math.max(0, this.height - record.blockHeight + 1);
  }

  subscribe(listener: (event: ChainEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Produce `count` blocks, applying inclusion, reverts, drops and reorgs. */
  advance(count = 1): Block[] {
    const produced: Block[] = [];
    for (let i = 0; i < count; i++) {
      if (this.height > this.config.maxReorgDepth && this.rng.chance(this.config.reorgChanceBps)) {
        this.reorg();
      }
      produced.push(this.produceBlock());
      this.emitConfirmations();
    }
    return produced;
  }

  /** Advance until the transaction is final, or `maxBlocks` have passed. */
  advanceUntilFinal(hash: string, maxBlocks = 500): ChainTransaction | undefined {
    for (let i = 0; i < maxBlocks; i++) {
      const record = this.transactions.get(hash);
      if (!record) return undefined;
      if (record.status === 'failed' || record.status === 'dropped')
        return this.toTransaction(record);
      if (record.status === 'confirmed') return this.toTransaction(record);
      this.advance(1);
    }
    const record = this.transactions.get(hash);
    return record ? this.toTransaction(record) : undefined;
  }

  /**
   * Inject a reorg of an exact depth. Failure injection for tests and scenarios;
   * organic reorgs happen on their own during `advance`.
   */
  forceReorg(depth?: number): string[] {
    const requested = depth ?? this.config.maxReorgDepth;
    const actual = Math.min(requested, this.blocks.length - 1);
    if (actual < 1) throw new ChainError('not enough blocks to reorg');
    return this.rollback(actual);
  }

  private produceBlock(): Block {
    const parent = this.blocks[this.blocks.length - 1]!;
    this.timestampMs += this.config.blockTimeMs;

    const included: string[] = [];
    let considered = 0;

    while (this.mempool.length > 0 && included.length < this.config.maxTransactionsPerBlock) {
      if (considered++ > this.config.maxTransactionsPerBlock * 4) break;

      const hash = this.mempool.shift()!;
      const record = this.transactions.get(hash);
      if (!record || record.status !== 'pending') continue;

      if (record.dropped) {
        record.status = 'dropped';
        this.emit({ type: 'dropped', hash });
        continue;
      }

      if (record.delay > 0) {
        record.delay -= 1;
        this.mempool.push(hash);
        continue;
      }

      included.push(hash);
    }

    const block: Block = {
      height: parent.height + 1,
      hash: `0x${this.rng.hex(64)}`,
      parentHash: parent.hash,
      timestampMs: this.timestampMs,
      transactionHashes: included,
    };
    this.blocks.push(block);

    for (const hash of included) {
      const record = this.transactions.get(hash)!;
      record.blockHeight = block.height;
      record.blockHash = block.hash;
      if (record.reverts) {
        record.status = 'failed';
        record.failureReason = 'execution reverted';
        this.emit({ type: 'failed', hash, reason: 'execution reverted' });
      } else {
        record.status = 'included';
        this.emit({ type: 'included', hash, blockHeight: block.height });
      }
    }

    this.emit({ type: 'block', block });
    return block;
  }

  private reorg(): void {
    const depth = 1 + this.rng.int(this.config.maxReorgDepth);
    const actual = Math.min(depth, this.blocks.length - 1);
    if (actual < 1) return;
    this.rollback(actual);
  }

  private rollback(actual: number): string[] {
    const removed = this.blocks.splice(this.blocks.length - actual, actual);
    const reverted: string[] = [];

    for (const block of removed) {
      for (const hash of block.transactionHashes) {
        const record = this.transactions.get(hash);
        if (!record) continue;
        record.blockHeight = null;
        record.blockHash = null;
        record.status = 'pending';
        delete record.failureReason;
        reverted.push(hash);
        this.mempool.unshift(hash);
      }
    }

    this.emit({
      type: 'reorg',
      depth: actual,
      fromHeight: this.height,
      revertedTransactions: reverted,
    });

    return reverted;
  }

  private emitConfirmations(): void {
    for (const record of this.transactions.values()) {
      if (record.status !== 'included' || record.blockHeight === null) continue;
      const confirmations = this.height - record.blockHeight + 1;
      if (confirmations >= this.config.finalityDepth) {
        record.status = 'confirmed';
        this.emit({ type: 'confirmed', hash: record.hash, confirmations });
      }
    }
  }

  private emit(event: ChainEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private toTransaction(record: TxRecord): ChainTransaction {
    const confirmations =
      record.blockHeight === null ? 0 : Math.max(0, this.height - record.blockHeight + 1);
    return {
      hash: record.hash,
      chain: this.chain,
      status: record.status,
      asset: record.asset,
      amount: record.amount,
      from: record.from,
      to: record.to,
      fee: record.fee,
      blockHeight: record.blockHeight,
      blockHash: record.blockHash,
      confirmations,
      final: confirmations >= this.config.finalityDepth && record.status === 'confirmed',
    };
  }
}

export function createSimulatedChains(
  options: SimulatorOptions = {},
): Record<ChainId, SimulatedChain> {
  const ids = Object.keys(CHAINS) as ChainId[];
  return Object.fromEntries(
    ids.map((id) => [
      id,
      new SimulatedChain(id, { ...options, seed: `${options.seed ?? 'arc'}:${id}` }),
    ]),
  ) as Record<ChainId, SimulatedChain>;
}
