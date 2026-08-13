import { createHmac, randomBytes } from 'node:crypto';

/**
 * The Arc Last Mile SDK.
 *
 * Amounts cross the wire as integer strings of minor units, never JSON numbers —
 * a JSON number is parsed as a float by most clients, which would reintroduce
 * exactly the error the ledger is built to avoid.
 */

export interface MoneyPayload {
  readonly amount: string;
  readonly currency: string;
}

export class ArcApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ArcApiError';
  }

  /** Retrying a 409 or a 4xx will fail the same way; a 429 or 5xx may not. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500 || this.code === 'rail_timeout';
  }
}

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

/** The transport seam. A real deployment supplies fetch; tests supply the router. */
export interface Transport {
  send(request: HttpRequest): Promise<HttpResponse>;
}

export function fetchTransport(baseUrl: string): Transport {
  return {
    async send(request) {
      const response = await fetch(`${baseUrl}${request.path}`, {
        method: request.method,
        headers: request.headers,
        ...(request.method === 'GET' ? {} : { body: request.body }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
  };
}

export interface QuoteRequest {
  readonly sendAmount: MoneyPayload;
  readonly receiveCurrency: string;
  readonly corridor: string;
}

export interface QuoteResponse {
  readonly id: string;
  readonly sendAmount: MoneyPayload;
  readonly receiveAmount: MoneyPayload;
  readonly fees: ReadonlyArray<{ kind: string; amount: MoneyPayload; description: string }>;
  readonly expiresAt: string;
}

export interface TransferRequest {
  readonly quoteId: string;
  readonly beneficiary: string;
  readonly reference?: string;
}

export interface TransferResponse {
  readonly id: string;
  readonly status: 'completed' | 'compensated' | 'compensation_failed';
  readonly steps: readonly string[];
  readonly failedStep?: string;
  readonly reason?: string;
  readonly chainTxHash?: string;
  readonly railReference?: string;
}

export interface ArcClientOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly transport: Transport;
  readonly now?: () => number;
  /** Automatic retries for retryable failures. */
  readonly maxRetries?: number;
}

export class ArcClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly maxRetries: number;

  constructor(options: ArcClientOptions) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.transport = options.transport;
    this.now = options.now ?? (() => Date.now());
    this.maxRetries = options.maxRetries ?? 2;
  }

  async quote(request: QuoteRequest): Promise<QuoteResponse> {
    return this.call<QuoteResponse>('POST', '/v1/quotes', request);
  }

  /**
   * Create a transfer.
   *
   * `idempotencyKey` is strongly recommended: with one, a retry after a network
   * failure returns the original transfer instead of creating a second.
   */
  async createTransfer(
    request: TransferRequest,
    idempotencyKey?: string,
  ): Promise<TransferResponse> {
    return this.call<TransferResponse>('POST', '/v1/transfers', request, idempotencyKey);
  }

  async getTransfer(id: string): Promise<TransferResponse> {
    return this.call<TransferResponse>('GET', `/v1/transfers/${id}`, null);
  }

  async registerWebhook(
    url: string,
    events: readonly string[],
  ): Promise<{ id: string; secret: string }> {
    return this.call<{ id: string; secret: string }>('POST', '/v1/webhook_endpoints', {
      url,
      events,
    });
  }

  async resetSandbox(): Promise<{ generation: number }> {
    return this.call<{ generation: number }>('POST', '/v1/sandbox/reset', {});
  }

  private sign(
    method: string,
    path: string,
    body: string,
    timestamp: number,
    nonce: string,
  ): string {
    const digest = createHmac('sha256', '').update(body).digest('hex');
    return createHmac('sha256', this.clientSecret)
      .update([method.toUpperCase(), path, String(timestamp), nonce, digest].join('\n'))
      .digest('hex');
  }

  private async call<T>(
    method: string,
    path: string,
    payload: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const body = payload === null ? '' : JSON.stringify(payload);
    let lastError: ArcApiError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const timestamp = this.now();
      // Fresh per attempt: a retry must not look like a replay of the original.
      const nonce = randomBytes(12).toString('hex');
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'arc-client-id': this.clientId,
        'arc-timestamp': String(timestamp),
        'arc-nonce': nonce,
        'arc-signature': this.sign(method, path, body, timestamp, nonce),
      };
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

      const response = await this.transport.send({ method, path, headers, body });

      if (response.status >= 200 && response.status < 300) {
        return response.body as T;
      }

      const error = response.body as { code?: string; message?: string; requestId?: string } | null;
      lastError = new ArcApiError(
        response.status,
        error?.code ?? 'unknown_error',
        error?.message ?? `request failed with ${response.status}`,
        error?.requestId,
      );

      if (!lastError.retryable) throw lastError;
    }

    throw lastError!;
  }
}

/**
 * Verify a webhook signature.
 *
 * Exported so integrators use the same code Arc signs with, rather than
 * reimplementing the concatenation from prose and getting it subtly wrong.
 */
export function verifyWebhookSignature(input: {
  secret: string;
  header: string;
  body: string;
  now?: number;
  toleranceMs?: number;
}): boolean {
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(input.header);
  if (!match) return false;

  const timestamp = Number(match[1]);
  const tolerance = input.toleranceMs ?? 300_000;
  if (Math.abs((input.now ?? Date.now()) - timestamp) > tolerance) return false;

  const expected = createHmac('sha256', input.secret)
    .update(`${timestamp}.${input.body}`)
    .digest('hex');

  // Length is fixed by the regex, so a simple comparison is safe here.
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ match[2]!.charCodeAt(i);
  }
  return mismatch === 0;
}
