import type { EventBus } from '@arc/bus';
import { isCurrencyCode, type CurrencyCode } from '@arc/money';
import { SYSTEM_ACCOUNTS, type AccountType } from './accounts.js';
import { LedgerError } from './journal.js';
import type { LedgerStore } from './posting.js';

export interface ProvisionOptions {
  handlerName?: string;
}

const PLATFORM_ACCOUNTS: ReadonlyArray<{
  code: (currency: CurrencyCode) => string;
  type: AccountType;
  overdraftFloor: bigint;
}> = [
  { code: SYSTEM_ACCOUNTS.bankFloat, type: 'asset', overdraftFloor: -(10n ** 12n) },
  { code: SYSTEM_ACCOUNTS.chainFloat, type: 'asset', overdraftFloor: -(10n ** 12n) },
  { code: SYSTEM_ACCOUNTS.inTransit, type: 'liability', overdraftFloor: 0n },
  { code: SYSTEM_ACCOUNTS.corridorFee, type: 'revenue', overdraftFloor: -(10n ** 18n) },
  { code: SYSTEM_ACCOUNTS.fxSpread, type: 'revenue', overdraftFloor: -(10n ** 18n) },
  { code: SYSTEM_ACCOUNTS.rounding, type: 'revenue', overdraftFloor: -(10n ** 18n) },
  { code: SYSTEM_ACCOUNTS.networkFee, type: 'expense', overdraftFloor: -(10n ** 18n) },
  { code: SYSTEM_ACCOUNTS.fxPosition, type: 'equity', overdraftFloor: -(10n ** 18n) },
];

export async function ensureAccount(
  store: LedgerStore,
  code: string,
  type: AccountType,
  currency: CurrencyCode,
  overdraftFloor: bigint,
): Promise<void> {
  const existing = await store.getAccount(code);
  if (existing) {
    if (existing.type !== type || existing.currency !== currency) {
      throw new LedgerError(
        `account ${code} already exists as ${existing.type}/${existing.currency}, ` +
          `cannot redefine as ${type}/${currency}`,
      );
    }
    return;
  }
  await store.createAccount({ code, name: code, type, currency, overdraftFloor });
}

export async function provisionPlatformAccounts(
  store: LedgerStore,
  currencies: readonly CurrencyCode[],
): Promise<void> {
  for (const currency of currencies) {
    for (const spec of PLATFORM_ACCOUNTS) {
      await ensureAccount(store, spec.code(currency), spec.type, currency, spec.overdraftFloor);
    }
  }
}

/**
 * Subscribes the ledger to the product context. No import crosses between them —
 * the event catalogue is the only shared surface.
 */
export function registerLedgerProvisioning(
  bus: EventBus,
  store: LedgerStore,
  options: ProvisionOptions = {},
): void {
  const handlerName = options.handlerName ?? 'ledger.provisioning';

  bus.subscribe(handlerName, 'virtual_account.issued', async (event) => {
    const { virtualAccountId, currency } = event.payload;
    if (!isCurrencyCode(currency)) {
      throw new LedgerError(`unknown currency on virtual_account.issued: ${currency}`);
    }

    await ensureAccount(
      store,
      SYSTEM_ACCOUNTS.customer(virtualAccountId, currency),
      'liability',
      currency,
      0n,
    );

    for (const spec of PLATFORM_ACCOUNTS) {
      await ensureAccount(store, spec.code(currency), spec.type, currency, spec.overdraftFloor);
    }
  });
}
