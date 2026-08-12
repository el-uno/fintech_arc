import { Money } from '@arc/money';
import { describe, expect, it } from 'vitest';
import {
  assertBalanced,
  balanceByCurrency,
  credit,
  debit,
  isBalanced,
  LedgerError,
  reverseEntries,
  SYSTEM_ACCOUNTS,
  UnbalancedJournalError,
} from '../src/index.js';

const eur = (v: string) => Money.parse(v, 'EUR');
const kes = (v: string) => Money.parse(v, 'KES');
const usdc = (v: string) => Money.parse(v, 'USDC');

describe('balance validation', () => {
  it('accepts a simple two-legged journal', () => {
    // A customer funds their EUR virtual account: Arc gains float, and owes them.
    const entries = [
      debit(SYSTEM_ACCOUNTS.bankFloat('EUR'), eur('1000.00')),
      credit(SYSTEM_ACCOUNTS.customer('va_1', 'EUR'), eur('1000.00')),
    ];
    expect(() => assertBalanced(entries)).not.toThrow();
    expect(isBalanced(entries)).toBe(true);
  });

  it('rejects a journal that is off by a single minor unit', () => {
    const entries = [
      debit(SYSTEM_ACCOUNTS.bankFloat('EUR'), eur('1000.00')),
      credit(SYSTEM_ACCOUNTS.customer('va_1', 'EUR'), eur('999.99')),
    ];
    expect(() => assertBalanced(entries)).toThrow(UnbalancedJournalError);
    // One cent is a rejection. There is no tolerance.
    expect(() => assertBalanced(entries)).toThrow(/difference 0.01/);
  });

  it('rejects a single-entry journal', () => {
    expect(() => assertBalanced([debit('asset.float.bank.EUR', eur('10.00'))])).toThrow(
      LedgerError,
    );
  });

  it('rejects negative and zero amounts', () => {
    expect(() =>
      assertBalanced([
        debit('asset.float.bank.EUR', Money.of(-1000n, 'EUR')),
        credit('liability.customer.va_1.EUR', Money.of(-1000n, 'EUR')),
      ]),
    ).toThrow(/must be positive/);

    expect(() =>
      assertBalanced([
        debit('asset.float.bank.EUR', eur('0.00')),
        credit('liability.customer.va_1.EUR', eur('0.00')),
      ]),
    ).toThrow(/records nothing/);
  });

  it('balances a many-legged fee split', () => {
    const entries = [
      debit(SYSTEM_ACCOUNTS.customer('va_1', 'EUR'), eur('100.00')),
      credit(SYSTEM_ACCOUNTS.inTransit('EUR'), eur('97.50')),
      credit(SYSTEM_ACCOUNTS.corridorFee('EUR'), eur('2.00')),
      credit(SYSTEM_ACCOUNTS.fxSpread('EUR'), eur('0.50')),
    ];
    expect(() => assertBalanced(entries)).not.toThrow();
  });
});

describe('multi-currency journals balance per currency', () => {
  it('rejects offsetting one currency against another', () => {
    // 100 EUR debited, 100 KES credited. Numerically equal, economically nonsense.
    const entries = [
      debit(SYSTEM_ACCOUNTS.bankFloat('EUR'), eur('100.00')),
      credit(SYSTEM_ACCOUNTS.bankFloat('KES'), kes('100.00')),
    ];
    expect(() => assertBalanced(entries)).toThrow(UnbalancedJournalError);
  });

  it('accepts an FX journal where each half closes against FX position', () => {
    // €1,000.00 → 1,080.000000 USDC. Each currency balances independently.
    const entries = [
      debit(SYSTEM_ACCOUNTS.fxPosition('EUR'), eur('1000.00')),
      credit(SYSTEM_ACCOUNTS.bankFloat('EUR'), eur('1000.00')),
      debit(SYSTEM_ACCOUNTS.chainFloat('USDC'), usdc('1080.000000')),
      credit(SYSTEM_ACCOUNTS.fxPosition('USDC'), usdc('1080.000000')),
    ];
    expect(() => assertBalanced(entries)).not.toThrow();

    const balances = balanceByCurrency(entries);
    expect(balances.map((b) => b.currency)).toEqual(['EUR', 'USDC']);
    expect(balances.every((b) => b.difference.isZero)).toBe(true);
  });

  it('reports the currency that failed to balance', () => {
    const entries = [
      debit(SYSTEM_ACCOUNTS.fxPosition('EUR'), eur('1000.00')),
      credit(SYSTEM_ACCOUNTS.bankFloat('EUR'), eur('1000.00')),
      debit(SYSTEM_ACCOUNTS.chainFloat('USDC'), usdc('1080.000000')),
      credit(SYSTEM_ACCOUNTS.fxPosition('USDC'), usdc('1079.000000')),
    ];
    expect(() => assertBalanced(entries)).toThrow(/USDC/);
  });
});

describe('rounding residuals keep a journal balanced', () => {
  it('posts the un-representable fraction to a rounding account', () => {
    // A fee of 1.5% on €33.33 is €0.49995 — not representable in cents.
    // Rounding down gives €0.49, and the €0.00995 difference would simply vanish
    // if it were not posted somewhere. Here the residual cent is explicit.
    const gross = eur('33.33');
    const feeRounded = eur('0.49');
    const residual = eur('0.01');
    const net = gross.subtract(feeRounded).subtract(residual);

    const entries = [
      debit(SYSTEM_ACCOUNTS.customer('va_1', 'EUR'), gross),
      credit(SYSTEM_ACCOUNTS.inTransit('EUR'), net),
      credit(SYSTEM_ACCOUNTS.corridorFee('EUR'), feeRounded),
      credit(SYSTEM_ACCOUNTS.rounding('EUR'), residual),
    ];

    expect(() => assertBalanced(entries)).not.toThrow();
    expect(net.toDecimalString()).toBe('32.83');
  });
});

describe('reversal', () => {
  it('flips every direction and stays balanced', () => {
    const original = [
      debit(SYSTEM_ACCOUNTS.bankFloat('EUR'), eur('1000.00')),
      credit(SYSTEM_ACCOUNTS.customer('va_1', 'EUR'), eur('1000.00')),
    ];
    const reversed = reverseEntries(original);

    expect(reversed[0]!.direction).toBe('credit');
    expect(reversed[1]!.direction).toBe('debit');
    expect(isBalanced(reversed)).toBe(true);
  });

  it('nets to zero when applied on top of the original', () => {
    const original = [
      debit(SYSTEM_ACCOUNTS.customer('va_1', 'EUR'), eur('100.00')),
      credit(SYSTEM_ACCOUNTS.corridorFee('EUR'), eur('2.00')),
      credit(SYSTEM_ACCOUNTS.inTransit('EUR'), eur('98.00')),
    ];
    const both = [...original, ...reverseEntries(original)];

    for (const balance of balanceByCurrency(both)) {
      expect(balance.difference.isZero).toBe(true);
      // Every account is debited and credited the same amount overall.
      expect(balance.debits.equals(balance.credits)).toBe(true);
    }
  });

  it('is an inverse: reversing twice returns the original directions', () => {
    const original = [
      debit(SYSTEM_ACCOUNTS.bankFloat('EUR'), eur('10.00')),
      credit(SYSTEM_ACCOUNTS.customer('va_1', 'EUR'), eur('10.00')),
    ];
    expect(reverseEntries(reverseEntries(original))).toEqual(original);
  });
});
