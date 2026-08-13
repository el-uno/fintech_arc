import { Money, sum, type CurrencyCode } from '@arc/money';
import { entrySign, type AccountType } from './accounts.js';
import type { PostedEntry } from './balances.js';
import type { PostedJournal } from './posting.js';

export interface AccountLine {
  readonly accountCode: string;
  readonly type: AccountType;
  readonly currency: CurrencyCode;
  readonly balance: Money;
}

function foldByAccount(entries: readonly PostedEntry[]): AccountLine[] {
  const totals = new Map<string, { type: AccountType; currency: CurrencyCode; minor: bigint }>();

  for (const entry of entries) {
    const key = entry.accountCode;
    const existing = totals.get(key) ?? {
      type: entry.accountType,
      currency: entry.amount.currency,
      minor: 0n,
    };
    existing.minor += entrySign(entry.accountType, entry.direction) * entry.amount.amount;
    totals.set(key, existing);
  }

  return [...totals.entries()]
    .map(([accountCode, value]) => ({
      accountCode,
      type: value.type,
      currency: value.currency,
      balance: Money.of(value.minor, value.currency),
    }))
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode));
}

export interface ProfitAndLoss {
  readonly currency: CurrencyCode;
  readonly revenue: Money;
  readonly expenses: Money;
  readonly net: Money;
  readonly byAccount: readonly AccountLine[];
}

/**
 * P&L per currency.
 *
 * Reported per currency and never summed across them: converting at a reporting
 * rate would bake today's FX into a historical figure and make the number move
 * for reasons that have nothing to do with the business.
 */
export function profitAndLoss(entries: readonly PostedEntry[]): Map<CurrencyCode, ProfitAndLoss> {
  const lines = foldByAccount(entries);
  const currencies = new Set(lines.map((l) => l.currency));
  const result = new Map<CurrencyCode, ProfitAndLoss>();

  for (const currency of currencies) {
    const revenueLines = lines.filter((l) => l.currency === currency && l.type === 'revenue');
    const expenseLines = lines.filter((l) => l.currency === currency && l.type === 'expense');

    const revenue = sum(
      revenueLines.map((l) => l.balance),
      currency,
    );
    const expenses = sum(
      expenseLines.map((l) => l.balance),
      currency,
    );

    result.set(currency, {
      currency,
      revenue,
      expenses,
      net: revenue.subtract(expenses),
      byAccount: [...revenueLines, ...expenseLines],
    });
  }

  return result;
}

export interface FloatPosition {
  readonly currency: CurrencyCode;
  /** What Arc holds — bank and chain float. */
  readonly assets: Money;
  /** What Arc owes customers and counterparties. */
  readonly liabilities: Money;
  /** assets − liabilities. Negative means Arc owes more than it holds. */
  readonly surplus: Money;
  readonly covered: boolean;
}

/**
 * The solvency question, per currency: **do we hold what we owe?**
 *
 * The trial balance proves the books balance; it does not prove Arc is covered.
 * A currency can balance perfectly while assets sit short of liabilities,
 * because equity absorbs the difference. This is the report that notices.
 */
export function floatPosition(entries: readonly PostedEntry[]): Map<CurrencyCode, FloatPosition> {
  const lines = foldByAccount(entries);
  const currencies = new Set(lines.map((l) => l.currency));
  const result = new Map<CurrencyCode, FloatPosition>();

  for (const currency of currencies) {
    const assets = sum(
      lines.filter((l) => l.currency === currency && l.type === 'asset').map((l) => l.balance),
      currency,
    );
    const liabilities = sum(
      lines.filter((l) => l.currency === currency && l.type === 'liability').map((l) => l.balance),
      currency,
    );
    const surplus = assets.subtract(liabilities);

    result.set(currency, {
      currency,
      assets,
      liabilities,
      surplus,
      covered: !surplus.isNegative,
    });
  }

  return result;
}

export interface StatementLine {
  readonly journalId: string;
  readonly kind: PostedJournal['kind'];
  readonly postedAt: Date;
  readonly description?: string;
  readonly direction: 'debit' | 'credit';
  readonly amount: Money;
  readonly runningBalance: Money;
}

export interface Statement {
  readonly accountCode: string;
  readonly currency: CurrencyCode;
  readonly opening: Money;
  readonly closing: Money;
  readonly lines: readonly StatementLine[];
}

/**
 * An account statement with a running balance.
 *
 * Ordered by posting time, so a partner or an auditor can follow the arithmetic
 * line by line rather than being handed a total to trust.
 */
export function statement(
  accountCode: string,
  accountType: AccountType,
  currency: CurrencyCode,
  journals: readonly PostedJournal[],
  opening: Money = Money.zero(currency),
): Statement {
  const ordered = [...journals].sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime());
  const lines: StatementLine[] = [];
  let running = opening;

  for (const journal of ordered) {
    for (const entry of journal.entries) {
      if (entry.accountCode !== accountCode) continue;

      running = running.add(
        Money.of(entrySign(accountType, entry.direction) * entry.amount.amount, currency),
      );

      lines.push({
        journalId: journal.id,
        kind: journal.kind,
        postedAt: journal.postedAt,
        ...(journal.description ? { description: journal.description } : {}),
        direction: entry.direction,
        amount: entry.amount,
        runningBalance: running,
      });
    }
  }

  return { accountCode, currency, opening, closing: running, lines };
}

export interface CorridorSummary {
  readonly corridor: string;
  readonly transfers: number;
  readonly volume: Money;
  /** Gross revenue booked against this corridor. */
  readonly revenue: Money;
  /** Direct costs — network fees and the like. */
  readonly expenses: Money;
  /** revenue − expenses. The number the corridor is actually judged on. */
  readonly net: Money;
}

/**
 * Volume and revenue per corridor.
 *
 * Journals carry a `referenceId`, not a corridor, so the caller supplies the
 * mapping. Tagging every journal with a corridor would push a product concept
 * into the ledger, which should record what happened rather than why.
 */
export function corridorSummary(
  journals: readonly PostedJournal[],
  corridorOf: (journal: PostedJournal) => string | undefined,
  currency: CurrencyCode,
): CorridorSummary[] {
  const byCorridor = new Map<
    string,
    { references: Set<string>; volume: Money; revenue: Money; expenses: Money }
  >();

  for (const journal of journals) {
    const corridor = corridorOf(journal);
    if (!corridor) continue;

    const bucket = byCorridor.get(corridor) ?? {
      references: new Set<string>(),
      volume: Money.zero(currency),
      revenue: Money.zero(currency),
      expenses: Money.zero(currency),
    };

    if (journal.kind === 'transfer') {
      bucket.references.add(journal.referenceId);
      for (const entry of journal.entries) {
        if (entry.amount.currency !== currency) continue;
        if (entry.direction === 'debit' && entry.accountType === 'liability') {
          bucket.volume = bucket.volume.add(entry.amount);
        }
      }
    }

    for (const entry of journal.entries) {
      if (entry.amount.currency !== currency) continue;

      if (entry.accountType === 'revenue') {
        bucket.revenue = bucket.revenue.add(
          entry.direction === 'credit' ? entry.amount : entry.amount.negate(),
        );
      }
      if (entry.accountType === 'expense') {
        bucket.expenses = bucket.expenses.add(
          entry.direction === 'debit' ? entry.amount : entry.amount.negate(),
        );
      }
    }

    byCorridor.set(corridor, bucket);
  }

  return [...byCorridor.entries()]
    .map(([corridor, value]) => ({
      corridor,
      transfers: value.references.size,
      volume: value.volume,
      revenue: value.revenue,
      expenses: value.expenses,
      net: value.revenue.subtract(value.expenses),
    }))
    .sort((a, b) => a.corridor.localeCompare(b.corridor));
}
