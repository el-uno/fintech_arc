import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The rule set that matters most here is `no-floating-money`.
 *
 * Arc represents every monetary value as an integer count of minor units. The
 * failure mode this guards against is a single careless line — one `parseFloat`,
 * one `toFixed`, one `0.1` literal — that introduces binary-fraction error into
 * a ledger whose central invariant is that debits equal credits *exactly*.
 *
 * That error is ~1e-17. It will not fail a test with small fixtures. It surfaces
 * months later as a reconciliation break nobody can trace. Static enforcement
 * catches it at the only cheap moment: when it is written.
 */
const noFloatingMoney = {
  'no-restricted-globals': [
    'error',
    { name: 'parseFloat', message: 'Floats cannot represent money exactly. Use Money.parse().' },
  ],
  'no-restricted-properties': [
    'error',
    {
      object: 'Number',
      property: 'parseFloat',
      message: 'Floats cannot represent money exactly. Use Money.parse().',
    },
    {
      object: 'Math',
      property: 'round',
      message: 'Use divRound() from @arc/money — rounding must state its mode.',
    },
    {
      object: 'Math',
      property: 'floor',
      message: "Use divRound(n, d, 'FLOOR') from @arc/money.",
    },
    {
      object: 'Math',
      property: 'ceil',
      message: "Use divRound(n, d, 'CEIL') from @arc/money.",
    },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: 'Literal[raw=/^[0-9]*\\.[0-9]+$/]',
      message:
        'Fractional number literal. Monetary values are bigint minor units; ' +
        'use Money.parse() or an integer basis-point value.',
    },
    {
      selector: "MemberExpression > Identifier[name='toFixed']",
      message: 'toFixed() formats a float. Use Money.toDecimalString().',
    },
  ],
};

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', 'prisma/generated/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { sourceType: 'module', ecmaVersion: 2023 },
    },
    rules: {
      ...noFloatingMoney,
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'warn',
    },
  },

  {
    // Bounded-context isolation, second layer.
    //
    // dependency-cruiser catches relative cross-service imports, but a
    // package-name import (`@arc/ledger`) resolves through node_modules to a
    // dist path that does not exist until build time, so it slips past
    // resolution. ESLint matches the raw import string and needs no resolution,
    // which closes that gap. Both layers are needed; neither alone is enough.
    //
    // Shared packages (@arc/money, @arc/contracts, @arc/bus, @arc/chain) stay
    // allowed — they are the seam contexts are meant to share.
    files: ['services/*/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@arc/ledger',
              message:
                'Contexts must not import each other. Communicate through @arc/contracts or the event bus.',
            },
            {
              name: '@arc/movement',
              message:
                'Contexts must not import each other. Communicate through @arc/contracts or the event bus.',
            },
            {
              name: '@arc/risk',
              message:
                'Contexts must not import each other. Communicate through @arc/contracts or the event bus.',
            },
            {
              name: '@arc/platform',
              message:
                'Contexts must not import each other. Communicate through @arc/contracts or the event bus.',
            },
            {
              name: '@arc/partner',
              message:
                'Contexts must not import each other. Communicate through @arc/contracts or the event bus.',
            },
            {
              name: '@arc/product',
              message:
                'Contexts must not import each other. Communicate through @arc/contracts or the event bus.',
            },
          ],
        },
      ],
    },
  },

  {
    // Repo tooling scripts run in Node, not the browser.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
    rules: { 'no-console': 'off' },
  },

  {
    // CommonJS tooling configs (dependency-cruiser) run in Node's CJS scope.
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
  },

  {
    // Tests may write float literals — several exist precisely to demonstrate
    // the arithmetic failures that Money is built to prevent.
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      'no-restricted-globals': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
