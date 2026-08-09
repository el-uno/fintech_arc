import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BusError,
  createEvent,
  Dispatcher,
  EventBus,
  InMemoryOutbox,
  InMemoryProcessedLog,
  type PublishContext,
} from '../src/index.js';

function context(overrides: Partial<PublishContext> = {}): PublishContext {
  return {
    tenantId: 'tenant_demo',
    correlationId: randomUUID(),
    source: 'test',
    ...overrides,
  };
}

const validPayout = () => ({
  transferId: randomUUID(),
  payoutId: randomUUID(),
  rail: 'sepa_instant',
  amount: { amount: '10000', currency: 'EUR' },
});

function harness() {
  const outbox = new InMemoryOutbox();
  const bus = new EventBus(outbox);
  const processed = new InMemoryProcessedLog();
  const dispatcher = new Dispatcher(bus, outbox, processed, { baseRetryDelayMs: 0 });
  return { outbox, bus, processed, dispatcher };
}

describe('createEvent', () => {
  it('validates the payload against the catalogue', () => {
    const event = createEvent('payout.completed', validPayout(), context());
    expect(event.type).toBe('payout.completed');
    expect(event.version).toBe(1);
    expect(event.tenantId).toBe('tenant_demo');
  });

  it('rejects a malformed payload at the producer', () => {
    expect(() =>
      // @ts-expect-error - deliberately wrong shape
      createEvent('payout.completed', { transferId: 'not-a-uuid' }, context()),
    ).toThrow(BusError);
  });

  it('rejects a float amount on the wire', () => {
    expect(() =>
      createEvent(
        'payout.completed',
        // @ts-expect-error - amount must be an integer string of minor units
        { ...validPayout(), amount: { amount: 100.5, currency: 'EUR' } },
        context(),
      ),
    ).toThrow(BusError);
  });

  it('rejects a journal that cannot balance', () => {
    expect(() =>
      createEvent(
        'journal.posted',
        {
          journalId: randomUUID(),
          kind: 'transfer',
          referenceId: randomUUID(),
          // A single entry can never balance.
          entries: [
            {
              accountId: randomUUID(),
              direction: 'debit',
              amount: { amount: '100', currency: 'EUR' },
            },
          ],
        },
        context(),
      ),
    ).toThrow(BusError);
  });

  it('carries correlation and causation for tracing a saga', () => {
    const correlationId = randomUUID();
    const first = createEvent('payout.completed', validPayout(), context({ correlationId }));
    const second = createEvent(
      'payout.completed',
      validPayout(),
      context({ correlationId, causationId: first.id }),
    );
    expect(second.correlationId).toBe(first.correlationId);
    expect(second.causationId).toBe(first.id);
  });
});

describe('publish and dispatch', () => {
  it('does not deliver anything until the dispatcher runs', async () => {
    const { bus, dispatcher } = harness();
    const seen: string[] = [];
    bus.subscribe('recorder', 'payout.completed', async (e) => {
      seen.push(e.id);
    });

    await bus.publishOne('payout.completed', validPayout(), context());
    expect(seen).toEqual([]); // staged, not delivered

    await dispatcher.drain();
    expect(seen).toHaveLength(1);
  });

  it('fans out to every subscriber of a type', async () => {
    const { bus, dispatcher } = harness();
    const calls: string[] = [];
    bus.subscribe('ledger', 'payout.completed', async () => void calls.push('ledger'));
    bus.subscribe(
      'notifications',
      'payout.completed',
      async () => void calls.push('notifications'),
    );
    bus.subscribe('webhooks', 'payout.completed', async () => void calls.push('webhooks'));

    await bus.publishOne('payout.completed', validPayout(), context());
    await dispatcher.drain();

    expect(calls.sort()).toEqual(['ledger', 'notifications', 'webhooks']);
  });

  it('refuses a duplicate handler registration', () => {
    const { bus } = harness();
    bus.subscribe('ledger', 'payout.completed', async () => {});
    expect(() => bus.subscribe('ledger', 'payout.completed', async () => {})).toThrow(BusError);
  });

  it('marks an event delivered only once all handlers succeed', async () => {
    const { bus, outbox, dispatcher } = harness();
    bus.subscribe('ok', 'payout.completed', async () => {});
    bus.subscribe('bad', 'payout.completed', async () => {
      throw new Error('downstream unavailable');
    });

    await bus.publishOne('payout.completed', validPayout(), context());
    const result = await dispatcher.drain();

    expect(result.delivered).toBe(0);
    expect(result.failed).toBe(1);
    expect(await outbox.pendingCount()).toBe(1);
  });
});

describe('at-least-once delivery with idempotent handlers', () => {
  it('does not re-run a handler that already succeeded', async () => {
    const { bus, dispatcher } = harness();
    let okCalls = 0;
    let flakyCalls = 0;
    let failuresRemaining = 2;

    bus.subscribe('ok', 'payout.completed', async () => {
      okCalls += 1;
    });
    bus.subscribe('flaky', 'payout.completed', async () => {
      flakyCalls += 1;
      if (failuresRemaining-- > 0) throw new Error('transient');
    });

    await bus.publishOne('payout.completed', validPayout(), context());
    await dispatcher.drainUntilEmpty();

    // The flaky handler retried until it succeeded...
    expect(flakyCalls).toBe(3);
    // ...but the healthy handler ran exactly once despite three delivery attempts.
    expect(okCalls).toBe(1);
  });

  it('eventually delivers once a transient failure clears', async () => {
    const { bus, outbox, dispatcher } = harness();
    let shouldFail = true;
    bus.subscribe('flaky', 'payout.completed', async () => {
      if (shouldFail) throw new Error('transient');
    });

    await bus.publishOne('payout.completed', validPayout(), context());
    await dispatcher.drain();
    expect(await outbox.pendingCount()).toBe(1);

    shouldFail = false;
    await dispatcher.drain();
    expect(await outbox.pendingCount()).toBe(0);
  });

  it('parks a poison event instead of blocking the queue forever', async () => {
    const outbox = new InMemoryOutbox();
    const bus = new EventBus(outbox);
    const dispatcher = new Dispatcher(bus, outbox, new InMemoryProcessedLog(), {
      baseRetryDelayMs: 0,
      maxAttempts: 3,
    });

    bus.subscribe('always-fails', 'payout.completed', async () => {
      throw new Error('permanently broken');
    });

    await bus.publishOne('payout.completed', validPayout(), context());
    const passes = await dispatcher.drainUntilEmpty();

    expect(passes.some((p) => p.exhausted === 1)).toBe(true);
    // Parked, not deleted — it stays visible as an operational case.
    const record = outbox.all()[0]!;
    expect(record.status).toBe('failed');
    expect(record.lastError).toContain('permanently broken');
  });

  it('staging the same event id twice produces one delivery', async () => {
    const { bus, dispatcher } = harness();
    let calls = 0;
    bus.subscribe('counter', 'payout.completed', async () => {
      calls += 1;
    });

    const event = createEvent('payout.completed', validPayout(), context());
    await bus.publish([event]);
    await bus.publish([event]); // redelivery of the identical event
    await dispatcher.drainUntilEmpty();

    expect(calls).toBe(1);
  });
});

describe('backoff', () => {
  it('does not retry before the delay has elapsed', async () => {
    const outbox = new InMemoryOutbox();
    const bus = new EventBus(outbox);
    let clock = 1_000;
    const dispatcher = new Dispatcher(bus, outbox, new InMemoryProcessedLog(), {
      baseRetryDelayMs: 500,
      now: () => clock,
    });

    let calls = 0;
    bus.subscribe('flaky', 'payout.completed', async () => {
      calls += 1;
      throw new Error('transient');
    });

    await bus.publishOne('payout.completed', validPayout(), context());
    await dispatcher.drain();
    expect(calls).toBe(1);

    // Too early — nothing is claimed.
    clock += 100;
    expect((await dispatcher.drain()).claimed).toBe(0);
    expect(calls).toBe(1);

    // Past the backoff — retried.
    clock += 500;
    await dispatcher.drain();
    expect(calls).toBe(2);
  });
});
