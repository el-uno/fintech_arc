# Runbook: reconciliation break

**Severity:** high · **SLA:** 1 hour (urgent case) · **Queue:** `reconciliation`

---

## Symptom

A reconciliation run has raised one or more breaks, and a case is open in the `reconciliation` queue. The case names the break kind, the reference, and both amounts.

You may also arrive here from a float-position alert: `covered: false` for a currency.

---

## What a break actually means

The ledger balancing proves Arc's books are **internally consistent**. It says nothing about whether they match reality. A payout the ledger records but the bank never made leaves the ledger perfectly balanced and the money missing.

A break is the gap between what Arc believes and what the outside world reports. It is never "just a data issue" until you have proved it is.

---

## Triage: identify the break kind

The case reason begins with the kind. Each has a different first question.

### `missing_external` — the ledger says it happened, the rail does not

**Most urgent.** Either the payout never left, or the rail's report is late or lost.

1. Check the transfer's saga result: did `payout` complete, and is there a `railReference`?
2. Query the rail with that reference.
   - **Rail has it** → the rail's statement feed is lagging. Note it on the case, re-run reconciliation after the next feed, close when matched.
   - **Rail has never seen it** → the payout did not happen. **Do not re-send.** Go to _Resolution A_.
3. Confirm the beneficiary has not been paid by another route before doing anything else.

### `missing_internal` — the rail moved money Arc never recorded

Money left an account without a journal. Treat as a potential unauthorised movement until proven otherwise.

1. Is the reference recognisable as an Arc transfer id? If not, escalate to security immediately.
2. If it is, check whether the saga failed _after_ the rail accepted — a compensation that unwound the ledger while the payout stood.
3. Go to _Resolution B_.

### `amount_mismatch` — both agree it happened, they disagree on how much

Usually a fee the rail deducted that Arc did not model, or a rounding difference.

1. Compare `internal` and `external` on the case. The `difference` field is signed: positive means Arc recorded more than the rail moved.
2. If the difference equals a known rail fee, the fee model is wrong — raise a defect and go to _Resolution C_.
3. If it is a single minor unit, check the rounding policy at that boundary before assuming it is trivial. A systematic one-unit difference across many transfers is a real loss.

### `duplicate_external` — the rail reports two movements for one journal

**A double payout until proven otherwise.**

1. Confirm both external ids are distinct and both settled.
2. If genuinely paid twice, open a recall with the rail immediately — recall windows are short.
3. Go to _Resolution B_ for the unrecorded leg.

### `currency_mismatch`

Should be impossible: the database has a composite foreign key binding an entry's currency to its account. If you see this, the external feed is mis-mapped. Do not post anything. Escalate to engineering.

---

## Resolution

Every resolution is a **new journal**. Never edit or delete an entry — the database will refuse (`ledger_entry is append-only`), and the refusal is the point.

### Resolution A — the ledger recorded a payout that never happened

Reverse the payout journal. The obligation to the beneficiary returns, and the float goes back up.

```
Dr  asset.float.bank.<CCY>            <amount>
  Cr  liability.in_transit.<CCY>      <amount>
```

Then decide with the business whether to retry the payout or refund the sender. Both are ordinary flows; neither is a reconciliation action.

### Resolution B — money moved that the ledger never recorded

Post the movement, then investigate why it was missing.

```
Dr  liability.in_transit.<CCY>        <amount>
  Cr  asset.float.bank.<CCY>          <amount>
```

If it was a double payout, the second leg is a loss until recalled:

```
Dr  expense.recovery.<CCY>            <amount>
  Cr  asset.float.bank.<CCY>          <amount>
```

### Resolution C — amounts disagree

Post the difference to the account that explains it. A rail fee Arc did not model:

```
Dr  expense.rail_fee.<CCY>            <difference>
  Cr  asset.float.bank.<CCY>          <difference>
```

**Never post a difference to a suspense account and move on.** Suspense balances are where reconciliation breaks go to be forgotten.

---

## Closing the case

1. Post the correcting journal and record its id on the case.
2. Re-run reconciliation for the affected source and window. Confirm the break is gone and no new one appeared.
3. Check `floatPosition` for the currency: `covered` should be true.
4. Decide the case with a note naming the root cause, not just the action taken.

`reconciliation` is not a four-eyes queue, so one decision closes it. Any break above a material threshold should still get a second reviewer by convention.

---

## Verification

```bash
pnpm dev
```

Confirms the whole stack still posts a balanced corridor transfer end to end.

For the affected currency specifically, check that the trial balance is zero **and** the float position is covered. Those are different questions and a break can leave one healthy while the other is not.

---

## Prevention

- A break that recurs on the same rail is a fee-model or feed-mapping defect, not an ops problem. Raise it as a defect.
- Recurring `missing_external` inside the settlement window means the window is set too short for that rail; tune `settlementWindowMs` rather than triaging noise.
- Every break kind here has a test in `services/ledger/test/reconciliation.test.ts`. A new break kind should arrive with one.
