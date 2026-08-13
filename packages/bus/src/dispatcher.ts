import type { EventBus } from './bus.js';
import type { Outbox } from './outbox.js';

export interface ProcessedLog {
  has(handlerName: string, eventId: string): Promise<boolean>;
  record(handlerName: string, eventId: string): Promise<void>;
}

export class InMemoryProcessedLog implements ProcessedLog {
  private readonly seen = new Set<string>();

  async has(handlerName: string, eventId: string): Promise<boolean> {
    return this.seen.has(`${handlerName}:${eventId}`);
  }

  async record(handlerName: string, eventId: string): Promise<void> {
    this.seen.add(`${handlerName}:${eventId}`);
  }

  get size(): number {
    return this.seen.size;
  }
}

export interface DispatcherOptions {
  batchSize?: number;
  maxAttempts?: number;
  baseRetryDelayMs?: number;
  now?: () => number;
}

export interface DrainResult {
  claimed: number;
  delivered: number;
  failed: number;
  skipped: number;
  exhausted: number;
}

export class Dispatcher {
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly baseRetryDelayMs: number;
  private readonly now: () => number;

  constructor(
    private readonly bus: EventBus,
    private readonly outbox: Outbox,
    private readonly processed: ProcessedLog,
    options: DispatcherOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 50;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 100;
    this.now = options.now ?? (() => Date.now());
  }

  async drain(): Promise<DrainResult> {
    const result: DrainResult = {
      claimed: 0,
      delivered: 0,
      failed: 0,
      skipped: 0,
      exhausted: 0,
    };

    const records = await this.outbox.claim(this.batchSize, this.now());
    result.claimed = records.length;

    for (const record of records) {
      const { event } = record;
      const handlers = this.bus.subscribersFor(event.type);
      const errors: string[] = [];

      for (const handler of handlers) {
        if (await this.processed.has(handler.name, event.id)) {
          result.skipped += 1;
          continue;
        }
        try {
          await handler.handle(event);
          await this.processed.record(handler.name, event.id);
        } catch (error) {
          errors.push(`${handler.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (errors.length === 0) {
        await this.outbox.markDelivered(event.id);
        result.delivered += 1;
        continue;
      }

      const nextAttempt = record.attempts + 1;
      if (nextAttempt >= this.maxAttempts) {
        await this.outbox.markFailed(
          event.id,
          errors.join('; '),
          Number.MAX_SAFE_INTEGER,
          this.now(),
        );
        result.exhausted += 1;
      } else {
        const delay = this.baseRetryDelayMs * 2 ** record.attempts;
        await this.outbox.markFailed(event.id, errors.join('; '), delay, this.now());
        result.failed += 1;
      }
    }

    return result;
  }

  async drainUntilEmpty(maxPasses = 100): Promise<DrainResult[]> {
    const passes: DrainResult[] = [];
    for (let i = 0; i < maxPasses; i++) {
      const result = await this.drain();
      passes.push(result);
      if (result.claimed === 0) break;
      if (result.delivered === 0 && result.failed === 0 && result.exhausted === 0) break;
    }
    return passes;
  }
}
