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
  readonly name: string;
  readonly type: EventType;
  readonly handle: (event: AnyDomainEvent) => Promise<void>;
}

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
      // Sound: subscribersFor only returns handlers whose type matches the event.
      handle: handle as (event: AnyDomainEvent) => Promise<void>,
    });
  }

  subscribersFor(type: string): Subscription[] {
    return this.subscriptions.filter((s) => s.type === type);
  }

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
    // TS cannot prove an uninstantiated DomainEvent<T> is in the union; every
    // concrete instantiation is, and createEvent has already validated it.
    await this.publish([event as AnyDomainEvent]);
    return event;
  }
}
