import { randomUUID } from 'node:crypto';
import type { ChainDriver } from '@arc/chain';
import { Money, isCurrencyCode, type CurrencyCode } from '@arc/money';
import {
  QuoteError,
  RailError,
  SettlementSaga,
  type AccountRefs,
  type BankRail,
  type CompliancePort,
  type LedgerPort,
  type Quote,
  type QuoteEngine,
  type SagaResult,
} from '@arc/movement';
import type { PartnerOnboarding, SandboxRegistry, UsageMeter } from '@arc/partner';
import { triggerFor, type SandboxTrigger } from '@arc/partner';
import type {
  AuthService,
  IdempotencyStore,
  RateLimiter,
  Tracer,
  WebhookService,
} from '@arc/platform';
import { AuthError, GatewayError } from '@arc/platform';

export interface HttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface ApiDependencies {
  auth: AuthService;
  rateLimiter: RateLimiter;
  idempotency: IdempotencyStore;
  webhooks: WebhookService;
  tracer: Tracer;
  onboarding: PartnerOnboarding;
  sandbox: SandboxRegistry;
  usage: UsageMeter;
  quotes: QuoteEngine;
  ledger: LedgerPort;
  compliance: CompliancePort;
  chain: ChainDriver;
  rail: BankRail;
  accounts: AccountRefs;
  advanceChain: (hash: string) => void;
  /** Resolves a client id to the secret it signs with. */
  secretFor(clientId: string): string | undefined;
  /** Resolves a client id to the partner that owns it. */
  partnerFor(clientId: string): string | undefined;
  /** Sandbox failure injection, keyed by the magic-amount trigger. */
  applyTrigger?(trigger: SandboxTrigger): Partial<ApiDependencies>;
}

interface Session {
  readonly clientId: string;
  readonly partnerId: string;
  readonly tenantId: string;
}

function ok(body: unknown, status = 200): HttpResponse {
  return { status, body };
}

function fail(status: number, code: string, message: string, requestId: string): HttpResponse {
  return { status, body: { code, message, requestId } };
}

function money(value: Money): { amount: string; currency: string } {
  return { amount: value.amount.toString(), currency: value.currency };
}

function parseMoney(raw: unknown): Money {
  const value = raw as { amount?: unknown; currency?: unknown } | null;
  if (!value || typeof value.amount !== 'string' || typeof value.currency !== 'string') {
    throw new QuoteError('amount must be { amount: string, currency: string }');
  }
  if (!/^-?\d+$/.test(value.amount)) {
    throw new QuoteError('amount must be an integer string of minor units');
  }
  if (!isCurrencyCode(value.currency)) {
    throw new QuoteError(`unsupported currency: ${value.currency}`);
  }
  return Money.of(BigInt(value.amount), value.currency);
}

function serialiseQuote(quote: Quote) {
  return {
    id: quote.id,
    sendAmount: money(quote.sendAmount),
    receiveAmount: money(quote.receiveAmount),
    fees: quote.fees.map((f) => ({
      kind: f.kind,
      amount: money(f.amount),
      description: f.description,
    })),
    expiresAt: quote.expiresAt.toISOString(),
  };
}

function serialiseTransfer(result: SagaResult) {
  return {
    id: result.transferId,
    status: result.status,
    steps: result.completedSteps,
    ...(result.failedStep ? { failedStep: result.failedStep } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.chainTxHash ? { chainTxHash: result.chainTxHash } : {}),
    ...(result.railReference ? { railReference: result.railReference } : {}),
  };
}

/**
 * The Last Mile API.
 *
 * This is the composition root: the one place the six contexts are wired
 * together. Every cross-context dependency is satisfied here by passing an
 * implementation to a port, which is why no service imports another.
 */
export function createApi(deps: ApiDependencies) {
  const quotesById = new Map<string, Quote>();
  const transfers = new Map<string, SagaResult>();

  async function authenticate(request: HttpRequest): Promise<Session> {
    const clientId = request.headers['arc-client-id'];
    const signature = request.headers['arc-signature'];
    const timestamp = Number(request.headers['arc-timestamp']);

    if (!clientId || !signature || !Number.isFinite(timestamp)) {
      throw new AuthError('invalid_signature', 'missing signing headers');
    }

    const secret = deps.secretFor(clientId);
    if (!secret) throw new AuthError('unknown_client', `no such client: ${clientId}`);

    deps.auth.verifySignature(
      {
        method: request.method,
        path: request.path,
        body: request.body,
        timestamp,
        signature,
        clientId,
        ...(request.headers['arc-nonce'] ? { nonce: request.headers['arc-nonce'] } : {}),
      },
      secret,
    );

    const partnerId = deps.partnerFor(clientId);
    if (!partnerId) throw new AuthError('unknown_client', 'client is not bound to a partner');

    return { clientId, partnerId, tenantId: deps.sandbox.provision(partnerId).tenantId };
  }

  async function route(
    request: HttpRequest,
    session: Session,
    requestId: string,
  ): Promise<HttpResponse> {
    const payload = request.body ? (JSON.parse(request.body) as Record<string, unknown>) : {};

    if (request.method === 'POST' && request.path === '/v1/quotes') {
      const sendAmount = parseMoney(payload.sendAmount);
      const receiveCurrency = payload.receiveCurrency as CurrencyCode;
      if (!isCurrencyCode(receiveCurrency)) {
        return fail(400, 'invalid_request', `unsupported currency: ${receiveCurrency}`, requestId);
      }

      const quote = await deps.quotes.quote({
        sendAmount,
        receiveCurrency,
        settlementAsset: 'USDC',
        corridor: String(payload.corridor ?? 'DE-KE'),
      });
      quotesById.set(quote.id, quote);
      deps.usage.record(session.partnerId, 'quote_created');

      return ok(serialiseQuote(quote), 201);
    }

    if (request.method === 'POST' && request.path === '/v1/transfers') {
      const quote = quotesById.get(String(payload.quoteId));
      if (!quote) return fail(404, 'quote_not_found', 'no such quote', requestId);

      deps.quotes.assertUsable(quote);

      // Sandbox failure injection: the magic amount decides what goes wrong.
      const trigger = deps.sandbox.isSandboxTenant(session.tenantId)
        ? triggerFor(quote.sendAmount)
        : 'success';
      const overrides = deps.applyTrigger?.(trigger) ?? {};

      const saga = new SettlementSaga({
        ledger: overrides.ledger ?? deps.ledger,
        compliance: overrides.compliance ?? deps.compliance,
        chain: overrides.chain ?? deps.chain,
        rail: overrides.rail ?? deps.rail,
        advanceChain: overrides.advanceChain ?? deps.advanceChain,
      });

      const result = await saga.execute({
        transferId: randomUUID(),
        quote,
        accounts: {
          ...deps.accounts,
          beneficiaryIdentifier: String(payload.beneficiary ?? deps.accounts.beneficiaryIdentifier),
        },
        chain: 'base',
        settlementFrom: '0xarc',
        settlementTo: '0xpartner',
      });

      transfers.set(result.transferId, result);

      if (result.status === 'completed') {
        deps.usage.record(session.partnerId, 'transfer_completed', quote.sendAmount);
        deps.webhooks.enqueue({
          tenantId: session.tenantId,
          eventId: randomUUID(),
          eventType: 'transfer.settled',
          payload: serialiseTransfer(result),
        });
      }

      return ok(serialiseTransfer(result), result.status === 'completed' ? 201 : 200);
    }

    if (request.method === 'GET' && request.path.startsWith('/v1/transfers/')) {
      const id = request.path.slice('/v1/transfers/'.length);
      const result = transfers.get(id);
      if (!result) return fail(404, 'transfer_not_found', 'no such transfer', requestId);
      return ok(serialiseTransfer(result));
    }

    if (request.method === 'POST' && request.path === '/v1/webhook_endpoints') {
      const endpoint = deps.webhooks.register({
        tenantId: session.tenantId,
        url: String(payload.url),
        events: (payload.events as string[]) ?? ['*'],
      });
      deps.onboarding.registerWebhookEndpoint(session.partnerId);
      return ok({ id: endpoint.id, secret: endpoint.secret }, 201);
    }

    if (request.method === 'POST' && request.path === '/v1/sandbox/reset') {
      if (!deps.sandbox.isSandboxTenant(session.tenantId)) {
        return fail(403, 'not_sandbox', 'reset is only available in the sandbox', requestId);
      }
      const tenant = deps.sandbox.reset(session.partnerId);
      quotesById.clear();
      transfers.clear();
      return ok({ generation: tenant.generation });
    }

    return fail(404, 'not_found', `no route for ${request.method} ${request.path}`, requestId);
  }

  return {
    async handle(request: HttpRequest): Promise<HttpResponse> {
      const requestId = randomUUID();
      const span = deps.tracer.startSpan(`${request.method} ${request.path}`, undefined, {
        requestId,
      });

      try {
        const session = await authenticate(request);

        deps.rateLimiter.consume(session.tenantId);
        deps.usage.record(session.partnerId, 'api_call');
        if (deps.sandbox.isSandboxTenant(session.tenantId)) {
          deps.onboarding.recordSandboxCall(session.partnerId);
        }

        const idempotencyKey = request.headers['idempotency-key'];
        if (!idempotencyKey || request.method === 'GET') {
          const response = await route(request, session, requestId);
          deps.tracer.endSpan(span, response.status >= 400 ? 'error' : 'ok');
          return response;
        }

        const response = await deps.idempotency.run(
          {
            key: idempotencyKey,
            tenantId: session.tenantId,
            method: request.method,
            path: request.path,
            body: request.body ? JSON.parse(request.body) : null,
          },
          async () => route(request, session, requestId),
        );

        deps.tracer.endSpan(span, 'ok');
        return response;
      } catch (error) {
        deps.tracer.addEvent(span, 'exception', {
          message: error instanceof Error ? error.message : String(error),
        });
        deps.tracer.endSpan(span, 'error');

        if (error instanceof AuthError) {
          const status = error.code === 'insufficient_scope' ? 403 : 401;
          return fail(status, error.code, error.message, requestId);
        }
        if (error instanceof GatewayError) {
          return fail(error.status, error.code, error.message, requestId);
        }
        if (error instanceof QuoteError) {
          return fail(400, 'invalid_request', error.message, requestId);
        }
        if (error instanceof RailError) {
          return fail(502, error.code, error.message, requestId);
        }
        return fail(500, 'internal_error', 'unexpected failure', requestId);
      }
    },
  };
}
