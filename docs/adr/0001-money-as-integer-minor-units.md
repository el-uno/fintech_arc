# ADR 0001 — Money as integer minor units

**Status:** Accepted · Phase 0

## Context

Arc's central invariant is that every journal balances exactly: debits equal credits, with no tolerance. The system also handles assets with wildly different scales — EUR at 2 decimals, USDC at 6, ERC-20 tokens at 18.

## Decision

Every monetary value is an integer count of the currency's minor units, held as a `bigint`, paired with a currency code. No `number` appears in any monetary API. Rounding happens only through `divRound`, which requires an explicit mode, and the residual is always returned so it can be posted to a rounding account.

Enforced by ESLint: `parseFloat`, `toFixed`, `Math.round/floor/ceil`, and fractional numeric literals are errors in source.

## Consequences

**Good.** Arithmetic is exact and associative. The balance invariant needs no epsilon. 18-decimal assets work without special-casing. Rounding is a stated policy at each boundary rather than an emergent property, and residuals stay auditable.

**Costs.** Every amount must be converted at the system edge — JSON carries minor units as _strings_, never numbers, since most clients parse a JSON number as a float. Callers must choose a rounding mode explicitly, which is more verbose but is the point.

## Alternatives

_Floats_ — rejected; binary fractions cannot represent most decimal money values, and the errors accumulate exactly in FX, fee, and batching paths, poisoning reconciliation.

_Decimal library / Postgres `NUMERIC`_ — viable and used widely. Rejected because integers are faster, map directly onto both ISO-4217 minor units and on-chain base units, and remove any question of where precision is configured.
