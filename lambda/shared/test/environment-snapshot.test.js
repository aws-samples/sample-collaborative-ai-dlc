import { describe, expect, it } from 'vitest';
import {
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
});
