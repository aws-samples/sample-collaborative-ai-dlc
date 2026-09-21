import { describe, expect, it, vi } from 'vitest';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { pinCustomRuleVersions } from '../custom-rule-versions.js';

describe('pinCustomRuleVersions', () => {
  it('preserves rule metadata and pins the exact object version', async () => {
    const s3 = {
      send: vi.fn(async (command) => {
        expect(command).toBeInstanceOf(HeadObjectCommand);
        expect(command.input).toEqual({
          Bucket: 'artifacts',
          Key: 'custom-rules/p1/security.md',
        });
        return { VersionId: 'version-1' };
      }),
    };

    await expect(
      pinCustomRuleVersions({
        s3,
        bucket: 'artifacts',
        rules: [{ s3Key: 'custom-rules/p1/security.md', source: 'project' }],
      }),
    ).resolves.toEqual([
      {
        filename: 'security.md',
        s3Key: 'custom-rules/p1/security.md',
        source: 'project',
        versionId: 'version-1',
      },
    ]);
  });

  it('rejects an object without an immutable version', async () => {
    await expect(
      pinCustomRuleVersions({
        s3: { send: vi.fn(async () => ({})) },
        bucket: 'artifacts',
        rules: [{ filename: 'rules.md', s3Key: 'custom-rules/p1/rules.md' }],
      }),
    ).rejects.toThrow('has no immutable S3 version');
  });
});
