import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createToolsStatusHandler } from '../tools-status.js';

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

const ecrClient = ({ severityCounts = {}, imageSizeInBytes = 1000 } = {}) => ({
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
      imageScanStatus: { status: 'COMPLETE' },
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
});
