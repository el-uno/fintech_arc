import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export class AuthError extends Error {
  constructor(
    readonly code:
      | 'unknown_client'
      | 'invalid_secret'
      | 'invalid_signature'
      | 'stale_timestamp'
      | 'replayed_request'
      | 'insufficient_scope'
      | 'expired_token'
      | 'revoked',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export type Scope =
  | 'quotes:read'
  | 'transfers:write'
  | 'transfers:read'
  | 'accounts:read'
  | 'accounts:write'
  | 'webhooks:manage'
  | 'admin';

export interface ApiClient {
  readonly clientId: string;
  readonly tenantId: string;
  readonly secretHash: string;
  readonly scopes: readonly Scope[];
  readonly revoked: boolean;
  readonly environment: 'sandbox' | 'live';
}

export interface AccessToken {
  readonly token: string;
  readonly clientId: string;
  readonly tenantId: string;
  readonly scopes: readonly Scope[];
  readonly expiresAt: Date;
  readonly environment: 'sandbox' | 'live';
}

export function hashSecret(secret: string, salt: string): string {
  return createHmac('sha256', salt).update(secret).digest('hex');
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface AuthOptions {
  now?: () => Date;
  tokenTtlMs?: number;
  /** How far a signed request's timestamp may drift from now. */
  signatureToleranceMs?: number;
  salt?: string;
}

export interface SignedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly timestamp: number;
  readonly signature: string;
  readonly clientId: string;
  /**
   * Per-request random value. Without it, two identical requests in the same
   * millisecond produce the same signature and the second is indistinguishable
   * from a replay — which would reject a legitimate idempotent retry.
   */
  readonly nonce?: string;
}

/**
 * OAuth2 client-credentials plus HMAC request signing.
 *
 * Tokens prove who you are; signatures prove the request body was not altered
 * in transit and is not a replay.
 */
export class AuthService {
  private readonly clients = new Map<string, ApiClient>();
  private readonly tokens = new Map<string, AccessToken>();
  private readonly seenSignatures = new Map<string, number>();
  private readonly now: () => Date;
  private readonly tokenTtlMs: number;
  private readonly toleranceMs: number;
  private readonly salt: string;

  constructor(options: AuthOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.tokenTtlMs = options.tokenTtlMs ?? 3_600_000;
    this.toleranceMs = options.signatureToleranceMs ?? 300_000;
    this.salt = options.salt ?? 'arc-static-salt';
  }

  registerClient(input: {
    clientId: string;
    tenantId: string;
    secret: string;
    scopes: readonly Scope[];
    environment?: 'sandbox' | 'live';
  }): ApiClient {
    const client: ApiClient = {
      clientId: input.clientId,
      tenantId: input.tenantId,
      secretHash: hashSecret(input.secret, this.salt),
      scopes: input.scopes,
      revoked: false,
      environment: input.environment ?? 'sandbox',
    };
    this.clients.set(client.clientId, client);
    return client;
  }

  revokeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) throw new AuthError('unknown_client', `no such client: ${clientId}`);
    this.clients.set(clientId, { ...client, revoked: true });
    for (const [token, issued] of this.tokens) {
      if (issued.clientId === clientId) this.tokens.delete(token);
    }
  }

  /** Exchange client credentials for a scoped, expiring token. */
  issueToken(clientId: string, secret: string, requested?: readonly Scope[]): AccessToken {
    const client = this.clients.get(clientId);
    if (!client) throw new AuthError('unknown_client', `no such client: ${clientId}`);
    if (client.revoked) throw new AuthError('revoked', `client ${clientId} is revoked`);

    if (!constantTimeEquals(hashSecret(secret, this.salt), client.secretHash)) {
      throw new AuthError('invalid_secret', 'client secret does not match');
    }

    // A client can never receive a scope it was not granted.
    const granted = requested
      ? requested.filter((scope) => client.scopes.includes(scope))
      : client.scopes;

    if (requested && granted.length !== requested.length) {
      const denied = requested.filter((s) => !client.scopes.includes(s));
      throw new AuthError('insufficient_scope', `client was not granted: ${denied.join(', ')}`);
    }

    const token: AccessToken = {
      token: randomBytes(24).toString('hex'),
      clientId: client.clientId,
      tenantId: client.tenantId,
      scopes: granted,
      expiresAt: new Date(this.now().getTime() + this.tokenTtlMs),
      environment: client.environment,
    };
    this.tokens.set(token.token, token);
    return token;
  }

  verifyToken(raw: string, required?: Scope): AccessToken {
    const token = this.tokens.get(raw);
    if (!token) throw new AuthError('unknown_client', 'unknown access token');
    if (token.expiresAt.getTime() <= this.now().getTime()) {
      this.tokens.delete(raw);
      throw new AuthError('expired_token', 'access token has expired');
    }
    if (required && !token.scopes.includes(required) && !token.scopes.includes('admin')) {
      throw new AuthError('insufficient_scope', `token lacks scope ${required}`);
    }
    return token;
  }

  /** Canonical string a signature is computed over. */
  canonicalString(request: Omit<SignedRequest, 'signature' | 'clientId'>): string {
    return [
      request.method.toUpperCase(),
      request.path,
      String(request.timestamp),
      request.nonce ?? '',
      createHmac('sha256', '').update(request.body).digest('hex'),
    ].join('\n');
  }

  sign(secret: string, request: Omit<SignedRequest, 'signature' | 'clientId'>): string {
    return createHmac('sha256', secret).update(this.canonicalString(request)).digest('hex');
  }

  /**
   * Verify a signed request.
   *
   * Rejects a stale timestamp and a replayed signature, in that order: an old
   * request is refused before it can consume replay-cache space.
   */
  verifySignature(request: SignedRequest, secret: string): void {
    const client = this.clients.get(request.clientId);
    if (!client) throw new AuthError('unknown_client', `no such client: ${request.clientId}`);
    if (client.revoked) throw new AuthError('revoked', `client ${request.clientId} is revoked`);

    const drift = Math.abs(this.now().getTime() - request.timestamp);
    if (drift > this.toleranceMs) {
      throw new AuthError('stale_timestamp', `timestamp is ${drift}ms from now`);
    }

    const expected = this.sign(secret, request);
    if (!constantTimeEquals(expected, request.signature)) {
      throw new AuthError('invalid_signature', 'signature does not match');
    }

    if (this.seenSignatures.has(request.signature)) {
      throw new AuthError('replayed_request', 'this signature has already been used');
    }
    this.seenSignatures.set(request.signature, request.timestamp);
    this.pruneReplayCache();
  }

  private pruneReplayCache(): void {
    const cutoff = this.now().getTime() - this.toleranceMs;
    for (const [signature, at] of this.seenSignatures) {
      if (at < cutoff) this.seenSignatures.delete(signature);
    }
  }
}
