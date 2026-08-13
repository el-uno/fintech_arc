import { PrismaClient } from '../../../prisma/generated/client/index.js';

export { PrismaClient };
export type { Prisma } from '../../../prisma/generated/client/index.js';

/**
 * A Prisma client that may be the root client or a transaction-scoped one.
 * Stores accept this so the same code works inside and outside a transaction.
 */
export type PrismaLike = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends' | '$use'
>;

/** True when the client can open a transaction, i.e. it is not already inside one. */
export function canTransact(db: PrismaLike): db is PrismaLike & Pick<PrismaClient, '$transaction'> {
  return typeof (db as { $transaction?: unknown }).$transaction === 'function';
}

let shared: PrismaClient | undefined;

export function createPrismaClient(url?: string): PrismaClient {
  if (url) return new PrismaClient({ datasources: { db: { url } } });
  return new PrismaClient();
}

export function prisma(): PrismaClient {
  shared ??= createPrismaClient();
  return shared;
}

export async function disconnect(): Promise<void> {
  await shared?.$disconnect();
  shared = undefined;
}

/** Truncate every table. Test and sandbox-reset use only. */
export async function truncateAll(client: PrismaClient): Promise<void> {
  await client.$executeRawUnsafe(
    'TRUNCATE ledger_entry, ledger_hold, journal, ledger_account, outbox_event, processed_event, idempotency_key CASCADE',
  );
}
