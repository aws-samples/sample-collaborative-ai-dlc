import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import {
  ENHANCED_SCAN_SETTLE_MS,
  MAX_GATE_SCAN_FINDINGS,
  createScanReadClient,
  readGateScan,
  readImageScanFindings,
} from '../build-lifecycle.js';
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

  it('orders a vulnerability found in several packages the same way on every read', async () => {
    const affected = (packageName) => ({
      name: 'CVE-3',
      severity: 'HIGH',
      attributes: [
        { key: 'package_name', value: packageName },
        { key: 'package_version', value: '3.5.9' },
      ],
    });
    const read = (findings) =>
      readImageScanFindings({
        ecrClient: client({
          imageScanStatus: { status: 'ACTIVE' },
          imageScanFindings: { findingSeverityCounts: { HIGH: 2 }, findings },
        }),
        imageUri: '111111111111.dkr.ecr.eu-west-1.amazonaws.com/core',
        imageDigest: digest,
        now: () => '2026-11-20T00:00:00.000Z',
      });

    const first = await read([affected('openssl'), affected('libssl3t64')]);
    const second = await read([affected('libssl3t64'), affected('openssl')]);

    expect(first.findings.map((finding) => finding.packageName)).toEqual(['libssl3t64', 'openssl']);
    expect(second).toEqual(first);
  });

  it('lists the findings of an enhanced scan, which ECR returns in their own shape', async () => {
    const result = await readImageScanFindings({
      ecrClient: client({
        imageScanStatus: { status: 'ACTIVE' },
        imageScanFindings: {
          findingSeverityCounts: { HIGH: 1, CRITICAL: 1, MEDIUM: 1 },
          enhancedFindings: [
            {
              severity: 'HIGH',
              title: 'CVE-2026-1 - openssl, libssl3t64',
              packageVulnerabilityDetails: {
                vulnerabilityId: 'CVE-2026-1',
                sourceUrl: 'https://security-tracker.debian.org/tracker/CVE-2026-1',
                vulnerablePackages: [
                  { name: 'openssl', version: '3.5.9', filePath: '/usr/bin/openssl' },
                  { name: 'libssl3t64', version: '3.5.9' },
                  // The same package at another path is listed once.
                  { name: 'openssl', version: '3.5.9', filePath: '/opt/node/openssl' },
                ],
              },
            },
            {
              severity: 'LOW',
              title: 'CVE-2026-9 - zlib',
              packageVulnerabilityDetails: {
                vulnerabilityId: 'CVE-2026-9',
                // Only https links reach the UI.
                sourceUrl: 'javascript:alert(1)',
                vulnerablePackages: [{ name: 'zlib', version: '1.3' }],
              },
            },
            {
              severity: 'CRITICAL',
              title: 'GHSA-xxxx - cap-primitives',
              packageVulnerabilityDetails: {
                vulnerabilityId: 'GHSA-xxxx',
                // A link that is not https falls back to the reference.
                sourceUrl: 'http://example.test/GHSA-xxxx',
                referenceUrls: ['https://github.com/advisories/GHSA-xxxx'],
                vulnerablePackages: [{ name: 'cap-primitives', version: '4.0.2' }],
              },
            },
            // A finding without package details still shows up.
            { severity: 'MEDIUM', title: 'Untitled package finding' },
          ],
        },
      }),
      imageUri: '111111111111.dkr.ecr.eu-west-1.amazonaws.com/core',
      imageDigest: digest,
      now: () => '2026-11-20T00:00:00.000Z',
    });

    expect(result.findings).toEqual([
      {
        id: 'GHSA-xxxx',
        severity: 'CRITICAL',
        packageName: 'cap-primitives',
        packageVersion: '4.0.2',
        uri: 'https://github.com/advisories/GHSA-xxxx',
      },
      {
        id: 'CVE-2026-1',
        severity: 'HIGH',
        packageName: 'libssl3t64',
        packageVersion: '3.5.9',
        uri: 'https://security-tracker.debian.org/tracker/CVE-2026-1',
      },
      {
        id: 'CVE-2026-1',
        severity: 'HIGH',
        packageName: 'openssl',
        packageVersion: '3.5.9',
        uri: 'https://security-tracker.debian.org/tracker/CVE-2026-1',
      },
      {
        id: 'Untitled package finding',
        severity: 'MEDIUM',
        packageName: null,
        packageVersion: null,
        uri: null,
      },
      { id: 'CVE-2026-9', severity: 'LOW', packageName: 'zlib', packageVersion: '1.3', uri: null },
    ]);
  });

  describe('enhanced scan pages', () => {
    const enhanced = (id, severity) => ({
      severity,
      packageVulnerabilityDetails: {
        vulnerabilityId: id,
        vulnerablePackages: [{ name: 'krb5', version: '1.21.3' }],
      },
    });
    const page = (findings, nextToken) => ({
      imageScanStatus: { status: 'ACTIVE' },
      imageScanFindings: {
        // ECR counts only the findings of the page it returns.
        findingSeverityCounts: findings.reduce(
          (counts, finding) => ({
            ...counts,
            [finding.severity]: (counts[finding.severity] ?? 0) + 1,
          }),
          {},
        ),
        enhancedFindings: findings,
      },
      ...(nextToken ? { nextToken } : {}),
    });
    const read = (...pages) => {
      const send = vi.fn();
      for (const response of pages) send.mockResolvedValueOnce(response);
      send.mockResolvedValue(page([enhanced('CVE-LAST', 'LOW')], 'more'));
      return {
        send,
        result: readImageScanFindings({
          ecrClient: { send },
          imageUri: '111111111111.dkr.ecr.eu-west-1.amazonaws.com/core',
          imageDigest: digest,
          now: () => '2026-11-20T00:00:00.000Z',
        }),
      };
    };

    it('adds up the counts of every page and keeps the most severe findings', async () => {
      const { send, result } = read(
        page([enhanced('CVE-1', 'MEDIUM')], 'p2'),
        page([enhanced('CVE-2', 'HIGH'), enhanced('CVE-3', 'HIGH')]),
      );

      await expect(result).resolves.toMatchObject({
        status: 'ACTIVE',
        severityCounts: { MEDIUM: 1, HIGH: 2 },
        findingsTruncated: false,
        incomplete: false,
      });
      expect((await result).findings.map((finding) => finding.id)).toEqual([
        'CVE-2',
        'CVE-3',
        'CVE-1',
      ]);
      expect(send.mock.calls[1][0].input).toEqual({
        repositoryName: 'core',
        imageId: { imageDigest: digest },
        nextToken: 'p2',
      });
    });

    it('does not call a complete list truncated when ECR returns a token on its last page', async () => {
      const { result } = read(page([enhanced('CVE-1', 'HIGH')], 'p2'), page([]));

      await expect(result).resolves.toMatchObject({
        severityCounts: { HIGH: 1 },
        findingsTruncated: false,
        incomplete: false,
      });
    });

    it('stores a result larger than the seeding read bound as incomplete', async () => {
      const { send, result } = read();

      await expect(result).resolves.toMatchObject({
        severityCounts: { LOW: 5 },
        findingsTruncated: true,
        incomplete: true,
      });
      expect(send).toHaveBeenCalledTimes(5);
    });

    it('keeps the pages already read as incomplete when a later page fails', async () => {
      const send = vi
        .fn()
        .mockResolvedValueOnce(page([enhanced('CVE-1', 'HIGH')], 'p2'))
        .mockRejectedValueOnce(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));

      await expect(
        readImageScanFindings({
          ecrClient: { send },
          imageUri: '111111111111.dkr.ecr.eu-west-1.amazonaws.com/core',
          imageDigest: digest,
        }),
      ).resolves.toMatchObject({
        severityCounts: { HIGH: 1 },
        findings: [expect.objectContaining({ id: 'CVE-1' })],
        incomplete: true,
      });
      expect(send).toHaveBeenCalledTimes(2);
    });

    // Answers each page until the read's signal aborts, then rejects the call
    // in flight the way the SDK does.
    const untilAborted = (...pages) =>
      vi.fn((_command, { abortSignal }) => {
        if (pages.length) return Promise.resolve(pages.shift());
        return new Promise((_resolve, reject) =>
          abortSignal.addEventListener('abort', () =>
            reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })),
          ),
        );
      });

    it('cancels a later page at the deadline and keeps the pages already read', async () => {
      const send = untilAborted(page([enhanced('CVE-1', 'HIGH')], 'p2'));

      await expect(
        readImageScanFindings({
          ecrClient: { send },
          imageUri: '111111111111.dkr.ecr.eu-west-1.amazonaws.com/core',
          imageDigest: digest,
          budgetMs: 20,
        }),
      ).resolves.toMatchObject({ severityCounts: { HIGH: 1 }, incomplete: true });
      expect(send).toHaveBeenCalledTimes(2);
      // One deadline for the whole read, not one per page.
      expect(send.mock.calls[1][1].abortSignal).toBe(send.mock.calls[0][1].abortSignal);
    });

    it('fails the read when the first page misses the deadline', async () => {
      await expect(
        readImageScanFindings({
          ecrClient: { send: untilAborted() },
          imageUri: '111111111111.dkr.ecr.eu-west-1.amazonaws.com/core',
          imageDigest: digest,
          budgetMs: 20,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });
  });

  it('keeps only https links of basic scan findings', async () => {
    const basic = (name, uri) => ({ name, severity: 'HIGH', uri, attributes: [] });
    const result = await readImageScanFindings({
      ecrClient: client({
        imageScanStatus: { status: 'COMPLETE' },
        imageScanFindings: {
          findingSeverityCounts: { HIGH: 3 },
          findings: [
            basic('CVE-A', 'https://security-tracker.debian.org/tracker/CVE-A'),
            basic('CVE-B', 'javascript:alert(1)'),
            basic('CVE-C', 'not a url'),
          ],
        },
      }),
      imageUri: '111111111111.dkr.ecr.eu-west-1.amazonaws.com/core',
      imageDigest: digest,
    });

    expect(result.findings.map(({ id, uri }) => [id, uri])).toEqual([
      ['CVE-A', 'https://security-tracker.debian.org/tracker/CVE-A'],
      ['CVE-B', null],
      ['CVE-C', null],
    ]);
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

describe('readGateScan findings bound', () => {
  const finding = (index) => ({
    severity: 'LOW',
    packageVulnerabilityDetails: {
      vulnerabilityId: `CVE-${String(index).padStart(4, '0')}`,
      vulnerablePackages: [{ name: 'zlib', version: '1.3' }],
    },
  });
  const page = (from, to, nextToken) => ({
    imageScanStatus: { status: 'ACTIVE' },
    imageScanFindings: {
      imageScanCompletedAt: new Date(Date.now() - ENHANCED_SCAN_SETTLE_MS - 1000),
      findingSeverityCounts: to > from ? { LOW: to - from } : {},
      enhancedFindings: Array.from({ length: to - from }, (_, index) => finding(from + index)),
    },
    ...(nextToken ? { nextToken } : {}),
  });
  const read = (...pages) => {
    const send = vi.fn();
    for (const response of pages) send.mockResolvedValueOnce(response);
    return readGateScan({ ecrClient: { send }, repositoryName: 'core', imageDigest: digest });
  };

  it.each([
    ['every finding fits', [page(0, 60, 'p2'), page(60, MAX_GATE_SCAN_FINDINGS)], false],
    // A last page can be empty and still carry a token, then none.
    ['an empty last page', [page(0, MAX_GATE_SCAN_FINDINGS, 'p2'), page(0, 0)], false],
    ['one finding too many', [page(0, 60, 'p2'), page(60, MAX_GATE_SCAN_FINDINGS + 1)], true],
  ])('keeps the list complete when %s', async (_, pages, truncated) => {
    const result = await read(...pages);
    expect(result.findings).toHaveLength(MAX_GATE_SCAN_FINDINGS);
    expect(result.findingsTruncated).toBe(truncated);
    expect(result.incomplete).toBe(false);
  });

  // The gate retries on its next poll instead of judging a partial result.
  it('fails the read when a later page fails', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(page(0, 60, 'p2'))
      .mockRejectedValueOnce(
        Object.assign(new Error('throttled'), { name: 'ThrottlingException' }),
      );

    await expect(
      readGateScan({ ecrClient: { send }, repositoryName: 'core', imageDigest: digest }),
    ).rejects.toThrow('throttled');
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

describe('core image scan deadline across pages', () => {
  const stallMs = 150;
  const answerAfterMs = 80;
  let server;
  let attempts;

  // Every page stalls on its first attempt, past the request timeout, and
  // answers the retry late with one more page, so each page costs a timeout,
  // a backoff and a slow answer.
  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const page = Number(String(JSON.parse(body).nextToken ?? 'p1').slice(1));
        attempts.set(page, (attempts.get(page) ?? 0) + 1);
        if (attempts.get(page) === 1) return;
        const answer = setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
          response.end(
            JSON.stringify({
              imageScanStatus: { status: 'ACTIVE' },
              imageScanFindings: {
                findingSeverityCounts: { HIGH: 1 },
                enhancedFindings: [
                  {
                    severity: 'HIGH',
                    packageVulnerabilityDetails: {
                      vulnerabilityId: `CVE-${page}`,
                      vulnerablePackages: [{ name: 'krb5', version: '1.21.3' }],
                    },
                  },
                ],
              },
              nextToken: `p${page + 1}`,
            }),
          );
        }, answerAfterMs);
        response.on('close', () => clearTimeout(answer));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('stops at one deadline for every page and retry and keeps the pages read', async () => {
    attempts = new Map();
    const budgetMs = 500;
    const ecrClient = createScanReadClient({
      requestTimeout: stallMs,
      region: 'eu-west-1',
      endpoint: `http://127.0.0.1:${server.address().port}`,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const started = Date.now();

    const result = await readImageScanFindings({
      ecrClient,
      imageUri: '111111111111.dkr.ecr.eu-west-1.amazonaws.com/core',
      imageDigest: digest,
      budgetMs,
    });

    // Without the deadline the five pages take over 1.1 seconds. The deadline
    // cancels the call in flight; only the SDK retry backoff (up to 100 ms
    // after a timeout) does not stop on it.
    expect(Date.now() - started).toBeLessThan(budgetMs + 500);
    expect(attempts.size).toBeLessThan(5);
    expect(result).toMatchObject({ status: 'ACTIVE', incomplete: true, findingsTruncated: true });
    expect(result.severityCounts.HIGH).toBeGreaterThanOrEqual(1);
    expect(result.severityCounts.HIGH).toBeLessThan(5);
  });
});
