-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');

-- CreateEnum
CREATE TYPE "EntryDirection" AS ENUM ('debit', 'credit');

-- CreateEnum
CREATE TYPE "HoldStatus" AS ENUM ('active', 'released', 'captured');

-- CreateTable
CREATE TABLE "ledger_account" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "currency" TEXT NOT NULL,
    "overdraft_floor" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal" (
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reference_id" TEXT NOT NULL,
    "description" TEXT,
    "correlation_id" UUID,
    "posted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entry" (
    "id" UUID NOT NULL,
    "journal_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "direction" "EntryDirection" NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_hold" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "HoldStatus" NOT NULL DEFAULT 'active',
    "reference_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "ledger_hold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_account_code_key" ON "ledger_account"("code");

-- CreateIndex
CREATE INDEX "ledger_account_tenant_idx" ON "ledger_account"("tenant_id", "type");

-- CreateIndex
CREATE INDEX "ledger_account_currency_idx" ON "ledger_account"("currency");

-- CreateIndex
CREATE INDEX "journal_reference_idx" ON "journal"("reference_id");

-- CreateIndex
CREATE INDEX "journal_tenant_idx" ON "journal"("tenant_id", "posted_at");

-- CreateIndex
CREATE INDEX "ledger_entry_account_idx" ON "ledger_entry"("account_id", "currency");

-- CreateIndex
CREATE INDEX "ledger_entry_journal_idx" ON "ledger_entry"("journal_id");

-- CreateIndex
CREATE INDEX "ledger_hold_account_idx" ON "ledger_hold"("account_id", "status");

-- CreateIndex
CREATE INDEX "ledger_hold_reference_idx" ON "ledger_hold"("reference_id");

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_hold" ADD CONSTRAINT "ledger_hold_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
