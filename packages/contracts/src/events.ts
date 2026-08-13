import { z } from 'zod';
import { MoneySchema, type DomainEvent } from './envelope.js';

export const AccountOpenedSchema = z.object({
  accountId: z.string().uuid(),
  ownerId: z.string().uuid(),
  kind: z.enum(['personal', 'enterprise']),
  countryCode: z.string().length(2),
  tier: z.number().int().min(0).max(3),
});

export const VirtualAccountIssuedSchema = z.object({
  virtualAccountId: z.string().uuid(),
  accountId: z.string().uuid(),
  currency: z.string().min(3).max(5),
  rail: z.enum(['sepa', 'faster_payments', 'nip', 'mobile_money', 'eft', 'onchain']),
  identifier: z.string().min(1),
});

export const TransferRequestedSchema = z.object({
  transferId: z.string().uuid(),
  quoteId: z.string().uuid(),
  sourceAccountId: z.string().uuid(),
  sendAmount: MoneySchema,
  receiveAmount: MoneySchema,
  corridor: z.string().regex(/^[A-Z]{2}-[A-Z]{2}$/, 'corridor must be like DE-KE'),
});

export const ComplianceDecidedSchema = z.object({
  subjectId: z.string().uuid(),
  subjectType: z.enum(['account', 'transfer', 'counterparty']),
  decision: z.enum(['approved', 'rejected', 'review']),
  reasons: z.array(z.string()),
  riskScore: z.number().int().min(0).max(100),
  reviewerId: z.string().uuid().optional(),
});

export const CaseOpenedSchema = z.object({
  caseId: z.string().uuid(),
  subjectId: z.string().uuid(),
  queue: z.enum(['kyc', 'sanctions', 'aml', 'reconciliation']),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  slaExpiresAt: z.string().datetime(),
});

export const SettlementStartedSchema = z.object({
  transferId: z.string().uuid(),
  chain: z.enum(['ethereum', 'base', 'polygon', 'solana', 'tron']),
  asset: z.string().min(3).max(5),
  amount: MoneySchema,
});

export const SettlementConfirmedSchema = z.object({
  transferId: z.string().uuid(),
  chain: z.string().min(1),
  txHash: z.string().min(1),
  confirmations: z.number().int().nonnegative(),
  networkFee: MoneySchema,
});

export const PayoutCompletedSchema = z.object({
  transferId: z.string().uuid(),
  payoutId: z.string().uuid(),
  rail: z.string().min(1),
  amount: MoneySchema,
});

export const ReversalRequestedSchema = z.object({
  transferId: z.string().uuid(),
  reason: z.enum(['recall', 'return', 'failed_payout', 'compliance_hold', 'chargeback']),
  failedStep: z.string().min(1),
});

export const JournalPostedSchema = z.object({
  journalId: z.string().uuid(),
  kind: z.enum(['transfer', 'fee', 'fx', 'reversal', 'rounding', 'settlement']),
  entries: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        direction: z.enum(['debit', 'credit']),
        amount: MoneySchema,
      }),
    )
    .min(2, 'a journal needs at least two entries to balance'),
  referenceId: z.string().uuid(),
});

export const WebhookDeliveryAttemptedSchema = z.object({
  deliveryId: z.string().uuid(),
  endpointId: z.string().uuid(),
  eventId: z.string().uuid(),
  attempt: z.number().int().positive(),
  outcome: z.enum(['delivered', 'failed', 'exhausted']),
  responseStatus: z.number().int().optional(),
});

export const EVENT_CATALOGUE = {
  'account.opened': AccountOpenedSchema,
  'virtual_account.issued': VirtualAccountIssuedSchema,
  'transfer.requested': TransferRequestedSchema,
  'compliance.decided': ComplianceDecidedSchema,
  'case.opened': CaseOpenedSchema,
  'settlement.started': SettlementStartedSchema,
  'settlement.confirmed': SettlementConfirmedSchema,
  'payout.completed': PayoutCompletedSchema,
  'reversal.requested': ReversalRequestedSchema,
  'journal.posted': JournalPostedSchema,
  'webhook.delivery_attempted': WebhookDeliveryAttemptedSchema,
} as const;

export type EventType = keyof typeof EVENT_CATALOGUE;

export type PayloadOf<T extends EventType> = z.infer<(typeof EVENT_CATALOGUE)[T]>;

export const EVENT_TYPES = Object.keys(EVENT_CATALOGUE) as EventType[];

export function isEventType(value: string): value is EventType {
  return Object.prototype.hasOwnProperty.call(EVENT_CATALOGUE, value);
}

export function schemaFor<T extends EventType>(type: T): (typeof EVENT_CATALOGUE)[T] {
  return EVENT_CATALOGUE[type];
}

export type AnyDomainEvent = {
  [T in EventType]: DomainEvent<T, PayloadOf<T>>;
}[EventType];
