-- Ledger invariants, enforced by the database.
--
-- The posting engine in services/ledger already refuses to write an unbalanced
-- journal. Everything below enforces the same rules a second time, at the only
-- layer no caller can route around. An invariant that depends on every future
-- developer remembering to use the right class is not an invariant.

-- ---------------------------------------------------------------------------
-- 1. Shape of an entry.
-- ---------------------------------------------------------------------------

-- Amounts are always positive; `direction` carries the sign. A negative debit
-- and a positive credit would be two ways to say the same thing, and two
-- representations of one fact is how ledgers drift.
ALTER TABLE "ledger_entry"
  ADD CONSTRAINT "ledger_entry_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "ledger_hold"
  ADD CONSTRAINT "ledger_hold_amount_positive" CHECK ("amount" > 0);

-- An overdraft floor is how far *below* zero an account may go, so it can never
-- be positive.
ALTER TABLE "ledger_account"
  ADD CONSTRAINT "ledger_account_floor_non_positive" CHECK ("overdraft_floor" <= 0);

-- ---------------------------------------------------------------------------
-- 2. An entry must be denominated in its account's currency.
--
-- Declared as a composite foreign key rather than a trigger: the database will
-- not even represent a EUR entry against a KES account.
-- ---------------------------------------------------------------------------

ALTER TABLE "ledger_account"
  ADD CONSTRAINT "ledger_account_id_currency_key" UNIQUE ("id", "currency");

ALTER TABLE "ledger_entry"
  ADD CONSTRAINT "ledger_entry_account_currency_fkey"
  FOREIGN KEY ("account_id", "currency")
  REFERENCES "ledger_account" ("id", "currency")
  ON DELETE RESTRICT;

ALTER TABLE "ledger_hold"
  ADD CONSTRAINT "ledger_hold_account_currency_fkey"
  FOREIGN KEY ("account_id", "currency")
  REFERENCES "ledger_account" ("id", "currency")
  ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 3. Every journal balances, per currency.
--
-- DEFERRABLE INITIALLY DEFERRED is what makes this workable: the check runs at
-- COMMIT, not per row, so a journal can be inserted one entry at a time and is
-- judged only once it is complete. A transaction that leaves any journal
-- unbalanced in any currency cannot commit.
--
-- Balance is checked per currency independently. An FX journal has a EUR half
-- and a USDC half, and each must close on its own — offsetting one against the
-- other would be adding quantities of different things.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "assert_journal_balanced"() RETURNS trigger AS $$
DECLARE
  target_journal uuid;
  offending RECORD;
BEGIN
  target_journal := COALESCE(NEW."journal_id", OLD."journal_id");

  SELECT
    "currency",
    SUM(CASE WHEN "direction" = 'debit'  THEN "amount" ELSE 0 END) AS debits,
    SUM(CASE WHEN "direction" = 'credit' THEN "amount" ELSE 0 END) AS credits
  INTO offending
  FROM "ledger_entry"
  WHERE "journal_id" = target_journal
  GROUP BY "currency"
  HAVING SUM(CASE WHEN "direction" = 'debit'  THEN "amount" ELSE 0 END)
      <> SUM(CASE WHEN "direction" = 'credit' THEN "amount" ELSE 0 END)
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'journal % does not balance in %: debits % vs credits % (difference %)',
      target_journal, offending."currency", offending.debits, offending.credits,
      offending.debits - offending.credits
      USING ERRCODE = 'check_violation';
  END IF;

  -- A journal must have at least two entries; one entry can never balance, but
  -- a journal with no entries at all would pass the sum check vacuously.
  IF (SELECT COUNT(*) FROM "ledger_entry" WHERE "journal_id" = target_journal) < 2 THEN
    RAISE EXCEPTION 'journal % has fewer than two entries', target_journal
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ledger_entry_journal_balanced"
  AFTER INSERT OR UPDATE OR DELETE ON "ledger_entry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "assert_journal_balanced"();

-- ---------------------------------------------------------------------------
-- 4. Entries are append-only.
--
-- A correction is a new, opposing journal — never an edit or a delete. This is
-- what keeps the record of what happened separate from the record of what was
-- meant to happen, which is the property an auditor actually cares about.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "reject_ledger_entry_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'ledger_entry is append-only: post a reversing journal instead of % on entry %',
    TG_OP, COALESCE(OLD."id", NEW."id")
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_entry_append_only"
  BEFORE UPDATE OR DELETE ON "ledger_entry"
  FOR EACH ROW EXECUTE FUNCTION "reject_ledger_entry_mutation"();
