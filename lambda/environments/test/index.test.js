import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHandler } from '../index.js';
import { ENVIRONMENT_TOOL_CATALOG } from '../recipe.js';

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

const RUST_RECIPE = {
  ...RECIPE,
  tools: { rust: ENVIRONMENT_TOOL_CATALOG.tools.rust.versions[0] },
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

  it('returns the platform tool catalog with exact package provenance', async () => {
    const store = { ...storeBase() };
    const handler = createHandler({ store });
    const response = await handler({
      httpMethod: 'GET',
      path: '/environments/catalog',
      ...claims(),
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      tools: {
        node: {
          label: 'Node.js',
          versions: [{ version: '24.15.0', source: 'base' }],
        },
        java: {
          label: 'Java',
          publisher: 'Eclipse Temurin',
          versions: [
            {
              version: '21.0.8',
              source: 'archive',
              checksum: { algorithm: 'sha256' },
            },
          ],
        },
      },
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
        environmentId: 'catalog',
        name: 'Catalog',
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
      recipe: RUST_RECIPE,
      flattenedRecipe: RUST_RECIPE,
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
        recipe: RUST_RECIPE,
        flattenedRecipe: RUST_RECIPE,
      }),
    );
    expect(store.updateRevision).toHaveBeenNthCalledWith(
      1,
      'custom',
      'r-new',
      expect.objectContaining({
        status: 'QUEUED',
        recipe: expect.objectContaining({
          aptPackages: [{ name: 'build-essential', version: '12.9' }],
        }),
        flattenedRecipe: expect.objectContaining({
          aptPackages: [{ name: 'build-essential', version: '12.9' }],
        }),
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
      recipe: RECIPE,
      flattenedRecipe: RECIPE,
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
      createRevision: vi.fn(),
    };
    const handler = createHandler({ store });

    const response = await handler({
      httpMethod: 'PUT',
      path: '/environments/custom',
      body: JSON.stringify({ baseEnvironmentId: 'child', recipe: RECIPE }),
      ...claims('platform-admin'),
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toMatch(/create a cycle/);
    expect(store.createRevision).not.toHaveBeenCalled();
  });
});
