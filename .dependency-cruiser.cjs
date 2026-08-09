/**
 * Boundary rules for the modular monolith.
 *
 * Arc runs as one process, but its six contexts are meant to be as separated as
 * they would be across a network. Without enforcement, "modular monolith" decays
 * into "monolith" within a few weeks — someone reaches into another context's
 * internals because it is right there in the same repo, and the boundary that
 * the architecture diagram claims exists quietly stops existing.
 *
 * These rules fail the build instead. They are what makes the claim checkable.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-service-imports',
      severity: 'error',
      comment:
        'Contexts must not import each other directly. Communicate through @arc/contracts ' +
        'interfaces or by publishing an event on the bus. This is the rule that keeps each ' +
        'context independently extractable into its own deployable.',
      from: { path: '^services/([^/]+)/' },
      to: {
        path: '^services/([^/]+)/',
        pathNot: '^services/$1/',
      },
    },
    {
      name: 'packages-stay-shared',
      severity: 'error',
      comment:
        'Shared packages must not depend on a service or an app. A package that knows about ' +
        'a service is no longer shared infrastructure — it is that service, in the wrong place.',
      from: { path: '^packages/' },
      to: { path: '^(services|apps)/' },
    },
    {
      name: 'contracts-depend-on-nothing-internal',
      severity: 'error',
      comment:
        '@arc/contracts is the seam every context agrees on. If it depends on anything ' +
        'internal, the seam has a direction and is no longer neutral.',
      from: { path: '^packages/contracts/' },
      to: { path: '^(services|apps|packages/(?!contracts))' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make extraction impossible and startup order undefined.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Unreachable module — likely dead code left behind by a refactor.',
      from: { orphan: true, pathNot: ['\\.d\\.ts$', '(^|/)index\\.ts$', '\\.config\\.(js|ts)$'] },
      to: {},
    },
    {
      name: 'no-deep-package-imports',
      severity: 'error',
      comment:
        'Import a package through its public entry point, not by reaching into its src/. ' +
        'Deep imports bypass the surface the package chose to expose.',
      from: { pathNot: '^packages/([^/]+)/' },
      to: { path: '^packages/([^/]+)/src/(?!index\\.ts)' },
    },
    {
      name: 'no-dev-deps-in-src',
      severity: 'error',
      comment: 'Production source must not depend on a devDependency.',
      from: { path: '^(packages|services|apps)/[^/]+/src/', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['npm-dev'] },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|coverage|node_modules)(/|$)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js'],
    },
    reporterOptions: {
      dot: { collapsePattern: '^(packages|services|apps)/[^/]+' },
      archi: { collapsePattern: '^(packages|services|apps)/[^/]+' },
    },
  },
};
