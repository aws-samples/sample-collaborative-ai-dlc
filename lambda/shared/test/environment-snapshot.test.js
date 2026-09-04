import { describe, expect, it } from 'vitest';
import {
  resolvePublishedEnvironment,
  resolveEnvironmentSnapshot,
  supportsCompatibilityVersion,
} from '../environment-snapshot.js';

const environment = {
  environmentId: 'custom',
  name: 'Custom',
  status: 'PUBLISHED',
  publishedRevisionId: 'r-1',
};

const revision = {
  environmentId: 'custom',
  revisionId: 'r-1',
  status: 'PUBLISHED',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  runtimeArn: 'arn:aws:bedrock-agentcore:eu-west-1:123:runtime/custom',
  runtimeVersion: '3',
  runtimeEndpoint: 'revision_r_1',
  runtimeCompatibilityVersion: '2',
  verification: { status: 'PASSED' },
  flattenedRecipe: {
    resolvedTools: [
      { toolId: 'node', versionId: '22', name: 'Node.js', version: '22.17.0' },
      { toolId: 'python', versionId: '3.13', name: 'Python', version: '3.13.5' },
    ],
  },
};

const ddb = (revisionValue = revision) => ({
  send: async (command) =>
    command.input.Key.sk === 'META' ? { Item: environment } : { Item: revisionValue },
});

describe('environment snapshots', () => {
  it('accepts only the current and previous compatibility versions', () => {
    expect(supportsCompatibilityVersion('2', '2')).toBe(true);
    expect(supportsCompatibilityVersion('1', '2')).toBe(true);
    expect(supportsCompatibilityVersion('0', '2')).toBe(false);
    expect(supportsCompatibilityVersion('3', '2')).toBe(false);
  });

  it('returns immutable image and runtime fields from the published revision', async () => {
    await expect(
      resolveEnvironmentSnapshot({
        ddb: ddb(),
        tableName: 'registry',
        environmentId: 'custom',
        fallback: { compatibilityVersion: '2' },
      }),
    ).resolves.toMatchObject({
      environmentId: 'custom',
      revisionId: 'r-1',
      imageDigest: revision.imageDigest,
      runtimeArn: revision.runtimeArn,
      runtimeEndpoint: 'revision_r_1',
      compatibilityVersion: '2',
      verification: { status: 'PASSED' },
      tools: revision.flattenedRecipe.resolvedTools,
    });
  });

  it('returns the validated records alongside the immutable snapshot', async () => {
    await expect(
      resolvePublishedEnvironment({
        ddb: ddb(),
        tableName: 'registry',
        environmentId: 'custom',
        fallback: { compatibilityVersion: '2' },
      }),
    ).resolves.toMatchObject({
      environment,
      revision,
      snapshot: {
        environmentId: 'custom',
        revisionId: 'r-1',
        compatibilityVersion: '2',
      },
    });
  });

  it('uses the exact configured Standard runtime when the registry is not seeded yet', async () => {
    await expect(
      resolveEnvironmentSnapshot({
        ddb: { send: async () => ({}) },
        tableName: 'registry',
        environmentId: 'standard',
        fallback: {
          revisionId: 'core-4',
          imageDigest: `sha256:${'b'.repeat(64)}`,
          runtimeArn: 'arn:aws:bedrock-agentcore:eu-west-1:123:runtime/core',
          runtimeVersion: '4',
          compatibilityVersion: '2',
          verification: { status: 'PASSED', source: 'core-runtime' },
        },
      }),
    ).resolves.toMatchObject({
      environmentId: 'standard',
      revisionId: 'core-4',
      runtimeVersion: '4',
      compatibilityVersion: '2',
      verification: { status: 'PASSED', source: 'core-runtime' },
      tools: [],
    });
  });

  it('rejects unverified and unsupported published revisions', async () => {
    await expect(
      resolveEnvironmentSnapshot({
        ddb: ddb({ ...revision, verification: { status: 'FAILED' } }),
        tableName: 'registry',
        environmentId: 'custom',
        fallback: { compatibilityVersion: '2' },
      }),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_REVISION_UNVERIFIED' });

    await expect(
      resolveEnvironmentSnapshot({
        ddb: ddb({ ...revision, runtimeCompatibilityVersion: '0' }),
        tableName: 'registry',
        environmentId: 'custom',
        fallback: { compatibilityVersion: '2' },
      }),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_COMPATIBILITY_UNSUPPORTED' });
  });

  it('rejects custom fallbacks and revisions that are not published', async () => {
    await expect(
      resolveEnvironmentSnapshot({
        environmentId: 'custom',
      }),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_PUBLISHED' });

    await expect(
      resolveEnvironmentSnapshot({
        ddb: ddb({ ...revision, status: 'READY' }),
        tableName: 'registry',
        environmentId: 'custom',
        fallback: { compatibilityVersion: '2' },
      }),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_PUBLISHED' });
  });
});
