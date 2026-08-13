import { SimulatedChain } from '@arc/chain';
import {
  credit,
  debit,
  InMemoryLedgerStore,
  PostingEngine,
  projectBalance,
  SYSTEM_ACCOUNTS,
  trialBalance,
  type AccountType,
} from '@arc/ledger';
import { Money, type CurrencyCode } from '@arc/money';
import {
  AlwaysApprove,
  QuoteEngine,
  SimulatedRail,
  StaticRateProvider,
  type AccountRefs,
  type CompliancePort,
  type JournalInput,
  type LedgerPort,
  type PostedJournalRef,
} from '../src/index.js';

/**
 * Adapts the real ledger to movement's port. This is the composition root the
 * two contexts meet at — neither imports the other.
 */
export class LedgerAdapter implements LedgerPort {
  constructor(
    private readonly engine: PostingEngine,
    private readonly store: InMemoryLedgerStore,
  ) {}

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

export const SENDER_VA = 'va_sender';

export const ACCOUNTS: AccountRefs = {
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

const WIDE = -(10n ** 24n);

const ACCOUNT_SPECS: ReadonlyArray<[string, AccountType, CurrencyCode, bigint]> = [
  [ACCOUNTS.senderCustomer, 'liability', 'EUR', 0n],
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
  [SYSTEM_ACCOUNTS.bankFloat('EUR'), 'asset', 'EUR', WIDE],
];

export const RATES = {
  'EUR/KES': '139.7994',
  'EUR/USDC': '1.0842',
  'USDC/KES': '128.9463',
};

export interface Harness {
  store: InMemoryLedgerStore;
  engine: PostingEngine;
  ledger: LedgerAdapter;
  chain: SimulatedChain;
  rail: SimulatedRail;
  quotes: QuoteEngine;
  compliance: CompliancePort;
  advanceChain: (hash: string) => void;
  senderBalance(): Promise<Money>;
  assertBalancedLedger(): void;
}

export async function createHarness(
  options: { seed?: string; fundSender?: string; reliableRail?: boolean } = {},
): Promise<Harness> {
  const seed = options.seed ?? 'phase4';
  const store = new InMemoryLedgerStore();
  const engine = new PostingEngine(store);

  for (const [code, type, currency, floor] of ACCOUNT_SPECS) {
    await store.createAccount({ code, name: code, type, currency, overdraftFloor: floor });
  }

  const funding = Money.parse(options.fundSender ?? '5000.00', 'EUR');
  await engine.post({
    kind: 'transfer',
    referenceId: 'seed_deposit',
    entries: [
      debit(SYSTEM_ACCOUNTS.bankFloat('EUR'), funding),
      credit(ACCOUNTS.senderCustomer, funding),
    ],
  });

  const chain = new SimulatedChain('base', {
    seed,
    config: { dropChanceBps: 0, revertChanceBps: 0, reorgChanceBps: 0 },
  });

  const rail = new SimulatedRail(
    'mpesa',
    options.reliableRail === false
      ? { seed }
      : { seed, config: { rejectChanceBps: 0, timeoutChanceBps: 0 } },
  );

  const ledger = new LedgerAdapter(engine, store);

  return {
    store,
    engine,
    ledger,
    chain,
    rail,
    quotes: new QuoteEngine(new StaticRateProvider(RATES)),
    compliance: new AlwaysApprove(),
    advanceChain: () => chain.advance(chain.config.finalityDepth + 2),
    async senderBalance() {
      return projectBalance(ACCOUNTS.senderCustomer, 'liability', 'EUR', store.allEntries()).posted;
    },
    assertBalancedLedger() {
      for (const [, totals] of trialBalance(store.allEntries())) {
        if (!totals.difference.isZero) {
          throw new Error(
            `ledger out of balance: ${totals.difference.toString()} (debits ${totals.debits.toString()}, credits ${totals.credits.toString()})`,
          );
        }
      }
    },
  };
}
