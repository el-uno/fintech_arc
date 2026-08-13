import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Load .env so `pnpm verify` runs the database tests locally instead of skipping
// them. CI sets DATABASE_URL directly and ARC_REQUIRE_DB=1 to make a skip fatal.
const envPath = fileURLToPath(new URL('./.env', import.meta.url));
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key!] === undefined) {
      process.env[key!] = raw!.replace(/^["']|["']$/g, '');
    }
  }
}

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Resolve workspace packages to source so tests run without a build step.
    // Production resolution uses each package's `exports` field against dist.
    alias: {
      '@arc/money': src('money'),
      '@arc/contracts': src('contracts'),
      '@arc/bus': src('bus'),
      '@arc/db': src('db'),
      '@arc/chain': src('chain'),
      '@arc/product': fileURLToPath(new URL('./services/product/src/index.ts', import.meta.url)),
      '@arc/movement': fileURLToPath(new URL('./services/movement/src/index.ts', import.meta.url)),
      '@arc/risk': fileURLToPath(new URL('./services/risk/src/index.ts', import.meta.url)),
      '@arc/platform': fileURLToPath(new URL('./services/platform/src/index.ts', import.meta.url)),
      '@arc/partner': fileURLToPath(new URL('./services/partner/src/index.ts', import.meta.url)),
      '@arc/sdk': fileURLToPath(new URL('./packages/sdk-node/src/index.ts', import.meta.url)),
      '@arc/api': fileURLToPath(new URL('./apps/api/src/router.ts', import.meta.url)),
      '@arc/ledger': fileURLToPath(new URL('./services/ledger/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'services/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
    ],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'services/*/src/**'],
    },
  },
});
