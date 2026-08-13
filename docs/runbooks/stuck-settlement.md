# Runbook: stuck settlement

**Severity:** high · **Symptom:** a transfer sits in `settle` and never reaches finality

---

## Symptom

A transfer's saga has not progressed past `settle`. The trace shows the chain span open, or the saga returned `compensated` with `failedStep: settle` and a reason containing `finality`.

---

## Immediate check: is money at risk?

**No.** The saga compensates on failure: reserve and swap are unwound and the sender is made whole. Confirm rather than assume:

1. Find the transfer's journals by reference id.
2. There should be a reversal journal for every journal posted before the failure.
3. The sender's balance should equal what it was before the transfer.
4. The trial balance should be zero in every currency.

If any of those is false, this is no longer a stuck settlement — go to the [reconciliation break](reconciliation-break.md) runbook.

---

## Diagnose

Read the chain transaction by its hash from the saga result.

| Status                           | Meaning                  | Action                                                               |
| -------------------------------- | ------------------------ | -------------------------------------------------------------------- |
| `pending`                        | broadcast, never mined   | fee too low, or mempool eviction — see _Stuck in mempool_            |
| `dropped`                        | evicted from the mempool | safe to re-broadcast; nothing was spent                              |
| `failed`                         | mined and reverted       | **the fee was spent.** Investigate the revert reason before retrying |
| `included` but few confirmations | still settling           | wait; check the chain's finality depth                               |
| `confirmed`                      | it did settle            | the saga's finality check is wrong — escalate to engineering         |

Finality depths differ sharply: Base needs 10 confirmations at 2s, Polygon needs 128 at 2s. A Polygon transfer that looks stuck at 60 confirmations is simply not finished.

---

## Stuck in mempool

1. Check the current network fee against the fee quoted at broadcast. If the network has repriced, the transaction may never be mined at its original fee.
2. Re-broadcast using the **same idempotency key**. The chain driver returns the original hash rather than creating a second transaction — this is safe and is the point of the key.
3. If it remains unmined beyond the rail's own timeout, let the saga compensate and re-quote. Re-quoting is correct: the original quote has expired and the rate has moved.

---

## After a reorg

A reorg rolls a mined transaction back to `pending` and returns it to the mempool. This is expected on Polygon, rare on Base.

The saga's finality check is what protects against acting on a settlement that later disappears. **Never treat `included` as settled** — only `confirmed` past the chain's finality depth.

If a transfer was marked settled and then reorged, that is a defect in the confirmation tracker. Escalate, and reconcile the chain source for the affected window.

---

## Verification

- The transfer is either `completed` or `compensated`, not left in flight.
- Trial balance zero in every currency.
- `floatPosition` covered for the settlement asset.
- The chain source reconciles clean for the window.

---

## Prevention

- Fee estimation that is systematically low shows up as repeated `pending` transfers on one chain. Compare quoted against realised fees.
- Chain selection weights speed against cost; a corridor that keeps sticking may simply be on the wrong chain for its size.
