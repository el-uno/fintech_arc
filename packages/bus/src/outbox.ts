import type { AnyDomainEvent } from '@arc/contracts';

export type OutboxStatus = 'pending' | 'delivered' | 'failed';

export interface OutboxRecord {
  readonly event: AnyDomainEvent;
  status: OutboxStatus;
  attempts: number;
  lastError?: string;
  availableAt: number;
}

export interface Outbox {
  stage(events: readonly AnyDomainEvent[]): Promise<void>;
  claim(limit: number, now?: number): Promise<OutboxRecord[]>;
  markDelivered(eventId: string): Promise<void>;
  markFailed(eventId: string, error: string, retryDelayMs: number, now?: number): Promise<void>;
  pendingCount(): Promise<number>;
}

export class InMemoryOutbox implements Outbox {
  private readonly records = new Map<string, OutboxRecord>();

  async stage(events: readonly AnyDomainEvent[]): Promise<void> {
    for (const event of events) {
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

  all(): OutboxRecord[] {
    return [...this.records.values()];
  }
}
