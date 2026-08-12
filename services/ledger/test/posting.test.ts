import { Money, type CurrencyCode } from '@arc/money';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  credit,
  CurrencyMismatchError,
  debit,
  InMemoryLedgerStore,
  InsufficientFundsError,
  PostingEngine,
  projectBalance,
  SYSTEM_ACCOUNTS,
  trialBalance,
  UnbalancedJournalError,
  UnknownAccountError,
  type AccountType,
} from '../src/index.js';

const eur = (v: string) => Money.parse(v, 'EUR');
const kes = (v: string) => Money.parse(v, 'KES');

let store: InMemoryLedgerStore;
let engine: PostingEngine;

async function account(
  code: string,
  type: AccountType,
  currency: CurrencyCode,
  overdraftFloor = 0n,
) {
  return store.createAccount({ code, name: code, type, currency, overdraftFloor });
}

beforeEach(async () => {
  store = new InMemoryLedgerStore();
  engine = new PostingEngine(store);

  await account(SYSTEM_ACCOUNTS.bankFloat('EUR'), 'asset', 'EUR', -10_000_00n);
  await account(SYSTEM_ACCOUNTS.bankFloat('KES'), 'asset', 'KES', -10_000_000_00n);
  await account(SYSTEM_ACCOUNTS.chainFloat('USDC'), 'asset', 'USDC', -10_000_000_000n);
  await account(SYSTEM_ACCOUNTS.customer('va_sender', 'EUR'), 'liability', 'EUR');
  await account(SYSTEM_ACCOUNTS.customer('va_recipient', 'KES'), 'liability', 'KES');
  await account(SYSTEM_ACCOUNTS.inTransit('EUR'), 'liability', 'EUR');
  await account(SYSTEM_ACCOUNTS.corridorFee('EUR'), 'revenue', 'EUR');
  await account(SYSTEM_ACCOUNTS.fxSpread('EUR'), 'revenue', 'EUR');
  await account(SYSTEM_ACCOUNTS.rounding('EUR'), 'revenue', 'EUR');
  await account(SYSTEM_ACCOUNTS.fxPosition('EUR'), 'equity', 'EUR', -100_000_00n);
  await account(SYSTEM_ACCOUNTS.fxPosition('USDC'), 'equity', 'USDC', -100_000_000_000n);
  await account(SYSTEM_ACCOUNTS.fxPosition('KES'), 'equity', 'KES', -100_000_000_00n);
});

async function fundSender(amount = eur('1000.00')) {
  return engine.post({
    kind: 'transfer',
    referenceId: 'deposit_1',
    description: 'Sender funds their EUR virtual account',
    entries: [
      debit(SYSTEM_ACCOUNTS.bankFloat('EUR'), amount),
      credit(SYSTEM_ACCOUNTS.customer('va_sender', 'EUR'), amount),
    ],
  });
}

describe('balance-or-reject', () => {
  it('posts a valid journal and returns it', async () => {
    const journal = await fundSender();
    expect(journal.id).toBeTruthy();
    expect(journal.entries).toHaveLength(2);
    expect(store.allJournals()).toHaveLength(1);
  });

  it('writes nothing when a journal is unbalanced', async () => {
    await expect(
      engine.post({
        kind: 'transfer',
        referenceId: 'bad_1',
        entries: [
          debit(SYSTEM_ACCOUNTS.bankFloat('EUR'), eur('1000.00')),
          credit(SYSTEM_ACCOUNTS.customer('va_sender', 'EUR'), eur('999.99')),
        ],
      }),
    ).rejects.toThrow(UnbalancedJournalError);

    // The rejection left no trace at all.
    expect(store.allJournals()).toHaveLength(0);
    expect(store.allEntries()).toHaveLength(0);
  });

  it('rejects an unknown account', async () => {
    await expect(
      engine.post({
        kind: 'transfer',
        referenceId: 'bad_2',
        entries: [
          debit('asset.float.bank.GBP', Money.parse('10.00', 'GBP')),
          credit(SYSTEM_ACCOUNTS.customer('va_sender', 'EUR'), eur('10.00')),
        ],
      }),
    ).rejects.toThrow(UnbalancedJournalError); // GBP half cannot balance either
  });

  it('rejects an entry whose currency does not match its account', async () => {
    await expect(
      engine.post({
        kind: 'transfer',
        referenceId: 'bad_3',
        entries: [
          // The account is EUR-denominated; the entry is KES.
          debit(SYSTEM_ACCOUNTS.bankFloat('EUR'), kes('100.00')),
          credit(SYSTEM_ACCOUNTS.bankFloat('KES'), kes('100.00')),
        ],
      }),
    ).rejects.toThrow(CurrencyMismatchError);
    expect(store.allJournals()).toHaveLength(0);
  });

  it('reports an account that does not exist', async () => {
    await expect(
      engine.post({
        kind: 'fee',
        referenceId: 'bad_4',
        entries: [
          debit(SYSTEM_ACCOUNTS.customer('va_sender', 'EUR'), eur('1.00')),
          credit('revenue.fee.nonexistent.EUR', eur('1.00')),
        ],
      }),
    ).rejects.toThrow(UnknownAccountError);
  });
});

describe('overdraft protection', () => {
  it('refuses to overdraw a customer account', async () => {
    await fundSender(eur('100.00'));

    await expect(
      engine.post({
        kind: 'transfer',
        referenceId: 'over_1',
        entries: [
          debit(SYSTEM_ACCOUNTS.customer('va_sender', 'EUR'), eur('100.01')),
          credit(SYSTEM_ACCOUNTS.inTransit('EUR'), eur('100.01')),
        ],
      }),
    ).rejects.toThrow(InsufficientFundsError);

    // Balance untouched by the failed attempt.
    const balance = projectBalance(
      SYSTEM_ACCOUNTS.customer('va_sender', 'EUR'),
      'liability',
      'EUR',
      await store.entriesFor([SYSTEM_ACCOUNTS.customer('va_sender', 'EUR')]),
    );
    expect(balance.posted.toDecimalString()).toBe('100.00');
  });

  it('allows spending down to exactly zero', async () => {
    await fundSender(eur('100.00'));
    await expect(
      engine.post({
        kind: 'transfer',
        referenceId: 'exact_1',
        entries: [
          debit(SYSTEM_ACCOUNTS.customer('va_sender', 'EUR'), eur('100.00')),
          credit(SYSTEM_ACCOUNTS.inTransit('EUR'), eur('100.00')),
        ],
      }),
    ).resolves.toBeTruthy();
  });

  it('honours a configured overdraft floor on a platform account', async () => {
    // Bank float is allowed an intraday credit line down to -10,000.00.
    // Crediting an asset account decreases it, so this draws the float down.
    await expect(
      engine.post({
        kind: 'settlement',
        referenceId: 'float_1',
        entries: [
          debit(SYSTEM_ACCOUNTS.fxPosition('EUR'), eur('9000.00')),
          credit(SYSTEM_ACCOUNTS.bankFloat('EUR'), eur('9000.00')),
        ],
      }),
    ).resolves.toBeTruthy();

    // A further 2,000.00 would take it to -11,000.00, past the line.
    await expect(
      engine.post({
        kind: 'settlement',
        referenceId: 'float_2',
        entries: [
          debit(SYSTEM_ACCOUNTS.fxPosition('EUR'), eur('2000.00')),
          credit(SYSTEM_ACCOUNTS.bankFloat('EUR'), eur('2000.00')),
        ],
      }),
    ).rejects.toThrow(InsufficientFundsError);
  });

  it('refuses to drive a zero-floor liability account negative', async () => {
    // in_transit holds funds committed to live transfers. It can never be
    // negative: that would mean paying out money nobody put in.
    await expect(
      engine.post({
        kind: 'settlement',
        referenceId: 'transit_1',
        entries: [
          debit(SYSTEM_ACCOUNTS.inTransit('EUR'), eur('1.00')),
          credit(SYSTEM_ACCOUNTS.bankFloat('EUR'), eur('1.00')),
        ],
      }),
    ).rejects.toThrow(InsufficientFundsError);
  });
});

describe('balances are derived, never stored', () => {
  it('projects posted, reserved and available', async () => {
    await fundSender(eur('1000.00'));
    const code = SYSTEM_ACCOUNTS.customer('va_sender', 'EUR');

    store.addHold({ accountCode: code, amount: eur('250.00'), status: 'active' });
    store.addHold({ accountCode: code, amount: eur('100.00'), status: 'released' });

    const balance = projectBalance(
      code,
      'liability',
      'EUR',
      await store.entriesFor([code]),
      await store.activeHoldsFor([code]),
    );

    expect(balance.posted.toDecimalString()).toBe('1000.00');
    expect(balance.reserved.toDecimalString()).toBe('250.00'); // the released hold does not count
    expect(balance.available.toDecimalString()).toBe('750.00');
  });

  it('gives assets and liabilities opposite signs from the same entry', async () => {
    await fundSender(eur('500.00'));
    const entries = store.allEntries();

    const asset = projectBalance(SYSTEM_ACCOUNTS.bankFloat('EUR'), 'asset', 'EUR', entries);
    const liability = projectBalance(
      SYSTEM_ACCOUNTS.customer('va_sender', 'EUR'),
      'liability',
      'EUR',
      entries,
    );

    // Arc holds €500 and owes €500. Both balances read positive in their own terms.
    expect(asset.posted.toDecimalString()).toBe('500.00');
    expect(liability.posted.toDecimalString()).toBe('500.00');
  });
});

describe('a full corridor transfer: EUR in Germany → KES mobile money', () => {
  it('moves €1,000.00 to KES and leaves every currency balanced', async () => {
    await fundSender(eur('1000.00'));

    // 1. Debit the sender, split into net, corridor fee and FX spread.
    await engine.post({
      kind: 'transfer',
      referenceId: 'transfer_1',
      description: 'Sender commits EUR 1000.00',
      entries: [
        debit(SYSTEM_ACCOUNTS.customer('va_sender', 'EUR'), eur('1000.00')),
        credit(SYSTEM_ACCOUNTS.inTransit('EUR'), eur('990.00')),
        credit(SYSTEM_ACCOUNTS.corridorFee('EUR'), eur('5.00')),
        credit(SYSTEM_ACCOUNTS.fxSpread('EUR'), eur('5.00')),
      ],
    });

    // 2. Convert EUR to KES. Each currency closes against its FX position account.
    await engine.post({
      kind: 'fx',
      referenceId: 'transfer_1',
      description: 'EUR 990.00 → KES 138,401.00 at 139.799',
      entries: [
        debit(SYSTEM_ACCOUNTS.inTransit('EUR'), eur('990.00')),
        credit(SYSTEM_ACCOUNTS.fxPosition('EUR'), eur('990.00')),
        debit(SYSTEM_ACCOUNTS.fxPosition('KES'), kes('138401.00')),
        credit(SYSTEM_ACCOUNTS.bankFloat('KES'), kes('138401.00')),
      ],
    });

    // 3. Pay out to the recipient's mobile-money wallet.
    await engine.post({
      kind: 'settlement',
      referenceId: 'transfer_1',
      description: 'Payout to M-Pesa wallet',
      entries: [
        debit(SYSTEM_ACCOUNTS.bankFloat('KES'), kes('138401.00')),
        credit(SYSTEM_ACCOUNTS.customer('va_recipient', 'KES'), kes('138401.00')),
      ],
    });

    const entries = store.allEntries();

    // The recipient has their money.
    const recipient = projectBalance(
      SYSTEM_ACCOUNTS.customer('va_recipient', 'KES'),
      'liability',
      'KES',
      entries,
    );
    expect(recipient.posted.toDecimalString()).toBe('138401.00');

    // The sender is drained.
    const sender = projectBalance(
      SYSTEM_ACCOUNTS.customer('va_sender', 'EUR'),
      'liability',
      'EUR',
      entries,
    );
    expect(sender.posted.isZero).toBe(true);

    // Arc kept €10.00 in revenue.
    const fees = projectBalance(SYSTEM_ACCOUNTS.corridorFee('EUR'), 'revenue', 'EUR', entries);
    const spread = projectBalance(SYSTEM_ACCOUNTS.fxSpread('EUR'), 'revenue', 'EUR', entries);
    expect(fees.posted.add(spread.posted).toDecimalString()).toBe('10.00');

    // And every currency in the whole ledger still balances.
    for (const [, totals] of trialBalance(entries)) {
      expect(totals.difference.isZero).toBe(true);
    }
  });

  it('unwinds cleanly when the payout fails', async () => {
    await fundSender(eur('1000.00'));

    const committed = await engine.post({
      kind: 'transfer',
      referenceId: 'transfer_2',
      entries: [
        debit(SYSTEM_ACCOUNTS.customer('va_sender', 'EUR'), eur('1000.00')),
        credit(SYSTEM_ACCOUNTS.inTransit('EUR'), eur('990.00')),
        credit(SYSTEM_ACCOUNTS.corridorFee('EUR'), eur('10.00')),
      ],
    });

    // The rail rejects the payout. Compensate with the opposite journal — the
    // original stays in the record; the correction sits beside it.
    await engine.post({
      kind: 'reversal',
      referenceId: 'transfer_2',
      description: 'Payout rejected by rail; refunding sender',
      entries: committed.entries.map((e) => ({
        account: e.accountCode,
        direction: e.direction === 'debit' ? ('credit' as const) : ('debit' as const),
        amount: e.amount,
      })),
    });

    const entries = store.allEntries();

    // The sender is whole again.
    const sender = projectBalance(
      SYSTEM_ACCOUNTS.customer('va_sender', 'EUR'),
      'liability',
      'EUR',
      entries,
    );
    expect(sender.posted.toDecimalString()).toBe('1000.00');

    // The fee was given back too.
    const fees = projectBalance(SYSTEM_ACCOUNTS.corridorFee('EUR'), 'revenue', 'EUR', entries);
    expect(fees.posted.isZero).toBe(true);

    // Nothing was deleted — both journals are in the record.
    expect(store.allJournals()).toHaveLength(3);

    for (const [, totals] of trialBalance(entries)) {
      expect(totals.difference.isZero).toBe(true);
    }
  });
});
