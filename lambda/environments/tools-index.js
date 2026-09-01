import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild';
import { S3Client } from '@aws-sdk/client-s3';
import { buildResponse } from '../shared/response.js';
import { requirePlatformAdmin } from '../shared/authz.js';
import {
  generateToolBuildContext,
  normalizeToolId,
  normalizeToolVersionDefinition,
  toolVersionSnapshot,
} from './tool-catalog.js';
import { uploadBuildContext } from './build-lifecycle.js';
import {
  actorFrom,
  createRetryableInitializer,
  parseBody,
  pathParts,
  requireUser,
  responseError,
} from './request.js';
import { createEnvironmentStore } from './store.js';
import { createToolStore } from './tool-store.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const codebuild = new CodeBuildClient({});
const defaultStore = createToolStore({ ddb });
const defaultEnvironmentStore = createEnvironmentStore({ ddb });

const toolMetadata = (data, { partial = false } = {}) => {
  const values = {};
  if (!partial || data.name !== undefined) {
    const name = String(data.name ?? '').trim();
    if (!name || name.length > 100) {
      throw Object.assign(new Error('Tool name must be between 1 and 100 characters'), {
        statusCode: 400,
      });
    }
    values.name = name;
  }
  if (!partial || data.description !== undefined) {
    const description = String(data.description ?? '').trim();
    if (description.length > 500) {
      throw Object.assign(new Error('Tool description must not exceed 500 characters'), {
        statusCode: 400,
      });
    }
    values.description = description;
  }
  if (!partial || data.category !== undefined) {
    const category = String(data.category ?? 'cli').trim();
    if (!['language-sdk', 'build-tool', 'cli'].includes(category)) {
      throw Object.assign(new Error('Tool category is invalid'), { statusCode: 400 });
    }
    values.category = category;
  }
  if (!partial || data.publisher !== undefined) {
    const publisher = String(data.publisher ?? '').trim();
    if (publisher.length > 100) {
      throw Object.assign(new Error('Tool publisher must not exceed 100 characters'), {
        statusCode: 400,
      });
    }
    values.publisher = publisher;
  }
  return values;
};

const assertKnownDependencies = async (store, toolId, definition) => {
  for (const dependencyId of definition.dependencies ?? []) {
    if (dependencyId === toolId) {
      throw Object.assign(new Error('A tool cannot depend on itself'), {
        statusCode: 409,
        code: 'TOOL_DEPENDENCY_CYCLE',
      });
    }
    if (!(await store.getTool(dependencyId))) {
      throw Object.assign(new Error(`Dependency tool ${dependencyId} does not exist`), {
        statusCode: 409,
        code: 'TOOL_DEPENDENCY_NOT_FOUND',
      });
    }
  }
};

const assertRecommendationGraph = async (store, tool, candidate) => {
  const tools = await store.listTools();
  const published = await store.listAllVersions({ publishedOnly: true });
  const toolById = new Map(tools.map((item) => [item.toolId, item]));
  const versionById = new Map(published.map((version) => [version.versionId, version]));
  versionById.set(candidate.versionId, candidate);
  const visiting = new Set();
  const visited = new Set();

  const visit = (toolId) => {
    if (visiting.has(toolId)) {
      throw Object.assign(new Error('Recommended tool dependencies contain a cycle'), {
        statusCode: 409,
        code: 'TOOL_DEPENDENCY_CYCLE',
      });
    }
    if (visited.has(toolId)) return;
    const family = toolById.get(toolId);
    const versionId = toolId === tool.toolId ? candidate.versionId : family?.recommendedVersionId;
    const version = versionById.get(versionId);
    if (!version) {
      throw Object.assign(new Error(`Tool ${toolId} requires a published recommended version`), {
        statusCode: 409,
        code: 'TOOL_RECOMMENDED_DEPENDENCY_MISSING',
      });
    }
    visiting.add(toolId);
    for (const dependencyId of version.definition.dependencies ?? []) {
      if (!toolById.has(dependencyId)) {
        throw Object.assign(new Error(`Dependency tool ${dependencyId} does not exist`), {
          statusCode: 409,
          code: 'TOOL_DEPENDENCY_NOT_FOUND',
        });
      }
      visit(dependencyId);
    }
    visiting.delete(toolId);
    visited.add(toolId);
  };

  visit(tool.toolId);
};

const resolveBuildDependencies = async (store, version) => {
  const resolved = new Map();
  const visiting = new Set([version.toolId]);

  const include = async (toolId) => {
    if (visiting.has(toolId)) {
      throw Object.assign(new Error('Tool dependency cycle detected'), {
        statusCode: 409,
        code: 'TOOL_DEPENDENCY_CYCLE',
      });
    }
    if (resolved.has(toolId)) return;
    const tool = await store.getTool(toolId);
    const dependency = tool?.recommendedVersionId
      ? await store.getVersion(toolId, tool.recommendedVersionId)
      : null;
    if (
      !tool ||
      !dependency ||
      dependency.status !== 'PUBLISHED' ||
      !dependency.imageUri ||
      !dependency.imageDigest
    ) {
      throw Object.assign(
        new Error(`Tool ${version.toolId} requires a published recommended ${toolId} version`),
        {
          statusCode: 409,
          code: 'TOOL_RECOMMENDED_DEPENDENCY_MISSING',
        },
      );
    }
    visiting.add(toolId);
    for (const nested of dependency.definition.dependencies ?? []) await include(nested);
    visiting.delete(toolId);
    resolved.set(toolId, toolVersionSnapshot(dependency, tool));
  };

  for (const dependencyId of version.definition.dependencies ?? []) await include(dependencyId);
  return [...resolved.values()];
};

export const startToolBuild = async ({
  store,
  tool,
  version,
  actor,
  s3Client = s3,
  codebuildClient = codebuild,
}) => {
  if (!['DRAFT', 'FAILED', 'SECURITY_REVIEW', 'READY'].includes(version.status)) {
    throw Object.assign(new Error(`Tool version is ${version.status} and cannot be built`), {
      statusCode: 409,
    });
  }
  const dependencies = await resolveBuildDependencies(store, version);
  const buildAttempt = Number(version.buildAttempt ?? 0) + 1;
  const imageTag = `${version.versionId}-a${buildAttempt}`;
  const context = generateToolBuildContext({
    tool,
    version,
    dependencies,
    coreImageUri: process.env.CORE_IMAGE_URI,
    coreImageDigest: process.env.CORE_IMAGE_DIGEST,
    runtimeCompatibilityVersion: process.env.RUNTIME_COMPATIBILITY_VERSION || '1',
  });
  const prefix = `managed-tools/contexts/${tool.toolId}/${version.versionId}/a${buildAttempt}`;
  await uploadBuildContext({ files: context.files, prefix, s3Client });
  await store.updateVersion(
    tool.toolId,
    version.versionId,
    {
      status: 'QUEUED',
      autoBuild: false,
      buildAttempt,
      imageTag,
      contextPrefix: prefix,
      buildId: null,
      buildArn: null,
      buildLogUrl: null,
      failure: null,
      scanFindings: null,
      verification: null,
      imageUri: null,
      imageDigest: null,
      imageSizeBytes: null,
      securityFindingsAcceptedAt: null,
      securityFindingsAcceptedBy: null,
      ...(['DRAFT', 'FAILED'].includes(version.status) ? { definition: context.definition } : {}),
    },
    { fromStatus: version.status },
  );
  let started;
  try {
    started = await codebuildClient.send(
      new StartBuildCommand({
        projectName: process.env.TOOL_CODEBUILD_PROJECT,
        environmentVariablesOverride: [
          {
            name: 'CONTEXT_BUCKET',
            value: process.env.BUILD_CONTEXT_BUCKET,
            type: 'PLAINTEXT',
          },
          { name: 'CONTEXT_PREFIX', value: prefix, type: 'PLAINTEXT' },
          {
            name: 'TOOL_REPOSITORY_URI',
            value: process.env.TOOL_ECR_REPOSITORY_URI,
            type: 'PLAINTEXT',
          },
          { name: 'TOOL_IMAGE_TAG', value: imageTag, type: 'PLAINTEXT' },
          { name: 'CORE_IMAGE_URI', value: process.env.CORE_IMAGE_URI, type: 'PLAINTEXT' },
          {
            name: 'CORE_IMAGE_DIGEST',
            value: process.env.CORE_IMAGE_DIGEST,
            type: 'PLAINTEXT',
          },
        ],
      }),
    );
  } catch (error) {
    await store.updateVersion(
      tool.toolId,
      version.versionId,
      {
        status: 'FAILED',
        failure: {
          reason: 'tool_build_start_failed',
          detail: error.message,
          failedAt: new Date().toISOString(),
        },
      },
      { fromStatus: 'QUEUED' },
    );
    throw Object.assign(new Error('Unable to start tool build'), {
      statusCode: 502,
      code: 'TOOL_BUILD_START_FAILED',
    });
  }
  const build = started.build;
  const updated = await store.updateVersion(
    tool.toolId,
    version.versionId,
    {
      status: 'BUILDING',
      buildId: build?.id ?? null,
      buildArn: build?.arn ?? null,
      buildLogUrl: build?.logs?.deepLink ?? null,
      failure: null,
    },
    { fromStatus: 'QUEUED' },
  );
  return { tool, version: updated, requestedBy: actor };
};

export const createToolsHandler = ({
  store = defaultStore,
  environmentStore = defaultEnvironmentStore,
  s3Client = s3,
  codebuildClient = codebuild,
} = {}) => {
  const initialize = createRetryableInitializer(async () => {
    await store.seedSystemTools();
    const candidates = [
      ...(await store.listVersionsByStatus('DRAFT')),
      ...(await store.listVersionsByStatus('FAILED')),
    ];
    const autoBuilds = candidates.filter((version) => version.autoBuild);
    for (const version of autoBuilds) {
      const tool = await store.getTool(version.toolId);
      if (!tool) continue;
      try {
        await startToolBuild({
          store,
          tool,
          version,
          actor: 'platform',
          s3Client,
          codebuildClient,
        });
      } catch (error) {
        if (error.code === 'TOOL_RECOMMENDED_DEPENDENCY_MISSING') continue;
        console.error(`Unable to start seeded tool build ${version.versionId}:`, error.message);
      }
    }
  });

  return async (event) => {
    if (event?.action === 'bootstrap') {
      await initialize();
      return { initialized: true };
    }
    const response = buildResponse(event);
    if (event.httpMethod === 'OPTIONS') return response(200, {});
    const missingUser = requireUser(event);
    if (missingUser) return response(missingUser.statusCode, { error: missingUser.error });
    const denied = requirePlatformAdmin(event);
    if (denied) {
      return response(denied.statusCode, { error: denied.error, code: denied.code });
    }
    try {
      await initialize();
      const parts = pathParts(event);
      const toolsIndex = parts.lastIndexOf('tools');
      const tail = toolsIndex >= 0 ? parts.slice(toolsIndex + 1) : [];
      const toolId = tail[0] ?? null;
      const versionIndex = tail.indexOf('versions');
      const versionId = versionIndex >= 0 ? tail[versionIndex + 1] : null;
      const action = tail.at(-1);
      const actor = actorFrom(event);

      if (event.httpMethod === 'GET' && tail.length === 0) {
        const publishedOnly = event.queryStringParameters?.published === 'true';
        const tools = await store.listTools();
        return response(
          200,
          await Promise.all(
            tools.map(async (tool) => ({
              ...tool,
              versions: await store.listVersions(tool.toolId, { publishedOnly }),
            })),
          ),
        );
      }

      if (event.httpMethod === 'POST' && tail.length === 0) {
        const data = parseBody(event);
        const metadata = toolMetadata(data);
        const id = normalizeToolId(data.toolId || data.name);
        const tool = await store.createTool({
          toolId: id,
          ...metadata,
          createdBy: actor,
        });
        return response(201, { ...tool, versions: [] });
      }

      const tool = toolId ? await store.getTool(toolId) : null;
      if (!tool) return response(404, { error: 'Tool not found' });

      if (event.httpMethod === 'GET' && tail.length === 1) {
        return response(200, {
          ...tool,
          versions: await store.listVersions(tool.toolId),
        });
      }

      if (event.httpMethod === 'PUT' && tail.length === 1) {
        const data = parseBody(event);
        const updated = await store.updateTool(tool.toolId, toolMetadata(data, { partial: true }));
        return response(200, updated);
      }

      if (event.httpMethod === 'POST' && tail.length === 2 && action === 'versions') {
        const data = parseBody(event);
        const definition = normalizeToolVersionDefinition(data.definition ?? data);
        await assertKnownDependencies(store, tool.toolId, definition);
        const version = await store.createVersion({
          tool,
          definition,
          createdBy: actor,
        });
        return response(201, { tool, version });
      }

      if (event.httpMethod === 'PUT' && versionId && action === versionId) {
        const version = await store.getVersion(tool.toolId, versionId);
        if (!version) return response(404, { error: 'Tool version not found' });
        if (!['DRAFT', 'FAILED'].includes(version.status)) {
          return response(409, { error: 'Only draft or failed tool versions can be edited' });
        }
        const data = parseBody(event);
        const definition = normalizeToolVersionDefinition(data.definition ?? data);
        await assertKnownDependencies(store, tool.toolId, definition);
        if (definition.version !== version.definition.version) {
          return response(409, {
            error: 'Create a new tool version to change the version number',
          });
        }
        const sourceChanged =
          JSON.stringify(definition.source) !== JSON.stringify(version.definition.source);
        const updated = await store.updateVersion(tool.toolId, version.versionId, {
          definition,
          ...(sourceChanged ? { source: null } : {}),
        });
        return response(200, { tool, version: updated });
      }

      if (event.httpMethod === 'PUT' && action === 'recommended') {
        const data = parseBody(event);
        const versionIdToRecommend = String(data.versionId ?? '').trim();
        if (!versionIdToRecommend) return response(400, { error: 'versionId is required' });
        const candidate = await store.getVersion(tool.toolId, versionIdToRecommend);
        if (!candidate || candidate.status !== 'PUBLISHED') {
          return response(409, { error: 'Recommended version must be published' });
        }
        await assertRecommendationGraph(store, tool, candidate);
        const updated = await store.setRecommendedVersion({
          toolId: tool.toolId,
          versionId: versionIdToRecommend,
          actor,
        });
        const environments = await environmentStore.markToolUpdatesAvailable?.(
          tool.toolId,
          versionIdToRecommend,
        );
        return response(200, { tool: updated, environments: environments ?? [] });
      }

      const version = versionId ? await store.getVersion(tool.toolId, versionId) : null;

      if (event.httpMethod === 'GET' && versionId && action === versionId) {
        return version
          ? response(200, { tool, version })
          : response(404, { error: 'Tool version not found' });
      }

      if (event.httpMethod === 'GET' && action === 'logs') {
        return version
          ? response(200, {
              buildId: version.buildId,
              buildLogUrl: version.buildLogUrl,
              failure: version.failure,
              scanFindings: version.scanFindings,
              verification: version.verification,
            })
          : response(404, { error: 'Tool version not found' });
      }

      if (event.httpMethod === 'POST' && ['build', 'retry'].includes(action)) {
        if (!version) return response(404, { error: 'Tool version not found' });
        if (action === 'build' && version.status !== 'DRAFT') {
          return response(409, { error: 'Only draft tool versions can be built' });
        }
        if (
          action === 'retry' &&
          !['FAILED', 'SECURITY_REVIEW', 'READY'].includes(version.status)
        ) {
          return response(409, { error: 'Tool version cannot be retried from its current status' });
        }
        return response(
          202,
          await startToolBuild({
            store,
            tool,
            version,
            actor,
            s3Client,
            codebuildClient,
          }),
        );
      }

      if (event.httpMethod === 'POST' && action === 'acknowledge') {
        if (!version) return response(404, { error: 'Tool version not found' });
        if (version.status !== 'SECURITY_REVIEW') {
          return response(409, { error: 'Tool version is not awaiting security review' });
        }
        const acceptedAt = new Date().toISOString();
        const updated = await store.updateVersion(
          tool.toolId,
          version.versionId,
          {
            status: 'READY',
            securityFindingsAcceptedAt: acceptedAt,
            securityFindingsAcceptedBy: actor,
            verification: {
              ...version.verification,
              securityScan: 'ACCEPTED',
              completedAt: acceptedAt,
            },
            failure: null,
          },
          { fromStatus: 'SECURITY_REVIEW' },
        );
        return response(200, { tool, version: updated });
      }

      if (event.httpMethod === 'POST' && action === 'publish') {
        if (!version) return response(404, { error: 'Tool version not found' });
        const published = await store.publishVersion({ tool, version, actor });
        return response(200, { tool: await store.getTool(tool.toolId), version: published });
      }

      return response(405, { error: 'Method not allowed' });
    } catch (error) {
      console.error('Managed tool request failed:', error.message);
      return responseError(response, error);
    }
  };
};

export const handler = createToolsHandler();
