/* eslint-disable no-console */
import { randomUUID } from 'node:crypto';
import { SimulatedChain } from '@arc/chain';
import { createPrismaClient, truncateAll } from '@arc/db';
import {
  credit,
  debit,
  PostingEngine,
  PrismaLedgerStore,
  projectBalance,
  SYSTEM_ACCOUNTS,
  trialBalance,
  type AccountType,
} from '@arc/ledger';
import { Money, type CurrencyCode } from '@arc/money';
import {
  AlwaysApprove,
  QuoteEngine,
  SettlementSaga,
  SimulatedRail,
  StaticRateProvider,
  type AccountRefs,
  type JournalInput,
  type LedgerPort,
  type PostedJournalRef,
} from '@arc/movement';

/**
 * Runs one corridor transfer end to end against Postgres and prints the ledger.
 *
 * This is the answer to "does any of it actually work" — the real posting
 * engine, the real chain simulator, the real rail, and a real database.
 */

const SENDER_VA = 'va_scenario';

const ACCOUNTS: AccountRefs = {
  senderCustomer: SYSTEM_ACCOUNTS.customer(SENDER_VA, 'EUR'),
  beneficiaryIdentifier: '+254712345678',
  inTransitSend: SYSTEM_ACCOUNTS.inTransit('EUR'),
  inTransitReceive: SYSTEM_ACCOUNTS.inTransit('KES'),
  corridorFee: SYSTEM_ACCOUNTS.corridorFee('EUR'),
  fxSpread: SYSTEM_ACCOUNTS.fxSpread('EUR'),
  fxSpreadReceive: SYSTEM_ACCOUNTS.fxSpread('KES'),
  fxPositionSend: SYSTEM_ACCOUNTS.fxPosition('EUR'),
  fxPositionSettlement: SYSTEM_ACCOUNTS.fxPosition('USDC'),
  chainFloat: SYSTEM_ACCOUNTS.chainFloat('USDC'),
  bankFloatReceive: SYSTEM_ACCOUNTS.bankFloat('KES'),
  networkFeeExpense: SYSTEM_ACCOUNTS.networkFee('ETH'),
  chainFloatFeeAsset: SYSTEM_ACCOUNTS.chainFloat('ETH'),
};

// Wide enough for the scenario, and within the int64 range Postgres BIGINT holds.
const WIDE = -(10n ** 15n);

const SPECS: ReadonlyArray<[string, AccountType, CurrencyCode, bigint]> = [
  [ACCOUNTS.senderCustomer, 'liability', 'EUR', 0n],
  [SYSTEM_ACCOUNTS.bankFloat('EUR'), 'asset', 'EUR', WIDE],
  [ACCOUNTS.inTransitSend, 'liability', 'EUR', WIDE],
  [ACCOUNTS.inTransitReceive, 'liability', 'KES', WIDE],
  [ACCOUNTS.corridorFee, 'revenue', 'EUR', WIDE],
  [ACCOUNTS.fxSpread, 'revenue', 'EUR', WIDE],
  [ACCOUNTS.fxSpreadReceive, 'revenue', 'KES', WIDE],
  [ACCOUNTS.fxPositionSend, 'equity', 'EUR', WIDE],
  [ACCOUNTS.fxPositionSettlement, 'equity', 'USDC', WIDE],
  [ACCOUNTS.chainFloat, 'asset', 'USDC', WIDE],
  [ACCOUNTS.bankFloatReceive, 'asset', 'KES', WIDE],
  [ACCOUNTS.networkFeeExpense, 'expense', 'ETH', WIDE],
  [ACCOUNTS.chainFloatFeeAsset, 'asset', 'ETH', WIDE],
];

class LedgerAdapter implements LedgerPort {
  // Plain fields rather than parameter properties: this file runs directly
  // under `node --experimental-strip-types`, which does not support them.
  readonly engine: PostingEngine;
  readonly store: PrismaLedgerStore;

  constructor(engine: PostingEngine, store: PrismaLedgerStore) {
    this.engine = engine;
    this.store = store;
  }

  async post(journal: JournalInput): Promise<PostedJournalRef> {
    const posted = await this.engine.post({
      kind: journal.kind,
      referenceId: journal.referenceId,
      ...(journal.description ? { description: journal.description } : {}),
      entries: journal.entries.map((e) =>
        e.direction === 'debit' ? debit(e.account, e.amount) : credit(e.account, e.amount),
      ),
    });
    return {
      id: posted.id,
      entries: posted.entries.map((e) => ({
        account: e.accountCode,
        direction: e.direction,
        amount: e.amount,
      })),
    };
  }

  async availableBalance(accountCode: string, currency: CurrencyCode): Promise<Money> {
    const account = await this.store.getAccount(accountCode);
    if (!account) return Money.zero(currency);
    return projectBalance(
      accountCode,
      account.type,
      currency,
      await this.store.entriesFor([accountCode]),
    ).available;
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error(
      'DATABASE_URL is not set.\n\n' +
        '  cp .env.example .env\n' +
        '  docker compose -f ops/docker-compose.yml up -d\n' +
        '  pnpm prisma migrate deploy --schema prisma/schema.prisma\n',
    );
    process.exitCode = 1;
    return;
  }

  const db = createPrismaClient(process.env.DATABASE_URL);

  console.log('Arc — corridor scenario (EUR Germany → KES mobile money)\n');
  console.log('Resetting the database…');
  await truncateAll(db);

  const store = new PrismaLedgerStore(db);
  const engine = new PostingEngine(store);

  for (const [code, type, currency, floor] of SPECS) {
    await store.createAccount({ code, name: code, type, currency, overdraftFloor: floor });
  }

  const funding = Money.parse('5000.00', 'EUR');
  await engine.post({
    kind: 'transfer',
    referenceId: 'deposit',
    description: 'Sender funds their EUR virtual account',
    entries: [
      debit(SYSTEM_ACCOUNTS.bankFloat('EUR'), funding),
      credit(ACCOUNTS.senderCustomer, funding),
    ],
  });
  console.log(`Funded sender with ${funding.toString()}\n`);

  const quotes = new QuoteEngine(
    new StaticRateProvider({ 'EUR/KES': '139.7994', 'EUR/USDC': '1.0842' }),
  );
  const quote = await quotes.quote({
    sendAmount: Money.parse('1000.00', 'EUR'),
    receiveCurrency: 'KES',
    settlementAsset: 'USDC',
    corridor: 'DE-KE',
  });

  console.log('Quote');
  console.log(`  send      ${quote.sendAmount.toString()}`);
  console.log(`  receive   ${quote.receiveAmount.toString()}`);
  console.log(`  settle    ${quote.settlementAmount.toString()}`);
  for (const fee of quote.fees) {
    console.log(
      `  fee       ${fee.kind.padEnd(10)} ${fee.amount.toString()}  (${fee.description})`,
    );
  }
  console.log();

  const chain = new SimulatedChain('base', {
    seed: 'scenario',
    config: { dropChanceBps: 0, revertChanceBps: 0, reorgChanceBps: 0 },
  });

  const saga = new SettlementSaga({
    ledger: new LedgerAdapter(engine, store),
    compliance: new AlwaysApprove(),
    chain,
    rail: new SimulatedRail('mpesa', {
      seed: 'scenario',
      config: { rejectChanceBps: 0, timeoutChanceBps: 0 },
    }),
    advanceChain: () => chain.advance(chain.config.finalityDepth + 2),
  });

  const transferId = randomUUID();
  const result = await saga.execute({
    transferId,
    quote,
    accounts: ACCOUNTS,
    chain: 'base',
    settlementFrom: '0xarc',
    settlementTo: '0xpartner',
  });

  console.log(`Saga: ${result.status}`);
  console.log(`  steps     ${result.completedSteps.join(' → ')}`);
  if (result.chainTxHash) console.log(`  chain tx  ${result.chainTxHash}`);
  if (result.railReference) console.log(`  rail ref  ${result.railReference}`);
  if (result.reason) console.log(`  reason    ${result.reason}`);
  console.log();

  const journals = await store.journalsFor(transferId);
  console.log(`Journals posted for this transfer: ${journals.length}\n`);

  for (const journal of journals) {
    console.log(`  [${journal.kind}] ${journal.description ?? ''}`);
    for (const entry of journal.entries) {
      const side = entry.direction === 'debit' ? 'Dr' : '  Cr';
      console.log(`      ${side} ${entry.accountCode.padEnd(42)} ${entry.amount.toString()}`);
    }
    console.log();
  }

  const entries = await store.allEntries();

  console.log('Trial balance');
  let balanced = true;
  for (const [currency, totals] of trialBalance(entries)) {
    const ok = totals.difference.isZero;
    balanced &&= ok;
    console.log(
      `  ${currency.padEnd(6)} debits ${totals.debits.toDecimalString().padStart(16)}   ` +
        `credits ${totals.credits.toDecimalString().padStart(16)}   ${ok ? 'balanced' : 'OUT BY ' + totals.difference.toDecimalString()}`,
    );
  }

  const sender = projectBalance(
    ACCOUNTS.senderCustomer,
    'liability',
    'EUR',
    await store.entriesFor([ACCOUNTS.senderCustomer]),
  );
  console.log(`\nSender balance: ${sender.posted.toString()}`);
  console.log(`Every currency balanced: ${balanced ? 'yes' : 'NO'}`);

  await db.$disconnect();

  if (!balanced || result.status !== 'completed') process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
