import { Money, sum, type CurrencyCode } from '@arc/money';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assertBalanced,
  credit,
  debit,
  InMemoryLedgerStore,
  isBalanced,
  PostingEngine,
  projectPosted,
  reverseEntries,
  trialBalance,
  type AccountType,
  type EntryDraft,
  type JournalKind,
} from '../src/index.js';

/**
 * The invariant suite.
 *
 * Phase 1's acceptance criterion is that an unbalanced journal cannot be
 * constructed through any public API, and that the ledger's invariants survive
 * randomised load. These are the tests that assert it.
 */

const CURRENCIES: CurrencyCode[] = ['EUR', 'KES', 'NGN', 'USDC'];
const KINDS: JournalKind[] = ['transfer', 'fee', 'fx', 'reversal', 'rounding', 'settlement'];

/** A pool of accounts per currency, with floors wide enough not to interfere. */
const POOL_SIZE = 6;
const FLOOR = -(10n ** 24n);

function accountCode(currency: CurrencyCode, index: number): string {
  return `test.pool.${currency}.${index}`;
}

const ACCOUNT_TYPES: AccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];

function typeFor(index: number): AccountType {
  return ACCOUNT_TYPES[index % ACCOUNT_TYPES.length]!;
}

async function freshLedger() {
  const store = new InMemoryLedgerStore();
  const engine = new PostingEngine(store);
  for (const currency of CURRENCIES) {
    for (let i = 0; i < POOL_SIZE; i++) {
      await store.createAccount({
        code: accountCode(currency, i),
        name: accountCode(currency, i),
        type: typeFor(i),
        currency,
        overdraftFloor: FLOOR,
      });
    }
  }
  return { store, engine };
}

/**
 * Generate a journal that balances by construction.
 *
 * The total is split across debit accounts and credit accounts using `allocate`,
 * which guarantees the parts sum to exactly the whole — so whatever amounts come
 * out, the two sides are equal.
 */
const balancedEntries = fc
  .record({
    currency: fc.constantFrom(...CURRENCIES),
    total: fc.bigInt({ min: 1n, max: 10n ** 15n }),
    debitWeights: fc.array(fc.bigInt({ min: 1n, max: 1000n }), { minLength: 1, maxLength: 3 }),
    creditWeights: fc.array(fc.bigInt({ min: 1n, max: 1000n }), { minLength: 1, maxLength: 3 }),
    debitOffset: fc.integer({ min: 0, max: POOL_SIZE - 1 }),
    creditOffset: fc.integer({ min: 0, max: POOL_SIZE - 1 }),
  })
  .map(({ currency, total, debitWeights, creditWeights, debitOffset, creditOffset }) => {
    const amount = Money.of(total, currency);

    const debits = amount
      .allocate(debitWeights)
      .map((part, i) => debit(accountCode(currency, (debitOffset + i) % POOL_SIZE), part));

    const credits = amount
      .allocate(creditWeights)
      .map((part, i) => credit(accountCode(currency, (creditOffset + i) % POOL_SIZE), part));

    // `allocate` can hand back a zero part when a weight is small relative to the
    // total; zero entries record nothing and are rejected by design.
    return [...debits, ...credits].filter((e) => !e.amount.isZero);
  })
  .filter((entries) => isBalanced(entries));

const journalDraft = fc
  .tuple(balancedEntries, fc.constantFrom(...KINDS), fc.uuid())
  .map(([entries, kind, referenceId]) => ({ kind, referenceId, entries }));

describe('property: a journal always balances or is rejected', () => {
  it('accepts every journal generated to balance', () => {
    fc.assert(
      fc.property(balancedEntries, (entries) => {
        expect(() => assertBalanced(entries)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  it('rejects any journal perturbed by a single minor unit', () => {
    fc.assert(
      fc.property(balancedEntries, fc.nat(), (entries, index) => {
        const target = index % entries.length;
        const perturbed: EntryDraft[] = entries.map((entry, i) =>
          i === target
            ? { ...entry, amount: Money.of(entry.amount.amount + 1n, entry.amount.currency) }
            : entry,
        );
        // One extra minor unit anywhere is enough to fail the whole journal.
        expect(isBalanced(perturbed)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it('rejects any journal missing one of its entries', () => {
    fc.assert(
      fc.property(balancedEntries, fc.nat(), (entries, index) => {
        fc.pre(entries.length > 2);
        const dropped = entries.filter((_, i) => i !== index % entries.length);
        expect(isBalanced(dropped)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });
});

describe('property: the ledger stays balanced under randomised load', () => {
  it('trial balance is zero in every currency after any sequence of journals', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(journalDraft, { minLength: 1, maxLength: 30 }), async (drafts) => {
        const { store, engine } = await freshLedger();

        for (const draft of drafts) {
          await engine.post(draft);
        }

        for (const [, totals] of trialBalance(store.allEntries())) {
          expect(totals.difference.isZero).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('the sum of every account balance is zero in each currency', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(journalDraft, { minLength: 1, maxLength: 20 }), async (drafts) => {
        const { store, engine } = await freshLedger();
        for (const draft of drafts) await engine.post(draft);

        const entries = store.allEntries();

        for (const currency of CURRENCIES) {
          // Signed by normal balance, assets net against liabilities and equity.
          const balances = Array.from({ length: POOL_SIZE }, (_, i) => {
            const code = accountCode(currency, i);
            const posted = projectPosted(code, typeFor(i), currency, entries);
            // Convert back to a raw debit-positive figure so the sides can be added.
            return typeFor(i) === 'asset' || typeFor(i) === 'expense' ? posted : posted.negate();
          });
          expect(sum(balances, currency).isZero).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('a rejected journal changes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(journalDraft, balancedEntries, fc.nat(), async (good, bad, index) => {
        const { store, engine } = await freshLedger();
        await engine.post(good);

        const before = store.allEntries().length;

        const target = index % bad.length;
        const broken = bad.map((entry, i) =>
          i === target
            ? { ...entry, amount: Money.of(entry.amount.amount + 1n, entry.amount.currency) }
            : entry,
        );

        await expect(
          engine.post({ kind: 'transfer', referenceId: 'bad', entries: broken }),
        ).rejects.toThrow();

        expect(store.allEntries()).toHaveLength(before);
      }),
      { numRuns: 100 },
    );
  });
});

describe('property: reversal restores the prior state exactly', () => {
  it('posting a journal and its reversal returns every balance to where it was', async () => {
    await fc.assert(
      fc.asyncProperty(journalDraft, async (draft) => {
        const { store, engine } = await freshLedger();

        const touched = [...new Set(draft.entries.map((e) => e.account))];
        const currency = draft.entries[0]!.amount.currency;

        const balanceOf = (code: string) => {
          const index = Number(code.split('.').pop());
          return projectPosted(code, typeFor(index), currency, store.allEntries());
        };

        const before = touched.map(balanceOf);

        await engine.post(draft);
        await engine.post({
          kind: 'reversal',
          referenceId: draft.referenceId,
          entries: reverseEntries(draft.entries),
        });

        const after = touched.map(balanceOf);

        for (let i = 0; i < touched.length; i++) {
          expect(after[i]!.equals(before[i]!)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('property: balances are a pure fold over entries', () => {
  it('replaying the entry log reproduces the same balance', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(journalDraft, { minLength: 1, maxLength: 15 }), async (drafts) => {
        const { store, engine } = await freshLedger();
        for (const draft of drafts) await engine.post(draft);

        const entries = store.allEntries();

        for (const currency of CURRENCIES) {
          for (let i = 0; i < POOL_SIZE; i++) {
            const code = accountCode(currency, i);
            const first = projectPosted(code, typeFor(i), currency, entries);
            // Recomputing from the same log must give the same answer, and the
            // order entries are folded in must not matter.
            const shuffled = [...entries].reverse();
            const second = projectPosted(code, typeFor(i), currency, shuffled);
            expect(second.equals(first)).toBe(true);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
