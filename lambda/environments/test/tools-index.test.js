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
      listVersionsByStatus: vi.fn().mockResolvedValue([draft]),
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
      listVersionsByStatus: vi.fn().mockResolvedValue([draft]),
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
    });
    expect(environmentStore.markToolUpdatesAvailable).toHaveBeenCalledWith('java', 'tv-java-21');
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
