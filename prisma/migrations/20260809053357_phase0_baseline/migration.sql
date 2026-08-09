-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'delivered', 'failed');

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "tenant_id" TEXT NOT NULL,
    "correlation_id" UUID NOT NULL,
    "causation_id" UUID,
    "source" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_event" (
    "handler_name" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_event_pkey" PRIMARY KEY ("handler_name","event_id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "key" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_code" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "outbox_due_idx" ON "outbox_event"("status", "available_at");

-- CreateIndex
CREATE INDEX "outbox_correlation_idx" ON "outbox_event"("correlation_id");

-- CreateIndex
CREATE INDEX "outbox_tenant_idx" ON "outbox_event"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "processed_event_idx" ON "processed_event"("event_id");

-- CreateIndex
CREATE INDEX "idempotency_tenant_idx" ON "idempotency_key"("tenant_id");

-- CreateIndex
CREATE INDEX "idempotency_expiry_idx" ON "idempotency_key"("expires_at");

-- AddForeignKey
ALTER TABLE "processed_event" ADD CONSTRAINT "processed_event_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "outbox_event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
