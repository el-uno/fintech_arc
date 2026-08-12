import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export class WebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookError';
  }
}

export type DeliveryOutcome = 'delivered' | 'failed' | 'exhausted';

export interface WebhookEndpoint {
  readonly id: string;
  readonly tenantId: string;
  readonly url: string;
  readonly secret: string;
  readonly events: readonly string[];
  readonly disabled: boolean;
}

export interface DeliveryAttempt {
  readonly attempt: number;
  readonly at: Date;
  readonly outcome: DeliveryOutcome;
  readonly responseStatus?: number;
  readonly error?: string;
}

export interface Delivery {
  readonly id: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly attempts: DeliveryAttempt[];
  status: 'pending' | 'delivered' | 'exhausted';
  nextAttemptAt: number;
}

export interface WebhookTransport {
  send(input: {
    url: string;
    body: string;
    headers: Record<string, string>;
  }): Promise<{ status: number }>;
}

export interface WebhookOptions {
  now?: () => Date;
  maxAttempts?: number;
  baseBackoffMs?: number;
  /** How long a signature stays acceptable to a receiver. */
  toleranceMs?: number;
}

export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * Receiver-side verification, exported so partners can use exactly the code the
 * sender uses. Constant-time compare, and a timestamp window so a captured
 * payload cannot be replayed indefinitely.
 */
export function verifySignature(input: {
  secret: string;
  header: string;
  body: string;
  now?: number;
  toleranceMs?: number;
}): boolean {
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(input.header);
  if (!match) return false;

  const timestamp = Number(match[1]);
  const provided = match[2]!;
  const tolerance = input.toleranceMs ?? 300_000;
  const now = input.now ?? Date.now();

  if (Math.abs(now - timestamp) > tolerance) return false;

  const expected = signPayload(input.secret, timestamp, input.body);
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class WebhookService {
  private readonly endpoints = new Map<string, WebhookEndpoint>();
  private readonly deliveries = new Map<string, Delivery>();
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;

  constructor(
    private readonly transport: WebhookTransport,
    options: WebhookOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxAttempts = options.maxAttempts ?? 6;
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000;
  }

  register(input: {
    tenantId: string;
    url: string;
    events: readonly string[];
    secret?: string;
  }): WebhookEndpoint {
    if (!/^https:\/\//.test(input.url)) {
      throw new WebhookError('webhook endpoints must be https');
    }
    const endpoint: WebhookEndpoint = {
      id: randomUUID(),
      tenantId: input.tenantId,
      url: input.url,
      secret: input.secret ?? `whsec_${randomBytes(24).toString('hex')}`,
      events: input.events,
      disabled: false,
    };
    this.endpoints.set(endpoint.id, endpoint);
    return endpoint;
  }

  /** Rotate a secret without dropping deliveries in flight. */
  rotateSecret(endpointId: string): WebhookEndpoint {
    const endpoint = this.get(endpointId);
    const rotated = { ...endpoint, secret: `whsec_${randomBytes(24).toString('hex')}` };
    this.endpoints.set(endpointId, rotated);
    return rotated;
  }

  get(endpointId: string): WebhookEndpoint {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) throw new WebhookError(`no such endpoint: ${endpointId}`);
    return endpoint;
  }

  setDisabled(endpointId: string, disabled: boolean): WebhookEndpoint {
    const updated = { ...this.get(endpointId), disabled };
    this.endpoints.set(endpointId, updated);
    return updated;
  }

  /** Queue a delivery to every subscribed endpoint of the tenant. */
  enqueue(input: {
    tenantId: string;
    eventId: string;
    eventType: string;
    payload: unknown;
  }): Delivery[] {
    const created: Delivery[] = [];

    for (const endpoint of this.endpoints.values()) {
      if (endpoint.tenantId !== input.tenantId) continue;
      if (endpoint.disabled) continue;
      if (!endpoint.events.includes(input.eventType) && !endpoint.events.includes('*')) continue;

      const delivery: Delivery = {
        id: randomUUID(),
        endpointId: endpoint.id,
        eventId: input.eventId,
        eventType: input.eventType,
        payload: input.payload,
        attempts: [],
        status: 'pending',
        nextAttemptAt: this.now().getTime(),
      };
      this.deliveries.set(delivery.id, delivery);
      created.push(delivery);
    }

    return created;
  }

  async deliverDue(): Promise<Delivery[]> {
    const at = this.now().getTime();
    const due = [...this.deliveries.values()].filter(
      (d) => d.status === 'pending' && d.nextAttemptAt <= at,
    );
    for (const delivery of due) await this.attempt(delivery);
    return due;
  }

  /** Re-send a delivery on request, even one already delivered. */
  async replay(deliveryId: string): Promise<Delivery> {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery) throw new WebhookError(`no such delivery: ${deliveryId}`);
    delivery.status = 'pending';
    delivery.nextAttemptAt = this.now().getTime();
    await this.attempt(delivery);
    return delivery;
  }

  deliveriesFor(endpointId: string): Delivery[] {
    return [...this.deliveries.values()].filter((d) => d.endpointId === endpointId);
  }

  private async attempt(delivery: Delivery): Promise<void> {
    const endpoint = this.get(delivery.endpointId);
    const at = this.now();
    const timestamp = at.getTime();

    const body = JSON.stringify({
      id: delivery.eventId,
      type: delivery.eventType,
      created: Math.trunc(timestamp / 1000),
      data: delivery.payload,
    });

    const attemptNumber = delivery.attempts.length + 1;

    try {
      const response = await this.transport.send({
        url: endpoint.url,
        body,
        headers: {
          'content-type': 'application/json',
          'arc-signature': `t=${timestamp},v1=${signPayload(endpoint.secret, timestamp, body)}`,
          'arc-event-id': delivery.eventId,
          'arc-delivery-id': delivery.id,
          'arc-attempt': String(attemptNumber),
        },
      });

      if (response.status >= 200 && response.status < 300) {
        delivery.attempts.push({
          attempt: attemptNumber,
          at,
          outcome: 'delivered',
          responseStatus: response.status,
        });
        delivery.status = 'delivered';
        return;
      }

      this.recordFailure(delivery, attemptNumber, at, `HTTP ${response.status}`, response.status);
    } catch (error) {
      this.recordFailure(
        delivery,
        attemptNumber,
        at,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private recordFailure(
    delivery: Delivery,
    attemptNumber: number,
    at: Date,
    error: string,
    status?: number,
  ): void {
    const exhausted = attemptNumber >= this.maxAttempts;

    delivery.attempts.push({
      attempt: attemptNumber,
      at,
      outcome: exhausted ? 'exhausted' : 'failed',
      error,
      ...(status !== undefined ? { responseStatus: status } : {}),
    });

    if (exhausted) {
      delivery.status = 'exhausted';
      return;
    }

    delivery.nextAttemptAt = at.getTime() + this.baseBackoffMs * 2 ** (attemptNumber - 1);
  }
}
