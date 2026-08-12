import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AuthError,
  AuthService,
  GatewayError,
  IdempotencyStore,
  Metrics,
  RateLimiter,
  redact,
  SecretsError,
  SecretsManager,
  signPayload,
  Tracer,
  verifySignature,
  WebhookError,
  WebhookService,
  type Scope,
  type WebhookTransport,
} from '../src/index.js';

const NOW = new Date('2026-06-01T12:00:00Z');

describe('auth: client credentials', () => {
  let auth: AuthService;

  beforeEach(() => {
    auth = new AuthService({ now: () => NOW });
    auth.registerClient({
      clientId: 'client_a',
      tenantId: 'tenant_a',
      secret: 'super-secret',
      scopes: ['quotes:read', 'transfers:write'],
    });
  });

  it('issues a scoped token', () => {
    const token = auth.issueToken('client_a', 'super-secret');
    expect(token.tenantId).toBe('tenant_a');
    expect(token.scopes).toEqual(['quotes:read', 'transfers:write']);
    expect(token.expiresAt.getTime()).toBe(NOW.getTime() + 3_600_000);
  });

  it('refuses a wrong secret', () => {
    expect(() => auth.issueToken('client_a', 'wrong')).toThrow(AuthError);
  });

  it('refuses an unknown client', () => {
    expect(() => auth.issueToken('nope', 'x')).toThrow(/no such client/);
  });

  it('never grants a scope the client does not hold', () => {
    expect(() => auth.issueToken('client_a', 'super-secret', ['admin'])).toThrow(
      /was not granted: admin/,
    );
  });

  it('narrows scope on request', () => {
    const token = auth.issueToken('client_a', 'super-secret', ['quotes:read']);
    expect(token.scopes).toEqual(['quotes:read']);
    expect(() => auth.verifyToken(token.token, 'transfers:write')).toThrow(/lacks scope/);
  });

  it('rejects an expired token', () => {
    let clock = NOW;
    const service = new AuthService({ now: () => clock, tokenTtlMs: 1_000 });
    service.registerClient({
      clientId: 'c',
      tenantId: 't',
      secret: 's',
      scopes: ['quotes:read'],
    });
    const token = service.issueToken('c', 's');

    expect(service.verifyToken(token.token)).toBeTruthy();
    clock = new Date(NOW.getTime() + 2_000);
    expect(() => service.verifyToken(token.token)).toThrow(/expired/);
  });

  it('admin satisfies any scope check', () => {
    auth.registerClient({
      clientId: 'root',
      tenantId: 'tenant_a',
      secret: 's',
      scopes: ['admin'],
    });
    const token = auth.issueToken('root', 's');
    expect(auth.verifyToken(token.token, 'transfers:write' as Scope)).toBeTruthy();
  });

  it('revoking a client invalidates its live tokens', () => {
    const token = auth.issueToken('client_a', 'super-secret');
    auth.revokeClient('client_a');
    expect(() => auth.verifyToken(token.token)).toThrow(AuthError);
    expect(() => auth.issueToken('client_a', 'super-secret')).toThrow(/revoked/);
  });
});

describe('auth: request signing', () => {
  let clock: Date;
  let auth: AuthService;
  const secret = 'signing-secret';

  const request = (over: Partial<Parameters<AuthService['sign']>[1]> = {}) => ({
    method: 'POST',
    path: '/v1/transfers',
    body: JSON.stringify({ amount: '10000', currency: 'EUR' }),
    timestamp: clock.getTime(),
    ...over,
  });

  beforeEach(() => {
    clock = NOW;
    auth = new AuthService({ now: () => clock });
    auth.registerClient({
      clientId: 'client_a',
      tenantId: 'tenant_a',
      secret,
      scopes: ['transfers:write'],
    });
  });

  it('accepts a correctly signed request', () => {
    const base = request();
    const signature = auth.sign(secret, base);
    expect(() =>
      auth.verifySignature({ ...base, signature, clientId: 'client_a' }, secret),
    ).not.toThrow();
  });

  it('rejects a tampered body', () => {
    const base = request();
    const signature = auth.sign(secret, base);
    expect(() =>
      auth.verifySignature(
        { ...base, body: JSON.stringify({ amount: '9999999' }), signature, clientId: 'client_a' },
        secret,
      ),
    ).toThrow(/signature does not match/);
  });

  it('rejects a tampered path', () => {
    const base = request();
    const signature = auth.sign(secret, base);
    expect(() =>
      auth.verifySignature({ ...base, path: '/v1/admin', signature, clientId: 'client_a' }, secret),
    ).toThrow(/signature does not match/);
  });

  it('rejects a stale timestamp', () => {
    const base = request({ timestamp: NOW.getTime() - 600_000 });
    const signature = auth.sign(secret, base);
    expect(() =>
      auth.verifySignature({ ...base, signature, clientId: 'client_a' }, secret),
    ).toThrow(/timestamp is/);
  });

  it('rejects a replayed signature', () => {
    const base = request();
    const signature = auth.sign(secret, base);
    const signed = { ...base, signature, clientId: 'client_a' };

    auth.verifySignature(signed, secret);
    expect(() => auth.verifySignature(signed, secret)).toThrow(/already been used/);
  });

  it('a signature for one client does not work for another', () => {
    auth.registerClient({
      clientId: 'client_b',
      tenantId: 'tenant_b',
      secret: 'different',
      scopes: [],
    });
    const base = request();
    const signature = auth.sign(secret, base);
    expect(() =>
      auth.verifySignature({ ...base, signature, clientId: 'client_b' }, 'different'),
    ).toThrow(/signature does not match/);
  });
});

describe('gateway: idempotency', () => {
  let clock: number;
  let store: IdempotencyStore;

  beforeEach(() => {
    clock = NOW.getTime();
    store = new IdempotencyStore({ now: () => clock });
  });

  const call = (
    key: string,
    body: unknown,
    handler: () => Promise<{ status: number; body: unknown }>,
  ) =>
    store.run({ key, tenantId: 'tenant_a', method: 'POST', path: '/v1/transfers', body }, handler);

  it('runs the handler once and replays the response', async () => {
    let calls = 0;
    const handler = async () => {
      calls += 1;
      return { status: 201, body: { transferId: 't_1' } };
    };

    const first = await call('key_1', { amount: '100' }, handler);
    const second = await call('key_1', { amount: '100' }, handler);

    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });

  it('rejects the same key with a different body', async () => {
    await call('key_1', { amount: '100' }, async () => ({ status: 201, body: {} }));

    await expect(
      call('key_1', { amount: '999' }, async () => ({ status: 201, body: {} })),
    ).rejects.toThrow(/different request body/);
  });

  it('does not cache a failed request', async () => {
    await expect(
      call('key_2', { amount: '100' }, async () => {
        throw new Error('downstream exploded');
      }),
    ).rejects.toThrow('downstream exploded');

    // The key is free again, so a retry can succeed.
    const retry = await call('key_2', { amount: '100' }, async () => ({
      status: 201,
      body: { ok: true },
    }));
    expect(retry.status).toBe(201);
  });

  it('scopes keys per tenant', async () => {
    await store.run(
      { key: 'shared', tenantId: 'tenant_a', method: 'POST', path: '/p', body: { a: 1 } },
      async () => ({ status: 201, body: { who: 'a' } }),
    );
    const other = await store.run(
      { key: 'shared', tenantId: 'tenant_b', method: 'POST', path: '/p', body: { b: 2 } },
      async () => ({ status: 201, body: { who: 'b' } }),
    );
    expect(other.body).toEqual({ who: 'b' });
  });

  it('expires records after the TTL', async () => {
    let calls = 0;
    const handler = async () => {
      calls += 1;
      return { status: 200, body: {} };
    };
    await call('key_3', { a: 1 }, handler);
    clock += 25 * 60 * 60 * 1000;
    await call('key_3', { a: 1 }, handler);
    expect(calls).toBe(2);
  });
});

describe('gateway: rate limiting', () => {
  it('allows a burst then throttles', () => {
    const clock = NOW.getTime();
    const limiter = new RateLimiter({ now: () => clock, capacity: 5, refillPerSecond: 1 });

    for (let i = 0; i < 5; i++) expect(limiter.check('tenant_a').allowed).toBe(true);

    const denied = limiter.check('tenant_a');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills over time', () => {
    let clock = NOW.getTime();
    const limiter = new RateLimiter({ now: () => clock, capacity: 2, refillPerSecond: 1 });
    limiter.consume('tenant_a', 2);
    expect(limiter.check('tenant_a').allowed).toBe(false);

    clock += 2_000;
    expect(limiter.check('tenant_a').allowed).toBe(true);
  });

  it('never exceeds capacity when idle', () => {
    let clock = NOW.getTime();
    const limiter = new RateLimiter({ now: () => clock, capacity: 3, refillPerSecond: 100 });
    clock += 60_000;
    expect(limiter.check('tenant_a').remaining).toBeLessThanOrEqual(3);
  });

  it('isolates tenants', () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 0 });
    limiter.consume('tenant_a');
    expect(() => limiter.consume('tenant_a')).toThrow(GatewayError);
    expect(() => limiter.consume('tenant_b')).not.toThrow();
  });

  it('throws with a retry hint', () => {
    const limiter = new RateLimiter({ capacity: 0, refillPerSecond: 1 });
    try {
      limiter.consume('tenant_a');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).status).toBe(429);
      expect((error as GatewayError).retryAfterMs).toBeGreaterThan(0);
    }
  });
});

describe('webhooks', () => {
  let clock: Date;
  let sent: Array<{ url: string; body: string; headers: Record<string, string> }>;
  let respondWith: number | (() => never);

  const transport: WebhookTransport = {
    async send(input) {
      sent.push(input);
      if (typeof respondWith === 'function') respondWith();
      return { status: respondWith };
    },
  };

  function service(maxAttempts = 3) {
    return new WebhookService(transport, {
      now: () => clock,
      maxAttempts,
      baseBackoffMs: 1_000,
    });
  }

  beforeEach(() => {
    clock = NOW;
    sent = [];
    respondWith = 200;
  });

  it('requires https endpoints', () => {
    expect(() =>
      service().register({ tenantId: 't', url: 'http://insecure.example', events: ['*'] }),
    ).toThrow(WebhookError);
  });

  it('delivers to subscribed endpoints only', async () => {
    const webhooks = service();
    webhooks.register({ tenantId: 't', url: 'https://a.example', events: ['transfer.settled'] });
    webhooks.register({ tenantId: 't', url: 'https://b.example', events: ['payout.completed'] });

    webhooks.enqueue({
      tenantId: 't',
      eventId: 'e1',
      eventType: 'transfer.settled',
      payload: { id: 't_1' },
    });
    await webhooks.deliverDue();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://a.example');
  });

  it('honours a wildcard subscription', async () => {
    const webhooks = service();
    webhooks.register({ tenantId: 't', url: 'https://all.example', events: ['*'] });
    webhooks.enqueue({ tenantId: 't', eventId: 'e', eventType: 'anything', payload: {} });
    await webhooks.deliverDue();
    expect(sent).toHaveLength(1);
  });

  it('does not leak events across tenants', async () => {
    const webhooks = service();
    webhooks.register({ tenantId: 'other', url: 'https://other.example', events: ['*'] });
    webhooks.enqueue({ tenantId: 't', eventId: 'e', eventType: 'x', payload: {} });
    await webhooks.deliverDue();
    expect(sent).toHaveLength(0);
  });

  it('signs the payload so a receiver can verify it', async () => {
    const webhooks = service();
    const endpoint = webhooks.register({
      tenantId: 't',
      url: 'https://a.example',
      events: ['*'],
    });

    webhooks.enqueue({ tenantId: 't', eventId: 'e1', eventType: 'x', payload: { a: 1 } });
    await webhooks.deliverDue();

    const { headers, body } = sent[0]!;
    expect(
      verifySignature({
        secret: endpoint.secret,
        header: headers['arc-signature']!,
        body,
        now: clock.getTime(),
      }),
    ).toBe(true);
  });

  it('rejects a tampered body at the receiver', async () => {
    const webhooks = service();
    const endpoint = webhooks.register({ tenantId: 't', url: 'https://a.example', events: ['*'] });
    webhooks.enqueue({ tenantId: 't', eventId: 'e1', eventType: 'x', payload: { a: 1 } });
    await webhooks.deliverDue();

    expect(
      verifySignature({
        secret: endpoint.secret,
        header: sent[0]!.headers['arc-signature']!,
        body: sent[0]!.body.replace('"a":1', '"a":999'),
        now: clock.getTime(),
      }),
    ).toBe(false);
  });

  it('rejects a signature outside the tolerance window', async () => {
    const webhooks = service();
    const endpoint = webhooks.register({ tenantId: 't', url: 'https://a.example', events: ['*'] });
    webhooks.enqueue({ tenantId: 't', eventId: 'e1', eventType: 'x', payload: {} });
    await webhooks.deliverDue();

    expect(
      verifySignature({
        secret: endpoint.secret,
        header: sent[0]!.headers['arc-signature']!,
        body: sent[0]!.body,
        now: clock.getTime() + 600_000,
      }),
    ).toBe(false);
  });

  it('rejects a malformed signature header', () => {
    expect(verifySignature({ secret: 's', header: 'garbage', body: '' })).toBe(false);
  });

  it('retries with exponential backoff and eventually exhausts', async () => {
    respondWith = 500;
    const webhooks = service(3);
    const endpoint = webhooks.register({ tenantId: 't', url: 'https://a.example', events: ['*'] });
    webhooks.enqueue({ tenantId: 't', eventId: 'e1', eventType: 'x', payload: {} });

    await webhooks.deliverDue();
    expect(sent).toHaveLength(1);

    // Too early for the second attempt.
    await webhooks.deliverDue();
    expect(sent).toHaveLength(1);

    clock = new Date(clock.getTime() + 1_000);
    await webhooks.deliverDue();
    expect(sent).toHaveLength(2);

    clock = new Date(clock.getTime() + 2_000);
    await webhooks.deliverDue();
    expect(sent).toHaveLength(3);

    const delivery = webhooks.deliveriesFor(endpoint.id)[0]!;
    expect(delivery.status).toBe('exhausted');
    expect(delivery.attempts.at(-1)!.outcome).toBe('exhausted');
  });

  it('records a transport exception as a failed attempt', async () => {
    respondWith = () => {
      throw new Error('connection refused');
    };
    const webhooks = service(2);
    const endpoint = webhooks.register({ tenantId: 't', url: 'https://a.example', events: ['*'] });
    webhooks.enqueue({ tenantId: 't', eventId: 'e1', eventType: 'x', payload: {} });
    await webhooks.deliverDue();

    const delivery = webhooks.deliveriesFor(endpoint.id)[0]!;
    expect(delivery.attempts[0]!.error).toContain('connection refused');
  });

  it('replays a delivered event on request', async () => {
    const webhooks = service();
    const endpoint = webhooks.register({ tenantId: 't', url: 'https://a.example', events: ['*'] });
    const [delivery] = webhooks.enqueue({
      tenantId: 't',
      eventId: 'e1',
      eventType: 'x',
      payload: {},
    });
    await webhooks.deliverDue();
    expect(sent).toHaveLength(1);

    await webhooks.replay(delivery!.id);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.headers['arc-event-id']).toBe('e1');
    expect(webhooks.deliveriesFor(endpoint.id)[0]!.status).toBe('delivered');
  });

  it('rotates a secret so old signatures stop verifying', async () => {
    const webhooks = service();
    const endpoint = webhooks.register({ tenantId: 't', url: 'https://a.example', events: ['*'] });
    const oldSecret = endpoint.secret;

    const rotated = webhooks.rotateSecret(endpoint.id);
    expect(rotated.secret).not.toBe(oldSecret);

    webhooks.enqueue({ tenantId: 't', eventId: 'e1', eventType: 'x', payload: {} });
    await webhooks.deliverDue();

    const header = sent[0]!.headers['arc-signature']!;
    expect(
      verifySignature({
        secret: rotated.secret,
        header,
        body: sent[0]!.body,
        now: clock.getTime(),
      }),
    ).toBe(true);
    expect(
      verifySignature({ secret: oldSecret, header, body: sent[0]!.body, now: clock.getTime() }),
    ).toBe(false);
  });

  it('skips a disabled endpoint', async () => {
    const webhooks = service();
    const endpoint = webhooks.register({ tenantId: 't', url: 'https://a.example', events: ['*'] });
    webhooks.setDisabled(endpoint.id, true);
    webhooks.enqueue({ tenantId: 't', eventId: 'e', eventType: 'x', payload: {} });
    await webhooks.deliverDue();
    expect(sent).toHaveLength(0);
  });

  it('produces a stable signature for the same inputs', () => {
    expect(signPayload('s', 1000, 'body')).toBe(signPayload('s', 1000, 'body'));
    expect(signPayload('s', 1000, 'body')).not.toBe(signPayload('s', 1001, 'body'));
  });
});

describe('secrets', () => {
  it('seals and opens a secret', () => {
    const manager = new SecretsManager();
    manager.seal('rail.mpesa.key', 'sk_live_abc123');
    expect(manager.open('rail.mpesa.key')).toBe('sk_live_abc123');
  });

  it('never stores plaintext', () => {
    const manager = new SecretsManager();
    const sealed = manager.seal('api.key', 'plaintext-value');
    expect(JSON.stringify(sealed)).not.toContain('plaintext-value');
  });

  it('gives each secret its own data key', () => {
    const manager = new SecretsManager();
    const a = manager.seal('a', 'same-value');
    const b = manager.seal('b', 'same-value');
    // Identical plaintext, different ciphertext — no leakage between secrets.
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
  });

  it('detects tampering via the auth tag', () => {
    const manager = new SecretsManager();
    const sealed = manager.seal('a', 'value');
    const tampered = { ...sealed, ciphertext: sealed.ciphertext.replace(/^../, 'ff') };
    expect(() => manager.openSealed(tampered)).toThrow();
  });

  it('rotates the master key and keeps every secret readable', () => {
    const manager = new SecretsManager(randomBytes(32));
    manager.seal('a', 'value-a');
    manager.seal('b', 'value-b');

    const version = manager.rotateMasterKey();
    expect(version).toBe(2);
    expect(manager.open('a')).toBe('value-a');
    expect(manager.open('b')).toBe('value-b');
  });

  it('refuses an unknown secret', () => {
    expect(() => new SecretsManager().open('nope')).toThrow(SecretsError);
  });
});

describe('redaction', () => {
  it('redacts by key name', () => {
    const redacted = redact({
      clientId: 'client_a',
      client_secret: 'shhh',
      authorization: 'Bearer abc',
      nested: { api_key: 'k', safe: 'visible' },
    }) as Record<string, unknown>;

    expect(redacted.clientId).toBe('client_a');
    expect(redacted.client_secret).toBe('[redacted]');
    expect(redacted.authorization).toBe('[redacted]');
    expect((redacted.nested as Record<string, unknown>).api_key).toBe('[redacted]');
    expect((redacted.nested as Record<string, unknown>).safe).toBe('visible');
  });

  it('redacts by value pattern in free text', () => {
    expect(redact('payout to DE89370400440532013000 failed')).toContain('[redacted:iban]');
    expect(redact('used whsec_' + 'a'.repeat(48))).toContain('[redacted:webhook-secret]');
    expect(redact('header was Bearer abcdefghijklmnopqrstuvwxyz')).toContain('Bearer [redacted]');
    expect(redact('card 4111111111111111 declined')).toContain('[redacted:pan]');
  });

  it('walks arrays and stops at excessive depth', () => {
    expect(redact([{ password: 'x' }])).toEqual([{ password: '[redacted]' }]);

    let deep: unknown = 'bottom';
    for (let i = 0; i < 12; i++) deep = { next: deep };
    expect(JSON.stringify(redact(deep))).toContain('too-deep');
  });

  it('leaves ordinary values alone', () => {
    expect(redact({ amount: '10000', currency: 'EUR' })).toEqual({
      amount: '10000',
      currency: 'EUR',
    });
  });
});

describe('observability', () => {
  it('threads one trace id through nested spans', async () => {
    const tracer = new Tracer({ service: 'api' });

    const root = tracer.startSpan('POST /v1/transfers');
    await tracer.inSpan('compliance.screen', root, async () => undefined);
    await tracer.inSpan('ledger.post', root, async () => undefined);
    tracer.endSpan(root);

    const trace = tracer.trace(root.traceId);
    expect(trace).toHaveLength(3);
    expect(trace.filter((s) => s.parentSpanId === root.spanId)).toHaveLength(2);
    expect(new Set(trace.map((s) => s.traceId)).size).toBe(1);
  });

  it('marks a span errored and records the exception', async () => {
    const tracer = new Tracer();
    const root = tracer.startSpan('saga');

    await expect(
      tracer.inSpan('settle', root, async () => {
        throw new Error('chain timeout');
      }),
    ).rejects.toThrow('chain timeout');

    const settle = tracer.trace(root.traceId).find((s) => s.name === 'settle')!;
    expect(settle.status).toBe('error');
    expect(settle.events[0]!.name).toBe('exception');
    expect(settle.endedAt).toBeDefined();
  });

  it('redacts span attributes and log fields', () => {
    const tracer = new Tracer();
    const span = tracer.startSpan('request', undefined, { authorization: 'Bearer secret-token' });
    expect(span.attributes.authorization).toBe('[redacted]');

    const record = tracer.log('info', 'called with api_key', { api_key: 'k' }, span);
    expect(record.fields.api_key).toBe('[redacted]');
    expect(record.traceId).toBe(span.traceId);
  });

  it('collects RED metrics with percentiles', () => {
    const metrics = new Metrics();
    for (const ms of [10, 20, 30, 40, 500]) {
      metrics.increment('http_requests_total', { route: '/v1/transfers', status: '200' });
      metrics.observe('http_request_duration_ms', ms, { route: '/v1/transfers' });
    }
    metrics.increment('http_requests_total', { route: '/v1/transfers', status: '500' });

    const snapshot = metrics.snapshot();
    expect(snapshot.counters['http_requests_total{route="/v1/transfers",status="200"}']).toBe(5);
    expect(snapshot.counters['http_requests_total{route="/v1/transfers",status="500"}']).toBe(1);

    const histogram = snapshot.histograms['http_request_duration_ms{route="/v1/transfers"}']!;
    expect(histogram.count).toBe(5);
    expect(histogram.p50).toBe(30);
    expect(histogram.p95).toBe(500);
  });
});
