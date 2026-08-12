import { randomUUID } from 'node:crypto';
import { Dispatcher, EventBus, InMemoryOutbox, InMemoryProcessedLog } from '@arc/bus';
import { Money } from '@arc/money';
import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertWithinTierLimit,
  generateIban,
  generateMobileMoneyMsisdn,
  generateNuban,
  IdentifierError,
  InMemoryAccountStore,
  isValidIban,
  isValidNuban,
  nubanCheckDigit,
  OnboardingService,
  ProductError,
  railAllowedForTier,
  railForCurrency,
  requiresSecondApproval,
  TierLimitError,
} from '../src/index.js';

const context = () => ({
  tenantId: 'tenant_demo',
  correlationId: randomUUID(),
  source: 'product',
});

let store: InMemoryAccountStore;
let bus: EventBus;
let outbox: InMemoryOutbox;
let dispatcher: Dispatcher;
let onboarding: OnboardingService;

beforeEach(() => {
  store = new InMemoryAccountStore();
  outbox = new InMemoryOutbox();
  bus = new EventBus(outbox);
  dispatcher = new Dispatcher(bus, outbox, new InMemoryProcessedLog(), { baseRetryDelayMs: 0 });
  onboarding = new OnboardingService(store, bus);
});

describe('IBAN generation', () => {
  it('produces IBANs that pass the mod-97 check', () => {
    for (let i = 0; i < 50; i++) {
      expect(isValidIban(generateIban(`seed_${i}`))).toBe(true);
    }
  });

  it('produces the right length per country', () => {
    expect(generateIban('x', 'DE')).toHaveLength(22);
    expect(generateIban('x', 'FR')).toHaveLength(27);
    expect(generateIban('x', 'NL')).toHaveLength(18);
  });

  it('rejects a tampered IBAN', () => {
    const iban = generateIban('tamper');
    const digit = iban[10] === '9' ? '8' : '9';
    const tampered = `${iban.slice(0, 10)}${digit}${iban.slice(11)}`;
    expect(isValidIban(tampered)).toBe(false);
  });

  it('validates a known-good real-format IBAN', () => {
    expect(isValidIban('DE89370400440532013000')).toBe(true);
    expect(isValidIban('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(isValidIban('DE89370400440532013001')).toBe(false);
  });

  it('is deterministic for a given seed', () => {
    expect(generateIban('stable')).toBe(generateIban('stable'));
    expect(generateIban('stable')).not.toBe(generateIban('other'));
  });
});

describe('NUBAN generation', () => {
  it('produces account numbers with a valid check digit', () => {
    for (let i = 0; i < 50; i++) {
      const nuban = generateNuban(`seed_${i}`);
      expect(nuban).toHaveLength(10);
      expect(isValidNuban('058', nuban)).toBe(true);
    }
  });

  it('rejects a tampered account number', () => {
    const nuban = generateNuban('tamper');
    const digit = nuban[0] === '9' ? '8' : '9';
    expect(isValidNuban('058', `${digit}${nuban.slice(1)}`)).toBe(false);
  });

  it('requires a 12-digit body', () => {
    expect(() => nubanCheckDigit('58', '123456789')).toThrow(IdentifierError);
  });
});

describe('mobile money', () => {
  it('issues a Safaricom-shaped MSISDN', () => {
    expect(generateMobileMoneyMsisdn('seed')).toMatch(/^\+2547\d{8}$/);
  });
});

describe('tier policy', () => {
  it('blocks transfers above the tier ceiling', () => {
    expect(() => assertWithinTierLimit(1, Money.parse('1000.00', 'EUR'))).not.toThrow();
    expect(() => assertWithinTierLimit(1, Money.parse('1000.01', 'EUR'))).toThrow(TierLimitError);
  });

  it('lets tier 3 through unlimited', () => {
    expect(() => assertWithinTierLimit(3, Money.parse('9999999.00', 'EUR'))).not.toThrow();
  });

  it('blocks everything at tier 0', () => {
    expect(() => assertWithinTierLimit(0, Money.parse('0.01', 'EUR'))).toThrow(TierLimitError);
    expect(railAllowedForTier(0, 'sepa')).toBe(false);
  });

  it('restricts rails by tier', () => {
    expect(railAllowedForTier(1, 'sepa')).toBe(true);
    expect(railAllowedForTier(1, 'onchain')).toBe(false);
    expect(railAllowedForTier(2, 'onchain')).toBe(true);
  });

  it('requires a second approver only for large enterprise payouts', () => {
    const big = Money.parse('150000.00', 'EUR');
    const small = Money.parse('500.00', 'EUR');
    expect(requiresSecondApproval('enterprise', 3, big)).toBe(true);
    expect(requiresSecondApproval('enterprise', 3, small)).toBe(false);
    expect(requiresSecondApproval('personal', 3, big)).toBe(false);
  });
});

describe('rail routing', () => {
  it('maps each corridor currency to its rail', () => {
    expect(railForCurrency('EUR')).toBe('sepa');
    expect(railForCurrency('NGN')).toBe('nip');
    expect(railForCurrency('KES')).toBe('mobile_money');
    expect(railForCurrency('ZAR')).toBe('eft');
    expect(railForCurrency('USDC')).toBe('onchain');
  });

  it('refuses a currency with no rail', () => {
    expect(() => railForCurrency('ETH')).toThrow(ProductError);
  });
});

describe('onboarding', () => {
  it('opens an account with virtual accounts across four currencies', async () => {
    const result = await onboarding.openAccount(
      {
        kind: 'personal',
        countryCode: 'DE',
        displayName: 'Amina',
        tier: 2,
        currencies: ['EUR', 'NGN', 'KES', 'USDC'],
      },
      context(),
    );

    expect(result.virtualAccounts).toHaveLength(4);

    const byCurrency = Object.fromEntries(result.virtualAccounts.map((v) => [v.currency, v]));
    expect(isValidIban(byCurrency.EUR!.identifier)).toBe(true);
    expect(isValidNuban('058', byCurrency.NGN!.identifier)).toBe(true);
    expect(byCurrency.KES!.identifier).toMatch(/^\+2547\d{8}$/);
    expect(byCurrency.USDC!.identifier).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('publishes account.opened and one virtual_account.issued per currency', async () => {
    const seen: string[] = [];
    bus.subscribe('recorder-opened', 'account.opened', async () => void seen.push('opened'));
    bus.subscribe(
      'recorder-issued',
      'virtual_account.issued',
      async () => void seen.push('issued'),
    );

    await onboarding.openAccount(
      {
        kind: 'enterprise',
        countryCode: 'NG',
        displayName: 'Kola Imports',
        currencies: ['EUR', 'NGN'],
      },
      context(),
    );
    await dispatcher.drainUntilEmpty();

    expect(seen.filter((s) => s === 'opened')).toHaveLength(1);
    expect(seen.filter((s) => s === 'issued')).toHaveLength(2);
  });

  it('is idempotent per currency', async () => {
    const { account } = await onboarding.openAccount(
      { kind: 'personal', countryCode: 'DE', displayName: 'Amina', currencies: ['EUR'] },
      context(),
    );
    const first = (await store.virtualAccountsFor(account.id))[0]!;
    const again = await onboarding.issueVirtualAccount(account.id, 'EUR', context());

    expect(again.id).toBe(first.id);
    expect(await store.virtualAccountsFor(account.id)).toHaveLength(1);
  });

  it('rejects a malformed country code', async () => {
    await expect(
      onboarding.openAccount(
        { kind: 'personal', countryCode: 'Germany', displayName: 'x' },
        context(),
      ),
    ).rejects.toThrow(ProductError);
  });

  it('defaults to tier 1', async () => {
    const { account } = await onboarding.openAccount(
      { kind: 'personal', countryCode: 'DE', displayName: 'Amina' },
      context(),
    );
    expect(account.tier).toBe(1);
  });
});

describe('property: issued identifiers are always well-formed and unique', () => {
  it('every generated IBAN validates', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), (seed) => {
        expect(isValidIban(generateIban(seed))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('every generated NUBAN validates', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), (seed) => {
        expect(isValidNuban('058', generateNuban(seed))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('distinct seeds do not collide', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(generateIban(`collide_${i}`));
    expect(seen.size).toBe(2000);
  });
});
