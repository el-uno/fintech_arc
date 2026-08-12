import { randomUUID } from 'node:crypto';
import type { EventBus, PublishContext } from '@arc/bus';
import type { CurrencyCode } from '@arc/money';
import {
  ProductError,
  railForCurrency,
  type Account,
  type AccountKind,
  type VerificationTier,
} from './accounts.js';
import { issueIdentifier, type Rail } from './identifiers.js';

export interface VirtualAccount {
  readonly id: string;
  readonly accountId: string;
  readonly currency: CurrencyCode;
  readonly rail: Rail;
  readonly identifier: string;
  readonly metadata: Record<string, string>;
  readonly createdAt: Date;
}

export interface OpenAccountInput {
  readonly kind: AccountKind;
  readonly countryCode: string;
  readonly displayName: string;
  readonly tier?: VerificationTier;
  readonly currencies?: readonly CurrencyCode[];
}

export interface AccountStore {
  saveAccount(account: Account): Promise<void>;
  saveVirtualAccount(virtualAccount: VirtualAccount): Promise<void>;
  getAccount(id: string): Promise<Account | undefined>;
  virtualAccountsFor(accountId: string): Promise<VirtualAccount[]>;
  findByIdentifier(identifier: string): Promise<VirtualAccount | undefined>;
}

export class InMemoryAccountStore implements AccountStore {
  private readonly accounts = new Map<string, Account>();
  private readonly virtualAccounts = new Map<string, VirtualAccount>();

  async saveAccount(account: Account): Promise<void> {
    this.accounts.set(account.id, account);
  }

  async saveVirtualAccount(virtualAccount: VirtualAccount): Promise<void> {
    if (await this.findByIdentifier(virtualAccount.identifier)) {
      throw new ProductError(`identifier collision: ${virtualAccount.identifier}`);
    }
    this.virtualAccounts.set(virtualAccount.id, virtualAccount);
  }

  async getAccount(id: string): Promise<Account | undefined> {
    return this.accounts.get(id);
  }

  async virtualAccountsFor(accountId: string): Promise<VirtualAccount[]> {
    return [...this.virtualAccounts.values()].filter((v) => v.accountId === accountId);
  }

  async findByIdentifier(identifier: string): Promise<VirtualAccount | undefined> {
    return [...this.virtualAccounts.values()].find((v) => v.identifier === identifier);
  }
}

export interface OnboardingResult {
  readonly account: Account;
  readonly virtualAccounts: readonly VirtualAccount[];
}

export class OnboardingService {
  constructor(
    private readonly store: AccountStore,
    private readonly bus: EventBus,
  ) {}

  async openAccount(input: OpenAccountInput, context: PublishContext): Promise<OnboardingResult> {
    if (!/^[A-Z]{2}$/.test(input.countryCode)) {
      throw new ProductError(`countryCode must be ISO-3166 alpha-2, got ${input.countryCode}`);
    }

    const account: Account = {
      id: randomUUID(),
      kind: input.kind,
      tier: input.tier ?? 1,
      countryCode: input.countryCode,
      displayName: input.displayName,
      createdAt: new Date(),
    };

    await this.store.saveAccount(account);

    await this.bus.publishOne(
      'account.opened',
      {
        accountId: account.id,
        ownerId: randomUUID(),
        kind: account.kind,
        countryCode: account.countryCode,
        tier: account.tier,
      },
      context,
    );

    const virtualAccounts: VirtualAccount[] = [];
    for (const currency of input.currencies ?? []) {
      virtualAccounts.push(await this.issueVirtualAccount(account.id, currency, context));
    }

    return { account, virtualAccounts };
  }

  async issueVirtualAccount(
    accountId: string,
    currency: CurrencyCode,
    context: PublishContext,
  ): Promise<VirtualAccount> {
    const account = await this.store.getAccount(accountId);
    if (!account) throw new ProductError(`no such account: ${accountId}`);

    const existing = await this.store.virtualAccountsFor(accountId);
    const duplicate = existing.find((v) => v.currency === currency);
    if (duplicate) return duplicate;

    const rail = railForCurrency(currency) as Rail;
    const id = randomUUID();
    const issued = issueIdentifier(rail, `${accountId}:${currency}:${id}`);

    const virtualAccount: VirtualAccount = {
      id,
      accountId,
      currency,
      rail,
      identifier: issued.identifier,
      metadata: issued.metadata,
      createdAt: new Date(),
    };

    await this.store.saveVirtualAccount(virtualAccount);

    await this.bus.publishOne(
      'virtual_account.issued',
      {
        virtualAccountId: virtualAccount.id,
        accountId,
        currency,
        rail,
        identifier: virtualAccount.identifier,
      },
      context,
    );

    return virtualAccount;
  }
}
