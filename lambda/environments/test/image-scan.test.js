import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createScanReadClient, readImageScanFindings } from '../build-lifecycle.js';
import { createHandler } from '../index.js';

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

// The seeding client is exercised for real: an ECRClient with its timeout and
// retry handling, sending to a local endpoint that answers only after the
// client's request timeout.
describe('core image scan read during seeding', () => {
  const answerAfterMs = 2000;
  let server;
  let requests = 0;

  beforeAll(async () => {
    server = createServer((request, response) => {
      requests += 1;
      request.resume();
      const answer = setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
        response.end(
          JSON.stringify({
            imageScanStatus: { status: 'ACTIVE' },
            imageScanFindings: { findingSeverityCounts: { HIGH: 1 }, findings: [] },
          }),
        );
      }, answerAfterMs);
      response.on('close', () => clearTimeout(answer));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  afterEach(() => vi.unstubAllEnvs());

  it('stops waiting for a stalled ECR answer and serves the request without a scan', async () => {
    vi.stubEnv('CORE_IMAGE_URI', '111111111111.dkr.ecr.eu-west-1.amazonaws.com/core');
    vi.stubEnv('CORE_IMAGE_DIGEST', digest);
    vi.stubEnv('CORE_RUNTIME_ARN', 'arn:aws:bedrock-agentcore:eu-west-1:111111111111:runtime/core');
    const store = {
      seedSystemEnvironments: vi.fn(),
      stageCoreRevision: vi.fn(),
      reconcileBaseUpdates: vi.fn(),
      listEnvironments: vi.fn().mockResolvedValue([]),
    };
    const ecrClient = createScanReadClient({
      requestTimeout: 100,
      region: 'eu-west-1',
      endpoint: `http://127.0.0.1:${server.address().port}`,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const handler = createHandler({ store, ecrClient });
    requests = 0;
    const started = Date.now();

    const response = await handler({
      httpMethod: 'GET',
      path: '/environments',
      requestContext: {
        authorizer: { claims: { sub: 'user-1', email: 'user@example.com' } },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(answerAfterMs);
    // One retry, then seeding goes on without the scan.
    expect(requests).toBe(2);
    expect(store.stageCoreRevision).toHaveBeenCalledWith(
      expect.objectContaining({ coreScanFindings: null }),
    );
  });
});
