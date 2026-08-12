import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

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
      '@arc/chain': src('chain'),
      '@arc/product': fileURLToPath(new URL('./services/product/src/index.ts', import.meta.url)),
      '@arc/ledger': fileURLToPath(new URL('./services/ledger/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'services/*/src/**'],
    },
  },
});
