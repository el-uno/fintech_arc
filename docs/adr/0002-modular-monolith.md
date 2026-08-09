# ADR 0002 — Modular monolith over microservices

**Status:** Accepted · Phase 0

## Context

Arc models roughly thirty services across six domains. It is a public showcase repository: someone who clones it should reach a working corridor transfer quickly, while the architecture should still demonstrate real distributed-system concerns — sagas, compensating actions, at-least-once delivery.

## Decision

One deployable, six bounded contexts under `services/`, communicating only through the event catalogue in `@arc/contracts` or by publishing on the in-process bus. No context imports another's code.

`dependency-cruiser` enforces this in CI. A cross-context import fails the build.

## Consequences

**Good.** `pnpm install && pnpm dev` is the whole setup. Contexts stay independently extractable, because the boundary is mechanically checked rather than merely intended. The transactional outbox gives real at-least-once semantics, so the saga and idempotency work is genuine rather than simulated away.

**Costs.** No true network partition between contexts, so failure modes involving partial network availability are modelled rather than experienced. Everything scales together. The event bus is in-process — durable, via the outbox table, but not a broker.

## Alternatives

_True microservices with Docker Compose_ — the most realistic, and the most impressive in diagrams. Rejected because heavy local setup works against a repo whose main job is to be read and run by strangers.

_Plain monolith with an extraction path documented_ — fastest, but demonstrates the least. The boundary enforcement here is the interesting part; removing it removes the point.
