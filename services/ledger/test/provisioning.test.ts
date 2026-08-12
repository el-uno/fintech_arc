import { randomUUID } from 'node:crypto';
import { Dispatcher, EventBus, InMemoryOutbox, InMemoryProcessedLog } from '@arc/bus';
import { Money } from '@arc/money';
import { InMemoryAccountStore, OnboardingService } from '@arc/product';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  credit,
  debit,
  InMemoryLedgerStore,
  PostingEngine,
  projectBalance,
  registerLedgerProvisioning,
  SYSTEM_ACCOUNTS,
  trialBalance,
} from '../src/index.js';

const context = () => ({
  tenantId: 'tenant_demo',
  correlationId: randomUUID(),
  source: 'test',
});

let ledgerStore: InMemoryLedgerStore;
let engine: PostingEngine;
let bus: EventBus;
let outbox: InMemoryOutbox;
let dispatcher: Dispatcher;
let onboarding: OnboardingService;

beforeEach(() => {
  ledgerStore = new InMemoryLedgerStore();
  engine = new PostingEngine(ledgerStore);
  outbox = new InMemoryOutbox();
  bus = new EventBus(outbox);
  dispatcher = new Dispatcher(bus, outbox, new InMemoryProcessedLog(), { baseRetryDelayMs: 0 });
  onboarding = new OnboardingService(new InMemoryAccountStore(), bus);

  registerLedgerProvisioning(bus, ledgerStore);
});

describe('product and ledger communicate only through events', () => {
  it('provisions a customer liability account when a virtual account is issued', async () => {
    const { virtualAccounts } = await onboarding.openAccount(
      {
        kind: 'personal',
        countryCode: 'DE',
        displayName: 'Amina',
        tier: 2,
        currencies: ['EUR', 'NGN', 'KES', 'USDC'],
      },
      context(),
    );

    // Nothing exists in the ledger yet — the events are staged, not delivered.
    for (const va of virtualAccounts) {
      expect(
        await ledgerStore.getAccount(SYSTEM_ACCOUNTS.customer(va.id, va.currency)),
      ).toBeUndefined();
    }

    await dispatcher.drainUntilEmpty();

    for (const va of virtualAccounts) {
      const account = await ledgerStore.getAccount(SYSTEM_ACCOUNTS.customer(va.id, va.currency));
      expect(account).toBeDefined();
      expect(account!.type).toBe('liability');
      expect(account!.currency).toBe(va.currency);
      expect(account!.overdraftFloor).toBe(0n);
    }
  });

  it('provisions the platform accounts for each currency touched', async () => {
    await onboarding.openAccount(
      { kind: 'personal', countryCode: 'DE', displayName: 'Amina', currencies: ['EUR'] },
      context(),
    );
    await dispatcher.drainUntilEmpty();

    for (const code of [
      SYSTEM_ACCOUNTS.bankFloat('EUR'),
      SYSTEM_ACCOUNTS.inTransit('EUR'),
      SYSTEM_ACCOUNTS.corridorFee('EUR'),
      SYSTEM_ACCOUNTS.fxPosition('EUR'),
      SYSTEM_ACCOUNTS.rounding('EUR'),
    ]) {
      expect(await ledgerStore.getAccount(code)).toBeDefined();
    }
  });

  it('is idempotent under redelivery', async () => {
    await onboarding.openAccount(
      { kind: 'personal', countryCode: 'DE', displayName: 'Amina', currencies: ['EUR', 'KES'] },
      context(),
    );
    await dispatcher.drainUntilEmpty();
    // Draining again must not attempt to recreate anything.
    await expect(dispatcher.drainUntilEmpty()).resolves.toBeDefined();
  });

  it('an onboarded user can be funded and holds a real balance', async () => {
    const { virtualAccounts } = await onboarding.openAccount(
      {
        kind: 'personal',
        countryCode: 'DE',
        displayName: 'Amina',
        tier: 2,
        currencies: ['EUR', 'NGN', 'KES', 'USDC'],
      },
      context(),
    );
    await dispatcher.drainUntilEmpty();

    const deposits: Array<[string, string]> = [
      ['EUR', '1500.00'],
      ['NGN', '250000.00'],
      ['KES', '75000.00'],
      ['USDC', '900.000000'],
    ];

    for (const [currency, amount] of deposits) {
      const va = virtualAccounts.find((v) => v.currency === currency)!;
      const value = Money.parse(amount, currency as 'EUR');
      const float =
        currency === 'USDC'
          ? SYSTEM_ACCOUNTS.chainFloat('USDC')
          : SYSTEM_ACCOUNTS.bankFloat(currency as 'EUR');

      await engine.post({
        kind: 'transfer',
        referenceId: `deposit_${currency}`,
        entries: [debit(float, value), credit(SYSTEM_ACCOUNTS.customer(va.id, va.currency), value)],
      });
    }

    const entries = ledgerStore.allEntries();

    for (const [currency, amount] of deposits) {
      const va = virtualAccounts.find((v) => v.currency === currency)!;
      const balance = projectBalance(
        SYSTEM_ACCOUNTS.customer(va.id, va.currency),
        'liability',
        currency as 'EUR',
        entries,
      );
      expect(balance.posted.toDecimalString()).toBe(amount);
    }

    for (const [, totals] of trialBalance(entries)) {
      expect(totals.difference.isZero).toBe(true);
    }
  });
});
