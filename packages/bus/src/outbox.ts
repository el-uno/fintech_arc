import type { AnyDomainEvent } from '@arc/contracts';

/**
 * The transactional outbox.
 *
 * The problem it solves: a service must both change state ("the transfer is
 * settled") and tell the rest of the system. Doing the write and the publish
 * separately means a crash between them either loses the event or announces
 * something that never happened.
 *
 * The outbox makes the event part of the same database transaction as the state
 * change. A separate dispatcher drains it afterwards. The event is therefore
 * published *at least once* — never zero times, possibly twice — which is why
 * every handler in Arc must be idempotent.
 */

export type OutboxStatus = 'pending' | 'delivered' | 'failed';

export interface OutboxRecord {
  readonly event: AnyDomainEvent;
  status: OutboxStatus;
  attempts: number;
  lastError?: string;
  /** Not eligible for dispatch before this time — the retry backoff. */
  availableAt: number;
}

export interface Outbox {
  /** Stage events. In a real store this participates in the caller's transaction. */
  stage(events: readonly AnyDomainEvent[]): Promise<void>;
  /** Take up to `limit` events that are due for dispatch. */
  claim(limit: number, now?: number): Promise<OutboxRecord[]>;
  markDelivered(eventId: string): Promise<void>;
  markFailed(eventId: string, error: string, retryDelayMs: number, now?: number): Promise<void>;
  pendingCount(): Promise<number>;
}

/**
 * In-memory outbox. Correct semantics, no durability — sufficient for the
 * modular monolith and for tests. Phase 1 adds a Postgres-backed implementation
 * behind this same interface, at which point `stage` joins the caller's
 * transaction and the semantics become real.
 */
export class InMemoryOutbox implements Outbox {
  private readonly records = new Map<string, OutboxRecord>();

  async stage(events: readonly AnyDomainEvent[]): Promise<void> {
    for (const event of events) {
      // Staging the same event id twice is a no-op, not a duplicate.
      if (this.records.has(event.id)) continue;
      this.records.set(event.id, {
        event,
        status: 'pending',
        attempts: 0,
        availableAt: 0,
      });
    }
  }

  async claim(limit: number, now = Date.now()): Promise<OutboxRecord[]> {
    const due: OutboxRecord[] = [];
    for (const record of this.records.values()) {
      if (due.length >= limit) break;
      if (record.status === 'delivered') continue;
      if (record.availableAt > now) continue;
      due.push(record);
    }
    return due;
  }

  async markDelivered(eventId: string): Promise<void> {
    const record = this.records.get(eventId);
    if (record) {
      record.status = 'delivered';
      delete record.lastError;
    }
  }

  async markFailed(
    eventId: string,
    error: string,
    retryDelayMs: number,
    now = Date.now(),
  ): Promise<void> {
    const record = this.records.get(eventId);
    if (!record) return;
    record.status = 'failed';
    record.attempts += 1;
    record.lastError = error;
    record.availableAt = now + retryDelayMs;
  }

  async pendingCount(): Promise<number> {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.status !== 'delivered') count += 1;
    }
    return count;
  }

  /** Test/inspection helper. Not part of the interface. */
  all(): OutboxRecord[] {
    return [...this.records.values()];
  }
}
