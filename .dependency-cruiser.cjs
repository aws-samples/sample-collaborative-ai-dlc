/**
 * dependency-cruiser configuration for the backend (lambda/).
 *
 * Analyses coupling, circular dependencies, orphan modules and other
 * structural anomalies across the Lambda workspaces and shared code —
 * the JS/TS equivalent of a JArchitect dependency analysis.
 *
 * Usage (see package.json scripts):
 *   npm run dep:check     - fail on rule violations (circular deps, etc.)
 *   npm run dep:report    - HTML dependency report
 *   npm run dep:graph     - mermaid dependency graph
 *   npm run dep:metrics   - per-folder coupling / instability metrics
 *
 * Docs: https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md
 */
// Shared modules resolve these runtime packages against the root manifest,
// where they are devDependencies for the workspace build. They are intentional
// runtime imports; all other npm-dev/npm-no-pkg imports from production code
// are forbidden below.
const sharedRuntimeDependencyPath =
  '^node_modules/(?:@aws-lambda-powertools/|@aws-sdk/|@smithy/|gremlin(?:/|$)|gremlin-aws-sigv4(?:/|$)|js-yaml(?:/|$)|neptune-lambda-client(?:/|$)|tar-stream(?:/|$))';

module.exports = {
  forbidden: [
    {
      name: 'authentication-catalog-is-pure',
      comment:
        'Public authentication contracts cannot load clients, storage, or workspace modules.',
      severity: 'error',
      from: { path: '^lambda/shared/agent-auth-catalog\\.js$' },
      to: {},
    },
    {
      name: 'runtime-cannot-issue-or-load-agent-secrets',
      comment:
        'Runtime authentication uses the redemption broker; it cannot load key storage or grant signing code.',
      severity: 'error',
      from: { path: '^lambda/agentcore/', pathNot: '/test/' },
      to: {
        path: '^lambda/shared/(agent-key-repository|agent-credential-grants|agent-auth-redemption|agent-credentials)\\.js$',
      },
    },
    {
      name: 'no-circular',
      comment:
        'Circular dependency detected. Cycles couple modules tightly, make ' +
        'them hard to test in isolation and can trigger runtime ordering bugs.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      comment:
        'Orphan module: nothing imports it and it imports nothing relevant. ' +
        'Likely dead code or a missing wiring.',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$', // dot files
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.json$',
          '(^|/)package\\.json$',
          '(^|/)index\\.js$', // Lambda entry points are invoked by AWS, not imported
          '(^|/)vitest\\.config\\.js$', // test runner config, loaded by vitest
          '(^|/)test/', // infra/smoke tests import nothing but are not dead code
          '\\.(test|spec)\\.(js|mjs|cjs|ts|tsx)$',
        ],
      },
      to: {},
    },
    {
      name: 'no-deprecated-core',
      comment: 'Depends on a deprecated Node.js core module.',
      severity: 'warn',
      from: {},
      to: {
        dependencyTypes: ['core'],
        path: [
          '^(v8/tools/codemap)$',
          '^(v8/tools/consarray)$',
          '^(v8/tools/csvparser)$',
          '^(v8/tools/logreader)$',
          '^(v8/tools/profile_view)$',
          '^(v8/tools/profile)$',
          '^(v8/tools/SourceMap)$',
          '^(v8/tools/splaytree)$',
          '^(v8/tools/tickprocessor-driver)$',
          '^(v8/tools/tickprocessor)$',
          '^(node-inspect/lib/_inspect)$',
          '^(node-inspect/lib/internal/inspect_client)$',
          '^(node-inspect/lib/internal/inspect_repl)$',
          '^(async_hooks)$',
          '^(punycode)$',
          '^(domain)$',
          '^(constants)$',
          '^(sys)$',
          '^(_linklist)$',
          '^(_stream_wrap)$',
        ],
      },
    },
    {
      name: 'not-to-dev-dep',
      comment:
        'Runtime module depends on a devDependency. It will not be present in ' +
        'the deployed Lambda bundle.',
      severity: 'error',
      from: {
        path: '^lambda',
        pathNot: '\\.(test|spec)\\.(js|mjs|ts)$|/test/',
      },
      to: {
        dependencyTypes: ['npm-dev', 'npm-no-pkg'],
        dependencyTypesNot: ['type-only'],
        pathNot: sharedRuntimeDependencyPath,
      },
    },
    {
      name: 'no-duplicate-dep-types',
      comment: 'A dependency is declared more than once (e.g. both prod and dev).',
      severity: 'warn',
      from: {},
      to: {
        moreThanOneDependencyType: true,
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'high-fan-in',
      comment:
        'This module is imported by a large number of others (high afferent ' +
        'coupling). A change here has a wide blast radius. If it is a thin, ' +
        'stable utility that is fine; if it is a transversal concern branched ' +
        'on everywhere (like the credential subsystem), it likely needs an ' +
        'owning abstraction so callers depend on one interface instead of ' +
        'threading logic by hand. Investigate with: npm run dep:reaches -- "<file>".',
      severity: 'warn',
      // `module` selects the modules to check and the threshold; `from`
      // filters which dependents count. Caveat: only path/pathNot are honoured
      // here, so `from.pathNot` keeps the count to production importers.
      module: {
        path: '^lambda/',
        numberOfDependentsMoreThan: 10,
      },
      from: {
        pathNot: '(^|/)test/|\\.(test|spec)\\.(js|mjs|cjs|ts|tsx)$',
      },
    },
    {
      name: 'not-to-test',
      comment:
        'Non-test code must not import a test file. Test helpers belong in ' +
        'test/ and must not ship in the runtime bundle.',
      severity: 'error',
      from: {
        pathNot: '(^|/)test/|\\.(test|spec)\\.(js|mjs|cjs|ts|tsx)$',
      },
      to: {
        path: '(^|/)test/|\\.(test|spec)\\.(js|mjs|cjs|ts|tsx)$',
      },
    },
    {
      name: 'shared-is-foundation',
      comment:
        'lambda/shared must stay a leaf foundation: it may import external ' +
        'packages and other shared modules, but never a Lambda workspace. ' +
        'Push shared code down into shared/, do not reach sideways.',
      severity: 'error',
      from: {
        path: '^lambda/shared/',
        pathNot: '(^|/)test/|\\.(test|spec)\\.(js|mjs|cjs|ts|tsx)$',
      },
      to: {
        path: '^lambda/[^/]+/',
        pathNot: '^lambda/shared/',
      },
    },
    {
      name: 'no-cross-lambda',
      comment:
        "A Lambda workspace must not import another workspace's internals " +
        'directly. Share code through lambda/shared/ instead.',
      severity: 'error',
      from: {
        path: '^lambda/([^/]+)/',
        pathNot: [
          '^lambda/shared/', // shared handled by shared-is-foundation
          // integration/e2e tests legitimately wire several workspaces together
          '(^|/)test/|\\.(test|spec)\\.(js|mjs|cjs|ts|tsx)$',
        ],
      },
      to: {
        path: '^lambda/([^/]+)/',
        pathNot: [
          '^lambda/shared/', // shared is the allowed common dependency
          '^lambda/$1/', // same workspace as the importer
        ],
      },
    },
  ],
  options: {
    doNotFollow: {
      path: ['node_modules'],
    },
    // Keep imported targets in the graph so rules can validate edges from
    // Lambda code to devDependencies and files outside lambda/. `doNotFollow`
    // above prevents dependency-cruiser from traversing external packages.
    // NB: test files are intentionally NOT excluded here so the `not-to-test`
    // rule can see (and forbid) any prod -> test edge. The report/metrics/graph
    // npm scripts pass `--exclude` on the CLI to keep those outputs source-only.
    exclude: {
      path: ['\\.build/', '(^|/)coverage/', '(^|/)\\.stryker-tmp/'],
    },
    moduleSystems: ['es6', 'cjs'],
    enhancedResolveOptions: {
      extensions: ['.js', '.mjs', '.cjs', '.json'],
    },
    reporterOptions: {
      dot: {
        collapsePattern: 'lambda/[^/]+',
      },
      archi: {
        collapsePattern: '^lambda/[^/]+',
      },
      metrics: {
        orderBy: 'instability',
      },
    },
  },
};
