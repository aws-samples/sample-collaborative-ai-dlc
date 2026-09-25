import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHandler } from '../index.js';

const BASE = {
  environmentId: 'standard',
  revisionId: 'core-1',
  imageUri: '111111111111.dkr.ecr.eu-west-1.amazonaws.com/core',
  imageDigest: `sha256:${'a'.repeat(64)}`,
};

const RECIPE = {
  schemaVersion: 1,
  base: BASE,
  tools: { node: { version: '24.15.0', source: 'base' } },
  buildTools: {},
  aptPackages: [],
  environmentVariables: {},
  buildCommands: [],
};

const CATALOG_RECIPE = {
  schemaVersion: 2,
  base: BASE,
  toolVersionIds: [],
  tools: [],
  resolvedTools: [],
  aptPackages: [],
  environmentVariables: {},
  buildCommands: [],
};

const claims = (groups = 'member') => ({
  requestContext: {
    authorizer: {
      claims: {
        sub: 'user-1',
        email: 'user@example.com',
        'cognito:groups': groups,
      },
    },
  },
});

const storeBase = () => ({
  seedSystemEnvironments: vi.fn(),
  stageCoreRevision: vi.fn(),
  reconcileBaseUpdates: vi.fn(),
});

describe('managed environment handler', () => {
  beforeEach(() => {
    vi.stubEnv('CORE_IMAGE_URI', BASE.imageUri);
    vi.stubEnv('CORE_IMAGE_DIGEST', BASE.imageDigest);
    vi.stubEnv('CORE_RUNTIME_ARN', 'arn:aws:bedrock-agentcore:eu-west-1:111111111111:runtime/core');
    vi.stubEnv('BUILD_CONTEXT_BUCKET', 'contexts');
    vi.stubEnv('ENVIRONMENT_CODEBUILD_PROJECT', 'environment-build');
    vi.stubEnv(
      'ENVIRONMENT_ECR_REPOSITORY_URI',
      '111111111111.dkr.ecr.eu-west-1.amazonaws.com/environments',
    );
    vi.stubEnv('ENVIRONMENT_ECR_REPOSITORY_NAME', 'environments');
  });

  it('logs a sanitized API Gateway event when event logging is enabled', async () => {
    const eventLogger = { logEventIfEnabled: vi.fn() };
    const handler = createHandler({ store: storeBase(), eventLogger });

    await handler({
      httpMethod: 'OPTIONS',
      path: '/environments',
      headers: { Authorization: 'Bearer admin-secret' },
      body: JSON.stringify({
        recipe: { environmentVariables: { SERVICE_TOKEN: 'recipe-secret' } },
      }),
    });

    const logged = eventLogger.logEventIfEnabled.mock.calls[0][0];
    expect(logged).not.toHaveProperty('headers');
    expect(JSON.stringify(logged)).not.toContain('admin-secret');
    expect(JSON.parse(logged.body).recipe.environmentVariables).toEqual({
      SERVICE_TOKEN: '[REDACTED]',
    });
  });

  it('allows authenticated users to list only published environments', async () => {
    const store = {
      ...storeBase(),
      listEnvironments: vi.fn().mockResolvedValue([{ environmentId: 'standard' }]),
    };
    const handler = createHandler({ store });
    const response = await handler({
      httpMethod: 'GET',
      path: '/environments',
      ...claims(),
    });
    expect(response.statusCode).toBe(200);
    expect(store.listEnvironments).toHaveBeenCalledWith({
      publishedOnly: true,
    });
  });

  it('reports deployment capabilities so the UI can hide unconfigured compute types', async () => {
    const handler = createHandler({ store: storeBase() });

    // Default deployment: enable_instances_compute is off.
    const disabled = await handler({
      httpMethod: 'GET',
      path: '/environments/capabilities',
      ...claims(),
    });
    expect(disabled.statusCode).toBe(200);
    expect(JSON.parse(disabled.body)).toEqual({
      instancesCompute: false,
      amd64CoreImage: false,
    });

    // Instances-enabled deployment.
    vi.stubEnv('MANAGED_INSTANCES_OPERATOR_ROLE_ARN', 'arn:aws:iam::1:role/operator');
    vi.stubEnv('MANAGED_INSTANCES_SUBNETS', '["subnet-1"]');
    vi.stubEnv('MANAGED_INSTANCES_SECURITY_GROUPS', '["sg-1"]');
    vi.stubEnv('CORE_IMAGE_URI_AMD64', '111111111111.dkr.ecr.eu-west-1.amazonaws.com/core');
    vi.stubEnv('CORE_IMAGE_DIGEST_AMD64', `sha256:${'d'.repeat(64)}`);
    const enabled = await handler({
      httpMethod: 'GET',
      path: '/environments/capabilities',
      ...claims(),
    });
    expect(JSON.parse(enabled.body)).toEqual({
      instancesCompute: true,
      amd64CoreImage: true,
    });
    vi.unstubAllEnvs();
  });

  it('requires fixed-tool environments to be recreated with catalog tools', async () => {
    const environment = {
      environmentId: 'go',
      status: 'FAILED',
      baseEnvironmentId: 'standard',
      currentRevisionId: 'seed-go-1',
      publishedRevisionId: null,
      updateAvailable: true,
    };
    const failedRevision = {
      environmentId: 'go',
      revisionId: 'seed-go-1',
      status: 'FAILED',
      recipe: {
        ...RECIPE,
        base: {
          ...BASE,
          revisionId: 'core-old',
          imageDigest: `sha256:${'b'.repeat(64)}`,
        },
      },
      flattenedRecipe: RECIPE,
    };
    const latestBase = {
      environmentId: 'standard',
      revisionId: 'core-new',
      status: 'PUBLISHED',
      imageUri: BASE.imageUri,
      imageDigest: `sha256:${'c'.repeat(64)}`,
      recipe: {
        ...RECIPE,
        base: {
          environmentId: 'core',
          revisionId: 'core-new',
          imageUri: BASE.imageUri,
          imageDigest: `sha256:${'c'.repeat(64)}`,
        },
      },
      flattenedRecipe: RECIPE,
    };
    const replacement = {
      environmentId: 'go',
      revisionId: 'r-new',
      status: 'DRAFT',
      recipe: failedRevision.recipe,
      flattenedRecipe: failedRevision.flattenedRecipe,
    };
    const store = {
      ...storeBase(),
      getEnvironment: vi.fn().mockImplementation(async (environmentId) =>
        environmentId === 'standard'
          ? {
              environmentId: 'standard',
              status: 'PUBLISHED',
              publishedRevisionId: latestBase.revisionId,
              currentRevisionId: latestBase.revisionId,
            }
          : environment,
      ),
      getRevision: vi.fn().mockImplementation(async (environmentId, revisionId) => {
        if (environmentId === 'standard' && revisionId === latestBase.revisionId) {
          return latestBase;
        }
        return failedRevision;
      }),
      createRevision: vi
        .fn()
        .mockImplementation(async ({ recipe: nextRecipe, flattenedRecipe }) => ({
          ...replacement,
          recipe: nextRecipe,
          flattenedRecipe,
        })),
      updateRevision: vi.fn().mockImplementation(async (_environmentId, _revisionId, patch) => ({
        ...replacement,
        ...patch,
      })),
      updateEnvironment: vi.fn().mockResolvedValue(environment),
    };
    const s3Client = { send: vi.fn().mockResolvedValue({}) };
    const codebuildClient = {
      send: vi.fn().mockResolvedValue({
        build: {
          id: 'environment-build:build-1',
          arn: 'arn:aws:codebuild:eu-west-1:111111111111:build/build-1',
        },
      }),
    };
    const handler = createHandler({ store, s3Client, codebuildClient });

    const response = await handler({
      httpMethod: 'POST',
      path: '/environments/go/rebuild',
      body: '{}',
      ...claims('platform-admin'),
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'FIXED_TOOL_RECIPE_REQUIRES_RECREATION',
    });
    expect(store.createRevision).not.toHaveBeenCalled();
    expect(codebuildClient.send).not.toHaveBeenCalled();
  });

  it('rejects a default microVM environment derived from a published x86_64 base', async () => {
    const x86Parent = {
      environmentId: 'x86-parent',
      status: 'PUBLISHED',
      baseEnvironmentId: 'standard',
      publishedRevisionId: 'r-x86',
      currentRevisionId: 'r-x86',
    };
    const x86Revision = {
      environmentId: 'x86-parent',
      revisionId: 'r-x86',
      status: 'PUBLISHED',
      imageUri: '111111111111.dkr.ecr.eu-west-1.amazonaws.com/environments',
      imageDigest: `sha256:${'d'.repeat(64)}`,
      recipe: { ...CATALOG_RECIPE, architecture: 'x86_64' },
      flattenedRecipe: { ...CATALOG_RECIPE, architecture: 'x86_64' },
    };
    const store = {
      ...storeBase(),
      getEnvironment: vi
        .fn()
        .mockImplementation(async (environmentId) =>
          environmentId === 'x86-parent' ? x86Parent : null,
        ),
      getRevision: vi.fn().mockResolvedValue(x86Revision),
      createEnvironment: vi.fn(),
    };
    const handler = createHandler({ store });

    const response = await handler({
      httpMethod: 'POST',
      path: '/environments',
      body: JSON.stringify({
        name: 'Derived',
        baseEnvironmentId: 'x86-parent',
        recipe: CATALOG_RECIPE,
      }),
      ...claims('platform-admin'),
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'BASE_ARCHITECTURE_MISMATCH',
    });
    expect(store.createEnvironment).not.toHaveBeenCalled();
  });

  describe('x86_64 environments with catalog tools', () => {
    const amdDigest = `sha256:${'b'.repeat(64)}`;
    const standard = {
      environmentId: 'standard',
      status: 'PUBLISHED',
      publishedRevisionId: 'core-1',
    };
    const standardRevision = {
      ...BASE,
      environmentId: 'standard',
      status: 'PUBLISHED',
      recipe: CATALOG_RECIPE,
      flattenedRecipe: CATALOG_RECIPE,
      amd64Image: { imageUri: BASE.imageUri, imageDigest: amdDigest },
    };
    const toolVersion = (versionId, architecture) => ({
      toolId: 'go',
      versionId,
      status: 'PUBLISHED',
      imageUri: '111111111111.dkr.ecr.eu-west-1.amazonaws.com/tools',
      imageDigest: `sha256:${(architecture === 'x86_64' ? 'e' : 'f').repeat(64)}`,
      definition: {
        version: '1.24.6',
        ...(architecture === 'x86_64' ? { architecture } : {}),
        executables: [{ name: 'go', path: 'bin/go' }],
        dependencies: [],
        aptPackages: [],
        environmentVariables: {},
        verification: { preset: 'go' },
      },
    });
    const toolStore = {
      listTools: vi.fn().mockResolvedValue([{ toolId: 'go', name: 'Go SDK' }]),
      listAllVersions: vi
        .fn()
        .mockResolvedValue([toolVersion('tv-go-arm', 'arm64'), toolVersion('tv-go-x86', 'x86_64')]),
    };
    const create = (toolVersionIds) => {
      const store = {
        ...storeBase(),
        getEnvironment: vi
          .fn()
          .mockImplementation(async (id) => (id === 'standard' ? standard : null)),
        getRevision: vi.fn().mockResolvedValue(standardRevision),
        createEnvironment: vi.fn().mockImplementation(async (item) => item),
      };
      const handler = createHandler({ store, toolStore });
      return {
        store,
        response: handler({
          httpMethod: 'POST',
          path: '/environments',
          body: JSON.stringify({
            environmentId: 'go-x86',
            name: 'Go x86',
            compute: { type: 'instances', architecture: 'x86_64' },
            recipe: { ...CATALOG_RECIPE, toolVersionIds },
          }),
          ...claims('platform-admin'),
        }),
      };
    };

    beforeEach(() => {
      vi.stubEnv('MANAGED_INSTANCES_OPERATOR_ROLE_ARN', 'arn:aws:iam::1:role/operator');
      vi.stubEnv('MANAGED_INSTANCES_SUBNETS', '["subnet-1"]');
      vi.stubEnv('MANAGED_INSTANCES_SECURITY_GROUPS', '["sg-1"]');
      vi.stubEnv('CORE_IMAGE_URI_AMD64', BASE.imageUri);
      vi.stubEnv('CORE_IMAGE_DIGEST_AMD64', amdDigest);
    });

    it('builds from the amd64 core with the x86_64 tool image', async () => {
      const { store, response } = create(['tv-go-x86']);
      const result = await response;
      expect(result.statusCode).toBe(201);
      const { recipe, flattenedRecipe } = store.createEnvironment.mock.calls[0][0];
      expect(recipe.architecture).toBe('x86_64');
      expect(recipe.base.imageDigest).toBe(amdDigest);
      expect(recipe.tools).toEqual([
        expect.objectContaining({ versionId: 'tv-go-x86', architecture: 'x86_64' }),
      ]);
      expect(flattenedRecipe.resolvedTools).toEqual([
        expect.objectContaining({ versionId: 'tv-go-x86' }),
      ]);
    });

    it('rejects an arm64 tool build with an actionable error', async () => {
      const { store, response } = create(['tv-go-arm']);
      const result = await response;
      expect(result.statusCode).toBe(409);
      expect(JSON.parse(result.body)).toMatchObject({ code: 'TOOL_ARCHITECTURE_MISMATCH' });
      expect(store.createEnvironment).not.toHaveBeenCalled();
    });
  });

  it('rejects retrying a failed revision pinned to an outdated base', async () => {
    const environment = {
      environmentId: 'go',
      status: 'FAILED',
      baseEnvironmentId: 'standard',
      currentRevisionId: 'seed-go-1',
      publishedRevisionId: null,
      updateAvailable: true,
    };
    const failedRevision = {
      environmentId: 'go',
      revisionId: 'seed-go-1',
      status: 'FAILED',
      recipe: CATALOG_RECIPE,
      flattenedRecipe: CATALOG_RECIPE,
    };
    const store = {
      ...storeBase(),
      getEnvironment: vi.fn().mockResolvedValue(environment),
      getRevision: vi.fn().mockResolvedValue(failedRevision),
      createRevision: vi.fn(),
    };
    const codebuildClient = { send: vi.fn() };
    const handler = createHandler({ store, codebuildClient });

    const response = await handler({
      httpMethod: 'POST',
      path: '/environments/go/revisions/seed-go-1/retry',
      body: '{}',
      ...claims('platform-admin'),
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'BASE_UPDATE_AVAILABLE',
    });
    expect(store.createRevision).not.toHaveBeenCalled();
    expect(codebuildClient.send).not.toHaveBeenCalled();
  });

  it('blocks direct builds for fixed-tool custom environments', async () => {
    const environment = {
      environmentId: 'fixed-java',
      status: 'DRAFT',
      baseEnvironmentId: 'standard',
      currentRevisionId: 'fixed-1',
      publishedRevisionId: null,
      updateAvailable: false,
    };
    const fixedToolRevision = {
      environmentId: environment.environmentId,
      revisionId: environment.currentRevisionId,
      status: 'DRAFT',
      recipe: RECIPE,
      flattenedRecipe: RECIPE,
    };
    const store = {
      ...storeBase(),
      getEnvironment: vi.fn().mockResolvedValue(environment),
      getRevision: vi.fn().mockResolvedValue(fixedToolRevision),
    };
    const handler = createHandler({ store, codebuildClient: { send: vi.fn() } });

    const response = await handler({
      httpMethod: 'POST',
      path: '/environments/fixed-java/revisions/fixed-1/build',
      body: '{}',
      ...claims('platform-admin'),
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'FIXED_TOOL_RECIPE_UNSUPPORTED',
    });
  });

  it('rejects non-admin mutations', async () => {
    const store = { ...storeBase() };
    const handler = createHandler({ store });
    const response = await handler({
      httpMethod: 'POST',
      path: '/environments',
      body: JSON.stringify({ name: 'Custom' }),
      ...claims(),
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'PLATFORM_ADMIN_REQUIRED',
    });
  });

  it('rejects environment IDs reserved by control routes', async () => {
    const store = { ...storeBase() };
    const handler = createHandler({ store });
    const response = await handler({
      httpMethod: 'POST',
      path: '/environments',
      body: JSON.stringify({
        environmentId: 'rebuild',
        name: 'Rebuild',
        baseEnvironmentId: 'standard',
        recipe: RECIPE,
      }),
      ...claims('platform-admin'),
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/reserved/);
  });

  it('retries a failed build with a new immutable revision tag', async () => {
    const environment = {
      environmentId: 'custom',
      name: 'Custom',
      status: 'FAILED',
      currentRevisionId: 'r-old',
      baseEnvironmentId: 'standard',
    };
    const failed = {
      environmentId: 'custom',
      revisionId: 'r-old',
      status: 'FAILED',
      recipe: CATALOG_RECIPE,
      flattenedRecipe: CATALOG_RECIPE,
    };
    const replacement = {
      ...failed,
      revisionId: 'r-new',
      status: 'DRAFT',
      imageDigest: null,
    };
    const store = {
      ...storeBase(),
      getEnvironment: vi.fn().mockResolvedValue(environment),
      getRevision: vi.fn().mockResolvedValue(failed),
      createRevision: vi.fn().mockResolvedValue(replacement),
      updateRevision: vi.fn().mockImplementation(async (_environmentId, _revisionId, patch) => ({
        ...replacement,
        ...patch,
      })),
      updateEnvironment: vi.fn().mockImplementation(async (_environmentId, patch) => ({
        ...environment,
        ...patch,
      })),
    };
    const s3Client = { send: vi.fn().mockResolvedValue({}) };
    const codebuildClient = {
      send: vi.fn().mockResolvedValue({
        build: {
          id: 'environment-build:123',
          arn: 'arn:aws:codebuild:eu-west-1:111111111111:build/environment-build:123',
          logs: {
            deepLink: 'https://console.aws.amazon.com/codebuild/builds/123',
          },
        },
      }),
    };
    const handler = createHandler({ store, s3Client, codebuildClient });
    const response = await handler({
      httpMethod: 'POST',
      path: '/environments/custom/revisions/r-old/retry',
      body: '{}',
      ...claims('platform-admin'),
    });

    expect(response.statusCode).toBe(202);
    expect(store.createRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'retry',
        recipe: CATALOG_RECIPE,
        flattenedRecipe: CATALOG_RECIPE,
      }),
    );
    expect(store.updateRevision).toHaveBeenNthCalledWith(
      1,
      'custom',
      'r-new',
      expect.objectContaining({
        status: 'QUEUED',
        recipe: CATALOG_RECIPE,
        flattenedRecipe: CATALOG_RECIPE,
      }),
      { fromStatus: 'DRAFT' },
    );
    const startInput = codebuildClient.send.mock.calls[0][0].input;
    expect(startInput.environmentVariablesOverride).toContainEqual(
      expect.objectContaining({ name: 'IMAGE_TAG', value: 'r-new' }),
    );
    expect(s3Client.send).toHaveBeenCalled();
  });

  it('marks a queued revision failed when CodeBuild cannot start', async () => {
    const environment = {
      environmentId: 'custom',
      name: 'Custom',
      status: 'DRAFT',
      currentRevisionId: 'r-1',
      baseEnvironmentId: 'standard',
    };
    const draft = {
      environmentId: 'custom',
      revisionId: 'r-1',
      status: 'DRAFT',
      recipe: CATALOG_RECIPE,
      flattenedRecipe: CATALOG_RECIPE,
    };
    const store = {
      ...storeBase(),
      getEnvironment: vi.fn().mockResolvedValue(environment),
      getRevision: vi.fn().mockResolvedValue(draft),
      updateRevision: vi.fn().mockImplementation(async (_environmentId, _revisionId, patch) => ({
        ...draft,
        ...patch,
      })),
      updateEnvironment: vi.fn().mockImplementation(async (_environmentId, patch) => ({
        ...environment,
        ...patch,
      })),
    };
    const handler = createHandler({
      store,
      s3Client: { send: vi.fn().mockResolvedValue({}) },
      codebuildClient: {
        send: vi.fn().mockRejectedValue(new Error('service unavailable')),
      },
    });

    const response = await handler({
      httpMethod: 'POST',
      path: '/environments/custom/revisions/r-1/build',
      body: '{}',
      ...claims('platform-admin'),
    });

    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body)).toMatchObject({
      error: 'Unable to start environment image build',
      code: 'IMAGE_BUILD_START_FAILED',
    });
    expect(store.updateRevision).toHaveBeenLastCalledWith(
      'custom',
      'r-1',
      expect.objectContaining({
        status: 'FAILED',
        failure: expect.objectContaining({
          reason: 'image_build_start_failed',
          detail: 'service unavailable',
        }),
      }),
      { fromStatus: 'QUEUED' },
    );
    expect(store.updateEnvironment).toHaveBeenCalledWith(
      'custom',
      expect.objectContaining({ status: 'FAILED' }),
      {
        ifCurrentRevisionId: 'r-1',
        unlessRetired: true,
      },
    );
  });

  it('returns a conflict when a revision is published before it is ready', async () => {
    const environment = {
      environmentId: 'custom',
      status: 'BUILDING',
      currentRevisionId: 'r-1',
    };
    const store = {
      ...storeBase(),
      getEnvironment: vi.fn().mockResolvedValue(environment),
      getRevision: vi.fn().mockResolvedValue({
        environmentId: 'custom',
        revisionId: 'r-1',
        status: 'BUILDING',
      }),
      publishRevision: vi.fn(),
    };
    const handler = createHandler({ store });

    const response = await handler({
      httpMethod: 'POST',
      path: '/environments/custom/revisions/r-1/publish',
      body: '{}',
      ...claims('platform-admin'),
    });

    expect(response.statusCode).toBe(409);
    expect(store.publishRevision).not.toHaveBeenCalled();
  });

  it('records security findings acceptance for the status worker to continue', async () => {
    const environment = {
      environmentId: 'custom',
      status: 'SECURITY_REVIEW',
      currentRevisionId: 'r-1',
    };
    const revision = {
      environmentId: 'custom',
      revisionId: 'r-1',
      status: 'SECURITY_REVIEW',
    };
    const store = {
      ...storeBase(),
      getEnvironment: vi.fn().mockResolvedValue(environment),
      getRevision: vi.fn().mockResolvedValue(revision),
      updateRevision: vi.fn().mockResolvedValue({
        ...revision,
        securityFindingsAcceptedAt: '2026-08-11T00:00:00.000Z',
        securityFindingsAcceptedBy: 'user@example.com',
      }),
    };
    const handler = createHandler({ store });

    const response = await handler({
      httpMethod: 'POST',
      path: '/environments/custom/revisions/r-1/acknowledge',
      body: '{}',
      ...claims('platform-admin'),
    });

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toMatchObject({
      pending: true,
      revision: {
        status: 'SECURITY_REVIEW',
        securityFindingsAcceptedBy: 'user@example.com',
      },
    });
    expect(store.updateRevision).toHaveBeenCalledWith(
      'custom',
      'r-1',
      expect.objectContaining({
        securityFindingsAcceptedBy: 'user@example.com',
      }),
      { fromStatus: 'SECURITY_REVIEW' },
    );
  });

  it('accepts findings on a legacy security-only failure without rebuilding', async () => {
    const environment = {
      environmentId: 'custom',
      status: 'FAILED',
      currentRevisionId: 'r-1',
    };
    const revision = {
      environmentId: 'custom',
      revisionId: 'r-1',
      status: 'FAILED',
      imageDigest: `sha256:${'b'.repeat(64)}`,
      failure: { reason: 'critical_vulnerability_findings' },
    };
    const store = {
      ...storeBase(),
      getEnvironment: vi.fn().mockResolvedValue(environment),
      getRevision: vi.fn().mockResolvedValue(revision),
      updateRevision: vi.fn().mockResolvedValue({
        ...revision,
        status: 'SECURITY_REVIEW',
        failure: null,
        securityFindingsAcceptedBy: 'user@example.com',
      }),
      updateEnvironment: vi.fn().mockResolvedValue({
        ...environment,
        status: 'SECURITY_REVIEW',
      }),
    };
    const handler = createHandler({ store });

    const response = await handler({
      httpMethod: 'POST',
      path: '/environments/custom/revisions/r-1/acknowledge',
      body: '{}',
      ...claims('platform-admin'),
    });

    expect(response.statusCode).toBe(202);
    expect(store.updateRevision).toHaveBeenCalledWith(
      'custom',
      'r-1',
      expect.objectContaining({
        status: 'SECURITY_REVIEW',
        failure: null,
        securityFindingsAcceptedBy: 'user@example.com',
      }),
      { fromStatus: 'FAILED' },
    );
    expect(store.updateEnvironment).toHaveBeenCalledWith(
      'custom',
      { status: 'SECURITY_REVIEW' },
      {
        ifCurrentRevisionId: 'r-1',
        unlessRetired: true,
      },
    );
  });

  it('accepts findings when the status poll concurrently reopens a legacy failure', async () => {
    const environment = {
      environmentId: 'custom',
      status: 'FAILED',
      currentRevisionId: 'r-1',
    };
    const failed = {
      environmentId: 'custom',
      revisionId: 'r-1',
      status: 'FAILED',
      imageDigest: `sha256:${'b'.repeat(64)}`,
      failure: { reason: 'critical_vulnerability_findings' },
    };
    const reopened = {
      ...failed,
      status: 'SECURITY_REVIEW',
      failure: null,
    };
    const conditionalFailure = Object.assign(new Error('revision advanced'), {
      name: 'ConditionalCheckFailedException',
    });
    const store = {
      ...storeBase(),
      getEnvironment: vi.fn().mockResolvedValue(environment),
      getRevision: vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(reopened),
      updateRevision: vi
        .fn()
        .mockRejectedValueOnce(conditionalFailure)
        .mockResolvedValueOnce({
          ...reopened,
          securityFindingsAcceptedBy: 'user@example.com',
        }),
      updateEnvironment: vi.fn().mockResolvedValue({
        ...environment,
        status: 'SECURITY_REVIEW',
      }),
    };
    const handler = createHandler({ store });

    const response = await handler({
      httpMethod: 'POST',
      path: '/environments/custom/revisions/r-1/acknowledge',
      body: '{}',
      ...claims('platform-admin'),
    });

    expect(response.statusCode).toBe(202);
    expect(store.updateRevision).toHaveBeenNthCalledWith(
      2,
      'custom',
      'r-1',
      expect.objectContaining({
        securityFindingsAcceptedBy: 'user@example.com',
      }),
      { fromStatus: 'SECURITY_REVIEW' },
    );
  });

  it('keeps the Standard environment managed by the protected core runtime', async () => {
    const store = {
      ...storeBase(),
      getEnvironment: vi.fn().mockResolvedValue({
        environmentId: 'standard',
        status: 'PUBLISHED',
        publishedRevisionId: 'core-1',
      }),
      createRevision: vi.fn(),
    };
    const handler = createHandler({ store });

    const response = await handler({
      httpMethod: 'PUT',
      path: '/environments/standard',
      body: JSON.stringify({ baseEnvironmentId: 'standard', recipe: RECIPE }),
      ...claims('platform-admin'),
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/protected core runtime/);
    expect(store.createRevision).not.toHaveBeenCalled();
  });

  it('rejects a base assignment that would create a dependency cycle', async () => {
    const environments = new Map([
      [
        'custom',
        {
          environmentId: 'custom',
          status: 'PUBLISHED',
          baseEnvironmentId: 'standard',
          publishedRevisionId: 'custom-1',
        },
      ],
      [
        'child',
        {
          environmentId: 'child',
          status: 'PUBLISHED',
          baseEnvironmentId: 'custom',
          publishedRevisionId: 'child-1',
        },
      ],
    ]);
    const store = {
      ...storeBase(),
      getEnvironment: vi
        .fn()
        .mockImplementation((environmentId) => environments.get(environmentId)),
      getRevision: vi.fn().mockResolvedValue({ recipe: CATALOG_RECIPE }),
      createRevision: vi.fn(),
    };
    const handler = createHandler({ store });

    const response = await handler({
      httpMethod: 'PUT',
      path: '/environments/custom',
      body: JSON.stringify({ baseEnvironmentId: 'child', recipe: CATALOG_RECIPE }),
      ...claims('platform-admin'),
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/create a cycle/);
    expect(store.createRevision).not.toHaveBeenCalled();
  });
});
