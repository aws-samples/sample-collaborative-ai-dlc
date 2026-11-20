import { describe, expect, it, vi } from 'vitest';
import { readImageScanFindings } from '../build-lifecycle.js';

const digest = `sha256:${'c'.repeat(64)}`;
const client = (response) => ({ send: vi.fn().mockResolvedValue(response) });

describe('readImageScanFindings', () => {
  it('reads the scan of the image in its own repository', async () => {
    const ecrClient = client({
      imageScanStatus: { status: 'COMPLETE' },
      imageScanFindings: {
        findingSeverityCounts: { HIGH: 1 },
        findings: [
          {
            name: 'CVE-2',
            severity: 'HIGH',
            attributes: [
              { key: 'package_name', value: 'zlib' },
              { key: 'package_version', value: '1.0' },
            ],
          },
        ],
      },
      nextToken: 'more',
    });

    const result = await readImageScanFindings({
      ecrClient,
      imageUri: '111111111111.dkr.ecr.eu-west-1.amazonaws.com/team/core:latest',
      imageDigest: digest,
      now: () => '2026-11-20T00:00:00.000Z',
    });

    expect(ecrClient.send.mock.calls[0][0].input).toEqual({
      repositoryName: 'team/core',
      imageId: { imageDigest: digest },
    });
    expect(result).toEqual({
      status: 'COMPLETE',
      severityCounts: { HIGH: 1 },
      findings: [
        { id: 'CVE-2', severity: 'HIGH', packageName: 'zlib', packageVersion: '1.0', uri: null },
      ],
      findingsTruncated: true,
      evaluatedAt: '2026-11-20T00:00:00.000Z',
      imageDigest: digest,
    });
  });

  it('returns no result while the scan is pending or cannot run', async () => {
    for (const status of ['PENDING', 'IN_PROGRESS', 'FAILED', 'UNSUPPORTED_IMAGE', undefined]) {
      await expect(
        readImageScanFindings({
          ecrClient: client({ imageScanStatus: { status } }),
          imageUri: '111111111111.dkr.ecr.eu-west-1.amazonaws.com/core',
          imageDigest: digest,
        }),
      ).resolves.toBeNull();
    }
  });

  it('does not call ECR without an image digest or repository', async () => {
    const ecrClient = client({});
    await expect(
      readImageScanFindings({ ecrClient, imageUri: 'core-repository', imageDigest: digest }),
    ).resolves.toBeNull();
    await expect(
      readImageScanFindings({
        ecrClient,
        imageUri: '111111111111.dkr.ecr.eu-west-1.amazonaws.com/core',
        imageDigest: null,
      }),
    ).resolves.toBeNull();
    expect(ecrClient.send).not.toHaveBeenCalled();
  });
});
