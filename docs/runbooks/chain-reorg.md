# Runbook: chain reorg

**Severity:** medium · **Symptom:** a `reorg` event names transactions Arc had seen mined

---

## What happened

The chain replaced blocks Arc had already observed. Transactions in those blocks are back in the mempool with no block height and no confirmations.

This is **normal chain behaviour**, not an incident, unless a transfer was already treated as settled.

Depth expectations by chain:

| Chain    | Finality depth | Modelled max reorg |
| -------- | -------------- | ------------------ |
| base     | 10             | 1                  |
| ethereum | 12             | 2                  |
| tron     | 19             | 2                  |
| solana   | 32             | 3                  |
| polygon  | 128            | 5                  |

---

## Triage

1. Take `revertedTransactions` from the reorg event.
2. For each, find the transfer that owns it.
3. Ask the only question that matters: **did the saga treat any of them as settled?**

### If none were settled

Nothing to do. The transactions are back in the mempool and will be re-mined. The saga is still waiting on finality, which is exactly the behaviour finality depth exists to produce.

Record the reorg depth. A depth beyond the modelled maximum for that chain means the config is wrong, not the chain.

### If a transfer was settled and then reverted

This is a defect: the finality check let a transaction through below the chain's finality depth.

1. Do **not** post corrections yet. Wait for the transaction to be re-mined — it usually is, with the same hash.
2. If it is re-mined and reaches finality, the ledger is correct after all. Note it and raise the defect.
3. If it is **not** re-mined, the settlement did not happen. Reverse the settlement journal per [reconciliation break](reconciliation-break.md) _Resolution A_, and reconcile the chain source for the window.

---

## Verification

- Every affected transfer is `completed` or `compensated`.
- Chain reconciliation is clean for the window covering the reorg.
- Trial balance zero; float position covered for the settlement asset.

---

## Prevention

The finality depth per chain is the single control here. It is configured in `packages/chain/src/types.ts` and should be set from the chain's own guidance, not from how fast it feels.

Reorg handling is tested deterministically: `forceReorg(depth)` rolls a mined transaction back to `pending` and the suite asserts it loses its block, its confirmations, and is then re-mined.
