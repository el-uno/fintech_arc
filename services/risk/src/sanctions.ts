/*
 * Similarity scores are not money.
 *
 * Jaro-Winkler works on 0-1 fractions, and the prefix weight (0.1) and default
 * match threshold (0.9) are algorithm constants, not amounts. Nothing in this
 * file produces or consumes a monetary value, so the no-fractional-literal rule
 * is disabled here rather than distorting the algorithm to satisfy it.
 */
/* eslint-disable no-restricted-syntax */

export type ListedEntityType = 'individual' | 'entity' | 'vessel';

export interface ListedEntity {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly type: ListedEntityType;
  readonly programme: string;
  readonly countries: readonly string[];
}

/**
 * Synthetic list. Every name here is invented for this simulation — no real
 * person, entity or vessel appears, and none of these correspond to any actual
 * sanctions programme.
 */
export const SYNTHETIC_SANCTIONS_LIST: readonly ListedEntity[] = [
  {
    id: 'SYN-0001',
    name: 'Vorlan Krestomayer',
    aliases: ['V. Krestomayer', 'Vorlan K.'],
    type: 'individual',
    programme: 'SYNTHETIC-ALPHA',
    countries: ['ZZ'],
  },
  {
    id: 'SYN-0002',
    name: 'Blentari Holdings Zeta',
    aliases: ['Blentari Zeta', 'BHZ Group'],
    type: 'entity',
    programme: 'SYNTHETIC-ALPHA',
    countries: ['ZZ', 'XX'],
  },
  {
    id: 'SYN-0003',
    name: 'Ondrimo Falquist',
    aliases: ['O. Falquist'],
    type: 'individual',
    programme: 'SYNTHETIC-BETA',
    countries: ['XX'],
  },
  {
    id: 'SYN-0004',
    name: 'Quorvex Maritime Sarn',
    aliases: ['Quorvex Sarn', 'QM Sarn'],
    type: 'vessel',
    programme: 'SYNTHETIC-BETA',
    countries: ['YY'],
  },
  {
    id: 'SYN-0005',
    name: 'Illiana Threndolf',
    aliases: ['I. Threndolf', 'Illiana T.'],
    type: 'individual',
    programme: 'SYNTHETIC-GAMMA',
    countries: ['ZZ'],
  },
];

export function normaliseName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaro(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const window = Math.max(0, Math.trunc(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - window);
    const end = Math.min(i + window + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  const t = transpositions / 2;
  return (matches / a.length + matches / b.length + (matches - t) / matches) / 3;
}

/** Jaro-Winkler: favours strings agreeing on their first characters. */
export function jaroWinkler(a: string, b: string): number {
  const base = jaro(a, b);
  if (base === 0) return 0;

  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++;

  return base + prefix * 0.1 * (1 - base);
}

/** Token-aware similarity, so word order does not defeat a match. */
export function nameSimilarity(a: string, b: string): number {
  const left = normaliseName(a);
  const right = normaliseName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;

  const whole = jaroWinkler(left, right);

  const leftTokens = left.split(' ');
  const rightTokens = right.split(' ');
  let total = 0;
  for (const token of leftTokens) {
    let best = 0;
    for (const other of rightTokens) {
      const score = jaroWinkler(token, other);
      if (score > best) best = score;
    }
    total += best;
  }
  const tokenScore = total / leftTokens.length;

  return Math.max(whole, tokenScore);
}

export interface SanctionsMatch {
  readonly entity: ListedEntity;
  readonly matchedOn: string;
  readonly score: number;
}

export interface ScreeningOptions {
  /** Score at or above which a match is reported, 0–1. */
  threshold?: number;
  list?: readonly ListedEntity[];
}

export interface SanctionsResult {
  readonly query: string;
  readonly matches: readonly SanctionsMatch[];
  readonly threshold: number;
  readonly screenedAt: Date;
  readonly listSize: number;
}

export class SanctionsScreener {
  private readonly threshold: number;
  private readonly list: readonly ListedEntity[];

  constructor(options: ScreeningOptions = {}) {
    this.threshold = options.threshold ?? 0.9;
    this.list = options.list ?? SYNTHETIC_SANCTIONS_LIST;
  }

  screen(name: string, now = new Date()): SanctionsResult {
    const matches: SanctionsMatch[] = [];

    for (const entity of this.list) {
      let best: SanctionsMatch | undefined;
      for (const candidate of [entity.name, ...entity.aliases]) {
        const score = nameSimilarity(name, candidate);
        if (score >= this.threshold && (!best || score > best.score)) {
          best = { entity, matchedOn: candidate, score };
        }
      }
      if (best) matches.push(best);
    }

    matches.sort((a, b) => b.score - a.score);

    return {
      query: name,
      matches,
      threshold: this.threshold,
      screenedAt: now,
      listSize: this.list.length,
    };
  }

  isHit(name: string): boolean {
    return this.screen(name).matches.length > 0;
  }
}
