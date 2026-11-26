import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UNAVAILABLE_SCAN_RECHECK_MS, createToolsStatusHandler } from '../tools-status.js';
import { ENHANCED_SCAN_SETTLE_MS } from '../build-lifecycle.js';

const initialVersion = {
  toolId: 'dotnet-sdk',
  versionId: 'tv-dotnet-8',
  status: 'BUILDING',
  imageTag: 'tv-dotnet-8-a1',
  contextPrefix: 'managed-tools/contexts/dotnet-sdk/tv-dotnet-8/a1',
};

const mutableStore = () => {
  let version = initialVersion;
  return {
    get current() {
      return version;
    },
    getLookup: vi.fn().mockResolvedValue({
      toolId: initialVersion.toolId,
      versionId: initialVersion.versionId,
    }),
    getVersion: vi.fn().mockImplementation(async () => version),
    updateVersion: vi.fn().mockImplementation(async (_toolId, _versionId, patch) => {
      version = { ...version, ...patch };
      return version;
    }),
    listVersionsByStatus: vi
      .fn()
      .mockImplementation(async (status) => (version.status === status ? [version] : [])),
  };
};

const s3Client = {
  send: vi.fn().mockResolvedValue({
    Body: {
      transformToString: async () =>
        JSON.stringify({
          source: {
            requestedUrl: 'https://example.test/dotnet.tar.gz',
            resolvedUrl: 'https://example.test/dotnet.tar.gz',
            sha256: 'a'.repeat(64),
            sizeBytes: 1024,
            trustLevel: 'PLATFORM_PINNED',
          },
          imageSizeBytes: 1000,
          verification: {
            status: 'PASSED',
            architecture: 'arm64',
            nonRoot: true,
            networkless: true,
            sbom: true,
          },
        }),
    },
  }),
};

const buildEvent = {
  source: 'aws.codebuild',
  detail: {
    'build-id': 'tool-build:1',
    'build-status': 'SUCCEEDED',
  },
};

const ecrClient = ({
  severityCounts = {},
  imageSizeInBytes = 1000,
  scanStatus = 'COMPLETE',
  scanDescription,
} = {}) => ({
  send: vi
    .fn()
    .mockResolvedValueOnce({
      imageDetails: [
        {
          imageDigest: `sha256:${'b'.repeat(64)}`,
          imageSizeInBytes,
        },
      ],
    })
    .mockResolvedValueOnce({
      imageScanStatus: {
        status: scanStatus,
        ...(scanDescription ? { description: scanDescription } : {}),
      },
      imageScanFindings: {
        findingSeverityCounts: severityCounts,
        findings:
          Number(severityCounts.HIGH ?? 0) > 0
            ? [
                {
                  name: 'CVE-2026-1000',
                  severity: 'HIGH',
                  attributes: [{ key: 'package_name', value: 'runtime' }],
                },
              ]
            : [],
      },
    }),
});

describe('managed tool build status', () => {
  beforeEach(() => {
    vi.stubEnv('BUILD_CONTEXT_BUCKET', 'contexts');
    vi.stubEnv('TOOL_ECR_REPOSITORY_NAME', 'tools');
    vi.stubEnv('TOOL_ECR_REPOSITORY_URI', 'registry/tools');
    vi.stubEnv('MAX_TOOL_IMAGE_MB', '1536');
  });

  it('records clean verified artifacts as READY', async () => {
    const store = mutableStore();
    const handler = createToolsStatusHandler({
      store,
      ecrClient: ecrClient(),
      s3Client,
    });

    const result = await handler(buildEvent);

    expect(result.version).toMatchObject({
      status: 'READY',
      imageUri: 'registry/tools',
      imageDigest: `sha256:${'b'.repeat(64)}`,
      source: { trustLevel: 'PLATFORM_PINNED' },
      verification: {
        status: 'PASSED',
        securityScan: 'PASSED',
        sbom: true,
      },
    });
  });

  it('retains Critical and High findings for explicit administrator acceptance', async () => {
    const store = mutableStore();
    const handler = createToolsStatusHandler({
      store,
      ecrClient: ecrClient({ severityCounts: { CRITICAL: 1, HIGH: 2 } }),
      s3Client,
    });

    const result = await handler(buildEvent);

    expect(result.version).toMatchObject({
      status: 'SECURITY_REVIEW',
      failure: null,
      scanFindings: {
        severityCounts: { CRITICAL: 1, HIGH: 2 },
        findings: [
          {
            id: 'CVE-2026-1000',
            severity: 'HIGH',
            packageName: 'runtime',
          },
        ],
      },
    });
  });

  it('judges an enhanced tool scan only once its findings have had time to reach ECR', async () => {
    const store = mutableStore();
    const enhancedClient = (completedAgoMs, severityCounts) => ({
      send: vi
        .fn()
        .mockResolvedValueOnce({
          imageDetails: [{ imageDigest: `sha256:${'b'.repeat(64)}`, imageSizeInBytes: 1000 }],
        })
        .mockResolvedValueOnce({
          imageScanStatus: { status: 'ACTIVE' },
          imageScanFindings: {
            imageScanCompletedAt: new Date(Date.now() - completedAgoMs),
            findingSeverityCounts: severityCounts,
          },
        }),
    });
    const inspect = (client) =>
      createToolsStatusHandler({ store, ecrClient: client, s3Client })(buildEvent);

    // A read seconds after the scan sees none of the findings, or only some.
    let result = await inspect(enhancedClient(13_000, {}));
    expect(result).toMatchObject({ pending: true, version: { status: 'SCANNING' } });
    result = await inspect(enhancedClient(13_000, { HIGH: 5 }));
    expect(result).toMatchObject({ pending: true, version: { status: 'SCANNING' } });

    result = await inspect(
      enhancedClient(ENHANCED_SCAN_SETTLE_MS + 1000, { CRITICAL: 1, HIGH: 13 }),
    );
    expect(result.version).toMatchObject({
      status: 'SECURITY_REVIEW',
      scanFindings: { status: 'ACTIVE', severityCounts: { CRITICAL: 1, HIGH: 13 } },
    });
  });

  it('sends an enhanced tool scan cut at the page bound to review', async () => {
    const store = mutableStore();
    const client = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          imageDetails: [{ imageDigest: `sha256:${'b'.repeat(64)}`, imageSizeInBytes: 1000 }],
        })
        .mockResolvedValue({
          imageScanStatus: { status: 'ACTIVE' },
          imageScanFindings: {
            imageScanCompletedAt: new Date(Date.now() - ENHANCED_SCAN_SETTLE_MS - 1000),
            findingSeverityCounts: { LOW: 1 },
          },
          nextToken: 'more',
        }),
    };

    const result = await createToolsStatusHandler({ store, ecrClient: client, s3Client })(
      buildEvent,
    );

    expect(result.version).toMatchObject({
      status: 'SECURITY_REVIEW',
      scanFindings: { severityCounts: { LOW: 50 }, findingsTruncated: true, incomplete: true },
    });
  });

  it('keeps a Critical tool finding from a later page for review', async () => {
    const store = mutableStore();
    const finding = (severity, id) => ({
      severity,
      packageVulnerabilityDetails: {
        vulnerabilityId: id,
        vulnerablePackages: [{ name: 'stdlib', version: 'go1.27.4' }],
      },
    });
    const page = (severityCounts, enhancedFindings, nextToken) => ({
      imageScanStatus: { status: 'ACTIVE' },
      imageScanFindings: {
        imageScanCompletedAt: new Date(Date.now() - ENHANCED_SCAN_SETTLE_MS - 1000),
        findingSeverityCounts: severityCounts,
        enhancedFindings,
      },
      ...(nextToken ? { nextToken } : {}),
    });
    const client = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          imageDetails: [{ imageDigest: `sha256:${'b'.repeat(64)}`, imageSizeInBytes: 1000 }],
        })
        .mockResolvedValueOnce(
          page(
            { LOW: 100 },
            Array.from({ length: 100 }, (_, index) => finding('LOW', `CVE-LOW-${index}`)),
            'page-2',
          ),
        )
        .mockResolvedValueOnce(page({ CRITICAL: 1 }, [finding('CRITICAL', 'CVE-CRITICAL')])),
    };

    const result = await createToolsStatusHandler({ store, ecrClient: client, s3Client })(
      buildEvent,
    );

    expect(result.version.status).toBe('SECURITY_REVIEW');
    expect(result.version.scanFindings).toMatchObject({
      severityCounts: { CRITICAL: 1, LOW: 100 },
      findingsTruncated: true,
    });
    expect(result.version.scanFindings).not.toHaveProperty('incomplete');
    expect(result.version.scanFindings.findings).toHaveLength(100);
    expect(result.version.scanFindings.findings[0]).toMatchObject({
      id: 'CVE-CRITICAL',
      severity: 'CRITICAL',
      packageName: 'stdlib',
    });
  });

  it('routes unsupported artifact scans to explicit administrator review', async () => {
    const store = mutableStore();
    const handler = createToolsStatusHandler({
      store,
      ecrClient: ecrClient({
        scanStatus: 'FAILED',
        scanDescription:
          'UnsupportedImageError: The operating system and/or package manager are not supported.',
      }),
      s3Client,
    });

    const result = await handler(buildEvent);

    expect(result.version).toMatchObject({
      status: 'SECURITY_REVIEW',
      failure: null,
      scanFindings: {
        status: 'UNSUPPORTED',
        description:
          'UnsupportedImageError: The operating system and/or package manager are not supported.',
        severityCounts: {},
        findings: [],
      },
      verification: {
        status: 'PASSED',
        securityScan: 'UNSUPPORTED',
      },
    });
  });

  it('fails artifacts that exceed the configured size limit', async () => {
    const store = mutableStore();
    const handler = createToolsStatusHandler({
      store,
      ecrClient: ecrClient({ imageSizeInBytes: 1537 * 1024 * 1024 }),
      s3Client,
    });

    const result = await handler(buildEvent);

    expect(result.version).toMatchObject({
      status: 'FAILED',
      imageUri: 'registry/tools',
      imageDigest: `sha256:${'b'.repeat(64)}`,
      source: { trustLevel: 'PLATFORM_PINNED' },
      verification: { status: 'PASSED' },
      failure: { reason: 'tool_image_size_exceeded' },
    });
  });

  it('retains source provenance when installation fails after download', async () => {
    const store = mutableStore();
    const source = {
      requestedUrl: 'https://example.test/dotnet.tar.gz',
      resolvedUrl: 'https://cdn.example.test/dotnet.tar.gz',
      sha256: 'a'.repeat(64),
      sizeBytes: 1024,
      trustLevel: 'PLATFORM_PINNED',
    };
    const handler = createToolsStatusHandler({
      store,
      ecrClient: { send: vi.fn() },
      s3Client: {
        send: vi.fn().mockResolvedValue({
          Body: { transformToString: async () => JSON.stringify(source) },
        }),
      },
    });

    const result = await handler({
      source: 'aws.codebuild',
      detail: {
        'build-id': 'tool-build:1',
        'build-status': 'FAILED',
      },
    });

    expect(result.version).toMatchObject({
      status: 'FAILED',
      source,
      failure: { reason: 'tool_build_failed' },
    });
  });

  it('keeps a successful build pending until its result object is visible', async () => {
    const store = mutableStore();
    const missing = Object.assign(new Error('The specified key does not exist'), {
      name: 'NoSuchKey',
    });
    const handler = createToolsStatusHandler({
      store,
      ecrClient: { send: vi.fn() },
      s3Client: { send: vi.fn().mockRejectedValue(missing) },
    });

    const result = await handler(buildEvent);

    expect(result).toMatchObject({ pending: true });
    expect(store.current.status).toBe('BUILDING');
    expect(store.updateVersion).not.toHaveBeenCalled();
  });

  describe('a version whose image ECR could not scan', () => {
    const digest = `sha256:${'b'.repeat(64)}`;
    const NOW = Date.parse('2026-11-25T12:00:00.000Z');
    const stale = new Date(NOW - UNAVAILABLE_SCAN_RECHECK_MS).toISOString();
    const unsupportedVersion = (overrides = {}) => ({
      ...initialVersion,
      status: 'SECURITY_REVIEW',
      imageUri: 'registry/tools',
      imageDigest: digest,
      verification: { status: 'PASSED', securityScan: 'UNSUPPORTED' },
      scanFindings: {
        status: 'UNSUPPORTED',
        description:
          'UnsupportedImageError: The operating system and/or package manager are not supported.',
        severityCounts: {},
        findings: [],
        findingsTruncated: false,
        evaluatedAt: stale,
        imageDigest: digest,
      },
      ...overrides,
    });
    // A registry of versions with the conditions DynamoDB applies.
    const storeWith = (...versions) => {
      const records = new Map(versions.map((version) => [version.versionId, version]));
      const conditional = () =>
        Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
      return {
        records,
        version: (versionId = initialVersion.versionId) => records.get(versionId),
        getVersion: vi.fn(async (_toolId, versionId) => records.get(versionId)),
        listVersionsByStatus: vi.fn(async (status) =>
          [...records.values()].filter((version) => version.status === status),
        ),
        claimScanRecheck: vi.fn(async (_toolId, versionId, { previous, at }) => {
          const current = records.get(versionId);
          if (current.status !== 'SECURITY_REVIEW') return false;
          if ((current.scanRecheckedAt ?? null) !== previous) return false;
          records.set(versionId, { ...current, scanRecheckedAt: at });
          return true;
        }),
        updateVersion: vi.fn(async (_toolId, versionId, patch, options = {}) => {
          const current = records.get(versionId);
          if (options.fromStatus && options.fromStatus !== current.status) throw conditional();
          if (options.imageDigest && options.imageDigest !== current.imageDigest) {
            throw conditional();
          }
          const updated = { ...current, ...patch };
          records.set(versionId, updated);
          return updated;
        }),
      };
    };
    // An enhanced scan finished an hour ago, so its findings have settled.
    const enhancedScan = (findings) => ({
      imageScanStatus: { status: 'ACTIVE' },
      imageScanFindings: {
        imageScanCompletedAt: new Date(NOW - 60 * 60 * 1000),
        findingSeverityCounts: findings.reduce(
          (counts, finding) => ({
            ...counts,
            [finding.severity]: (counts[finding.severity] ?? 0) + 1,
          }),
          {},
        ),
        enhancedFindings: findings,
      },
    });
    const high = {
      severity: 'HIGH',
      packageVulnerabilityDetails: {
        vulnerabilityId: 'CVE-2026-1000',
        vulnerablePackages: [{ name: 'stdlib', version: 'go1.24.6' }],
      },
    };
    const unsupportedScan = {
      imageScanStatus: {
        status: 'FAILED',
        description:
          'UnsupportedImageError: The operating system and/or package manager are not supported.',
      },
      imageScanFindings: {},
    };
    const poll = async (store, answer, now = NOW) => {
      const ecr = {
        send: vi.fn(async () => {
          const response = typeof answer === 'function' ? await answer() : answer;
          if (response instanceof Error) throw response;
          return response;
        }),
      };
      const handler = createToolsStatusHandler({ store, ecrClient: ecr, s3Client, now: () => now });
      return { ecr, result: await handler({ action: 'poll' }) };
    };

    it('sends the version to the normal review once an enhanced scan has findings', async () => {
      const store = storeWith(unsupportedVersion());
      const { ecr, result } = await poll(store, enhancedScan([high]));

      expect(ecr.send.mock.calls[0][0].input).toEqual({
        repositoryName: 'tools',
        imageId: { imageDigest: digest },
      });
      // The read is bounded: a stalled ECR call is cancelled.
      expect(ecr.send.mock.calls[0][1].abortSignal).toBeInstanceOf(AbortSignal);
      expect(result.rechecked).toEqual(['review']);
      expect(store.version()).toMatchObject({
        status: 'SECURITY_REVIEW',
        scanFindings: {
          status: 'ACTIVE',
          severityCounts: { HIGH: 1 },
          findings: [{ id: 'CVE-2026-1000', severity: 'HIGH' }],
          imageDigest: digest,
        },
      });
    });

    it('makes the version ready once an enhanced scan has no Critical or High finding', async () => {
      const store = storeWith(unsupportedVersion());
      await poll(store, enhancedScan([]));

      expect(store.version()).toMatchObject({
        status: 'READY',
        scanFindings: { status: 'ACTIVE', severityCounts: {} },
        verification: { status: 'PASSED', securityScan: 'PASSED' },
      });
    });

    it('records that ECR no longer scans the image, without failing the version', async () => {
      const store = storeWith(unsupportedVersion());
      await poll(store, {
        imageScanStatus: {
          status: 'SCAN_ELIGIBILITY_EXPIRED',
          description: `The image is no longer eligible for scanning. ${'x'.repeat(600)}`,
        },
        imageScanFindings: {},
      });

      expect(store.version()).toMatchObject({
        status: 'SECURITY_REVIEW',
        failure: null,
        scanFindings: { status: 'SCAN_ELIGIBILITY_EXPIRED' },
        verification: { securityScan: 'SCAN_ELIGIBILITY_EXPIRED' },
      });
      expect(store.version().scanFindings.description).toHaveLength(500);

      // An expired scan only changes with a rebuild: later polls leave it alone.
      const later = await poll(store, enhancedScan([high]), NOW + 2 * UNAVAILABLE_SCAN_RECHECK_MS);
      expect(later.ecr.send).not.toHaveBeenCalled();
    });

    it('writes nothing but the check time while ECR still cannot scan the image', async () => {
      const store = storeWith(unsupportedVersion());
      const { result } = await poll(store, unsupportedScan);

      expect(result.rechecked).toEqual(['unchanged']);
      expect(store.updateVersion).not.toHaveBeenCalled();
      expect(store.version().scanFindings.evaluatedAt).toBe(stale);
      expect(store.version().scanRecheckedAt).toBe(new Date(NOW).toISOString());

      const soon = await poll(store, enhancedScan([]), NOW + 60 * 1000);
      expect(soon.ecr.send).not.toHaveBeenCalled();
      await poll(store, enhancedScan([]), NOW + UNAVAILABLE_SCAN_RECHECK_MS);
      expect(store.version().status).toBe('READY');
    });

    it('leaves a scan state the next check may clear as it is', async () => {
      const store = storeWith(unsupportedVersion());
      const { result } = await poll(store, {
        imageScanStatus: { status: 'FINDINGS_UNAVAILABLE' },
        imageScanFindings: {},
      });

      expect(result.rechecked).toEqual(['unchanged']);
      expect(store.updateVersion).not.toHaveBeenCalled();
    });

    it('does not read ECR again before the recheck interval', async () => {
      const recent = new Date(NOW - UNAVAILABLE_SCAN_RECHECK_MS + 1000).toISOString();
      const store = storeWith(
        unsupportedVersion({
          scanFindings: { ...unsupportedVersion().scanFindings, evaluatedAt: recent },
        }),
      );
      const { ecr } = await poll(store, enhancedScan([]));

      expect(ecr.send).not.toHaveBeenCalled();
      expect(store.claimScanRecheck).not.toHaveBeenCalled();
    });

    it('checks a version stored without evaluatedAt', async () => {
      const { evaluatedAt: _evaluatedAt, ...scanFindings } = unsupportedVersion().scanFindings;
      const store = storeWith(unsupportedVersion({ scanFindings }));
      await poll(store, enhancedScan([]));

      expect(store.version().status).toBe('READY');
    });

    it('checks one version per poll, the one checked longest ago first', async () => {
      const older = new Date(NOW - 3 * UNAVAILABLE_SCAN_RECHECK_MS).toISOString();
      const store = storeWith(
        unsupportedVersion(),
        unsupportedVersion({
          versionId: 'tv-dotnet-9',
          scanFindings: { ...unsupportedVersion().scanFindings, evaluatedAt: older },
        }),
      );
      const { ecr } = await poll(store, enhancedScan([]));

      expect(ecr.send).toHaveBeenCalledTimes(1);
      expect(store.version('tv-dotnet-9').status).toBe('READY');
      expect(store.version().status).toBe('SECURITY_REVIEW');
    });

    it('does not check a version another poll has just claimed', async () => {
      const store = storeWith(unsupportedVersion());
      store.claimScanRecheck.mockResolvedValueOnce(false);
      const { ecr, result } = await poll(store, enhancedScan([]));

      expect(ecr.send).not.toHaveBeenCalled();
      expect(result.rechecked).toEqual([]);
    });

    it('checks the next due version when another poll claimed the first', async () => {
      const older = new Date(NOW - 3 * UNAVAILABLE_SCAN_RECHECK_MS).toISOString();
      const store = storeWith(
        unsupportedVersion({
          versionId: 'tv-dotnet-9',
          scanFindings: { ...unsupportedVersion().scanFindings, evaluatedAt: older },
        }),
        unsupportedVersion(),
      );
      store.claimScanRecheck.mockResolvedValueOnce(false);
      const { ecr } = await poll(store, enhancedScan([]));

      expect(ecr.send).toHaveBeenCalledTimes(1);
      expect(store.version().status).toBe('READY');
      expect(store.version('tv-dotnet-9').status).toBe('SECURITY_REVIEW');
    });

    it('counts a rebuild as a check, even after an older recheck', async () => {
      const recent = new Date(NOW - 60 * 1000).toISOString();
      const store = storeWith(
        unsupportedVersion({
          scanRecheckedAt: new Date(NOW - 10 * UNAVAILABLE_SCAN_RECHECK_MS).toISOString(),
          scanFindings: { ...unsupportedVersion().scanFindings, evaluatedAt: recent },
        }),
      );
      const { ecr } = await poll(store, enhancedScan([]));

      expect(ecr.send).not.toHaveBeenCalled();
    });

    it('gives up a read that passes the deadline and waits for the next interval', async () => {
      const store = storeWith(unsupportedVersion());
      const ecr = {
        send: vi.fn(
          (_command, { abortSignal }) =>
            new Promise((_resolve, reject) =>
              abortSignal.addEventListener('abort', () => reject(abortSignal.reason)),
            ),
        ),
      };
      const handler = createToolsStatusHandler({
        store,
        ecrClient: ecr,
        s3Client,
        now: () => NOW,
        recheckBudgetMs: 20,
      });

      await expect(handler({ action: 'poll' })).resolves.toMatchObject({ rechecked: ['failed'] });
      expect(store.updateVersion).not.toHaveBeenCalled();
      expect(store.version().scanRecheckedAt).toBe(new Date(NOW).toISOString());
    });

    it('keeps an administrator decision taken while the scan was read', async () => {
      const store = storeWith(unsupportedVersion());
      const { result } = await poll(store, async () => {
        // The administrator continues without a scan in the meantime.
        store.records.set(initialVersion.versionId, {
          ...store.version(),
          status: 'READY',
          securityFindingsAcceptedAt: '2026-11-25T11:59:00.000Z',
        });
        return enhancedScan([high]);
      });

      expect(result.rechecked).toEqual(['superseded']);
      expect(store.version()).toMatchObject({
        status: 'READY',
        securityFindingsAcceptedAt: '2026-11-25T11:59:00.000Z',
        scanFindings: { status: 'UNSUPPORTED' },
      });
    });

    it('does not write the old image scan over a version rebuilt in the meantime', async () => {
      const store = storeWith(unsupportedVersion());
      const rebuilt = `sha256:${'d'.repeat(64)}`;
      const { result } = await poll(store, async () => {
        store.records.set(initialVersion.versionId, { ...store.version(), imageDigest: rebuilt });
        return enhancedScan([]);
      });

      expect(result.rechecked).toEqual(['superseded']);
      expect(store.version()).toMatchObject({ status: 'SECURITY_REVIEW', imageDigest: rebuilt });
    });

    it('leaves the version unchanged when ECR fails, until the next interval', async () => {
      const store = storeWith(unsupportedVersion());
      const { result } = await poll(
        store,
        Object.assign(new Error('throttled'), { name: 'ThrottlingException' }),
      );

      expect(result.rechecked).toEqual(['failed']);
      expect(store.updateVersion).not.toHaveBeenCalled();
      const next = await poll(store, enhancedScan([]), NOW + 60 * 1000);
      expect(next.ecr.send).not.toHaveBeenCalled();
    });

    it('waits while an enhanced scan is still settling, until the next interval', async () => {
      const store = storeWith(unsupportedVersion());
      const settling = enhancedScan([high]);
      settling.imageScanFindings.imageScanCompletedAt = new Date(NOW - 60 * 1000);
      const { result } = await poll(store, settling);

      expect(result.rechecked).toEqual(['pending']);
      expect(store.updateVersion).not.toHaveBeenCalled();
      expect(store.version().scanRecheckedAt).toBe(new Date(NOW).toISOString());
    });

    it('treats a refused transition as a decision taken in the meantime', async () => {
      const store = storeWith(unsupportedVersion());
      store.updateVersion.mockRejectedValueOnce(
        Object.assign(new Error('Invalid tool version transition: QUEUED -> READY'), {
          statusCode: 409,
        }),
      );
      const { result } = await poll(store, enhancedScan([]));

      expect(result.rechecked).toEqual(['superseded']);
    });

    it('skips a version without an image', async () => {
      const store = storeWith(unsupportedVersion({ imageDigest: null }));
      const { ecr } = await poll(store, enhancedScan([]));

      expect(ecr.send).not.toHaveBeenCalled();
    });

    it('leaves a version under review with findings to the administrator', async () => {
      const store = storeWith(
        unsupportedVersion({
          scanFindings: { status: 'ACTIVE', severityCounts: { HIGH: 1 }, evaluatedAt: stale },
        }),
      );
      const { ecr } = await poll(store, enhancedScan([]));

      expect(ecr.send).not.toHaveBeenCalled();
      expect(store.version().status).toBe('SECURITY_REVIEW');
    });
  });
});
