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
  type JournalInput,
  type LedgerPort,
  type PostedJournalRef,
} from '@arc/movement';
import {
  BillingEngine,
  PartnerOnboarding,
  SandboxRegistry,
  UsageMeter,
  KYB_REQUIREMENTS,
} from '@arc/partner';
import {
  AuthService,
  IdempotencyStore,
  RateLimiter,
  Tracer,
  WebhookService,
  type WebhookTransport,
} from '@arc/platform';
import { ArcClient, verifyWebhookSignature, type Transport } from '@arc/sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '../src/router.js';

/**
 * The Phase 7 acceptance test: a partner signs up, integrates against the
 * sandbox using only the SDK, and completes a EUR to KES payout.
 */

const NOW = new Date('2026-06-01T12:00:00Z');
const eur = (v: string) => Money.parse(v, 'EUR');

const ACCOUNTS: AccountRefs = {
  senderCustomer: SYSTEM_ACCOUNTS.customer('va_partner', 'EUR'),
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
    return projectBalance(accountCode, account.type, currency, this.store.allEntries()).available;
  }
}

interface Harness {
  client: ArcClient;
  transport: Transport;
  store: InMemoryLedgerStore;
  onboarding: PartnerOnboarding;
  usage: UsageMeter;
  partnerId: string;
  webhooksSent: Array<{ url: string; body: string; headers: Record<string, string> }>;
  webhooks: WebhookService;
  sandbox: SandboxRegistry;
  assertBalanced(): void;
}

async function setup(options: { funding?: string } = {}): Promise<Harness> {
  const store = new InMemoryLedgerStore();
  const engine = new PostingEngine(store);

  for (const [code, type, currency, floor] of SPECS) {
    await store.createAccount({ code, name: code, type, currency, overdraftFloor: floor });
  }

  const funding = eur(options.funding ?? '50000.00');
  await engine.post({
    kind: 'transfer',
    referenceId: 'seed',
    entries: [
      debit(SYSTEM_ACCOUNTS.bankFloat('EUR'), funding),
      credit(ACCOUNTS.senderCustomer, funding),
    ],
  });

  const onboarding = new PartnerOnboarding({ now: () => NOW, minimumSandboxCalls: 3 });
  const { partner, sandbox: credential } = onboarding.register({
    name: 'Zephyr Exchange',
    countryCode: 'NG',
    tier: 'growth',
  });

  const auth = new AuthService({ now: () => NOW });
  auth.registerClient({
    clientId: credential.clientId,
    tenantId: `sbx_${partner.id}`,
    secret: credential.secret,
    scopes: ['quotes:read', 'transfers:write', 'webhooks:manage'],
  });

  const webhooksSent: Harness['webhooksSent'] = [];
  const transport: WebhookTransport = {
    async send(input) {
      webhooksSent.push(input);
      return { status: 200 };
    },
  };
  const webhooks = new WebhookService(transport, { now: () => NOW });

  const chain = new SimulatedChain('base', {
    seed: 'partner',
    config: { dropChanceBps: 0, revertChanceBps: 0, reorgChanceBps: 0 },
  });

  const usage = new UsageMeter({ now: () => NOW });
  const sandboxRegistry = new SandboxRegistry({ now: () => NOW });

  const api = createApi({
    auth,
    rateLimiter: new RateLimiter({ capacity: 1_000, refillPerSecond: 100 }),
    idempotency: new IdempotencyStore({ now: () => NOW.getTime() }),
    webhooks,
    tracer: new Tracer({ service: 'api' }),
    onboarding,
    sandbox: sandboxRegistry,
    usage,
    quotes: new QuoteEngine(
      new StaticRateProvider({ 'EUR/KES': '139.7994', 'EUR/USDC': '1.0842' }),
      { now: () => NOW },
    ),
    ledger: new LedgerAdapter(engine, store),
    compliance: new AlwaysApprove(),
    chain,
    rail: new SimulatedRail('mpesa', {
      seed: 'partner',
      config: { rejectChanceBps: 0, timeoutChanceBps: 0 },
    }),
    accounts: ACCOUNTS,
    advanceChain: () => chain.advance(chain.config.finalityDepth + 2),
    secretFor: (clientId) => (clientId === credential.clientId ? credential.secret : undefined),
    partnerFor: (clientId) => (clientId === credential.clientId ? partner.id : undefined),
    applyTrigger: (trigger) => {
      switch (trigger) {
        case 'rail_reject':
          return {
            rail: new SimulatedRail('mpesa', {
              seed: 'reject',
              config: { rejectChanceBps: 10_000, timeoutChanceBps: 0 },
            }),
          };
        case 'chain_stuck':
          return { advanceChain: () => chain.advance(1) };
        case 'compliance_reject':
          return {
            compliance: {
              async screenTransfer() {
                return {
                  decision: 'rejected' as const,
                  reasons: ['sanctions_hit'],
                  riskScore: 100,
                };
              },
            },
          };
        default:
          return {};
      }
    },
  });

  const sdkTransport: Transport = { send: (request) => api.handle(request) };

  return {
    transport: sdkTransport,
    client: new ArcClient({
      clientId: credential.clientId,
      clientSecret: credential.secret,
      transport: sdkTransport,
      now: () => NOW.getTime(),
      maxRetries: 0,
    }),
    store,
    onboarding,
    usage,
    partnerId: partner.id,
    webhooksSent,
    webhooks,
    sandbox: sandboxRegistry,
    assertBalanced() {
      for (const [, totals] of trialBalance(store.allEntries())) {
        expect(totals.difference.isZero).toBe(true);
      }
    },
  };
}

describe('a partner integrates using only the SDK', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await setup();
  });

  it('quotes and completes a EUR to KES payout', async () => {
    const quote = await harness.client.quote({
      sendAmount: { amount: '100000', currency: 'EUR' },
      receiveCurrency: 'KES',
      corridor: 'DE-KE',
    });

    expect(quote.id).toBeTruthy();
    expect(quote.receiveAmount.currency).toBe('KES');
    // Amounts are integer strings of minor units, never JSON numbers.
    expect(typeof quote.sendAmount.amount).toBe('string');
    expect(quote.fees.map((f) => f.kind)).toContain('corridor');

    const transfer = await harness.client.createTransfer({
      quoteId: quote.id,
      beneficiary: '+254712345678',
    });

    expect(transfer.status).toBe('completed');
    expect(transfer.steps).toEqual(['compliance', 'reserve', 'swap', 'settle', 'payout']);
    expect(transfer.chainTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(transfer.railReference).toMatch(/^MPESA-/);

    harness.assertBalanced();
  });

  it('reads a transfer back by id', async () => {
    const quote = await harness.client.quote({
      sendAmount: { amount: '50000', currency: 'EUR' },
      receiveCurrency: 'KES',
      corridor: 'DE-KE',
    });
    const created = await harness.client.createTransfer({
      quoteId: quote.id,
      beneficiary: '+254712345678',
    });

    const fetched = await harness.client.getTransfer(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.status).toBe('completed');
  });

  it('rejects an unknown client', async () => {
    const stranger = new ArcClient({
      clientId: 'ak_test_unknown',
      clientSecret: 'sk_test_nope',
      transport: harness.transport,
      now: () => NOW.getTime(),
      maxRetries: 0,
    });

    await expect(
      stranger.quote({
        sendAmount: { amount: '1000', currency: 'EUR' },
        receiveCurrency: 'KES',
        corridor: 'DE-KE',
      }),
    ).rejects.toMatchObject({ status: 401, code: 'unknown_client' });
  });

  it('rejects a request signed with the wrong secret', async () => {
    const clientId = (harness.client as unknown as { clientId: string }).clientId;
    const impostor = new ArcClient({
      clientId,
      clientSecret: 'sk_test_wrong_secret',
      transport: harness.transport,
      now: () => NOW.getTime(),
      maxRetries: 0,
    });

    await expect(
      impostor.quote({
        sendAmount: { amount: '1000', currency: 'EUR' },
        receiveCurrency: 'KES',
        corridor: 'DE-KE',
      }),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_signature' });
  });

  it('rejects a request whose body was altered after signing', async () => {
    const tampering: Transport = {
      async send(request) {
        // A man-in-the-middle rewrites the amount but cannot re-sign it.
        return harness.transport.send({
          ...request,
          body: request.body.replace('"1000"', '"999999"'),
        });
      },
    };

    const victim = new ArcClient({
      clientId: (harness.client as unknown as { clientId: string }).clientId,
      clientSecret: (harness.client as unknown as { clientSecret: string }).clientSecret,
      transport: tampering,
      now: () => NOW.getTime(),
      maxRetries: 0,
    });

    await expect(
      victim.quote({
        sendAmount: { amount: '1000', currency: 'EUR' },
        receiveCurrency: 'KES',
        corridor: 'DE-KE',
      }),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_signature' });
  });

  it('returns the original transfer when a request is retried with the same key', async () => {
    const quote = await harness.client.quote({
      sendAmount: { amount: '25000', currency: 'EUR' },
      receiveCurrency: 'KES',
      corridor: 'DE-KE',
    });

    const first = await harness.client.createTransfer(
      { quoteId: quote.id, beneficiary: '+254712345678' },
      'idem_key_1',
    );
    const second = await harness.client.createTransfer(
      { quoteId: quote.id, beneficiary: '+254712345678' },
      'idem_key_1',
    );

    expect(second.id).toBe(first.id);
    // Only one transfer was actually executed.
    expect(harness.usage.countOf(harness.partnerId, 'transfer_completed')).toBe(1);
    harness.assertBalanced();
  });

  it('delivers a signed webhook the partner can verify with the SDK', async () => {
    const endpoint = await harness.client.registerWebhook('https://partner.example/hooks', [
      'transfer.settled',
    ]);

    const quote = await harness.client.quote({
      sendAmount: { amount: '30000', currency: 'EUR' },
      receiveCurrency: 'KES',
      corridor: 'DE-KE',
    });
    await harness.client.createTransfer({ quoteId: quote.id, beneficiary: '+254712345678' });
    await harness.webhooks.deliverDue();

    expect(harness.webhooksSent).toHaveLength(1);
    const sent = harness.webhooksSent[0]!;

    expect(
      verifyWebhookSignature({
        secret: endpoint.secret,
        header: sent.headers['arc-signature']!,
        body: sent.body,
        now: NOW.getTime(),
      }),
    ).toBe(true);

    // A tampered body fails verification.
    expect(
      verifyWebhookSignature({
        secret: endpoint.secret,
        header: sent.headers['arc-signature']!,
        body: sent.body.replace('completed', 'failed'),
        now: NOW.getTime(),
      }),
    ).toBe(false);
  });
});

describe('sandbox failure triggers', () => {
  it('a magic amount forces a rail rejection, and the ledger still balances', async () => {
    const harness = await setup();

    // …66 in the minor units means "the rail rejects this payout".
    const quote = await harness.client.quote({
      sendAmount: { amount: '100066', currency: 'EUR' },
      receiveCurrency: 'KES',
      corridor: 'DE-KE',
    });
    const transfer = await harness.client.createTransfer({
      quoteId: quote.id,
      beneficiary: '+254712345678',
    });

    expect(transfer.status).toBe('compensated');
    expect(transfer.failedStep).toBe('payout');
    harness.assertBalanced();
  });

  it('a magic amount forces a compliance rejection before money moves', async () => {
    const harness = await setup();
    const quote = await harness.client.quote({
      sendAmount: { amount: '100061', currency: 'EUR' },
      receiveCurrency: 'KES',
      corridor: 'DE-KE',
    });
    const transfer = await harness.client.createTransfer({
      quoteId: quote.id,
      beneficiary: '+254712345678',
    });

    expect(transfer.status).toBe('compensated');
    expect(transfer.failedStep).toBe('compliance');
    expect(transfer.steps).toEqual([]);
    harness.assertBalanced();
  });

  it('a magic amount forces a stuck settlement', async () => {
    const harness = await setup();
    const quote = await harness.client.quote({
      sendAmount: { amount: '100068', currency: 'EUR' },
      receiveCurrency: 'KES',
      corridor: 'DE-KE',
    });
    const transfer = await harness.client.createTransfer({
      quoteId: quote.id,
      beneficiary: '+254712345678',
    });

    expect(transfer.failedStep).toBe('settle');
    harness.assertBalanced();
  });

  it('an ordinary amount is unaffected', async () => {
    const harness = await setup();
    const quote = await harness.client.quote({
      sendAmount: { amount: '100000', currency: 'EUR' },
      receiveCurrency: 'KES',
      corridor: 'DE-KE',
    });
    const transfer = await harness.client.createTransfer({
      quoteId: quote.id,
      beneficiary: '+254712345678',
    });
    expect(transfer.status).toBe('completed');
  });

  it('reset bumps the sandbox generation and clears state', async () => {
    const harness = await setup();
    const before = harness.sandbox.provision(harness.partnerId).generation;

    const result = await harness.client.resetSandbox();
    expect(result.generation).toBe(before + 1);
  });
});

describe('go-live and billing', () => {
  it('refuses live access until the checklist is complete', async () => {
    const harness = await setup();

    expect(() => harness.onboarding.goLive(harness.partnerId)).toThrow(/not ready for live/);

    for (const requirement of KYB_REQUIREMENTS) {
      harness.onboarding.submitDocument(harness.partnerId, requirement);
    }
    await harness.client.registerWebhook('https://partner.example/hooks', ['*']);

    // Still short of the sandbox-traffic requirement until enough calls land.
    const stillShort = harness.onboarding.readiness(harness.partnerId);
    if (!stillShort.ready) expect(stillShort.outstanding).toContain('sandbox_traffic');

    for (let i = 0; i < 5; i++) {
      await harness.client.quote({
        sendAmount: { amount: '1000', currency: 'EUR' },
        receiveCurrency: 'KES',
        corridor: 'DE-KE',
      });
    }

    const readiness = harness.onboarding.readiness(harness.partnerId);
    expect(readiness.ready).toBe(true);

    const { partner, live } = harness.onboarding.goLive(harness.partnerId);
    expect(partner.status).toBe('live');
    expect(live.clientId).toMatch(/^ak_live_/);
    expect(live.secret).toMatch(/^sk_live_/);
  });

  it('meters usage and produces an invoice with rev-share', async () => {
    const harness = await setup();

    for (let i = 0; i < 3; i++) {
      const quote = await harness.client.quote({
        sendAmount: { amount: '100000', currency: 'EUR' },
        receiveCurrency: 'KES',
        corridor: 'DE-KE',
      });
      await harness.client.createTransfer({ quoteId: quote.id, beneficiary: '+254712345678' });
    }

    const billing = new BillingEngine(harness.usage);
    const invoice = billing.invoice({
      partnerId: harness.partnerId,
      tier: 'growth',
      periodStart: new Date(NOW.getTime() - 86_400_000),
      periodEnd: new Date(NOW.getTime() + 86_400_000),
      corridorRevenue: eur('120.00'),
    });

    expect(invoice.transfers).toBe(3);
    expect(invoice.apiCalls).toBeGreaterThan(0);

    // Growth tier: €499 platform fee, 2000 transfers included, 10bp on volume.
    expect(invoice.lines[0]!.amount.toDecimalString()).toBe('499.00');
    const volumeLine = invoice.lines.find((l) => l.description.includes('bp on'));
    expect(volumeLine!.amount.toDecimalString()).toBe('3.00'); // 10bp of 3000.00

    // 1000bp rev-share on 120.00 of corridor revenue.
    expect(invoice.revShareCredit.toDecimalString()).toBe('12.00');
    expect(invoice.total.toDecimalString()).toBe('490.00');
  });
});
