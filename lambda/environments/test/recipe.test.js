import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ENVIRONMENT_TOOL_CATALOG,
  SYSTEM_ENVIRONMENT_TEMPLATES,
  applyToolPrerequisites,
  assertRevisionTransition,
  evaluateScanFindings,
  flattenRecipe,
  generateBuildContext,
  generateDockerfile,
  orderRebuilds,
  validateRecipe,
} from '../recipe.js';

const BASE = {
  environmentId: 'standard',
  revisionId: 'core-1',
  imageUri: '111111111111.dkr.ecr.eu-west-1.amazonaws.com/core',
  imageDigest: `sha256:${'a'.repeat(64)}`,
};

const recipe = (overrides = {}) => ({
  schemaVersion: 1,
  base: BASE,
  tools: {
    node: { version: '24.15.0', source: 'base' },
  },
  buildTools: {},
  aptPackages: [],
  environmentVariables: {},
  buildCommands: [],
  ...overrides,
});

describe('managed environment recipes', () => {
  it('seeds the five required system environments', () => {
    expect(SYSTEM_ENVIRONMENT_TEMPLATES.map((item) => item.id)).toEqual([
      'standard',
      'jvm',
      'go',
      'rust',
      'polyglot',
    ]);
  });

  it('publishes the exact tool versions and package provenance available to the editor', () => {
    expect(ENVIRONMENT_TOOL_CATALOG.tools.node.versions).toEqual([
      { version: '24.15.0', source: 'base' },
    ]);
    expect(ENVIRONMENT_TOOL_CATALOG.tools.python.versions).toEqual([
      { version: '3.11', source: 'base' },
    ]);
    expect(ENVIRONMENT_TOOL_CATALOG.tools.java.versions).toEqual([
      SYSTEM_ENVIRONMENT_TEMPLATES.find((item) => item.id === 'jvm').recipe.tools.java,
    ]);
    expect(ENVIRONMENT_TOOL_CATALOG.tools.go.versions).toEqual([
      SYSTEM_ENVIRONMENT_TEMPLATES.find((item) => item.id === 'go').recipe.tools.go,
    ]);
    expect(ENVIRONMENT_TOOL_CATALOG.tools.rust.versions).toEqual([
      SYSTEM_ENVIRONMENT_TEMPLATES.find((item) => item.id === 'rust').recipe.tools.rust,
    ]);
  });

  it('adds the pinned native compiler toolchain required by Rust', () => {
    const rust = ENVIRONMENT_TOOL_CATALOG.tools.rust.versions[0];

    expect(
      applyToolPrerequisites(recipe({ tools: { rust }, aptPackages: [] })).aptPackages,
    ).toEqual([{ name: 'build-essential', version: '12.9' }]);
    expect(
      SYSTEM_ENVIRONMENT_TEMPLATES.find((item) => item.id === 'rust').recipe.aptPackages,
    ).toEqual([{ name: 'build-essential', version: '12.9' }]);
    expect(
      SYSTEM_ENVIRONMENT_TEMPLATES.find((item) => item.id === 'polyglot').recipe.aptPackages,
    ).toEqual([{ name: 'build-essential', version: '12.9' }]);
  });

  it('generates representative build checks for every system environment', () => {
    const expectedChecks = {
      standard: ['npm init -y', 'python3 -m py_compile'],
      jvm: ['javac "$d/Main.java"', 'mvn -q -o validate', 'gradle --offline'],
      go: ['go build -o app'],
      rust: ['cargo build -q'],
      polyglot: [
        'npm init -y',
        'python3 -m py_compile',
        'javac "$d/Main.java"',
        'mvn -q -o validate',
        'gradle --offline',
        'go build -o app',
        'cargo build -q',
      ],
    };

    for (const template of SYSTEM_ENVIRONMENT_TEMPLATES) {
      const flattenedRecipe = {
        ...template.recipe,
        base: BASE,
      };
      const context = generateBuildContext({
        environment: { environmentId: template.id },
        revision: { revisionId: 'r-1', runtimeCompatibilityVersion: '1' },
        flattenedRecipe,
        generatedAt: '2026-08-10T00:00:00.000Z',
      });
      for (const check of expectedChecks[template.id]) {
        expect(context.files['verification.sh']).toContain(check);
      }
    }
  });

  it('flattens tools, packages, variables, and ordered commands', () => {
    const parent = recipe({
      tools: { node: { version: '24.15.0', source: 'base' } },
      aptPackages: [{ name: 'git', version: '1:2.43.0-1' }],
      environmentVariables: { PARENT: 'yes', SHARED: 'parent' },
      buildCommands: ['printf parent'],
    });
    const child = recipe({
      tools: { python: { version: '3.11', source: 'base' } },
      aptPackages: [
        { name: 'git', version: '1:2.44.0-1' },
        { name: 'jq', version: '1.7.1-3' },
      ],
      environmentVariables: { SHARED: 'child', CHILD: 'yes' },
      buildCommands: ['printf child'],
    });

    expect(flattenRecipe(child, parent)).toMatchObject({
      tools: {
        node: { version: '24.15.0', source: 'base' },
        python: { version: '3.11', source: 'base' },
      },
      aptPackages: [
        { name: 'git', version: '1:2.44.0-1' },
        { name: 'jq', version: '1.7.1-3' },
      ],
      environmentVariables: { PARENT: 'yes', SHARED: 'child', CHILD: 'yes' },
      buildCommands: ['printf parent', 'printf child'],
    });
  });

  it('orders rebuilds from base environments to dependents', () => {
    const environments = [
      { environmentId: 'leaf', baseEnvironmentId: 'middle' },
      { environmentId: 'standard', baseEnvironmentId: null },
      { environmentId: 'middle', baseEnvironmentId: 'standard' },
      { environmentId: 'sibling', baseEnvironmentId: 'standard' },
    ];
    expect(orderRebuilds(environments).map((item) => item.environmentId)).toEqual([
      'standard',
      'middle',
      'leaf',
      'sibling',
    ]);
  });

  it('rejects dependency cycles', () => {
    expect(() =>
      orderRebuilds([
        { environmentId: 'a', baseEnvironmentId: 'b' },
        { environmentId: 'b', baseEnvironmentId: 'a' },
      ]),
    ).toThrow('Environment dependency cycle detected');
  });

  it('generates a digest-pinned Dockerfile with protected runtime settings', () => {
    const dockerfile = generateDockerfile(
      recipe({
        environmentVariables: { BUILD_MODE: 'strict' },
        buildCommands: ['printf verified'],
      }),
    );
    expect(dockerfile).toContain(`FROM ${BASE.imageUri}@${BASE.imageDigest}`);
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('WORKDIR /mnt/workspace');
    expect(dockerfile).toContain('ENTRYPOINT ["node", "/opt/agentcore/http-server.js"]');
    expect(dockerfile).toContain('CMD []');
    expect(dockerfile).toContain(
      'find /opt/agentcore /opt/shared -type f -print0 | sort -z | xargs -0 sha256sum',
    );
    expect(dockerfile).toContain('RUN sha256sum -c /opt/managed/protected-runtime.sha256');
  });

  it('stages the Rust installer outside its final prefix', () => {
    const rust = ENVIRONMENT_TOOL_CATALOG.tools.rust.versions[0];
    const dockerfile = generateDockerfile(recipe({ tools: { rust } }));

    expect(dockerfile).toContain('apt-get install -y --no-install-recommends build-essential=12.9');
    expect(dockerfile).toContain(
      "'/tmp/managed-rust-1.89.0/install.sh' --prefix='/opt/managed/tools/rust/1.89.0'",
    );
    expect(dockerfile).toContain("rm -rf '/tmp/managed-rust-1.89.0'");
    expect(dockerfile).not.toContain(
      "'/opt/managed/tools/rust/1.89.0/install.sh' --prefix='/opt/managed/tools/rust/1.89.0'",
    );
  });

  it('checksums the complete build input and emits an SPDX document', () => {
    const context = generateBuildContext({
      environment: { environmentId: 'custom' },
      revision: { revisionId: 'r-1', runtimeCompatibilityVersion: '1' },
      flattenedRecipe: recipe(),
      generatedAt: '2026-08-10T00:00:00.000Z',
    });
    expect(context.files['sbom.spdx.json']).toContain('"spdxVersion": "SPDX-2.3"');
    expect(context.files['checksums.sha256']).toContain('checksums.json');
    for (const [name, checksum] of Object.entries(context.checksums)) {
      expect(createHash('sha256').update(context.files[name]).digest('hex')).toBe(checksum);
    }
    expect(context.files['verification.sh']).toContain('test "$arch" = "arm64"');
    expect(context.files['verification.sh']).toContain('docker stop "$container"');
    expect(context.files['verification.sh']).toContain(
      'diff -qr --no-dereference "$protected_dir/base-$path" "$protected_dir/built-$path"',
    );
  });

  it('blocks secret-like variables and protected runtime commands', () => {
    const result = validateRecipe(
      recipe({
        environmentVariables: { API_TOKEN: 'not-allowed' },
        buildCommands: [
          'sudo cp replacement /opt/agentcore/http-server.js',
          'printf ok\nHEALTHCHECK NONE',
          'export API_TOKEN=plain-text-value',
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.map((item) => item.path)).toEqual(
      expect.arrayContaining([
        'environmentVariables.API_TOKEN',
        'buildCommands.0',
        'buildCommands.1',
        'buildCommands.2',
      ]),
    );
  });

  it('rejects credential-bearing or mutable archive URLs', () => {
    const result = validateRecipe(
      recipe({
        tools: {
          node: {
            version: '24.15.0',
            source: 'archive',
            url: 'https://user:password@nodejs.org/dist/node.tar.xz?token=value',
            checksum: { algorithm: 'sha256', value: 'a'.repeat(64) },
          },
        },
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: 'tools.node.url',
        message: expect.stringContaining('credentials'),
      }),
    );
  });

  it('blocks platform runtime overrides and archive fields on base tools', () => {
    const result = validateRecipe(
      recipe({
        tools: {
          node: {
            version: '24.15.0',
            source: 'base',
            url: 'https://go.dev/dl/go1.24.6.linux-arm64.tar.gz',
          },
        },
        environmentVariables: {
          BUILD_MODE: 'strict',
          NODE_OPTIONS: '--require /tmp/override.js',
          AWS_PROFILE: 'alternate',
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.map((item) => item.path)).toEqual(
      expect.arrayContaining([
        'tools.node',
        'environmentVariables.NODE_OPTIONS',
        'environmentVariables.AWS_PROFILE',
      ]),
    );
    expect(result.issues.map((item) => item.path)).not.toContain('environmentVariables.BUILD_MODE');
  });

  it('enforces vulnerability gates and lifecycle transitions', () => {
    expect(evaluateScanFindings({ CRITICAL: 1, HIGH: 0 })).toMatchObject({
      allowed: false,
      status: 'SECURITY_REVIEW',
    });
    expect(evaluateScanFindings({ HIGH: 2 })).toMatchObject({
      allowed: false,
      status: 'SECURITY_REVIEW',
    });
    expect(evaluateScanFindings({ CRITICAL: 1 }, true)).toMatchObject({
      allowed: true,
      status: 'VERIFYING',
    });
    expect(evaluateScanFindings({ HIGH: 2 }, true)).toMatchObject({
      allowed: true,
      status: 'VERIFYING',
    });
    expect(() => assertRevisionTransition('DRAFT', 'QUEUED')).not.toThrow();
    expect(() => assertRevisionTransition('FAILED', 'SECURITY_REVIEW')).not.toThrow();
    expect(() => assertRevisionTransition('BUILDING', 'PUBLISHED')).toThrow(
      'Invalid revision status transition',
    );
  });
});
