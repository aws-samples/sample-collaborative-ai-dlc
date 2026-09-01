import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SYSTEM_ENVIRONMENT_TEMPLATES,
  assertRevisionTransition,
  evaluateScanFindings,
  flattenRecipe,
  generateBuildContext,
  generateDockerfile,
  generateVerificationScript,
  isSupportedCompatibilityVersion,
  normalizeEnvironmentId,
  orderRebuilds,
  validateRecipe,
} from '../recipe.js';

const BASE = {
  environmentId: 'standard',
  revisionId: 'core-1',
  imageUri: '111111111111.dkr.ecr.eu-west-1.amazonaws.com/core',
  imageDigest: `sha256:${'a'.repeat(64)}`,
};

const archive = (version, url, algorithm, value, stripComponents = 1) => ({
  version,
  source: 'archive',
  url,
  checksum: { algorithm, value },
  stripComponents,
});
const PYTHON = { version: '3.11', source: 'base' };
const JAVA = archive(
  '21.0.8',
  'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.8%2B9/OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.8_9.tar.gz',
  'sha256',
  'e5c41a1ab0865ea5de9b4529bf8526005f1d4593090845387d14fe450ce39c33',
);
const GO = archive(
  '1.24.6',
  'https://go.dev/dl/go1.24.6.linux-arm64.tar.gz',
  'sha256',
  '124ea6033a8bf98aa9fbab53e58d134905262d45a022af3a90b73320f3c3afd5',
);
const RUST = archive(
  '1.89.0',
  'https://static.rust-lang.org/dist/rust-1.89.0-aarch64-unknown-linux-gnu.tar.gz',
  'sha256',
  '26d6de84ac59da702aa8c2f903e3c344e3259da02e02ce92ad1c735916b29a4a',
);
const MAVEN = archive(
  '3.9.11',
  'https://archive.apache.org/dist/maven/maven-3/3.9.11/binaries/apache-maven-3.9.11-bin.tar.gz',
  'sha512',
  'bcfe4fe305c962ace56ac7b5fc7a08b87d5abd8b7e89027ab251069faebee516b0ded8961445d6d91ec1985dfe30f8153268843c89aa392733d1a3ec956c9978',
);
const GRADLE = archive(
  '9.0.0',
  'https://services.gradle.org/distributions/gradle-9.0.0-bin.zip',
  'sha256',
  '8fad3d78296ca518113f3d29016617c7f9367dc005f932bd9d93bf45ba46072b',
);

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
  it('uses the shared runtime compatibility window', () => {
    expect(isSupportedCompatibilityVersion('2', '2')).toBe(true);
    expect(isSupportedCompatibilityVersion('1', '2')).toBe(true);
    expect(isSupportedCompatibilityVersion('0', '2')).toBe(false);
    expect(isSupportedCompatibilityVersion('3', '2')).toBe(false);
  });

  it('seeds only the protected Standard environment', () => {
    expect(SYSTEM_ENVIRONMENT_TEMPLATES.map((item) => item.id)).toEqual(['standard']);
    expect(SYSTEM_ENVIRONMENT_TEMPLATES[0].recipe.tools).toEqual({
      node: { version: '24.15.0', source: 'base' },
      python: { version: '3.11', source: 'base' },
    });
  });

  it('collapses and trims long environment id separator runs', () => {
    expect(normalizeEnvironmentId(`---Managed${'-'.repeat(100_000)}Environment---`)).toBe(
      'managed-environment',
    );
  });

  it('retains representative checks for protected Standard revisions', () => {
    const template = SYSTEM_ENVIRONMENT_TEMPLATES[0];
    const context = generateBuildContext({
      environment: { environmentId: template.id },
      revision: { revisionId: 'r-1', runtimeCompatibilityVersion: '1' },
      flattenedRecipe: { ...template.recipe, base: BASE },
      generatedAt: '2026-08-10T00:00:00.000Z',
    });
    expect(context.files['verification.sh']).toContain('npm init -y');
    expect(context.files['verification.sh']).toContain('python3 -m py_compile');
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
    const dockerfile = generateDockerfile(recipe({ tools: { rust: RUST } }));

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

  it('writes smoke-test fixtures without shell escape processing', () => {
    const verification = generateVerificationScript(
      recipe({
        tools: {
          python: PYTHON,
          java: JAVA,
          go: GO,
        },
        buildTools: {
          maven: MAVEN,
          gradle: GRADLE,
        },
      }),
    );

    expect(verification).toContain(
      `<<'MANAGED_GRADLE'
tasks.register("verifyEnvironment")
MANAGED_GRADLE`,
    );
    expect(verification).toContain(
      `<<'MANAGED_GO'
package main

import "fmt"

func main() {
  fmt.Println(2)
}
MANAGED_GO`,
    );
    expect(verification).not.toContain('printf "tasks.register');
    expect(verification).not.toContain('printf "package main');
    expect(verification).not.toContain(String.fromCodePoint(0x0b));
    expect(verification).not.toContain(String.fromCodePoint(0x0c));
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
