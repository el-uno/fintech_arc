import { z } from 'zod';

export const EventEnvelopeSchema = z.object({
  id: z.string().uuid(),
  type: z.string().min(1),
  version: z.number().int().positive(),
  tenantId: z.string().min(1),
  correlationId: z.string().uuid(),
  causationId: z.string().uuid().optional(),
  occurredAt: z.string().datetime(),
  source: z.string().min(1),
  idempotencyKey: z.string().min(1).optional(),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export type DomainEvent<TType extends string = string, TPayload = unknown> = EventEnvelope & {
  type: TType;
  payload: TPayload;
};

export const MoneySchema = z.object({
  amount: z.string().regex(/^-?\d+$/, 'amount must be an integer string of minor units'),
  currency: z.string().min(3).max(5),
});

export type MoneyPayload = z.infer<typeof MoneySchema>;
