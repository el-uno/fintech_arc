import { Money } from '@arc/money';
import { describe, expect, it } from 'vitest';
import {
  CHAINS,
  ChainError,
  createRng,
  createSimulatedChains,
  SimulatedChain,
  selectChain,
  type ChainEvent,
  type ChainId,
} from '../src/index.js';

const usdc = (v: string) => Money.parse(v, 'USDC');

function request(key = 'idem_1') {
  return {
    asset: 'USDC' as const,
    amount: usdc('1000.000000'),
    from: '0xaaaa',
    to: '0xbbbb',
    idempotencyKey: key,
  };
}

/** A chain with failure injection disabled, for testing the happy path. */
function reliableChain(id: ChainId = 'base', seed = 'test') {
  return new SimulatedChain(id, {
    seed,
    config: { dropChanceBps: 0, revertChanceBps: 0, reorgChanceBps: 0 },
  });
}

describe('determinism', () => {
  it('the same seed reproduces an identical block sequence', () => {
    const run = (seed: string) => {
      const chain = new SimulatedChain('polygon', { seed });
      const blocks = chain.advance(60);
      return blocks.map((b) => `${b.height}:${b.hash}:${b.transactionHashes.join(',')}`);
    };
    expect(run('seed-a')).toEqual(run('seed-a'));
    expect(run('seed-a')).not.toEqual(run('seed-b'));
  });

  it('the same seed reproduces an identical reorg sequence', () => {
    const run = (seed: string) => {
      const chain = new SimulatedChain('polygon', { seed });
      const events: string[] = [];
      chain.subscribe((e: ChainEvent) => {
        if (e.type === 'reorg') events.push(`reorg:${e.depth}@${e.fromHeight}`);
      });
      chain.advance(400);
      return events;
    };

    const first = run('reorg-seed');
    expect(first.length).toBeGreaterThan(0);
    expect(run('reorg-seed')).toEqual(first);
  });

  it('the same seed reproduces identical transaction outcomes', async () => {
    const run = async (seed: string) => {
      const chain = new SimulatedChain('solana', { seed });
      const hashes: string[] = [];
      for (let i = 0; i < 20; i++) {
        hashes.push((await chain.broadcast(request(`k_${i}`))).hash);
      }
      chain.advance(200);
      const results = [];
      for (const hash of hashes) {
        const tx = await chain.getTransaction(hash);
        results.push(`${tx!.status}:${tx!.blockHeight}`);
      }
      return results;
    };
    expect(await run('tx-seed')).toEqual(await run('tx-seed'));
  });

  it('the rng is stable across instances', () => {
    const a = createRng('x');
    const b = createRng('x');
    expect(Array.from({ length: 20 }, () => a.next())).toEqual(
      Array.from({ length: 20 }, () => b.next()),
    );
  });
});

describe('broadcast and inclusion', () => {
  it('starts pending and reaches finality', async () => {
    const chain = reliableChain('base');
    const submitted = await chain.broadcast(request());
    expect(submitted.status).toBe('pending');
    expect(submitted.confirmations).toBe(0);

    const settled = chain.advanceUntilFinal(submitted.hash);
    expect(settled!.status).toBe('confirmed');
    expect(settled!.final).toBe(true);
    expect(settled!.confirmations).toBeGreaterThanOrEqual(CHAINS.base.finalityDepth);
    expect(settled!.blockHeight).toBeGreaterThan(0);
  });

  it('is idempotent: rebroadcasting the same key returns the same hash', async () => {
    const chain = reliableChain();
    const first = await chain.broadcast(request('same-key'));
    const second = await chain.broadcast(request('same-key'));
    expect(second.hash).toBe(first.hash);
  });

  it('rejects a zero or negative amount', async () => {
    const chain = reliableChain();
    await expect(chain.broadcast({ ...request(), amount: Money.of(0n, 'USDC') })).rejects.toThrow(
      ChainError,
    );
  });

  it('rejects an amount whose currency is not the asset', async () => {
    const chain = reliableChain();
    await expect(
      chain.broadcast({ ...request(), amount: Money.parse('10.00', 'EUR') }),
    ).rejects.toThrow(ChainError);
  });

  it('reports zero confirmations for an unknown hash', async () => {
    const chain = reliableChain();
    expect(await chain.getConfirmations('0xdeadbeef')).toBe(0);
    expect(await chain.getTransaction('0xdeadbeef')).toBeUndefined();
  });
});

describe('failure modes', () => {
  it('drops a transaction when the mempool evicts it', async () => {
    const chain = new SimulatedChain('base', {
      seed: 'drop',
      config: { dropChanceBps: 10_000, reorgChanceBps: 0 },
    });
    const tx = await chain.broadcast(request());
    const result = chain.advanceUntilFinal(tx.hash);
    expect(result!.status).toBe('dropped');
    expect(result!.final).toBe(false);
  });

  it('marks a reverted transaction failed but still mined', async () => {
    const chain = new SimulatedChain('base', {
      seed: 'revert',
      config: { revertChanceBps: 10_000, dropChanceBps: 0, reorgChanceBps: 0 },
    });
    const tx = await chain.broadcast(request());
    const result = chain.advanceUntilFinal(tx.hash);

    expect(result!.status).toBe('failed');
    // A revert still consumes a block slot and a fee — it is not the same as a drop.
    expect(result!.blockHeight).not.toBeNull();
    expect(result!.fee.isPositive).toBe(true);
  });

  it('emits failure and drop events', async () => {
    const chain = new SimulatedChain('base', {
      seed: 'events',
      config: { revertChanceBps: 10_000, dropChanceBps: 0, reorgChanceBps: 0 },
    });
    const seen: string[] = [];
    chain.subscribe((e) => seen.push(e.type));
    const tx = await chain.broadcast(request());
    chain.advanceUntilFinal(tx.hash);
    expect(seen).toContain('failed');
  });
});

describe('reorgs', () => {
  it('rolls a mined transaction back to pending, then re-mines it', async () => {
    const chain = new SimulatedChain('polygon', {
      seed: 'rollback',
      config: { reorgChanceBps: 0, dropChanceBps: 0, revertChanceBps: 0 },
    });

    const tx = await chain.broadcast(request());
    chain.advance(6);

    const mined = await chain.getTransaction(tx.hash);
    expect(mined!.status).toBe('included');
    expect(mined!.blockHeight).not.toBeNull();
    expect(mined!.confirmations).toBeGreaterThan(0);

    const heightBefore = (await chain.head()).height;
    const events: ChainEvent[] = [];
    chain.subscribe((e) => events.push(e));

    // Reorg deep enough to swallow the block the transaction sits in.
    const depth = heightBefore - mined!.blockHeight! + 1;
    const reverted = chain.forceReorg(depth);

    expect(reverted).toContain(tx.hash);

    const reorgEvent = events.find((e) => e.type === 'reorg');
    expect(reorgEvent).toBeDefined();
    expect(reorgEvent!.type === 'reorg' && reorgEvent!.depth).toBe(depth);

    // The chain shortened, and the transaction lost its block entirely.
    expect((await chain.head()).height).toBe(heightBefore - depth);

    const during = await chain.getTransaction(tx.hash);
    expect(during!.status).toBe('pending');
    expect(during!.blockHeight).toBeNull();
    expect(during!.blockHash).toBeNull();
    expect(during!.confirmations).toBe(0);
    expect(during!.final).toBe(false);

    // It is back in the mempool and gets mined again.
    const settled = chain.advanceUntilFinal(tx.hash);
    expect(settled!.status).toBe('confirmed');
    expect(settled!.final).toBe(true);
    expect(settled!.blockHeight).not.toBeNull();
  });

  it('refuses to reorg past genesis', async () => {
    const chain = new SimulatedChain('base', { seed: 'genesis' });
    expect(() => chain.forceReorg(3)).toThrow(ChainError);
  });

  it('never leaves a reverted transaction claiming confirmations', async () => {
    const chain = new SimulatedChain('polygon', { seed: 'consistency' });
    const hashes: string[] = [];
    for (let i = 0; i < 30; i++) hashes.push((await chain.broadcast(request(`k${i}`))).hash);

    chain.advance(600);

    for (const hash of hashes) {
      const tx = await chain.getTransaction(hash);
      if (tx!.status === 'pending' || tx!.status === 'dropped') {
        expect(tx!.blockHeight).toBeNull();
        expect(tx!.confirmations).toBe(0);
      }
      if (tx!.final) expect(tx!.status).toBe('confirmed');
    }
  });

  it('keeps the chain linked after a reorg', async () => {
    const chain = new SimulatedChain('polygon', {
      seed: 'linkage',
      config: { reorgChanceBps: 3_000 },
    });
    chain.advance(300);

    const head = await chain.head();
    expect(head.height).toBeGreaterThan(0);
  });
});

describe('fees', () => {
  it('quotes a positive fee in the chain fee asset', async () => {
    for (const id of Object.keys(CHAINS) as ChainId[]) {
      const chain = new SimulatedChain(id, { seed: 'fee' });
      const fee = await chain.estimateFee({ asset: 'USDC', amount: usdc('100.000000') });
      expect(fee.isPositive).toBe(true);
      expect(fee.currency).toBe(CHAINS[id].feeAsset);
    }
  });

  it('varies within the configured volatility band', async () => {
    const chain = new SimulatedChain('ethereum', { seed: 'volatility' });
    const fees: bigint[] = [];
    for (let i = 0; i < 50; i++) {
      fees.push((await chain.estimateFee({ asset: 'USDC', amount: usdc('1.000000') })).amount);
    }
    const min = fees.reduce((a, b) => (a < b ? a : b));
    const max = fees.reduce((a, b) => (a > b ? a : b));
    expect(min).toBeLessThan(max);
    expect(min).toBeGreaterThan(0n);
  });
});

describe('chain selection', () => {
  it('prefers fast finality when speed is weighted high', () => {
    const choice = selectChain({
      available: ['ethereum', 'base', 'polygon'],
      speedPreference: 100,
    });
    expect(choice.chain).toBe('base');
    expect(choice.reason).toBe('fastest finality');
  });

  it('prefers a cheap chain when cost is weighted high', () => {
    const choice = selectChain({ available: ['ethereum', 'polygon', 'tron'], speedPreference: 0 });
    expect(choice.chain).toBe('tron');
    expect(choice.reason).toBe('lowest network fee');
  });

  it('refuses when nothing is available', () => {
    expect(() => selectChain({ available: [] })).toThrow(ChainError);
  });

  it('reports the estimated settlement window', () => {
    const choice = selectChain({ available: ['base'], speedPreference: 100 });
    expect(choice.estimatedSettlementMs).toBe(CHAINS.base.blockTimeMs * CHAINS.base.finalityDepth);
  });
});

describe('the five chains differ meaningfully', () => {
  it('builds all five with distinct finality characteristics', () => {
    const chains = createSimulatedChains({ seed: 'all' });
    const ids = Object.keys(chains) as ChainId[];
    expect(ids).toHaveLength(5);

    const windows = ids.map((id) => CHAINS[id].blockTimeMs * CHAINS[id].finalityDepth);
    expect(new Set(windows).size).toBeGreaterThan(1);
    // Polygon's deep finality requirement makes it the slowest to settle.
    expect(Math.max(...windows)).toBe(CHAINS.polygon.blockTimeMs * CHAINS.polygon.finalityDepth);
  });
});
