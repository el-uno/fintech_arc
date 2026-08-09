import { z } from 'zod';

/**
 * Every event in Arc travels in the same envelope.
 *
 * The envelope is what makes the system auditable: correlation across a whole
 * corridor transfer, causation between steps, and a tenant on every record so
 * that partner data can never leak across boundaries.
 */
export const EventEnvelopeSchema = z.object({
  /** Unique per event. Consumers use this to deduplicate — delivery is at-least-once. */
  id: z.string().uuid(),

  /** Dotted event name, e.g. `transfer.settled`. Matches a key in the catalogue. */
  type: z.string().min(1),

  /** Schema version for this event type. Consumers must tolerate unknown newer versions. */
  version: z.number().int().positive(),

  /** Partner/tenant scope. Every event belongs to exactly one tenant. */
  tenantId: z.string().min(1),

  /** Shared by every event emitted while servicing one inbound request or saga. */
  correlationId: z.string().uuid(),

  /** The event that directly caused this one. Absent for events that start a chain. */
  causationId: z.string().uuid().optional(),

  /** Emission time, ISO-8601 UTC. Not a business timestamp — those live in the payload. */
  occurredAt: z.string().datetime(),

  /** The service that emitted it. */
  source: z.string().min(1),

  /** Idempotency key of the originating request, when there was one. */
  idempotencyKey: z.string().min(1).optional(),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/** A full event: envelope plus a type-specific payload. */
export type DomainEvent<TType extends string = string, TPayload = unknown> = EventEnvelope & {
  type: TType;
  payload: TPayload;
};

/**
 * Money on the wire. Mirrors `@arc/money`'s `toJSON` — a string of minor units,
 * never a JSON number. Contracts enforce this at the boundary so a partner
 * cannot round-trip an amount through a float and hand it back changed.
 */
export const MoneySchema = z.object({
  amount: z.string().regex(/^-?\d+$/, 'amount must be an integer string of minor units'),
  currency: z.string().min(3).max(5),
});

export type MoneyPayload = z.infer<typeof MoneySchema>;
