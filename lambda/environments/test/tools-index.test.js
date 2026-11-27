import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_TOOL_TEMPLATES } from '../tool-catalog.js';
import { createToolsHandler } from '../tools-index.js';

const java = SYSTEM_TOOL_TEMPLATES.find((tool) => tool.toolId === 'java');

const claims = (groups = 'platform-admin') => ({
  requestContext: {
    authorizer: {
      claims: {
        sub: 'user-1',
        email: 'admin@example.com',
        'cognito:groups': groups,
      },
    },
  },
});

const baseStore = () => ({
  seedSystemTools: vi.fn().mockResolvedValue([]),
  listVersionsByStatus: vi.fn().mockResolvedValue([]),
  listTools: vi.fn().mockResolvedValue([]),
  listAllVersions: vi.fn().mockResolvedValue([]),
});

describe('managed tool control API', () => {
  beforeEach(() => {
    vi.stubEnv('BUILD_CONTEXT_BUCKET', 'contexts');
    vi.stubEnv('TOOL_CODEBUILD_PROJECT', 'tool-build');
    vi.stubEnv('TOOL_ECR_REPOSITORY_URI', '111111111111.dkr.ecr.us-east-1.amazonaws.com/tools');
    vi.stubEnv('CORE_IMAGE_URI', '111111111111.dkr.ecr.us-east-1.amazonaws.com/core');
    vi.stubEnv('CORE_IMAGE_DIGEST', `sha256:${'a'.repeat(64)}`);
  });

  it('logs a sanitized API Gateway event when event logging is enabled', async () => {
    const eventLogger = { logEventIfEnabled: vi.fn() };
    const handler = createToolsHandler({ store: baseStore(), eventLogger });

    await handler({
      httpMethod: 'OPTIONS',
      path: '/tools',
      headers: { Authorization: 'Bearer admin-secret' },
      body: JSON.stringify({
        environmentVariables: { TOOL_TOKEN: 'tool-secret' },
      }),
    });

    const logged = eventLogger.logEventIfEnabled.mock.calls[0][0];
    expect(logged).not.toHaveProperty('headers');
    expect(JSON.stringify(logged)).not.toContain('admin-secret');
    expect(JSON.parse(logged.body).environmentVariables).toEqual({
      TOOL_TOKEN: '[REDACTED]',
    });
  });

  it('rejects non-admin catalog mutations', async () => {
    const handler = createToolsHandler({ store: baseStore() });
    const response = await handler({
      httpMethod: 'POST',
      path: '/tools',
      body: JSON.stringify({ name: '.NET SDK' }),
      ...claims('member'),
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'PLATFORM_ADMIN_REQUIRED',
    });
  });

  it('caches successful initialization across handler invocations', async () => {
    const store = baseStore();
    const handler = createToolsHandler({ store });

    await expect(handler({ action: 'bootstrap' })).resolves.toEqual({ initialized: true });
    await expect(handler({ action: 'bootstrap' })).resolves.toEqual({ initialized: true });

    expect(store.seedSystemTools).toHaveBeenCalledOnce();
    expect(store.listVersionsByStatus).toHaveBeenCalledTimes(2);
    expect(store.listVersionsByStatus).toHaveBeenNthCalledWith(1, 'DRAFT');
    expect(store.listVersionsByStatus).toHaveBeenNthCalledWith(2, 'FAILED');
  });

  it('retries initialization after a failure', async () => {
    const store = {
      ...baseStore(),
      seedSystemTools: vi
        .fn()
        .mockRejectedValueOnce(new Error('registry unavailable'))
        .mockResolvedValueOnce([]),
    };
    const handler = createToolsHandler({ store });

    await expect(handler({ action: 'bootstrap' })).rejects.toThrow('registry unavailable');
    await expect(handler({ action: 'bootstrap' })).resolves.toEqual({ initialized: true });

    expect(store.seedSystemTools).toHaveBeenCalledTimes(2);
  });

  it('automatically starts seeded tool drafts from the bootstrap event', async () => {
    const draft = {
      toolId: 'java',
      versionId: 'tv-java-21',
      status: 'DRAFT',
      autoBuild: true,
      buildAttempt: 0,
      definition: java.version,
    };
    const store = {
      ...baseStore(),
      listVersionsByStatus: vi
        .fn()
        .mockImplementation(async (status) => (status === 'DRAFT' ? [draft] : [])),
      getTool: vi.fn().mockResolvedValue(java),
      updateVersion: vi.fn().mockImplementation(async (_toolId, _versionId, patch) => ({
        ...draft,
        ...patch,
      })),
    };
    const s3Client = { send: vi.fn().mockResolvedValue({}) };
    const codebuildClient = {
      send: vi.fn().mockResolvedValue({
        build: {
          id: 'tool-build:1',
          arn: 'arn:aws:codebuild:us-east-1:111111111111:build/tool-build:1',
        },
      }),
    };
    const handler = createToolsHandler({ store, s3Client, codebuildClient });

    await expect(handler({ action: 'bootstrap' })).resolves.toEqual({ initialized: true });
    expect(store.seedSystemTools).toHaveBeenCalledOnce();
    expect(store.listVersionsByStatus).toHaveBeenCalledWith('FAILED');
    expect(s3Client.send).toHaveBeenCalled();
    expect(codebuildClient.send.mock.calls[0][0].input).toMatchObject({
      projectName: 'tool-build',
      environmentVariablesOverride: expect.arrayContaining([
        { name: 'TOOL_IMAGE_TAG', value: 'tv-java-21-a1', type: 'PLAINTEXT' },
      ]),
    });
    expect(store.updateVersion.mock.calls[0][2]).toMatchObject({
      buildId: null,
      imageDigest: null,
      scanFindings: null,
      securityFindingsAcceptedAt: null,
      securityFindingsAcceptedBy: null,
    });
  });

  it('keeps dependent seeded tools pending until their dependency is recommended', async () => {
    const maven = SYSTEM_TOOL_TEMPLATES.find((tool) => tool.toolId === 'maven');
    const draft = {
      toolId: 'maven',
      versionId: 'tv-maven-3',
      status: 'DRAFT',
      autoBuild: true,
      buildAttempt: 0,
      definition: maven.version,
    };
    const store = {
      ...baseStore(),
      listVersionsByStatus: vi
        .fn()
        .mockImplementation(async (status) => (status === 'DRAFT' ? [draft] : [])),
      getTool: vi.fn().mockImplementation(async (toolId) =>
        toolId === 'maven'
          ? maven
          : {
              toolId: 'java',
              recommendedVersionId: null,
            },
      ),
      getVersion: vi.fn(),
      updateVersion: vi.fn(),
    };
    const s3Client = { send: vi.fn() };
    const codebuildClient = { send: vi.fn() };
    const handler = createToolsHandler({ store, s3Client, codebuildClient });

    await expect(handler({ action: 'bootstrap' })).resolves.toEqual({ initialized: true });
    expect(store.updateVersion).not.toHaveBeenCalled();
    expect(s3Client.send).not.toHaveBeenCalled();
    expect(codebuildClient.send).not.toHaveBeenCalled();
  });

  it('automatically retries reconciled failed system tool versions', async () => {
    const failed = {
      toolId: 'rust',
      versionId: 'tv-rust-1',
      status: 'FAILED',
      autoBuild: true,
      buildAttempt: 1,
      definition: SYSTEM_TOOL_TEMPLATES.find((tool) => tool.toolId === 'rust').version,
    };
    const store = {
      ...baseStore(),
      listVersionsByStatus: vi
        .fn()
        .mockImplementation(async (status) => (status === 'FAILED' ? [failed] : [])),
      getTool: vi
        .fn()
        .mockResolvedValue(SYSTEM_TOOL_TEMPLATES.find((tool) => tool.toolId === 'rust')),
      updateVersion: vi.fn().mockImplementation(async (_toolId, _versionId, patch) => ({
        ...failed,
        ...patch,
      })),
    };
    const s3Client = { send: vi.fn().mockResolvedValue({}) };
    const codebuildClient = {
      send: vi.fn().mockResolvedValue({
        build: {
          id: 'tool-build:2',
          arn: 'arn:aws:codebuild:us-east-1:111111111111:build/tool-build:2',
        },
      }),
    };
    const handler = createToolsHandler({ store, s3Client, codebuildClient });

    await expect(handler({ action: 'bootstrap' })).resolves.toEqual({ initialized: true });

    expect(codebuildClient.send.mock.calls[0][0].input).toMatchObject({
      environmentVariablesOverride: expect.arrayContaining([
        { name: 'TOOL_IMAGE_TAG', value: 'tv-rust-1-a2', type: 'PLAINTEXT' },
      ]),
    });
    expect(store.updateVersion.mock.calls[0][3]).toEqual({ fromStatus: 'FAILED' });
  });

  it('rebuilds a version whose scan is unavailable, for an administrator only', async () => {
    const rust = SYSTEM_TOOL_TEMPLATES.find((tool) => tool.toolId === 'rust');
    const unavailable = {
      toolId: 'rust',
      versionId: 'tv-rust-1',
      status: 'SECURITY_REVIEW',
      buildAttempt: 1,
      definition: rust.version,
      scanFindings: { status: 'SCAN_ELIGIBILITY_EXPIRED', severityCounts: {}, findings: [] },
    };
    const store = {
      ...baseStore(),
      getTool: vi.fn().mockResolvedValue(rust),
      getVersion: vi.fn().mockResolvedValue(unavailable),
      updateVersion: vi.fn().mockImplementation(async (_toolId, _versionId, patch) => ({
        ...unavailable,
        ...patch,
      })),
    };
    const codebuildClient = {
      send: vi.fn().mockResolvedValue({
        build: {
          id: 'tool-build:2',
          arn: 'arn:aws:codebuild:us-east-1:111111111111:build/tool-build:2',
        },
      }),
    };
    const handler = createToolsHandler({
      store,
      s3Client: { send: vi.fn().mockResolvedValue({}) },
      codebuildClient,
    });
    const retry = (groups) =>
      handler({
        httpMethod: 'POST',
        path: '/tools/rust/versions/tv-rust-1/retry',
        ...claims(groups),
      });

    const denied = await retry('member');
    expect(denied.statusCode).toBe(403);
    expect(codebuildClient.send).not.toHaveBeenCalled();

    const accepted = await retry('platform-admin');
    expect(accepted.statusCode).toBe(202);
    expect(store.updateVersion.mock.calls[0][2]).toMatchObject({
      status: 'QUEUED',
      scanFindings: null,
      imageDigest: null,
    });
    expect(store.updateVersion.mock.calls[0][3]).toEqual({ fromStatus: 'SECURITY_REVIEW' });
  });

  describe('accepting the review of a tool version', () => {
    const rust = SYSTEM_TOOL_TEMPLATES.find((tool) => tool.toolId === 'rust');
    const imageDigest = `sha256:${'b'.repeat(64)}`;
    const shownAt = '2026-11-27T10:00:00.000Z';
    // What the dialog showed: ECR could not scan the image.
    const unavailable = {
      toolId: 'rust',
      versionId: 'tv-rust-1',
      status: 'SECURITY_REVIEW',
      definition: rust.version,
      imageDigest,
      scanFindings: {
        status: 'UNSUPPORTED',
        severityCounts: {},
        findings: [],
        evaluatedAt: shownAt,
        imageDigest,
      },
    };
    // What the recheck stored while the dialog was open.
    const rescanned = {
      ...unavailable,
      scanFindings: {
        status: 'ACTIVE',
        severityCounts: { CRITICAL: 1 },
        findings: [{ id: 'CVE-2026-9', severity: 'CRITICAL' }],
        evaluatedAt: '2026-11-27T10:15:00.000Z',
        imageDigest,
      },
    };
    const storeWith = (version, updateVersion) => ({
      ...baseStore(),
      getTool: vi.fn().mockResolvedValue(rust),
      getVersion: vi.fn().mockResolvedValue(version),
      updateVersion:
        updateVersion ??
        vi.fn().mockImplementation(async (_toolId, _versionId, patch) => ({
          ...version,
          ...patch,
        })),
    });
    const acknowledge = (store, body) =>
      createToolsHandler({ store })({
        httpMethod: 'POST',
        path: '/tools/rust/versions/tv-rust-1/acknowledge',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...claims(),
      });

    it('records the decision on the image and scan the administrator saw', async () => {
      const store = storeWith(unavailable);

      const accepted = await acknowledge(store, { imageDigest, scanEvaluatedAt: shownAt });

      expect(accepted.statusCode).toBe(200);
      expect(store.updateVersion).toHaveBeenCalledOnce();
      expect(store.updateVersion.mock.calls[0][2]).toMatchObject({
        status: 'READY',
        securityFindingsAcceptedBy: expect.anything(),
        verification: { securityScan: 'ACCEPTED' },
      });
      expect(store.updateVersion.mock.calls[0][3]).toEqual({
        fromStatus: 'SECURITY_REVIEW',
        imageDigest,
        scanEvaluatedAt: shownAt,
      });
    });

    it('refuses a decision on a scan the recheck has replaced', async () => {
      const store = storeWith(rescanned);

      const refused = await acknowledge(store, { imageDigest, scanEvaluatedAt: shownAt });

      expect(refused.statusCode).toBe(409);
      expect(JSON.parse(refused.body)).toMatchObject({ code: 'TOOL_SCAN_CHANGED' });
      expect(store.updateVersion).not.toHaveBeenCalled();
    });

    it('refuses a decision on an image a rebuild has replaced', async () => {
      const store = storeWith(unavailable);

      const refused = await acknowledge(store, {
        imageDigest: `sha256:${'c'.repeat(64)}`,
        scanEvaluatedAt: shownAt,
      });

      expect(refused.statusCode).toBe(409);
      expect(JSON.parse(refused.body)).toMatchObject({ code: 'TOOL_SCAN_CHANGED' });
      expect(store.updateVersion).not.toHaveBeenCalled();
    });

    it.each([
      ['no body', undefined],
      ['a null body', null],
      ['an empty body', {}],
    ])('asks a client that sends %s to review the scan again', async (_label, body) => {
      const store = storeWith(unavailable);

      const refused = await acknowledge(store, body);

      expect(refused.statusCode).toBe(400);
      expect(JSON.parse(refused.body)).toMatchObject({ code: 'TOOL_SCAN_REVIEW_REQUIRED' });
      expect(store.updateVersion).not.toHaveBeenCalled();
    });

    it('records a decision on a version stored without a scan time or image', async () => {
      const { imageDigest: _digest, ...legacy } = unavailable;
      const { evaluatedAt: _evaluatedAt, ...legacyScan } = unavailable.scanFindings;
      const store = storeWith({ ...legacy, scanFindings: legacyScan });

      const accepted = await acknowledge(store, { imageDigest: null, scanEvaluatedAt: null });

      expect(accepted.statusCode).toBe(200);
      expect(store.updateVersion.mock.calls[0][3]).toEqual({
        fromStatus: 'SECURITY_REVIEW',
        imageDigest: null,
        scanEvaluatedAt: null,
      });
    });

    it('refuses the decision when the scan changes between the read and the write', async () => {
      const store = storeWith(
        unavailable,
        vi.fn().mockRejectedValue(
          Object.assign(new Error('The conditional request failed'), {
            name: 'ConditionalCheckFailedException',
          }),
        ),
      );

      const refused = await acknowledge(store, { imageDigest, scanEvaluatedAt: shownAt });

      expect(refused.statusCode).toBe(409);
      expect(JSON.parse(refused.body)).toMatchObject({ code: 'TOOL_SCAN_CHANGED' });
    });
  });

  it('marks environments when a published version becomes recommended', async () => {
    const tool = {
      toolId: 'java',
      recommendedVersionId: null,
    };
    const store = {
      ...baseStore(),
      getTool: vi.fn().mockResolvedValue(tool),
      getVersion: vi.fn().mockResolvedValue({
        toolId: 'java',
        versionId: 'tv-java-21',
        status: 'PUBLISHED',
        definition: { dependencies: [] },
      }),
      listTools: vi.fn().mockResolvedValue([tool]),
      listAllVersions: vi.fn().mockResolvedValue([
        {
          toolId: 'java',
          versionId: 'tv-java-21',
          status: 'PUBLISHED',
          definition: { dependencies: [] },
        },
      ]),
      setRecommendedVersion: vi.fn().mockResolvedValue({
        ...tool,
        recommendedVersionId: 'tv-java-21',
      }),
    };
    const environmentStore = {
      markToolUpdatesAvailable: vi.fn().mockResolvedValue([{ environmentId: 'backend' }]),
    };
    const handler = createToolsHandler({ store, environmentStore });
    const response = await handler({
      httpMethod: 'PUT',
      path: '/tools/java/recommended',
      body: JSON.stringify({ versionId: 'tv-java-21' }),
      ...claims(),
    });

    expect(response.statusCode).toBe(200);
    expect(store.setRecommendedVersion).toHaveBeenCalledWith({
      toolId: 'java',
      versionId: 'tv-java-21',
      actor: 'admin@example.com',
      architecture: 'arm64',
    });
    expect(environmentStore.markToolUpdatesAvailable).toHaveBeenCalledWith(
      'java',
      'tv-java-21',
      'arm64',
    );
  });

  it('rejects missing and cyclic recommended dependencies', async () => {
    const javaTool = { toolId: 'java', recommendedVersionId: 'tv-java-21' };
    const mavenTool = { toolId: 'maven', recommendedVersionId: null };
    const javaVersion = {
      toolId: 'java',
      versionId: 'tv-java-21',
      status: 'PUBLISHED',
      definition: { dependencies: ['maven'] },
    };
    const mavenVersion = {
      toolId: 'maven',
      versionId: 'tv-maven-3',
      status: 'PUBLISHED',
      definition: { dependencies: ['java'] },
    };
    const store = {
      ...baseStore(),
      getTool: vi
        .fn()
        .mockImplementation(async (toolId) => (toolId === 'maven' ? mavenTool : javaTool)),
      getVersion: vi.fn().mockResolvedValue(mavenVersion),
      listTools: vi.fn().mockResolvedValue([javaTool, mavenTool]),
      listAllVersions: vi.fn().mockResolvedValue([javaVersion, mavenVersion]),
      setRecommendedVersion: vi.fn(),
    };
    const handler = createToolsHandler({ store });
    const response = await handler({
      httpMethod: 'PUT',
      path: '/tools/maven/recommended',
      body: JSON.stringify({ versionId: 'tv-maven-3' }),
      ...claims(),
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'TOOL_DEPENDENCY_CYCLE' });
    expect(store.setRecommendedVersion).not.toHaveBeenCalled();
  });
});
