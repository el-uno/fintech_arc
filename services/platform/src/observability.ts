import { randomUUID } from 'node:crypto';
import { redact } from './secrets.js';

export type SpanStatus = 'ok' | 'error';

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly service: string;
  readonly startedAt: number;
  endedAt?: number;
  status: SpanStatus;
  attributes: Record<string, unknown>;
  events: Array<{ at: number; name: string; attributes?: Record<string, unknown> }>;
}

export interface LogRecord {
  readonly at: number;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly fields: Record<string, unknown>;
}

export interface TracerOptions {
  now?: () => number;
  service?: string;
}

/**
 * A minimal tracer with OpenTelemetry's shape.
 *
 * A corridor transfer crosses five contexts; one trace id threading all of them
 * is the difference between "the transfer failed" and "the payout rail timed out
 * after the chain reached finality".
 */
export class Tracer {
  private readonly spans: Span[] = [];
  private readonly logs: LogRecord[] = [];
  private readonly now: () => number;
  private readonly service: string;

  constructor(options: TracerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.service = options.service ?? 'arc';
  }

  startSpan(name: string, parent?: Span, attributes: Record<string, unknown> = {}): Span {
    const span: Span = {
      traceId: parent?.traceId ?? randomUUID(),
      spanId: randomUUID(),
      ...(parent ? { parentSpanId: parent.spanId } : {}),
      name,
      service: this.service,
      startedAt: this.now(),
      status: 'ok',
      attributes: redact(attributes) as Record<string, unknown>,
      events: [],
    };
    this.spans.push(span);
    return span;
  }

  endSpan(span: Span, status: SpanStatus = 'ok'): Span {
    span.endedAt = this.now();
    span.status = status;
    return span;
  }

  addEvent(span: Span, name: string, attributes?: Record<string, unknown>): void {
    span.events.push({
      at: this.now(),
      name,
      ...(attributes ? { attributes: redact(attributes) as Record<string, unknown> } : {}),
    });
  }

  /** Run a function inside a span, ending it correctly on either path. */
  async inSpan<T>(
    name: string,
    parent: Span | undefined,
    fn: (span: Span) => Promise<T>,
    attributes: Record<string, unknown> = {},
  ): Promise<T> {
    const span = this.startSpan(name, parent, attributes);
    try {
      const result = await fn(span);
      this.endSpan(span, 'ok');
      return result;
    } catch (error) {
      this.addEvent(span, 'exception', {
        message: error instanceof Error ? error.message : String(error),
      });
      this.endSpan(span, 'error');
      throw error;
    }
  }

  log(
    level: LogRecord['level'],
    message: string,
    fields: Record<string, unknown> = {},
    span?: Span,
  ): LogRecord {
    const record: LogRecord = {
      at: this.now(),
      level,
      message: redact(message) as string,
      ...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
      fields: redact(fields) as Record<string, unknown>,
    };
    this.logs.push(record);
    return record;
  }

  trace(traceId: string): Span[] {
    return this.spans
      .filter((s) => s.traceId === traceId)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  allSpans(): readonly Span[] {
    return this.spans;
  }

  allLogs(): readonly LogRecord[] {
    return this.logs;
  }

  durationOf(span: Span): number {
    return (span.endedAt ?? this.now()) - span.startedAt;
  }
}

export interface MetricSnapshot {
  readonly counters: Record<string, number>;
  readonly histograms: Record<string, { count: number; sum: number; p50: number; p95: number }>;
}

/** RED metrics — rate, errors, duration — plus business counters. */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly observations = new Map<string, number[]>();

  increment(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.key(name, labels);
    const list = this.observations.get(key) ?? [];
    list.push(value);
    this.observations.set(key, list);
  }

  snapshot(): MetricSnapshot {
    const histograms: MetricSnapshot['histograms'] = {};
    for (const [key, values] of this.observations) {
      const sorted = [...values].sort((a, b) => a - b);
      histograms[key] = {
        count: sorted.length,
        sum: sorted.reduce((a, b) => a + b, 0),
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
      };
    }
    return { counters: Object.fromEntries(this.counters), histograms };
  }

  private key(name: string, labels: Record<string, string>): string {
    const parts = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`);
    return parts.length ? `${name}{${parts.join(',')}}` : name;
  }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.trunc((p / 100) * sorted.length));
  return sorted[index]!;
}
