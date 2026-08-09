import { randomUUID } from 'node:crypto';
import {
  EventEnvelopeSchema,
  schemaFor,
  type AnyDomainEvent,
  type DomainEvent,
  type EventType,
  type PayloadOf,
} from '@arc/contracts';
import type { Outbox } from './outbox.js';

export class BusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusError';
  }
}

/** Ambient facts every event inherits from the request or saga that produced it. */
export interface PublishContext {
  tenantId: string;
  correlationId: string;
  causationId?: string;
  source: string;
  idempotencyKey?: string;
}

export type EventHandler<T extends EventType = EventType> = (
  event: DomainEvent<T, PayloadOf<T>>,
) => Promise<void>;

export interface Subscription {
  /** Stable name. Used to record which handlers have already seen an event. */
  readonly name: string;
  readonly type: EventType;
  /**
   * Accepts any catalogue event. The dispatcher only ever invokes a handler with
   * an event whose `type` matches its subscription, so the narrowing performed
   * at `subscribe` time is sound.
   */
  readonly handle: (event: AnyDomainEvent) => Promise<void>;
}

/**
 * Build a validated event. Payloads are checked against the catalogue *before*
 * they are staged, so a malformed event can never reach the outbox — a bad
 * publish fails loudly at the producer rather than quietly at every consumer.
 */
export function createEvent<T extends EventType>(
  type: T,
  payload: PayloadOf<T>,
  context: PublishContext,
  now: () => Date = () => new Date(),
): DomainEvent<T, PayloadOf<T>> {
  const parsed = schemaFor(type).safeParse(payload);
  if (!parsed.success) {
    throw new BusError(`invalid payload for ${type}: ${parsed.error.message}`);
  }

  const envelope = {
    id: randomUUID(),
    type,
    version: 1,
    tenantId: context.tenantId,
    correlationId: context.correlationId,
    ...(context.causationId ? { causationId: context.causationId } : {}),
    occurredAt: now().toISOString(),
    source: context.source,
    ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
  };

  const validated = EventEnvelopeSchema.safeParse(envelope);
  if (!validated.success) {
    throw new BusError(`invalid envelope for ${type}: ${validated.error.message}`);
  }

  return { ...envelope, type, payload: parsed.data } as DomainEvent<T, PayloadOf<T>>;
}

/**
 * The in-process event bus.
 *
 * Publishing only *stages* events — nothing is delivered until the dispatcher
 * runs. That separation is what makes the outbox guarantee hold, and it means a
 * caller can publish inside a transaction without any risk of a consumer
 * observing state the transaction later rolls back.
 */
export class EventBus {
  private readonly subscriptions: Subscription[] = [];

  constructor(private readonly outbox: Outbox) {}

  subscribe<T extends EventType>(name: string, type: T, handle: EventHandler<T>): void {
    if (this.subscriptions.some((s) => s.name === name && s.type === type)) {
      throw new BusError(`handler ${name} is already subscribed to ${type}`);
    }
    this.subscriptions.push({
      name,
      type,
      // Sound because `subscribersFor` only returns handlers whose `type` matches
      // the event being dispatched.
      handle: handle as (event: AnyDomainEvent) => Promise<void>,
    });
  }

  subscribersFor(type: string): Subscription[] {
    return this.subscriptions.filter((s) => s.type === type);
  }

  /** Stage events for delivery. Returns what was staged, for correlation. */
  async publish(events: readonly AnyDomainEvent[]): Promise<readonly AnyDomainEvent[]> {
    await this.outbox.stage(events);
    return events;
  }

  async publishOne<T extends EventType>(
    type: T,
    payload: PayloadOf<T>,
    context: PublishContext,
  ): Promise<DomainEvent<T, PayloadOf<T>>> {
    const event = createEvent(type, payload, context);
    // TypeScript cannot prove that an uninstantiated `DomainEvent<T>` is a member
    // of the union, though every concrete instantiation is. The payload has already
    // been validated against the catalogue by `createEvent`.
    await this.publish([event as AnyDomainEvent]);
    return event;
  }
}
