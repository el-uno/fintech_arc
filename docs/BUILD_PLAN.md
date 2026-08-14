# Arc — Build & Execution Plan

**Arc** is a simulation of a cross-border stablecoin + fiat infrastructure business operating the **EU↔Africa corridor**. It serves consumers and enterprises directly, and exposes the same rails to fintechs and exchanges through a white-label **Last Mile API**.

This document is the build plan: what gets built, in what order, and what "done" means at each step. It is a plan, not a spec — the specs live in the ADRs and service docs produced during Phase 0 and 1.

---

## 1. Decisions already made

| Decision           | Choice                                           | Why                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language / runtime | TypeScript on Node 22                            | One language across services, SDKs, and the docs site. Strongest ecosystem for fintech-shaped APIs.                                                                                                      |
| Topology           | Modular monolith in a pnpm monorepo              | Six bounded contexts with hard internal boundaries and an event bus between them. Reads as microservices in the architecture docs; runs with one command for anyone who clones the repo.                 |
| Chain layer        | Simulated chain adapter                          | A chain-agnostic driver interface backed by a deterministic in-process simulator: block times, confirmations, reorgs, gas, failed and stuck transactions. No external node, fully testable, CI-friendly. |
| Datastore          | Postgres 16 + Prisma                             | Ledger correctness needs real transactions and constraints.                                                                                                                                              |
| Queues / jobs      | BullMQ on Redis                                  | Payout execution, settlement polling, webhook delivery, reconciliation runs.                                                                                                                             |
| API surface        | Fastify + Zod, OpenAPI 3.1 generated from schema | One source of truth feeding docs, SDKs, and the sandbox.                                                                                                                                                 |

### Money representation

All monetary values are integer minor units (`bigint`) plus an ISO-4217 or asset code. No floats anywhere, enforced by lint rule and a custom `Money` type. This is non-negotiable and is checked in Phase 0.

---

## 2. Domain model — the corridor

The business being simulated:

- A Nigerian importer needs to pay an EU supplier in EUR. They fund a **virtual NGN account**, Arc swaps to **USDC**, settles on-chain in seconds, and pays out via **SEPA Instant** to the supplier's IBAN.
- A Kenyan diaspora worker in Germany sends EUR to a **KES mobile-money wallet**. Same rails, consumer surface.
- A partner exchange embeds Arc's **Last Mile API** to offer its own users EUR payouts without building bank integrations.

Three flows, one set of rails. Every service below exists to serve those three.

### Currencies and rails simulated

| Currency    | In-rail                            | Out-rail                        |
| ----------- | ---------------------------------- | ------------------------------- |
| EUR         | SEPA Credit Transfer, SEPA Instant | SEPA Instant                    |
| GBP         | Faster Payments                    | Faster Payments                 |
| USD         | —                                  | — (settlement/quote asset only) |
| NGN         | Local bank transfer (NIP)          | NIP                             |
| KES         | Mobile money (M-Pesa-shaped)       | Mobile money                    |
| GHS         | Local bank / mobile money          | Mobile money                    |
| ZAR         | EFT                                | EFT                             |
| USDC / USDT | On-chain deposit                   | On-chain withdrawal             |

Chains simulated: Ethereum, Base, Polygon, Solana, Tron — differing block times, finality depths, and fee models, all behind one adapter.

---

## 3. Repository layout

```
fintech_arc/
├── README.md                    # the front door — architecture, diagrams, quickstart
├── docs/
│   ├── BUILD_PLAN.md            # this file
│   ├── architecture/
│   │   ├── overview.md          # C4 context + container diagrams
│   │   ├── ledger.md            # double-entry model, invariants, worked examples
│   │   ├── settlement.md        # the saga, state machines, failure modes
│   │   ├── compliance.md        # KYC/KYB tiers, sanctions, AML rule engine
│   │   └── security.md          # authn/z, secrets, idempotency, replay defence
│   ├── flows/                   # step-by-step walkthroughs, one per flow
│   │   ├── consumer-remittance.md
│   │   ├── enterprise-payout.md
│   │   ├── partner-last-mile.md
│   │   └── reversal.md
│   ├── adr/                     # numbered architecture decision records
│   ├── runbooks/                # stuck settlement, reorg, reconciliation break
│   └── api/                     # generated OpenAPI + hand-written guides
├── apps/
│   ├── api/                     # the gateway — HTTP surface, composition root
│   ├── worker/                  # background job runner
│   ├── console/                 # partner + ops console (thin, read-mostly)
│   └── docs-site/               # published API docs & SDK reference
├── services/
│   ├── product/                 # onboarding, wallets, transfers, history, notifications
│   ├── movement/                # payouts, bank adapters, chain orchestration, settlement, reversals
│   ├── risk/                    # KYC/KYB, sanctions, AML rules, monitoring, review queues
│   ├── ledger/                  # balances, double-entry, fees, reconciliation, reporting
│   ├── platform/                # auth, webhooks, observability, secrets, jobs
│   └── partner/                 # partner onboarding, sandbox, keys, usage & billing
├── packages/
│   ├── contracts/               # shared types, events, Zod schemas — the seam
│   ├── money/                   # Money type, FX, rounding, minor units
│   ├── chain/                   # chain-agnostic adapter + deterministic simulator
│   ├── bus/                     # in-process event bus with outbox semantics
│   ├── sdk-node/                # generated + hand-polished partner SDK
│   └── testkit/                 # fixtures, scenario builders, property generators
├── sandbox/
│   ├── scenarios/               # named, replayable end-to-end scenarios
│   └── seed/                    # deterministic seed data for the demo tenant
└── ops/
    ├── docker-compose.yml
    └── grafana/                 # dashboards as code
```

**Boundary enforcement:** services may only import from `packages/*` and from their own directory. Cross-service calls go through `packages/contracts` interfaces or the event bus. Enforced by `dependency-cruiser` in CI — a violation fails the build. This is what makes "modular monolith" a real claim rather than a label.

---

## 4. The six contexts

### 4.1 Product services

| Service                 | Responsibility                                                                                         | Key surface                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| **Onboarding**          | Signup, identity capture, tier assignment, personal vs enterprise account creation                     | `POST /v1/accounts`, tier state machine |
| **Wallets / accounts**  | Multi-currency virtual accounts, IBAN/NUBAN/mobile-money handle issuance, available vs pending balance | `POST /v1/virtual-accounts`             |
| **Transfers**           | Quote → confirm → execute. Internal, on-chain, and fiat-out variants                                   | `POST /v1/quotes`, `POST /v1/transfers` |
| **Transaction history** | Unified activity feed across fiat and chain legs, with cursor pagination and per-leg status            | `GET /v1/transactions`                  |
| **Notifications**       | Email/SMS/push simulation, templating, delivery log, per-user preferences                              | Event consumer                          |

Personal and enterprise account surfaces differ in limits, approval requirements (enterprise payouts support maker-checker), and available products — same underlying account model, different policy.

### 4.2 Money movement services

| Service                      | Responsibility                                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Payout execution**         | Rail selection, batching, retry with exponential backoff, idempotency, dead-letter handling                                                    |
| **Bank integrations**        | Adapter per rail (SEPA, FPS, NIP, M-Pesa, EFT) with a simulator per adapter that injects realistic latency, cut-off windows, and failure codes |
| **Stablecoin orchestration** | Quote → swap → chain selection → broadcast → confirm. Chain-agnostic; picks chain by cost, speed, and liquidity                                |
| **Settlement confirmation**  | Confirmation-depth tracking per chain, reorg detection and rollback, finality events                                                           |
| **Reversal handling**        | Returns, recalls, chargebacks, failed-payout unwinds — every one produces compensating ledger entries, never a deletion                        |

The end-to-end transfer is a **saga** with an explicit state machine and a compensating action for every step. Documented in `docs/architecture/settlement.md` with the diagram.

### 4.3 Risk & compliance services

| Service                    | Responsibility                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **KYC / KYB**              | Tiered verification (Tier 0–3), document simulation, UBO graph for business accounts, periodic re-verification |
| **Sanctions**              | Fuzzy name screening against a synthetic list, with false-positive handling and an audit trail on every hit    |
| **AML rules**              | Declarative rule engine — structuring, velocity, unusual corridor, round-tripping, counterparty concentration  |
| **Transaction monitoring** | Real-time pre-transaction scoring plus post-transaction batch review; risk scores feed limits                  |
| **Manual review queues**   | Case management, assignment, SLA timers, four-eyes approval, full decision audit log                           |

Compliance is a **blocking pre-condition** on money movement, not a side channel. A transfer cannot leave `PENDING_COMPLIANCE` without a recorded decision.

### 4.4 Ledger & finance

The core. Everything else is an interface onto this.

- **Double-entry accounting** — every movement is a balanced set of entries; debits equal credits, always. Enforced by a DB constraint and a property-based test suite.
- **Balances** — derived from entries, never mutated directly. Available/pending/reserved computed from entry state.
- **Fee calculation** — FX spread, corridor fee, network fee, partner rev-share. Each fee is its own ledger entry against its own account.
- **Reconciliation** — three-way: internal ledger vs bank-adapter statements vs on-chain transaction history. Breaks raise cases, not silent drift.
- **Reporting** — trial balance, corridor P&L, float position by currency, partner statements, regulatory-shaped extracts.

**Invariants, tested continuously:**

1. The sum of all entries in any journal is zero.
2. No account crosses its configured overdraft floor.
3. Every external movement has exactly one matching ledger transaction.
4. Replaying the full event log reproduces balances byte-identically.

### 4.5 Infrastructure & platform

| Service                | Responsibility                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Auth**               | OAuth2 client-credentials for partners, session auth for consumers, scoped API keys, HMAC request signing, mTLS-shaped simulation     |
| **API gateway**        | Routing, per-tenant rate limiting, idempotency-key handling, request/response validation, versioning                                  |
| **Webhook delivery**   | At-least-once with signed payloads, exponential retry, replay endpoint, per-partner delivery log                                      |
| **Observability**      | OpenTelemetry traces spanning the full saga, structured logs with correlation IDs, RED + business metrics, Grafana dashboards as code |
| **Secrets management** | Envelope encryption, key rotation, no plaintext secrets at rest, redaction in every log path                                          |
| **Background jobs**    | Queue definitions, scheduling, concurrency limits, poison-message handling, job observability                                         |

### 4.6 Partner platform

| Service                | Responsibility                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Partner onboarding** | Fintech/exchange KYB, contract tiers, go-live checklist                                                       |
| **API docs & SDKs**    | Generated from OpenAPI, published docs site, Node SDK (hand-polished), REST examples in 4 languages           |
| **Sandbox**            | Fully isolated tenant, deterministic scenario triggers (magic amounts force specific failures), instant reset |
| **Webhook management** | Endpoint registration, secret rotation, event subscription, delivery inspection, manual replay                |
| **Billing & usage**    | Metering per API call and per transaction, tiered pricing, invoice generation, rev-share to the ledger        |

---

## 5. Execution phases

Each phase ends with a working, demonstrable state and a merged PR. Nothing is "done" without tests and docs.

### Phase 0 — Foundations (build first, everything depends on it)

- pnpm workspace, TypeScript strict, ESLint, Prettier, Vitest, CI on GitHub Actions.
- `packages/money` — the `Money` type, minor units, FX application, rounding policy. Property tests.
- `packages/contracts` — event catalogue and shared Zod schemas.
- `packages/bus` — in-process event bus with transactional outbox semantics.
- Postgres + Redis via Docker Compose; Prisma baseline migration.
- `dependency-cruiser` boundary rules wired into CI.
- **Done when:** `pnpm install && pnpm dev` boots, CI green, boundary violations fail the build.

### Phase 1 — The ledger

- Double-entry schema: accounts, journals, entries, chart of accounts.
- Posting engine with balance-or-reject semantics.
- Balance projection (available / pending / reserved).
- Property-based invariant suite.
- `docs/architecture/ledger.md` with worked examples of a full corridor transfer's entries.
- **Done when:** you cannot construct an unbalanced journal through any public API, and the invariant suite passes under randomized load.

### Phase 2 — Accounts & virtual accounts

- Account model, personal vs enterprise, tier policy.
- Multi-currency virtual account issuance with realistic identifier formats per rail.
- Onboarding flow, ledger accounts provisioned per virtual account.
- **Done when:** a user can be onboarded and hold balances in EUR, NGN, KES, and USDC.

### Phase 3 — Chain layer

- `packages/chain`: driver interface — `broadcast`, `getTransaction`, `getConfirmations`, `estimateFee`, `subscribeBlocks`.
- Deterministic simulator: per-chain block time, finality depth, fee model, seeded reorgs, stuck and dropped transactions.
- Confirmation tracker and finality events.
- **Done when:** a seeded run reproduces the same block/reorg sequence every time, and reorg rollback is proven by test.

### Phase 4 — Money movement

- Bank rail adapters with per-rail simulators (latency, cut-offs, failure codes).
- Quote engine: FX rate, spread, fees, expiry.
- The settlement saga: quote → compliance → reserve → swap → chain settle → confirm → fiat payout → complete, with compensation at every step.
- Reversal handling producing compensating entries.
- **Done when:** all three corridor flows complete end to end, and every injected failure at every saga step unwinds to a balanced ledger.

### Phase 5 — Risk & compliance

- KYC/KYB tiering, document simulation, UBO graph.
- Sanctions screening with fuzzy match and audit trail.
- AML rule engine with the five rule families.
- Review queue with assignment, SLA, and four-eyes approval.
- Compliance gate wired as a hard pre-condition in the saga.
- **Done when:** a structuring pattern and a sanctions hit each block a transfer and open a case with a complete audit trail.

### Phase 6 — Platform

- Auth: partner OAuth2 + scoped keys + HMAC signing; consumer sessions.
- Gateway: rate limits, idempotency keys, validation, versioning.
- Webhook delivery with signing, retries, and replay.
- Observability: OTel traces across the full saga, Grafana dashboards.
- Secrets: envelope encryption and rotation.
- **Done when:** one trace shows a complete corridor transfer across all six contexts, and a replayed webhook is provably idempotent.

### Phase 7 — Partner platform & Last Mile API

- Partner onboarding and KYB.
- Sandbox tenant with deterministic scenario triggers and reset.
- OpenAPI publication, docs site, Node SDK.
- Usage metering and billing, rev-share posted to the ledger.
- **Done when:** a partner can sign up in the sandbox and complete a EUR→KES payout using only the published SDK and docs.

### Phase 8 — Reconciliation, reporting, ops

- Three-way reconciliation with break detection and case creation.
- Trial balance, corridor P&L, float position, partner statements.
- Runbooks for stuck settlement, reorg, and reconciliation break.
- **Done when:** an injected break is detected, cased, and resolvable by following the runbook alone.

### Phase 9 — Documentation consolidation

Rescoped. The original plan assumed the repo README and `docs/` would be the only
documentation surface. A full documentation site was built in parallel at
`apps/docs-site`, published to <https://arc-doc.mintlify.site>, which already
covers the primer, architecture, flows, decisions and worked scenarios.

Re-doing that as a "public polish" pass would have duplicated it. Worse, two
surfaces explaining the same system **drift**, and a reader cannot tell which
copy is stale.

**The decision: the documentation site is canonical** for architecture and
decisions. The repo keeps only what belongs next to code.

- `docs/architecture/*.md` are **pointers** at the corresponding site page.
- `docs/adr/README.md` indexes all seven ADRs on the site.
- **Runbooks stay in the repo** — they are operational and reference code paths
  directly.
- `docs/BUILD_PLAN.md` stays here; it is a record of the build, not a product doc.

**Enforced, not just intended.** `pnpm run docs:check` fails the build if a repo
stub grows back into a second copy, if the site navigation references a missing
page, or if a page is unreachable from the navigation. It runs in `pnpm verify`
and in CI.

**Closed in this phase:** five missing ADRs (double-entry, chain abstraction,
idempotency, saga vs 2PC, multi-tenancy), and three architecture pages that
existed only in the repo (reconciliation, platform/security, partner platform).

---

## 6. Documentation plan

The README is the product. Someone landing on the repo should understand the business, the architecture, and how to run it within two minutes.

**README structure:**

1. One-paragraph pitch — what Arc is, what corridor, who it serves.
2. The three flows, each as a single sentence.
3. **Architecture diagram** — C4 container level, Mermaid, rendering natively on GitHub.
4. Quickstart — clone, `pnpm install`, `pnpm dev`, run a scenario, see the ledger entries.
5. The six contexts, table form, each linking to its deep-dive doc.
6. **Sequence diagram** of a full corridor transfer.
7. Repository map.
8. What is simulated vs real, stated plainly and up front.

**Diagrams (all Mermaid, all in-repo, all rendering on GitHub):**

- C4 context and container diagrams.
- Settlement saga state machine.
- Sequence diagram per flow: consumer remittance, enterprise payout, partner Last Mile, reversal.
- Ledger entry-relationship diagram.
- Compliance decision flow.
- Webhook delivery and retry lifecycle.

**Per-flow step-by-step walkthroughs** (`docs/flows/`) — each numbered step names the service, the API call, the events emitted, and the exact ledger entries produced. These are the documents that make the system legible.

**ADRs** for: modular-monolith choice, double-entry model, chain abstraction, idempotency strategy, saga vs 2PC, money representation, multi-tenancy model.

**Runbooks** written as if on-call: symptom, diagnosis, resolution, prevention.

---

## 7. Testing strategy

| Layer          | What it covers                                                      |
| -------------- | ------------------------------------------------------------------- |
| Unit           | Money arithmetic, fee calculation, rule evaluation                  |
| Property-based | Ledger invariants under randomized transaction sequences            |
| Integration    | Each service against a real Postgres                                |
| Contract       | Every event and API schema, versioned                               |
| Scenario (E2E) | The named corridor scenarios, run in CI                             |
| Chaos          | Injected failure at every saga step, asserting ledger balance holds |

The chaos suite is the one that matters most: **for every failure point in the settlement saga, the ledger must end balanced.** That single assertion is the strongest correctness claim this project can make.

---

## 8. Sequencing and dependencies

```
Phase 0 ──▶ Phase 1 ──▶ Phase 2 ──┬──▶ Phase 4 ──▶ Phase 5 ──▶ Phase 6 ──▶ Phase 7 ──▶ Phase 8
                                  │       ▲
                        Phase 3 ──┴───────┘
```

Phase 3 (chain) can be built in parallel with Phase 2 — it only depends on Phase 0. Everything else is strictly sequential; the ledger must exist before money can move, and money must move before there is anything to monitor or bill.

Docs are written _within_ each phase, not deferred. Phase 9 is polish and the README, not the first time documentation is considered.

---

## 9. Non-goals

Stated plainly so the repo is never misread:

- **Not a real financial system.** No real funds, no real bank connections, no real chain. Every external integration is a simulator.
- **Not production-hardened.** No HSM, no real KMS, no PCI scope, no regulatory licensing.
- **Not investment or compliance advice.** The AML rules and sanctions logic are illustrative, not a compliance program.
- The sanctions list is synthetic. No real persons or entities appear anywhere in the data.

This is stated in the README's first screen, not buried.

---

## 10. Open items

- Repo visibility is currently not public — that's a GitHub setting change and yours to make.
- Whether the partner console gets a real UI or stays API + docs only.
- Whether to add a second SDK language (Python) in Phase 7.
