import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';

export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsError';
  }
}

export interface SealedSecret {
  readonly id: string;
  readonly name: string;
  /** The data key, itself encrypted under the master key. */
  readonly wrappedKey: string;
  readonly ciphertext: string;
  readonly iv: string;
  readonly authTag: string;
  readonly keyVersion: number;
  readonly createdAt: Date;
}

const ALGORITHM = 'aes-256-gcm';

function encrypt(key: Buffer, plaintext: Buffer): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decrypt(key: Buffer, ciphertext: Buffer, iv: Buffer, tag: Buffer): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export interface SecretsOptions {
  now?: () => Date;
}

/**
 * Envelope encryption.
 *
 * Each secret gets its own data key; the data key is encrypted under a master
 * key. Rotating the master key therefore rewraps data keys rather than
 * re-encrypting every secret — and a leaked data key exposes exactly one secret.
 */
export class SecretsManager {
  private readonly masterKeys = new Map<number, Buffer>();
  private readonly secrets = new Map<string, SealedSecret>();
  private currentVersion = 1;
  private readonly now: () => Date;

  constructor(masterKey?: Buffer, options: SecretsOptions = {}) {
    this.masterKeys.set(1, masterKey ?? randomBytes(32));
    this.now = options.now ?? (() => new Date());
  }

  get keyVersion(): number {
    return this.currentVersion;
  }

  seal(name: string, plaintext: string): SealedSecret {
    const dataKey = randomBytes(32);
    const master = this.masterKeys.get(this.currentVersion)!;

    const payload = encrypt(dataKey, Buffer.from(plaintext, 'utf8'));
    const wrapped = encrypt(master, dataKey);

    const sealed: SealedSecret = {
      id: randomUUID(),
      name,
      wrappedKey: `${wrapped.iv.toString('hex')}:${wrapped.tag.toString('hex')}:${wrapped.ciphertext.toString('hex')}`,
      ciphertext: payload.ciphertext.toString('hex'),
      iv: payload.iv.toString('hex'),
      authTag: payload.tag.toString('hex'),
      keyVersion: this.currentVersion,
      createdAt: this.now(),
    };

    this.secrets.set(name, sealed);
    return sealed;
  }

  open(name: string): string {
    const sealed = this.secrets.get(name);
    if (!sealed) throw new SecretsError(`no such secret: ${name}`);
    return this.openSealed(sealed);
  }

  openSealed(sealed: SealedSecret): string {
    const master = this.masterKeys.get(sealed.keyVersion);
    if (!master) throw new SecretsError(`master key version ${sealed.keyVersion} is not available`);

    const [ivHex, tagHex, ctHex] = sealed.wrappedKey.split(':');
    const dataKey = decrypt(
      master,
      Buffer.from(ctHex!, 'hex'),
      Buffer.from(ivHex!, 'hex'),
      Buffer.from(tagHex!, 'hex'),
    );

    return decrypt(
      dataKey,
      Buffer.from(sealed.ciphertext, 'hex'),
      Buffer.from(sealed.iv, 'hex'),
      Buffer.from(sealed.authTag, 'hex'),
    ).toString('utf8');
  }

  /**
   * Rotate the master key and rewrap every data key. Old versions are retained
   * so secrets sealed before rotation stay readable.
   */
  rotateMasterKey(next?: Buffer): number {
    const version = this.currentVersion + 1;
    this.masterKeys.set(version, next ?? randomBytes(32));

    for (const [name, sealed] of this.secrets) {
      const plaintext = this.openSealed(sealed);
      this.currentVersion = version;
      this.secrets.set(name, { ...this.seal(name, plaintext), id: sealed.id });
      this.currentVersion = version;
    }

    this.currentVersion = version;
    return version;
  }

  names(): string[] {
    return [...this.secrets.keys()];
  }
}

const SENSITIVE_KEYS =
  /^(secret|password|passwd|token|access_token|refresh_token|api_key|apikey|authorization|client_secret|private_key|card|cvv|pan|iban|account_number|ssn)$/i;

const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, '[redacted:iban]'],
  [/\bwhsec_[a-f0-9]{32,}\b/g, '[redacted:webhook-secret]'],
  [/\bBearer\s+[A-Za-z0-9._-]{16,}\b/g, 'Bearer [redacted]'],
  [/\b\d{13,19}\b/g, '[redacted:pan]'],
];

/**
 * Redact secrets from anything about to be logged.
 *
 * Applied by key name and by value pattern: a token is caught whether it sits
 * under `authorization` or is embedded in a free-text message.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[redacted:too-deep]';

  if (typeof value === 'string') {
    let out = value;
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
    return out;
  }

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = SENSITIVE_KEYS.test(key) ? '[redacted]' : redact(item, depth + 1);
    }
    return result;
  }

  return value;
}
