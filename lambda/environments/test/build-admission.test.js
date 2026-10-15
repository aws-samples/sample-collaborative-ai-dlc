import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHandler } from '../index.js';

// Admission of NEW image builds for environments that already exist. The
// compute was valid at creation; these cases change the deployment underneath
// (feature disabled, allowlist emptied) and assert that every build entry
// point rejects before it creates a build attempt, uploads a context or starts
// CodeBuild.

const CORE = {
  imageUri: '111111111111.dkr.ecr.eu-west-1.amazonaws.com/core',
  imageDigest: `sha256:${'a'.repeat(64)}`,
};

const STANDARD_REVISION = {
  environmentId: 'standard',
  revisionId: 'core-2',
  status: 'PUBLISHED',
  imageUri: CORE.imageUri,
  imageDigest: CORE.imageDigest,
  amd64Image: { imageUri: `${CORE.imageUri}`, imageDigest: `sha256:${'b'.repeat(64)}` },
  recipe: { schemaVersion: 2 },
};

const recipeFor = (architecture) => ({
  schemaVersion: 2,
  ...(architecture === 'x86_64' ? { architecture } : {}),
  base: { environmentId: 'standard', revisionId: 'core-1', ...CORE },
  toolVersionIds: [],
  tools: [],
  resolvedTools: [],
  aptPackages: [],
  environmentVariables: {},
  buildCommands: [],
});

const claims = {
  requestContext: {
    authorizer: {
      claims: { sub: 'admin-1', email: 'admin@example.com', 'cognito:groups': 'platform-admin' },
    },
  },
};

const environmentFor = (architecture, overrides = {}) => ({
  environmentId: `ec2-${architecture}`,
  name: `EC2 ${architecture}`,
  status: 'FAILED',
  baseEnvironmentId: 'standard',
  currentRevisionId: 'r-1',
  publishedRevisionId: null,
  updateAvailable: false,
  compute: { type: 'instances', architecture },
  ...overrides,
});

const revisionFor = (environment, status) => ({
  environmentId: environment.environmentId,
  revisionId: 'r-1',
  status,
  recipe: recipeFor(environment.compute?.architecture),
  flattenedRecipe: recipeFor(environment.compute?.architecture),
});

const setup = ({ environments, revisionStatus = 'FAILED' }) => {
  const byId = Object.fromEntries(environments.map((item) => [item.environmentId, item]));
  const store = {
    seedSystemEnvironments: vi.fn(),
    stageCoreRevision: vi.fn(),
    reconcileBaseUpdates: vi.fn(),
    listEnvironments: vi.fn().mockResolvedValue(environments),
    getEnvironment: vi.fn().mockImplementation(async (id) =>
      id === 'standard'
        ? {
            environmentId: 'standard',
            status: 'PUBLISHED',
            publishedRevisionId: STANDARD_REVISION.revisionId,
            currentRevisionId: STANDARD_REVISION.revisionId,
          }
        : (byId[id] ?? null),
    ),
    getRevision: vi
      .fn()
      .mockImplementation(async (id) =>
        id === 'standard' ? STANDARD_REVISION : revisionFor(byId[id], revisionStatus),
      ),
    createRevision: vi
      .fn()
      .mockImplementation(async ({ environment, recipe, flattenedRecipe }) => ({
        environmentId: environment.environmentId,
        revisionId: 'r-new',
        status: 'DRAFT',
        recipe,
        flattenedRecipe,
      })),
    updateRevision: vi.fn().mockImplementation(async (environmentId, revisionId, patch) => ({
      environmentId,
      revisionId,
      ...patch,
    })),
    updateEnvironment: vi.fn().mockResolvedValue({}),
  };
  const s3Client = { send: vi.fn().mockResolvedValue({}) };
  const codebuildClient = {
    send: vi.fn().mockResolvedValue({ build: { id: 'b-1', arn: 'arn:b-1' } }),
  };
  const toolStore = {
    listTools: vi.fn().mockResolvedValue([]),
    listAllVersions: vi.fn().mockResolvedValue([]),
  };
  const handler = createHandler({ store, toolStore, s3Client, codebuildClient });
  return { handler, store, s3Client, codebuildClient };
};

const post = (handler, path, body = {}) =>
  handler({ httpMethod: 'POST', path, body: JSON.stringify(body), ...claims });

const expectNothingStarted = ({ store, s3Client, codebuildClient }) => {
  expect(store.createRevision).not.toHaveBeenCalled();
  expect(store.updateRevision).not.toHaveBeenCalled();
  expect(s3Client.send).not.toHaveBeenCalled();
  expect(codebuildClient.send).not.toHaveBeenCalled();
};

const configureInstances = () => {
  vi.stubEnv('MANAGED_INSTANCES_OPERATOR_ROLE_ARN', 'arn:aws:iam::1:role/operator');
  vi.stubEnv('MANAGED_INSTANCES_SUBNETS', '["subnet-1"]');
  vi.stubEnv('MANAGED_INSTANCES_SECURITY_GROUPS', '["sg-1"]');
  vi.stubEnv('MANAGED_INSTANCES_ALLOWED_TYPES', '["m6i.large"]');
  vi.stubEnv('MANAGED_INSTANCES_ALLOWED_TYPES_ARM64', '["m7g.large"]');
  vi.stubEnv('CORE_IMAGE_URI_AMD64', `${CORE.imageUri}`);
  vi.stubEnv('CORE_IMAGE_DIGEST_AMD64', `sha256:${'b'.repeat(64)}`);
};

// The two ways a deployment loses an Instances cell after an environment on
// it was created.
const UNAVAILABLE = {
  'feature disabled': {
    apply: () => {
      vi.stubEnv('MANAGED_INSTANCES_OPERATOR_ROLE_ARN', '');
      vi.stubEnv('MANAGED_INSTANCES_SUBNETS', '');
      vi.stubEnv('MANAGED_INSTANCES_SECURITY_GROUPS', '');
    },
    code: 'INSTANCES_COMPUTE_NOT_CONFIGURED',
  },
  'empty allowlist': {
    apply: (architecture) =>
      vi.stubEnv(
        architecture === 'x86_64'
          ? 'MANAGED_INSTANCES_ALLOWED_TYPES'
          : 'MANAGED_INSTANCES_ALLOWED_TYPES_ARM64',
        '[]',
      ),
    code: 'NO_INSTANCE_TYPES',
  },
};

describe('build admission for existing environments', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('CORE_IMAGE_URI', CORE.imageUri);
    vi.stubEnv('CORE_IMAGE_DIGEST', CORE.imageDigest);
    vi.stubEnv('CORE_RUNTIME_ARN', 'arn:aws:bedrock-agentcore:eu-west-1:1:runtime/core');
    vi.stubEnv('BUILD_CONTEXT_BUCKET', 'contexts');
    vi.stubEnv('ENVIRONMENT_CODEBUILD_PROJECT', 'environment-build');
    vi.stubEnv('ENVIRONMENT_ECR_REPOSITORY_URI', `${CORE.imageUri}-envs`);
    vi.stubEnv('ENVIRONMENT_ECR_REPOSITORY_NAME', 'envs');
    configureInstances();
  });

  for (const architecture of ['x86_64', 'arm64']) {
    for (const [label, { apply, code }] of Object.entries(UNAVAILABLE)) {
      describe(`Instances ${architecture}, ${label}`, () => {
        beforeEach(() => apply(architecture));

        it('rejects a direct build of the current draft', async () => {
          const environment = environmentFor(architecture, { status: 'DRAFT' });
          const ctx = setup({ environments: [environment], revisionStatus: 'DRAFT' });
          const res = await post(ctx.handler, `/environments/${environment.environmentId}/build`);
          expect(res.statusCode).toBe(409);
          expect(JSON.parse(res.body)).toMatchObject({ code });
          expectNothingStarted(ctx);
        });

        it('rejects a retry before creating the replacement revision', async () => {
          const environment = environmentFor(architecture);
          const ctx = setup({ environments: [environment] });
          const res = await post(
            ctx.handler,
            `/environments/${environment.environmentId}/revisions/r-1/retry`,
          );
          expect(res.statusCode).toBe(409);
          expect(JSON.parse(res.body)).toMatchObject({ code });
          expectNothingStarted(ctx);
        });

        it('rejects a single rebuild before cloning onto the latest base', async () => {
          const environment = environmentFor(architecture, {
            status: 'PUBLISHED',
            publishedRevisionId: 'r-1',
            updateAvailable: true,
          });
          const ctx = setup({ environments: [environment], revisionStatus: 'PUBLISHED' });
          const res = await post(ctx.handler, `/environments/${environment.environmentId}/rebuild`);
          expect(res.statusCode).toBe(409);
          expect(JSON.parse(res.body)).toMatchObject({ code });
          expectNothingStarted(ctx);
        });

        it('rejects an explicit bulk rebuild as a whole, starting nothing', async () => {
          const blocked = environmentFor(architecture, {
            status: 'PUBLISHED',
            publishedRevisionId: 'r-1',
            updateAvailable: true,
          });
          const healthy = {
            environmentId: 'node',
            status: 'PUBLISHED',
            baseEnvironmentId: 'standard',
            currentRevisionId: 'r-1',
            publishedRevisionId: 'r-1',
            updateAvailable: true,
            compute: null,
          };
          const ctx = setup({ environments: [healthy, blocked], revisionStatus: 'PUBLISHED' });
          const res = await post(ctx.handler, '/environments/rebuild', {
            environmentIds: [healthy.environmentId, blocked.environmentId],
          });
          expect(res.statusCode).toBe(409);
          expect(JSON.parse(res.body)).toMatchObject({
            code,
            environments: [{ environmentId: blocked.environmentId, code }],
          });
          expectNothingStarted(ctx);
        });

        it('skips and reports it in the implicit "all updates" bulk rebuild', async () => {
          const blocked = environmentFor(architecture, {
            status: 'PUBLISHED',
            publishedRevisionId: 'r-1',
            updateAvailable: true,
          });
          const healthy = {
            environmentId: 'node',
            status: 'PUBLISHED',
            baseEnvironmentId: 'standard',
            currentRevisionId: 'r-1',
            publishedRevisionId: 'r-1',
            updateAvailable: true,
            compute: null,
          };
          const ctx = setup({ environments: [healthy, blocked], revisionStatus: 'PUBLISHED' });
          const res = await post(ctx.handler, '/environments/rebuild', {});
          expect(res.statusCode).toBe(202);
          const body = JSON.parse(res.body);
          expect(body.skipped).toEqual([
            expect.objectContaining({ environmentId: blocked.environmentId, code }),
          ]);
          expect(body.builds).toHaveLength(1);
          expect(ctx.store.createRevision).toHaveBeenCalledTimes(1);
          expect(ctx.store.createRevision.mock.calls[0][0].environment.environmentId).toBe('node');
          expect(ctx.codebuildClient.send).toHaveBeenCalledTimes(1);
        });
      });
    }
  }

  it('rejects an x86_64 build once the amd64 core image is gone', async () => {
    vi.stubEnv('CORE_IMAGE_URI_AMD64', '');
    vi.stubEnv('CORE_IMAGE_DIGEST_AMD64', '');
    const environment = environmentFor('x86_64', { status: 'DRAFT' });
    const ctx = setup({ environments: [environment], revisionStatus: 'DRAFT' });
    const res = await post(ctx.handler, `/environments/${environment.environmentId}/build`);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'AMD64_CORE_IMAGE_MISSING' });
    expectNothingStarted(ctx);
  });

  it('still admits builds when the compute is available', async () => {
    for (const architecture of ['x86_64', 'arm64']) {
      const environment = environmentFor(architecture, { status: 'DRAFT' });
      const ctx = setup({ environments: [environment], revisionStatus: 'DRAFT' });
      const res = await post(ctx.handler, `/environments/${environment.environmentId}/build`);
      expect(res.statusCode).toBe(202);
      expect(ctx.codebuildClient.send).toHaveBeenCalledTimes(1);
    }
  });

  it('never gates default microVM environments on Instances configuration', async () => {
    UNAVAILABLE['feature disabled'].apply();
    const environment = environmentFor('arm64', { status: 'DRAFT', compute: null });
    const ctx = setup({ environments: [environment], revisionStatus: 'DRAFT' });
    const res = await post(ctx.handler, `/environments/${environment.environmentId}/build`);
    expect(res.statusCode).toBe(202);
  });

  it('still saves an inert draft revision of an unbuildable environment', async () => {
    UNAVAILABLE['feature disabled'].apply();
    const environment = environmentFor('x86_64', { status: 'DRAFT' });
    const ctx = setup({ environments: [environment], revisionStatus: 'DRAFT' });
    const res = await ctx.handler({
      httpMethod: 'PUT',
      path: `/environments/${environment.environmentId}`,
      body: JSON.stringify({ name: 'Renamed', recipe: recipeFor('x86_64') }),
      ...claims,
    });
    // Saving a draft is not a build: it is admitted, and nothing starts.
    expect(res.statusCode).toBe(200);
    expect(ctx.store.createRevision).toHaveBeenCalledTimes(1);
    expect(ctx.s3Client.send).not.toHaveBeenCalled();
    expect(ctx.codebuildClient.send).not.toHaveBeenCalled();
  });
});
