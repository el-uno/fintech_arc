import { createHash } from 'node:crypto';

export type Rail = 'sepa' | 'faster_payments' | 'nip' | 'mobile_money' | 'eft' | 'onchain';

export class IdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentifierError';
  }
}

function digitsFrom(seed: string, count: number): string {
  let out = '';
  let round = 0;
  while (out.length < count) {
    const hash = createHash('sha256').update(`${seed}:${round++}`).digest('hex');
    out += BigInt(`0x${hash}`)
      .toString()
      .slice(0, count - out.length);
  }
  return out.slice(0, count);
}

const IBAN_LENGTHS: Record<string, number> = {
  DE: 22,
  FR: 27,
  ES: 24,
  IT: 27,
  NL: 18,
  IE: 22,
  PT: 25,
};

function mod97(value: string): number {
  let remainder = 0;
  for (const char of value) {
    remainder = (remainder * 10 + Number(char)) % 97;
  }
  return remainder;
}

/** Letters map A=10 … Z=35 for the mod-97 check. */
function toNumeric(value: string): string {
  return value.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
}

export function ibanCheckDigits(countryCode: string, bban: string): string {
  const rearranged = toNumeric(`${bban}${countryCode}00`);
  const check = 98 - mod97(rearranged);
  return check.toString().padStart(2, '0');
}

export function isValidIban(iban: string): boolean {
  const compact = iban.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact)) return false;
  const expected = IBAN_LENGTHS[compact.slice(0, 2)];
  if (expected !== undefined && compact.length !== expected) return false;
  const rearranged = toNumeric(compact.slice(4) + compact.slice(0, 4));
  return mod97(rearranged) === 1;
}

export function generateIban(seed: string, countryCode = 'DE'): string {
  const length = IBAN_LENGTHS[countryCode];
  if (!length) throw new IdentifierError(`unsupported IBAN country: ${countryCode}`);
  const bban = digitsFrom(seed, length - 4);
  return `${countryCode}${ibanCheckDigits(countryCode, bban)}${bban}`;
}

const NUBAN_WEIGHTS = [3, 7, 3, 3, 7, 3, 3, 7, 3, 3, 7, 3];

export function nubanCheckDigit(bankCode: string, serial: string): string {
  const body = `${bankCode}${serial}`;
  if (body.length !== 12) {
    throw new IdentifierError('NUBAN requires a 3-digit bank code and 9-digit serial');
  }
  let total = 0;
  for (let i = 0; i < 12; i++) {
    total += Number(body[i]) * NUBAN_WEIGHTS[i]!;
  }
  const check = 10 - (total % 10);
  return String(check === 10 ? 0 : check);
}

export function isValidNuban(bankCode: string, accountNumber: string): boolean {
  if (!/^\d{10}$/.test(accountNumber)) return false;
  const serial = accountNumber.slice(0, 9);
  return nubanCheckDigit(bankCode, serial) === accountNumber[9];
}

export function generateNuban(seed: string, bankCode = '058'): string {
  const serial = digitsFrom(seed, 9);
  return `${serial}${nubanCheckDigit(bankCode, serial)}`;
}

export function generateSortCode(seed: string): string {
  const digits = digitsFrom(`${seed}:sort`, 6);
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}`;
}

export function generateUkAccountNumber(seed: string): string {
  return digitsFrom(`${seed}:ukacct`, 8);
}

/** Kenyan Safaricom range: +254 7XX XXX XXX. */
export function generateMobileMoneyMsisdn(seed: string, countryPrefix = '254'): string {
  return `+${countryPrefix}7${digitsFrom(`${seed}:msisdn`, 8)}`;
}

export function generateZarAccountNumber(seed: string): string {
  return digitsFrom(`${seed}:zar`, 10);
}

export function generateEvmAddress(seed: string): string {
  const hash = createHash('sha256').update(`${seed}:evm`).digest('hex');
  return `0x${hash.slice(0, 40)}`;
}

export interface IssuedIdentifier {
  readonly rail: Rail;
  readonly identifier: string;
  readonly metadata: Record<string, string>;
}

export function issueIdentifier(rail: Rail, seed: string): IssuedIdentifier {
  switch (rail) {
    case 'sepa':
      return { rail, identifier: generateIban(seed), metadata: { bic: 'ARCXDEM0XXX' } };
    case 'faster_payments':
      return {
        rail,
        identifier: generateUkAccountNumber(seed),
        metadata: { sortCode: generateSortCode(seed) },
      };
    case 'nip':
      return { rail, identifier: generateNuban(seed), metadata: { bankCode: '058' } };
    case 'mobile_money':
      return {
        rail,
        identifier: generateMobileMoneyMsisdn(seed),
        metadata: { provider: 'mpesa' },
      };
    case 'eft':
      return {
        rail,
        identifier: generateZarAccountNumber(seed),
        metadata: { branchCode: '250655' },
      };
    case 'onchain':
      return { rail, identifier: generateEvmAddress(seed), metadata: { network: 'base' } };
  }
}
