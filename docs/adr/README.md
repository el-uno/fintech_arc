# Architecture decision records

ADRs live on the documentation site, which is canonical for architecture and decisions:

→ **[arc-doc.mintlify.site/decisions](https://arc-doc.mintlify.site/decisions)**

| ADR                                                                               | Decision                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [0001](https://arc-doc.mintlify.site/decisions/0001-money-as-integer-minor-units) | Money as integer minor units, enforced by lint          |
| [0002](https://arc-doc.mintlify.site/decisions/0002-modular-monolith)             | Modular monolith over microservices                     |
| [0003](https://arc-doc.mintlify.site/decisions/0003-double-entry-ledger)          | Double-entry accounting, enforced by the database       |
| [0004](https://arc-doc.mintlify.site/decisions/0004-chain-abstraction)            | A chain-agnostic driver with a deterministic simulator  |
| [0005](https://arc-doc.mintlify.site/decisions/0005-idempotency-strategy)         | Idempotency keys, and why a reused key is a conflict    |
| [0006](https://arc-doc.mintlify.site/decisions/0006-saga-over-two-phase-commit)   | A compensating saga rather than two-phase commit        |
| [0007](https://arc-doc.mintlify.site/decisions/0007-multi-tenancy-model)          | Row-level tenancy with environment-prefixed credentials |

Source: [`apps/docs-site/decisions/`](../../apps/docs-site/decisions/)
