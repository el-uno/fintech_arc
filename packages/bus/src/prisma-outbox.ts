import type { PrismaLike } from '@arc/db';
import type { AnyDomainEvent } from '@arc/contracts';
import type { ProcessedLog } from './dispatcher.js';
import type { Outbox, OutboxRecord } from './outbox.js';

/**
 * Postgres-backed outbox.
 *
 * This is what makes the transactional guarantee real rather than modelled:
 * `stage` can join the caller's transaction, so the event and the state change
 * it describes commit together or not at all.
 */
export class PrismaOutbox implements Outbox {
  constructor(private readonly db: PrismaLike) {}

  async stage(events: readonly AnyDomainEvent[]): Promise<void> {
    if (events.length === 0) return;

    await this.db.outboxEvent.createMany({
      data: events.map((event) => ({
        id: event.id,
        type: event.type,
        version: event.version,
        tenantId: event.tenantId,
        correlationId: event.correlationId,
        causationId: event.causationId ?? null,
        source: event.source,
        idempotencyKey: event.idempotencyKey ?? null,
        payload: event.payload as never,
        occurredAt: new Date(event.occurredAt),
        // Set explicitly rather than relying on the column default: the database
        // clock can be marginally ahead of the caller's, which would make a
        // freshly staged event briefly un-claimable.
        availableAt: new Date(event.occurredAt),
      })),
      // Staging the same event id twice is a no-op, matching the in-memory store.
      skipDuplicates: true,
    });
  }

  async claim(limit: number, now = Date.now()): Promise<OutboxRecord[]> {
    const rows = await this.db.outboxEvent.findMany({
      where: { status: { not: 'delivered' }, availableAt: { lte: new Date(now) } },
      orderBy: { occurredAt: 'asc' },
      take: limit,
    });

    return rows.map((row) => ({
      event: {
        id: row.id,
        type: row.type,
        version: row.version,
        tenantId: row.tenantId,
        correlationId: row.correlationId,
        ...(row.causationId ? { causationId: row.causationId } : {}),
        source: row.source,
        ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
        occurredAt: row.occurredAt.toISOString(),
        payload: row.payload,
      } as AnyDomainEvent,
      status: row.status,
      attempts: row.attempts,
      ...(row.lastError ? { lastError: row.lastError } : {}),
      availableAt: row.availableAt.getTime(),
    }));
  }

  async markDelivered(eventId: string): Promise<void> {
    await this.db.outboxEvent.update({
      where: { id: eventId },
      data: { status: 'delivered', lastError: null },
    });
  }

  async markFailed(
    eventId: string,
    error: string,
    retryDelayMs: number,
    now = Date.now(),
  ): Promise<void> {
    // Clamp: Number.MAX_SAFE_INTEGER is used to park a poison event, and that
    // overflows a timestamp. A century out is "never" for practical purposes and
    // keeps the row inspectable.
    const delay = Math.min(retryDelayMs, 100 * 365 * 24 * 60 * 60 * 1000);

    await this.db.outboxEvent.update({
      where: { id: eventId },
      data: {
        status: 'failed',
        attempts: { increment: 1 },
        lastError: error,
        availableAt: new Date(now + delay),
      },
    });
  }

  async pendingCount(): Promise<number> {
    return this.db.outboxEvent.count({ where: { status: { not: 'delivered' } } });
  }
}

/**
 * Postgres-backed processed log.
 *
 * The composite primary key on (handler_name, event_id) makes a duplicate
 * delivery a no-op at the database level rather than a matter of application
 * discipline.
 */
export class PrismaProcessedLog implements ProcessedLog {
  constructor(private readonly db: PrismaLike) {}

  async has(handlerName: string, eventId: string): Promise<boolean> {
    const row = await this.db.processedEvent.findUnique({
      where: { handlerName_eventId: { handlerName, eventId } },
      select: { eventId: true },
    });
    return row !== null;
  }

  async record(handlerName: string, eventId: string): Promise<void> {
    await this.db.processedEvent.createMany({
      data: [{ handlerName, eventId }],
      skipDuplicates: true,
    });
  }
}
