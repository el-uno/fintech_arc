import { createHash } from 'node:crypto';

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'idempotency_conflict' | 'rate_limited' | 'in_progress',
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface IdempotentResponse {
  readonly status: number;
  readonly body: unknown;
}

interface IdempotencyRecord {
  readonly key: string;
  readonly tenantId: string;
  readonly requestHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  state: 'in_progress' | 'completed';
  response?: IdempotentResponse;
}

export function hashRequest(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${JSON.stringify(body ?? null)}`)
    .digest('hex');
}

export interface IdempotencyOptions {
  now?: () => number;
  ttlMs?: number;
}

/**
 * Request-level idempotency.
 *
 * A partner retrying a payout must get the original response back, not a second
 * payout. Reusing a key with a *different* body is a conflict, not a cache hit —
 * silently returning the first response would hide a client bug behind a success.
 */
export class IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: IdempotencyOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  }

  async run<T>(
    input: { key: string; tenantId: string; method: string; path: string; body: unknown },
    handler: () => Promise<IdempotentResponse & { value?: T }>,
  ): Promise<IdempotentResponse> {
    const id = `${input.tenantId}:${input.key}`;
    const requestHash = hashRequest(input.method, input.path, input.body);
    const at = this.now();

    const existing = this.records.get(id);
    if (existing && existing.expiresAt > at) {
      if (existing.requestHash !== requestHash) {
        throw new GatewayError(
          409,
          'idempotency_conflict',
          `idempotency key ${input.key} was already used with a different request body`,
        );
      }
      if (existing.state === 'in_progress') {
        throw new GatewayError(
          409,
          'in_progress',
          `a request with idempotency key ${input.key} is still in flight`,
        );
      }
      return existing.response!;
    }

    const record: IdempotencyRecord = {
      key: input.key,
      tenantId: input.tenantId,
      requestHash,
      createdAt: at,
      expiresAt: at + this.ttlMs,
      state: 'in_progress',
    };
    this.records.set(id, record);

    try {
      const response = await handler();
      record.state = 'completed';
      record.response = { status: response.status, body: response.body };
      return record.response;
    } catch (error) {
      // A failed request must not poison the key — the client should be able to
      // retry it. Only completed responses are cached.
      this.records.delete(id);
      throw error;
    }
  }

  size(): number {
    return this.records.size;
  }
}

export interface RateLimitOptions {
  now?: () => number;
  capacity?: number;
  refillPerSecond?: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Token bucket per tenant: sustained rate plus a burst allowance. */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly capacity: number;
  private readonly refillPerSecond: number;

  constructor(options: RateLimitOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.capacity = options.capacity ?? 100;
    this.refillPerSecond = options.refillPerSecond ?? 10;
  }

  check(tenantId: string, cost = 1): RateLimitDecision {
    const at = this.now();
    const bucket = this.buckets.get(tenantId) ?? { tokens: this.capacity, updatedAt: at };

    const elapsedSeconds = (at - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);
    bucket.updatedAt = at;

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      this.buckets.set(tenantId, bucket);
      return { allowed: true, remaining: Math.trunc(bucket.tokens), retryAfterMs: 0 };
    }

    this.buckets.set(tenantId, bucket);
    const deficit = cost - bucket.tokens;
    const waitMs = (deficit / this.refillPerSecond) * 1000;
    return {
      allowed: false,
      remaining: 0,
      // Round up so the caller never retries a millisecond too early. This is a
      // duration, not an amount — divRound is for money.
      retryAfterMs: Math.trunc(waitMs) + (waitMs % 1 > 0 ? 1 : 0),
    };
  }

  consume(tenantId: string, cost = 1): void {
    const decision = this.check(tenantId, cost);
    if (!decision.allowed) {
      throw new GatewayError(
        429,
        'rate_limited',
        `rate limit exceeded for ${tenantId}`,
        decision.retryAfterMs,
      );
    }
  }
}
