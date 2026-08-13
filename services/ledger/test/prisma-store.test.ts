import { randomUUID } from 'node:crypto';
import { createEvent, Dispatcher, EventBus, PrismaOutbox, PrismaProcessedLog } from '@arc/bus';
import { createPrismaClient, truncateAll, type PrismaClient } from '@arc/db';
import { Money } from '@arc/money';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  credit,
  debit,
  InsufficientFundsError,
  PostingEngine,
  PrismaLedgerStore,
  projectBalance,
  SYSTEM_ACCOUNTS,
  trialBalance,
  UnbalancedJournalError,
} from '../src/index.js';

/**
 * These tests exercise the real database. Without them the constraint triggers
 * and the locking are unverified claims — CI proves the migration applies, not
 * that it does anything.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const REQUIRED = process.env.ARC_REQUIRE_DB === '1';

if (REQUIRED && !DATABASE_URL) {
  throw new Error(
    'ARC_REQUIRE_DB=1 but DATABASE_URL is unset — database tests would silently skip',
  );
}

const suite = DATABASE_URL ? describe : describe.skip;

const eur = (v: string) => Money.parse(v, 'EUR');
const SENDER = SYSTEM_ACCOUNTS.customer('va_db', 'EUR');
const FLOAT = SYSTEM_ACCOUNTS.bankFloat('EUR');
const TRANSIT = SYSTEM_ACCOUNTS.inTransit('EUR');

suite('the ledger against Postgres', () => {
  let db: PrismaClient;
  let store: PrismaLedgerStore;
  let engine: PostingEngine;

  beforeAll(() => {
    db = createPrismaClient(DATABASE_URL);
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(db);
    store = new PrismaLedgerStore(db);
    engine = new PostingEngine(store);

    await store.createAccount({
      code: FLOAT,
      name: FLOAT,
      type: 'asset',
      currency: 'EUR',
      overdraftFloor: -(10n ** 15n),
    });
    await store.createAccount({
      code: SENDER,
      name: SENDER,
      type: 'liability',
      currency: 'EUR',
      overdraftFloor: 0n,
    });
    await store.createAccount({
      code: TRANSIT,
      name: TRANSIT,
      type: 'liability',
      currency: 'EUR',
      overdraftFloor: -(10n ** 15n),
    });
  });

  async function fund(amount = eur('1000.00')) {
    return engine.post({
      kind: 'transfer',
      referenceId: 'seed',
      entries: [debit(FLOAT, amount), credit(SENDER, amount)],
    });
  }

  describe('round trip', () => {
    it('persists a journal and reads the balance back', async () => {
      await fund(eur('1000.00'));

      const balance = projectBalance(SENDER, 'liability', 'EUR', await store.entriesFor([SENDER]));
      expect(balance.posted.toDecimalString()).toBe('1000.00');
    });

    it('survives a new client — the state is in the database, not the process', async () => {
      await fund(eur('250.00'));

      const fresh = new PrismaLedgerStore(createPrismaClient(DATABASE_URL));
      const balance = projectBalance(SENDER, 'liability', 'EUR', await fresh.entriesFor([SENDER]));
      expect(balance.posted.toDecimalString()).toBe('250.00');
    });

    it('keeps the trial balance at zero', async () => {
      await fund();
      await engine.post({
        kind: 'transfer',
        referenceId: 't_1',
        entries: [debit(SENDER, eur('400.00')), credit(TRANSIT, eur('400.00'))],
      });

      for (const [, totals] of trialBalance(await store.allEntries())) {
        expect(totals.difference.isZero).toBe(true);
      }
    });

    it('groups journals by reference', async () => {
      await fund();
      await engine.post({
        kind: 'fee',
        referenceId: 'ref_x',
        entries: [debit(SENDER, eur('1.00')), credit(TRANSIT, eur('1.00'))],
      });
      expect(await store.journalsFor('ref_x')).toHaveLength(1);
    });
  });

  describe('the database rejects what the engine would have', () => {
    it('refuses an unbalanced journal written directly, at COMMIT', async () => {
      const journalId = randomUUID();
      const account = await db.ledgerAccount.findUniqueOrThrow({ where: { code: FLOAT } });

      await expect(
        db.$transaction(async (tx) => {
          await tx.journal.create({
            data: { id: journalId, tenantId: 't', kind: 'transfer', referenceId: 'raw' },
          });
          await tx.ledgerEntry.create({
            data: {
              id: randomUUID(),
              journalId,
              accountId: account.id,
              direction: 'debit',
              amount: 100n,
              currency: 'EUR',
            },
          });
        }),
      ).rejects.toThrow(/does not balance/);

      expect(await db.ledgerEntry.count()).toBe(0);
    });

    it('refuses a negative amount', async () => {
      const journalId = randomUUID();
      const account = await db.ledgerAccount.findUniqueOrThrow({ where: { code: FLOAT } });

      await expect(
        db.$transaction(async (tx) => {
          await tx.journal.create({
            data: { id: journalId, tenantId: 't', kind: 'transfer', referenceId: 'neg' },
          });
          await tx.ledgerEntry.create({
            data: {
              id: randomUUID(),
              journalId,
              accountId: account.id,
              direction: 'debit',
              amount: -1n,
              currency: 'EUR',
            },
          });
        }),
      ).rejects.toThrow(/ledger_entry_amount_positive/);
    });

    it('refuses an entry in a currency its account does not hold', async () => {
      const journalId = randomUUID();
      const account = await db.ledgerAccount.findUniqueOrThrow({ where: { code: FLOAT } });

      await expect(
        db.$transaction(async (tx) => {
          await tx.journal.create({
            data: { id: journalId, tenantId: 't', kind: 'transfer', referenceId: 'ccy' },
          });
          await tx.ledgerEntry.create({
            data: {
              id: randomUUID(),
              journalId,
              accountId: account.id,
              direction: 'debit',
              amount: 100n,
              currency: 'KES',
            },
          });
        }),
      ).rejects.toThrow(/ledger_entry_account_currency_fkey/);
    });

    it('refuses to mutate or delete a posted entry', async () => {
      await fund();
      const entry = await db.ledgerEntry.findFirstOrThrow();

      await expect(
        db.ledgerEntry.update({ where: { id: entry.id }, data: { amount: 1n } }),
      ).rejects.toThrow(/append-only/);

      await expect(db.ledgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow(
        /append-only/,
      );
    });

    it('refuses a positive overdraft floor', async () => {
      await expect(
        db.ledgerAccount.create({
          data: {
            id: randomUUID(),
            tenantId: 't',
            code: 'bad.floor.EUR',
            name: 'x',
            type: 'asset',
            currency: 'EUR',
            overdraftFloor: 100n,
          },
        }),
      ).rejects.toThrow(/ledger_account_floor_non_positive/);
    });

    it('the engine still rejects before reaching the database', async () => {
      await expect(
        engine.post({
          kind: 'transfer',
          referenceId: 'bad',
          entries: [debit(FLOAT, eur('10.00')), credit(SENDER, eur('9.99'))],
        }),
      ).rejects.toThrow(UnbalancedJournalError);
      expect(await db.ledgerEntry.count()).toBe(0);
    });
  });

  describe('concurrency', () => {
    it('two concurrent transfers cannot both spend the same balance', async () => {
      await fund(eur('100.00'));

      const spend = (reference: string) =>
        engine.post({
          kind: 'transfer',
          referenceId: reference,
          entries: [debit(SENDER, eur('80.00')), credit(TRANSIT, eur('80.00'))],
        });

      const results = await Promise.allSettled([spend('a'), spend('b')]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly one succeeds. Without row locking both would read €100.00,
      // both would pass the check, and the account would end at −€60.00.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientFundsError);

      const balance = projectBalance(SENDER, 'liability', 'EUR', await store.entriesFor([SENDER]));
      expect(balance.posted.toDecimalString()).toBe('20.00');
      expect(balance.posted.isNegative).toBe(false);
    });

    it('holds the line under a burst of concurrent spends', async () => {
      await fund(eur('100.00'));

      const attempts = Array.from({ length: 8 }, (_, i) =>
        engine.post({
          kind: 'transfer',
          referenceId: `burst_${i}`,
          entries: [debit(SENDER, eur('30.00')), credit(TRANSIT, eur('30.00'))],
        }),
      );

      const results = await Promise.allSettled(attempts);
      const succeeded = results.filter((r) => r.status === 'fulfilled').length;

      // €100.00 funds exactly three €30.00 spends.
      expect(succeeded).toBe(3);

      const balance = projectBalance(SENDER, 'liability', 'EUR', await store.entriesFor([SENDER]));
      expect(balance.posted.toDecimalString()).toBe('10.00');

      for (const [, totals] of trialBalance(await store.allEntries())) {
        expect(totals.difference.isZero).toBe(true);
      }
    });
  });
});

suite('the outbox against Postgres', () => {
  let db: PrismaClient;

  beforeAll(() => {
    db = createPrismaClient(DATABASE_URL);
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  const payload = () => ({
    transferId: randomUUID(),
    payoutId: randomUUID(),
    rail: 'sepa_instant',
    amount: { amount: '10000', currency: 'EUR' },
  });

  const context = () => ({
    tenantId: 'tenant_demo',
    correlationId: randomUUID(),
    source: 'test',
  });

  it('survives a restart: staged events are still there for a new process', async () => {
    const outbox = new PrismaOutbox(db);
    const bus = new EventBus(outbox);
    await bus.publishOne('payout.completed', payload(), context());

    // A "new process" — fresh client, fresh outbox, same database.
    const restarted = new PrismaOutbox(createPrismaClient(DATABASE_URL));
    expect(await restarted.pendingCount()).toBe(1);

    const claimed = await restarted.claim(10);
    expect(claimed[0]!.event.type).toBe('payout.completed');
  });

  it('delivers, and does not redeliver a handled event', async () => {
    const outbox = new PrismaOutbox(db);
    const bus = new EventBus(outbox);
    const dispatcher = new Dispatcher(bus, outbox, new PrismaProcessedLog(db), {
      baseRetryDelayMs: 0,
    });

    let calls = 0;
    bus.subscribe('counter', 'payout.completed', async () => {
      calls += 1;
    });

    await bus.publishOne('payout.completed', payload(), context());
    await dispatcher.drainUntilEmpty();
    await dispatcher.drainUntilEmpty();

    expect(calls).toBe(1);
    expect(await outbox.pendingCount()).toBe(0);
  });

  it('does not re-run a handler that already succeeded, across processes', async () => {
    const outbox = new PrismaOutbox(db);
    const bus = new EventBus(outbox);
    const event = createEvent('payout.completed', payload(), context());
    await bus.publish([event]);

    const log = new PrismaProcessedLog(db);
    await log.record('ledger', event.id);
    // A different process asking the same question gets the same answer.
    expect(
      await new PrismaProcessedLog(createPrismaClient(DATABASE_URL)).has('ledger', event.id),
    ).toBe(true);
  });

  it('records failures and backs off', async () => {
    const outbox = new PrismaOutbox(db);
    const bus = new EventBus(outbox);
    const clock = Date.now();
    const dispatcher = new Dispatcher(bus, outbox, new PrismaProcessedLog(db), {
      baseRetryDelayMs: 60_000,
      now: () => clock,
    });

    bus.subscribe('flaky', 'payout.completed', async () => {
      throw new Error('downstream unavailable');
    });

    await bus.publishOne('payout.completed', payload(), context());
    await dispatcher.drain();

    const [record] = await outbox.claim(10, clock + 120_000);
    expect(record!.attempts).toBe(1);
    expect(record!.lastError).toContain('downstream unavailable');

    // Not yet due at the original time.
    expect(await outbox.claim(10, clock)).toHaveLength(0);
  });

  it('parks a poison event without overflowing its timestamp', async () => {
    const outbox = new PrismaOutbox(db);
    const bus = new EventBus(outbox);
    const dispatcher = new Dispatcher(bus, outbox, new PrismaProcessedLog(db), {
      baseRetryDelayMs: 0,
      maxAttempts: 2,
    });

    bus.subscribe('always-fails', 'payout.completed', async () => {
      throw new Error('permanently broken');
    });

    await bus.publishOne('payout.completed', payload(), context());
    await dispatcher.drainUntilEmpty();

    const row = await db.outboxEvent.findFirstOrThrow();
    expect(row.status).toBe('failed');
    expect(row.lastError).toContain('permanently broken');
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('staging the same event twice stores one row', async () => {
    const outbox = new PrismaOutbox(db);
    const event = createEvent('payout.completed', payload(), context());
    await outbox.stage([event]);
    await outbox.stage([event]);
    expect(await db.outboxEvent.count()).toBe(1);
  });
});
