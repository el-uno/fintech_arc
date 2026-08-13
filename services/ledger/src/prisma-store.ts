import { randomUUID } from 'node:crypto';
import { canTransact, type PrismaLike } from '@arc/db';
import { Money, isCurrencyCode, type CurrencyCode } from '@arc/money';
import type { AccountType, Direction } from './accounts.js';
import type { Hold, PostedEntry } from './balances.js';
import { LedgerError } from './journal.js';
import type { LedgerAccount, LedgerStore, PostedJournal } from './posting.js';

/**
 * Postgres BIGINT is a signed 64-bit integer. Every amount and overdraft floor
 * must fit, and the failure is otherwise a cryptic driver error rather than a
 * domain one.
 *
 * The ceiling is 9,223,372,036,854,775,807 minor units. For Arc's assets that is
 * ample — a trillion USDC at 6 decimals, or 9.2 ETH in wei — but an 18-decimal
 * balance above ~9.2 tokens would exceed it. A system holding large 18-decimal
 * positions needs NUMERIC(78,0) columns instead.
 */
export const INT64_MAX = 2n ** 63n - 1n;
export const INT64_MIN = -(2n ** 63n);

function assertFitsInt64(value: bigint, what: string): bigint {
  if (value > INT64_MAX || value < INT64_MIN) {
    throw new LedgerError(
      `${what} (${value}) exceeds the 64-bit range the ledger columns can store; ` +
        `the limit is ${INT64_MAX} minor units`,
    );
  }
  return value;
}

function toCurrency(value: string): CurrencyCode {
  if (!isCurrencyCode(value)) throw new LedgerError(`unknown currency in ledger row: ${value}`);
  return value;
}

export interface PrismaLedgerStoreOptions {
  tenantId?: string;
  /** Milliseconds a posting transaction may hold its locks. */
  transactionTimeoutMs?: number;
}

/**
 * Postgres-backed ledger store.
 *
 * The database enforces the balance and append-only rules independently of this
 * class (see the ledger-invariants migration). What this adds is the piece the
 * triggers cannot express: serialising concurrent posts against the same
 * accounts so the overdraft check cannot be raced.
 */
export class PrismaLedgerStore implements LedgerStore {
  private readonly tenantId: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly db: PrismaLike,
    private readonly options: PrismaLedgerStoreOptions = {},
  ) {
    this.tenantId = options.tenantId ?? 'tenant_demo';
    this.timeoutMs = options.transactionTimeoutMs ?? 15_000;
  }

  async getAccount(code: string): Promise<LedgerAccount | undefined> {
    const row = await this.db.ledgerAccount.findUnique({ where: { code } });
    if (!row) return undefined;
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type as AccountType,
      currency: toCurrency(row.currency),
      overdraftFloor: row.overdraftFloor,
    };
  }

  async createAccount(account: Omit<LedgerAccount, 'id'>): Promise<LedgerAccount> {
    const existing = await this.getAccount(account.code);
    if (existing) throw new LedgerError(`ledger account ${account.code} already exists`);

    const row = await this.db.ledgerAccount.create({
      data: {
        id: randomUUID(),
        tenantId: this.tenantId,
        code: account.code,
        name: account.name,
        type: account.type,
        currency: account.currency,
        overdraftFloor: assertFitsInt64(
          account.overdraftFloor,
          `overdraft floor for ${account.code}`,
        ),
      },
    });

    return { ...account, id: row.id };
  }

  async entriesFor(accountCodes: readonly string[]): Promise<PostedEntry[]> {
    if (accountCodes.length === 0) return [];

    const rows = await this.db.ledgerEntry.findMany({
      where: { account: { code: { in: [...accountCodes] } } },
      include: { account: { select: { code: true, type: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) => ({
      accountCode: row.account.code,
      accountType: row.account.type as AccountType,
      direction: row.direction as Direction,
      amount: Money.of(row.amount, toCurrency(row.currency)),
    }));
  }

  async activeHoldsFor(accountCodes: readonly string[]): Promise<Hold[]> {
    if (accountCodes.length === 0) return [];

    const rows = await this.db.ledgerHold.findMany({
      where: { status: 'active', account: { code: { in: [...accountCodes] } } },
      include: { account: { select: { code: true } } },
    });

    return rows.map((row) => ({
      accountCode: row.account.code,
      amount: Money.of(row.amount, toCurrency(row.currency)),
      status: 'active' as const,
    }));
  }

  async append(journal: PostedJournal): Promise<PostedJournal> {
    const codes = [...new Set(journal.entries.map((e) => e.accountCode))];
    const accounts = await this.db.ledgerAccount.findMany({
      where: { code: { in: codes } },
      select: { id: true, code: true },
    });
    const idByCode = new Map(accounts.map((a) => [a.code, a.id]));

    for (const code of codes) {
      if (!idByCode.has(code)) throw new LedgerError(`no such ledger account: ${code}`);
    }

    // The journal and all of its entries must land together. When called inside
    // withAccountLocks the caller's transaction already provides that; otherwise
    // open one here. The deferred balance trigger fires at COMMIT either way.
    const write = async (db: PrismaLike) => {
      await db.journal.create({
        data: {
          id: journal.id,
          tenantId: this.tenantId,
          kind: journal.kind,
          referenceId: journal.referenceId,
          ...(journal.description ? { description: journal.description } : {}),
          postedAt: journal.postedAt,
        },
      });
      await db.ledgerEntry.createMany({
        data: journal.entries.map((entry) => ({
          id: randomUUID(),
          journalId: journal.id,
          accountId: idByCode.get(entry.accountCode)!,
          direction: entry.direction,
          amount: assertFitsInt64(entry.amount.amount, `entry amount on ${entry.accountCode}`),
          currency: entry.amount.currency,
        })),
      });
    };

    if (canTransact(this.db)) {
      await this.db.$transaction(async (tx) => write(tx as PrismaLike), {
        timeout: this.timeoutMs,
      });
    } else {
      await write(this.db);
    }

    return journal;
  }

  /**
   * Lock the named accounts for the duration of `fn`.
   *
   * `SELECT … FOR UPDATE` blocks any other transaction that tries to lock the
   * same rows, so the read-check-write sequence inside becomes atomic. Codes
   * arrive sorted from the posting engine, so concurrent callers acquire in the
   * same order and cannot deadlock.
   */
  async withAccountLocks<T>(
    accountCodes: readonly string[],
    fn: (store: LedgerStore) => Promise<T>,
  ): Promise<T> {
    if (accountCodes.length === 0) return fn(this);

    // Already inside a transaction: the locks this would take are held already.
    if (!canTransact(this.db)) return fn(this);

    return this.db.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT id FROM ledger_account WHERE code = ANY($1::text[]) ORDER BY code FOR UPDATE`,
          [...accountCodes],
        );
        return fn(new PrismaLedgerStore(tx as PrismaLike, this.options));
      },
      { timeout: this.timeoutMs },
    );
  }

  /** Every entry ever posted. Reporting and reconciliation use only. */
  async allEntries(): Promise<PostedEntry[]> {
    const rows = await this.db.ledgerEntry.findMany({
      include: { account: { select: { code: true, type: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      accountCode: row.account.code,
      accountType: row.account.type as AccountType,
      direction: row.direction as Direction,
      amount: Money.of(row.amount, toCurrency(row.currency)),
    }));
  }

  async journalsFor(referenceId: string): Promise<PostedJournal[]> {
    const rows = await this.db.journal.findMany({
      where: { referenceId },
      include: { entries: { include: { account: { select: { code: true, type: true } } } } },
      orderBy: { postedAt: 'asc' },
    });

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as PostedJournal['kind'],
      referenceId: row.referenceId,
      ...(row.description ? { description: row.description } : {}),
      postedAt: row.postedAt,
      entries: row.entries.map((entry) => ({
        accountCode: entry.account.code,
        accountType: entry.account.type as AccountType,
        direction: entry.direction as Direction,
        amount: Money.of(entry.amount, toCurrency(entry.currency)),
      })),
    }));
  }
}
