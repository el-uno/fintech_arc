# Arc docs site

Mintlify documentation site for [Arc](https://github.com/el-uno/fintech_arc): a simulation of
cross-border stablecoin and fiat infrastructure for the EU↔Africa corridor.

Four tabs, 39 pages. The code Arc documents lives in a separate repository; this one holds only
the site.

| Tab | Covers |
| --- | --- |
| **Guide** | Orientation, quickstart, and the stablecoin/corridor primer with cited research |
| **Architecture** | The six contexts, ledger, chain layer, saga, compliance, testing, flows, ADRs |
| **IRL Scenarios** | Seven engineering narratives: symptom, diagnosis, the mechanism that prevents it |
| **Practice** | Four interview question banks with worked answers, plus two self-check quizzes |

## Design

"Terminal corridor": dark-first and technical. Charcoal ground (`#0D1117`), one electric-teal
accent (`#2DD4BF`), amber (`#F59E0B`) for known gaps and warnings. Mono is structural: eyebrows,
account codes, ledger figures. No glow, no gradients on text.

All of it is in `style.css`. The custom classes used throughout the MDX:

| Class | Meaning |
| --- | --- |
| `.arc-eyebrow` | Mono kicker above a page title (`--amber`, `--dim` variants) |
| `.arc-claim` | A load-bearing claim the code enforces, teal left rule |
| `.arc-gap` | A known limitation, stated rather than hidden, amber left rule |
| `.arc-symptom` | The opening symptom of an IRL scenario |
| `.arc-stats` / `.arc-stat` | Cited-figure strips |
| `.arc-cite` | Source line at the foot of a research page |

Keeping `.arc-claim` and `.arc-gap` used honestly is the site's main editorial rule: teal means
there is a test or a database constraint behind it, amber means there is not.

## Deploying

This site lives inside the Arc code repository at `apps/docs-site`, so documentation and the code
it describes move in the same commit.

1. In the Mintlify dashboard, connect the deployment to `el-uno/fintech_arc`.
2. Set the **content directory** to `apps/docs-site` (where `docs.json` lives).
3. Deploys run on push to `main`.

### Why it lives here

It previously lived in a standalone repo, `el-uno/fintech_doc`. That repo could not see the code,
so the phase status table and the "what is not here yet" blocks silently went three phases stale
while the build moved on. Co-locating makes the docs reviewable in the same pull request as the
change that invalidates them.

### It must not disturb the Arc build

Four constraints keep `pnpm verify` green. All four are satisfied today; breaking any one of them
will cause trouble:

| Constraint | Why |
| --- | --- |
| **No `package.json` in this folder** | `pnpm-workspace.yaml` globs `apps/*`. pnpm only adopts a directory as a package if it contains a `package.json`, so leaving it out keeps this folder invisible to the workspace. Mintlify uses the global `mint` CLI and does not need one. |
| **`apps/docs-site` stays in `.prettierignore`** | `format:check` runs `prettier --check .`, and Prettier's markdown parser mangles MDX. It has already silently deleted sections of this file once. |
| **Never add this path to `tsconfig.json` references** | `typecheck` is `tsc -b` against an explicit reference list, with no globs. Staying off the list keeps it out. |
| **No `test/` directory or `.test.ts` files here** | Vitest globs `apps/*/test/**/*.test.ts`. |

`boundaries` (`depcruise packages services`) never scans `apps/`, and every ESLint rule block is
scoped to `**/*.ts` or `**/*.cjs`, so neither gate sees this folder at all.

One side effect worth knowing: CI runs the full suite, including Postgres and Redis, on every push
to `main`, so a docs-only commit still runs the whole gate.

## Local preview

```bash
npm i -g mint
```

```bash
mint dev
```

Serves on `http://localhost:3000`. `mint broken-links` checks internal links.

## Editorial conventions

- Money is always integer minor units in prose and tables. `10000n` is €100.00.
- Account codes appear as structured strings: `asset.float.bank.EUR`.
- Every research figure carries the body it came from and the date, so it can be re-checked
  rather than inherited. Secondary-aggregator figures are flagged as such in
  `primer/bibliography.mdx`.
- Pages describing planned work say so at the top. Nothing claims a capability the repo lacks.
- **No em dashes in prose.** The few that remain are inside code fences, where they are literal
  output (ESLint messages, code comments, a Mermaid label) and must stay verbatim.

## Keeping it accurate

Phase status appears in two places: `index.mdx` and `architecture/overview.mdx`. The pages most
likely to go stale as the build progresses:

| When this lands | Update |
| --- | --- |
| Prisma-backed `LedgerStore` | `architecture/ledger.mdx`, `architecture/testing.mdx` gaps |
| Holds wired at quote time | `architecture/ledger.mdx`, `architecture/settlement-saga.mdx` |
| Real `CompliancePort` replaces `AlwaysApprove` | `architecture/compliance.mdx` |
| Phase 6 to 8 | Status tables, `decisions/index.mdx` planned ADRs |
