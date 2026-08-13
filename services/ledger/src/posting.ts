import { randomUUID } from 'node:crypto';
import { Money, type CurrencyCode } from '@arc/money';
import { entrySign, type AccountType } from './accounts.js';
import { projectPosted, type Hold, type PostedEntry } from './balances.js';
import { assertBalanced, LedgerError, type EntryDraft, type JournalDraft } from './journal.js';

export class UnknownAccountError extends LedgerError {
  constructor(readonly account: string) {
    super(`no such ledger account: ${account}`);
    this.name = 'UnknownAccountError';
  }
}

export class CurrencyMismatchError extends LedgerError {
  constructor(account: string, accountCurrency: CurrencyCode, entryCurrency: CurrencyCode) {
    super(`account ${account} is denominated in ${accountCurrency}, entry is ${entryCurrency}`);
    this.name = 'CurrencyMismatchError';
  }
}

export class InsufficientFundsError extends LedgerError {
  constructor(
    readonly account: string,
    readonly resulting: Money,
    readonly floor: Money,
  ) {
    super(
      `posting would take ${account} to ${resulting.toDecimalString()}, ` +
        `below its floor of ${floor.toDecimalString()}`,
    );
    this.name = 'InsufficientFundsError';
  }
}

export interface LedgerAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly currency: CurrencyCode;
  readonly overdraftFloor: bigint;
}

export interface PostedJournal {
  readonly id: string;
  readonly kind: JournalDraft['kind'];
  readonly referenceId: string;
  readonly description?: string;
  readonly postedAt: Date;
  readonly entries: readonly PostedEntry[];
}

export interface LedgerStore {
  getAccount(code: string): Promise<LedgerAccount | undefined>;
  createAccount(account: Omit<LedgerAccount, 'id'>): Promise<LedgerAccount>;
  entriesFor(accountCodes: readonly string[]): Promise<PostedEntry[]>;
  activeHoldsFor(accountCodes: readonly string[]): Promise<Hold[]>;
  /** Must be atomic: every entry lands or none does. */
  append(journal: PostedJournal): Promise<PostedJournal>;
  /**
   * Run `fn` with the named accounts locked against concurrent posting.
   *
   * Without this the overdraft check is a read-then-write race: two concurrent
   * transfers can both read a sufficient balance and both proceed, overdrawing
   * the account. The database triggers do not catch it — they enforce that a
   * journal balances, not that an account stayed above its floor.
   *
   * A store that cannot lock (single-threaded, in-memory) may pass straight
   * through; a real store must take row locks and keep the read and the write
   * inside one transaction.
   */
  withAccountLocks<T>(
    accountCodes: readonly string[],
    fn: (store: LedgerStore) => Promise<T>,
  ): Promise<T>;
}

export class PostingEngine {
  constructor(private readonly store: LedgerStore) {}

  async post(draft: JournalDraft): Promise<PostedJournal> {
    assertBalanced(draft.entries);

    const accounts = await this.resolveAccounts(draft.entries);

    const entries: PostedEntry[] = draft.entries.map((entry) => {
      const account = accounts.get(entry.account)!;
      return {
        accountCode: entry.account,
        accountType: account.type,
        direction: entry.direction,
        amount: entry.amount,
      };
    });

    const touched = [...new Set(entries.map((e) => e.accountCode))].sort();

    // The overdraft check and the write must be one atomic unit, or two
    // concurrent transfers can both pass the check and overdraw the account.
    // Codes are sorted so concurrent posts acquire locks in the same order and
    // cannot deadlock against each other.
    return this.store.withAccountLocks(touched, async (locked) => {
      await this.assertNoOverdraft(entries, accounts, locked);

      const journal: PostedJournal = {
        id: randomUUID(),
        kind: draft.kind,
        referenceId: draft.referenceId,
        ...(draft.description ? { description: draft.description } : {}),
        postedAt: new Date(),
        entries,
      };

      return locked.append(journal);
    });
  }

  private async resolveAccounts(
    entries: readonly EntryDraft[],
  ): Promise<Map<string, LedgerAccount>> {
    const codes = [...new Set(entries.map((e) => e.account))];
    const accounts = new Map<string, LedgerAccount>();

    for (const code of codes) {
      const account = await this.store.getAccount(code);
      if (!account) throw new UnknownAccountError(code);
      accounts.set(code, account);
    }

    for (const entry of entries) {
      const account = accounts.get(entry.account)!;
      if (account.currency !== entry.amount.currency) {
        throw new CurrencyMismatchError(entry.account, account.currency, entry.amount.currency);
      }
    }

    return accounts;
  }

  private async assertNoOverdraft(
    entries: readonly PostedEntry[],
    accounts: Map<string, LedgerAccount>,
    store: LedgerStore = this.store,
  ): Promise<void> {
    const touched = [...new Set(entries.map((e) => e.accountCode))];
    const existing = await store.entriesFor(touched);

    for (const code of touched) {
      const account = accounts.get(code)!;

      const current = projectPosted(code, account.type, account.currency, existing);

      let delta = 0n;
      for (const entry of entries) {
        if (entry.accountCode !== code) continue;
        delta += entrySign(account.type, entry.direction) * entry.amount.amount;
      }

      const resulting = current.add(Money.of(delta, account.currency));
      const floor = Money.of(account.overdraftFloor, account.currency);

      if (resulting.lessThan(floor)) {
        throw new InsufficientFundsError(code, resulting, floor);
      }
    }
  }
}

export class InMemoryLedgerStore implements LedgerStore {
  private readonly accounts = new Map<string, LedgerAccount>();
  private readonly journals: PostedJournal[] = [];
  private readonly holds: Hold[] = [];

  async getAccount(code: string): Promise<LedgerAccount | undefined> {
    return this.accounts.get(code);
  }

  async createAccount(account: Omit<LedgerAccount, 'id'>): Promise<LedgerAccount> {
    if (this.accounts.has(account.code)) {
      throw new LedgerError(`ledger account ${account.code} already exists`);
    }
    const created: LedgerAccount = { id: randomUUID(), ...account };
    this.accounts.set(created.code, created);
    return created;
  }

  async entriesFor(accountCodes: readonly string[]): Promise<PostedEntry[]> {
    const wanted = new Set(accountCodes);
    return this.journals.flatMap((j) => j.entries.filter((e) => wanted.has(e.accountCode)));
  }

  async activeHoldsFor(accountCodes: readonly string[]): Promise<Hold[]> {
    const wanted = new Set(accountCodes);
    return this.holds.filter((h) => wanted.has(h.accountCode) && h.status === 'active');
  }

  async append(journal: PostedJournal): Promise<PostedJournal> {
    this.journals.push(journal);
    return journal;
  }

  /** Single-threaded and in-process: nothing can interleave, so no lock is needed. */
  async withAccountLocks<T>(
    _accountCodes: readonly string[],
    fn: (store: LedgerStore) => Promise<T>,
  ): Promise<T> {
    return fn(this);
  }

  allEntries(): PostedEntry[] {
    return this.journals.flatMap((j) => j.entries);
  }

  allJournals(): readonly PostedJournal[] {
    return this.journals;
  }

  addHold(hold: Hold): void {
    this.holds.push(hold);
  }
}
