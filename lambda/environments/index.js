import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild';
import { buildResponse } from '../shared/response.js';
import { isPlatformAdmin, requirePlatformAdmin } from '../shared/authz.js';
import {
  ENVIRONMENT_TOOL_CATALOG,
  generateBuildContext,
  normalizeEnvironmentId,
  orderRebuilds,
  validateRecipe,
  flattenRecipe,
} from './recipe.js';
import { createEnvironmentStore } from './store.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const codebuild = new CodeBuildClient({});
const defaultStore = createEnvironmentStore({ ddb });

const actorFrom = (event) => {
  const claims = event?.requestContext?.authorizer?.claims ?? {};
  return claims.email || claims.sub || 'unknown';
};

const parseBody = (event) => {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
  }
};

const pathParts = (event) =>
  String(event.path ?? '')
    .split('/')
    .filter(Boolean);

const configuredCore = () => ({
  coreImageUri: process.env.CORE_IMAGE_URI,
  coreImageDigest: process.env.CORE_IMAGE_DIGEST,
  coreRuntimeArn: process.env.CORE_RUNTIME_ARN,
  coreRuntimeVersion: process.env.CORE_RUNTIME_VERSION || '1',
});

const responseError = (response, error) =>
  response(error.statusCode ?? 500, {
    error: error.statusCode ? error.message : 'Internal server error',
    ...(error.code ? { code: error.code } : {}),
    ...(error.issues ? { issues: error.issues } : {}),
  });

const requireUser = (event) => {
  if (event?.requestContext?.authorizer?.claims?.sub) return null;
  return { statusCode: 401, error: 'Unauthorized' };
};

const ensureSeeded = async (store) => {
  const core = configuredCore();
  if (!core.coreImageUri || !core.coreImageDigest || !core.coreRuntimeArn) {
    throw Object.assign(new Error('Managed environment core runtime is not configured'), {
      statusCode: 503,
    });
  }
  await store.seedSystemEnvironments(core);
  await store.stageCoreRevision(core);
};

const publishedBase = async (store, environmentId) => {
  const environment = await store.getEnvironment(environmentId);
  if (!environment || environment.status === 'RETIRED' || !environment.publishedRevisionId) {
    throw Object.assign(new Error('Base environment must have a published revision'), {
      statusCode: 409,
    });
  }
  const revision = await store.getRevision(environmentId, environment.publishedRevisionId);
  if (!revision?.imageUri || !revision?.imageDigest) {
    throw Object.assign(new Error('Base environment image is unavailable'), {
      statusCode: 409,
    });
  }
  return { environment, revision };
};

const assertAcyclicBase = async (store, environmentId, baseEnvironmentId) => {
  const visited = new Set();
  let candidateId = baseEnvironmentId;
  while (candidateId) {
    if (candidateId === environmentId) {
      throw Object.assign(new Error('Environment base dependency would create a cycle'), {
        statusCode: 409,
      });
    }
    if (visited.has(candidateId)) {
      throw Object.assign(new Error('Environment base dependency contains a cycle'), {
        statusCode: 409,
      });
    }
    visited.add(candidateId);
    const candidate = await store.getEnvironment(candidateId);
    candidateId = candidate?.baseEnvironmentId ?? null;
  }
};

const prepareRecipe = async (store, input, baseEnvironmentId) => {
  const { revision: baseRevision } = await publishedBase(store, baseEnvironmentId);
  const recipe = {
    schemaVersion: input?.schemaVersion ?? 1,
    base: {
      environmentId: baseEnvironmentId,
      revisionId: baseRevision.revisionId,
      imageUri: baseRevision.imageUri,
      imageDigest: baseRevision.imageDigest,
    },
    tools: input?.tools ?? {},
    buildTools: input?.buildTools ?? {},
    aptPackages: input?.aptPackages ?? [],
    environmentVariables: input?.environmentVariables ?? {},
    buildCommands: input?.buildCommands ?? [],
  };
  const validation = validateRecipe(recipe);
  if (!validation.valid) {
    throw Object.assign(new Error('Invalid environment recipe'), {
      statusCode: 400,
      issues: validation.issues,
    });
  }
  return {
    recipe,
    flattenedRecipe: flattenRecipe(recipe, baseRevision.flattenedRecipe),
  };
};

const startBuild = async ({ store, environment, revision, actor, deps }) => {
  if (revision.status !== 'DRAFT') {
    throw Object.assign(new Error(`Revision is ${revision.status} and cannot be built`), {
      statusCode: 409,
    });
  }
  const context = generateBuildContext({
    environment,
    revision,
    flattenedRecipe: revision.flattenedRecipe,
  });
  const prefix = `managed-environments/contexts/${environment.environmentId}/${revision.revisionId}`;
  await Promise.all(
    Object.entries(context.files).map(([name, body]) =>
      deps.s3.send(
        new PutObjectCommand({
          Bucket: process.env.BUILD_CONTEXT_BUCKET,
          Key: `${prefix}/${name}`,
          Body: body,
          ContentType: name.endsWith('.json') ? 'application/json' : 'text/plain',
          ServerSideEncryption: 'AES256',
        }),
      ),
    ),
  );
  await store.updateRevision(
    environment.environmentId,
    revision.revisionId,
    {
      status: 'QUEUED',
      contextPrefix: prefix,
      generatedDockerfile: context.dockerfile,
      failure: null,
    },
    { fromStatus: revision.status },
  );
  let started;
  try {
    started = await deps.codebuild.send(
      new StartBuildCommand({
        projectName: process.env.ENVIRONMENT_CODEBUILD_PROJECT,
        environmentVariablesOverride: [
          {
            name: 'CONTEXT_BUCKET',
            value: process.env.BUILD_CONTEXT_BUCKET,
            type: 'PLAINTEXT',
          },
          { name: 'CONTEXT_PREFIX', value: prefix, type: 'PLAINTEXT' },
          {
            name: 'ENVIRONMENT_ID',
            value: environment.environmentId,
            type: 'PLAINTEXT',
          },
          {
            name: 'REVISION_ID',
            value: revision.revisionId,
            type: 'PLAINTEXT',
          },
          {
            name: 'IMAGE_REPOSITORY_URI',
            value: process.env.ENVIRONMENT_ECR_REPOSITORY_URI,
            type: 'PLAINTEXT',
          },
          {
            name: 'IMAGE_REPOSITORY_NAME',
            value: process.env.ENVIRONMENT_ECR_REPOSITORY_NAME,
            type: 'PLAINTEXT',
          },
          { name: 'IMAGE_TAG', value: revision.revisionId, type: 'PLAINTEXT' },
        ],
      }),
    );
  } catch (error) {
    const failure = {
      reason: 'image_build_start_failed',
      detail: error.message,
      failedAt: new Date().toISOString(),
    };
    try {
      await store.updateRevision(
        environment.environmentId,
        revision.revisionId,
        { status: 'FAILED', failure },
        { fromStatus: 'QUEUED' },
      );
      await store.updateEnvironment(
        environment.environmentId,
        {
          status: 'FAILED',
        },
        {
          ifCurrentRevisionId: revision.revisionId,
          unlessRetired: true,
        },
      );
    } catch (stateError) {
      console.error('Unable to record environment image build start failure:', stateError.message);
    }
    throw Object.assign(new Error('Unable to start environment image build'), {
      statusCode: 502,
      code: 'IMAGE_BUILD_START_FAILED',
    });
  }
  const build = started.build;
  const updatedRevision = await store.updateRevision(
    environment.environmentId,
    revision.revisionId,
    {
      status: 'BUILDING',
      buildId: build?.id ?? null,
      buildArn: build?.arn ?? null,
      buildLogUrl: build?.logs?.deepLink ?? null,
      failure: null,
    },
    { fromStatus: 'QUEUED' },
  );
  try {
    await store.updateEnvironment(
      environment.environmentId,
      { status: 'BUILDING' },
      {
        ifCurrentRevisionId: revision.revisionId,
        unlessRetired: true,
      },
    );
  } catch (error) {
    if (error?.name !== 'ConditionalCheckFailedException') throw error;
  }
  return {
    environment: await store.getEnvironment(environment.environmentId),
    revision: updatedRevision,
    requestedBy: actor,
  };
};

const cloneOnLatestBase = async ({ store, environment, actor }) => {
  if (environment.status === 'RETIRED') {
    throw Object.assign(new Error('Retired environments cannot be rebuilt'), {
      statusCode: 409,
    });
  }
  if (!environment.publishedRevisionId) {
    throw Object.assign(new Error('Environment has no published recipe to rebuild'), {
      statusCode: 409,
    });
  }
  if (!environment.baseEnvironmentId) {
    throw Object.assign(new Error('The Standard environment follows the core runtime'), {
      statusCode: 409,
    });
  }
  const published = await store.getRevision(
    environment.environmentId,
    environment.publishedRevisionId,
  );
  const { revision: latestBase } = await publishedBase(store, environment.baseEnvironmentId);
  const recipe = {
    ...published.recipe,
    base: {
      environmentId: environment.baseEnvironmentId,
      revisionId: latestBase.revisionId,
      imageUri: latestBase.imageUri,
      imageDigest: latestBase.imageDigest,
    },
  };
  const flattenedRecipe = flattenRecipe(recipe, latestBase.flattenedRecipe);
  return store.createRevision({
    environment,
    recipe,
    flattenedRecipe,
    createdBy: actor,
    reason: 'latest-base',
  });
};

export const createHandler = ({
  store = defaultStore,
  s3Client = s3,
  codebuildClient = codebuild,
} = {}) => {
  const deps = { s3: s3Client, codebuild: codebuildClient };
  let initialization;
  const initialize = () => {
    initialization ??= ensureSeeded(store).catch((error) => {
      initialization = null;
      throw error;
    });
    return initialization;
  };
  return async (event) => {
    const response = buildResponse(event);
    if (event.httpMethod === 'OPTIONS') return response(200, {});
    const missingUser = requireUser(event);
    if (missingUser) return response(missingUser.statusCode, { error: missingUser.error });
    try {
      await initialize();
      const parts = pathParts(event);
      const environmentIndex = parts.lastIndexOf('environments');
      const tail = environmentIndex >= 0 ? parts.slice(environmentIndex + 1) : [];
      const environmentId = tail[0] ?? null;
      const revisionIndex = tail.indexOf('revisions');
      const revisionId = revisionIndex >= 0 ? tail[revisionIndex + 1] : null;
      const action = tail.at(-1);
      const actor = actorFrom(event);
      const admin = isPlatformAdmin(event);

      if (event.httpMethod === 'GET' && tail.length === 0) {
        const publishedOnly = event.queryStringParameters?.published === 'true' || !admin;
        return response(200, await store.listEnvironments({ publishedOnly }));
      }

      if (event.httpMethod === 'GET' && tail.length === 1 && environmentId === 'catalog') {
        return response(200, ENVIRONMENT_TOOL_CATALOG);
      }

      if (event.httpMethod === 'POST' && tail.length === 0) {
        const denied = requirePlatformAdmin(event);
        if (denied)
          return response(denied.statusCode, {
            error: denied.error,
            code: denied.code,
          });
        const data = parseBody(event);
        if (!data.name?.trim()) return response(400, { error: 'name is required' });
        const id = normalizeEnvironmentId(data.environmentId || data.name);
        if (['catalog', 'rebuild'].includes(id)) {
          return response(400, { error: 'environmentId is reserved by the platform' });
        }
        const baseEnvironmentId = data.baseEnvironmentId || 'standard';
        await assertAcyclicBase(store, id, baseEnvironmentId);
        const prepared = await prepareRecipe(store, data.recipe, baseEnvironmentId);
        const created = await store.createEnvironment({
          environmentId: id,
          name: data.name.trim(),
          description: String(data.description ?? '').trim(),
          baseEnvironmentId,
          recipe: prepared.recipe,
          flattenedRecipe: prepared.flattenedRecipe,
          createdBy: actor,
        });
        return response(201, created);
      }

      if (event.httpMethod === 'POST' && tail.length === 1 && !environmentId) {
        return response(404, { error: 'Environment not found' });
      }

      if (event.httpMethod === 'POST' && environmentId === 'rebuild') {
        const denied = requirePlatformAdmin(event);
        if (denied)
          return response(denied.statusCode, {
            error: denied.error,
            code: denied.code,
          });
        const data = parseBody(event);
        const all = await store.listEnvironments();
        const selected = Array.isArray(data.environmentIds)
          ? all.filter((item) => data.environmentIds.includes(item.environmentId))
          : all.filter((item) => item.updateAvailable);
        const builds = [];
        for (const environment of orderRebuilds(
          selected.filter((item) => item.baseEnvironmentId),
        )) {
          const revision = await cloneOnLatestBase({
            store,
            environment,
            actor,
          });
          builds.push(
            await startBuild({
              store,
              environment: await store.getEnvironment(environment.environmentId),
              revision,
              actor,
              deps,
            }),
          );
        }
        return response(202, { builds });
      }

      const environment = environmentId ? await store.getEnvironment(environmentId) : null;
      if (!environment) return response(404, { error: 'Environment not found' });

      if (event.httpMethod === 'GET' && tail.length === 1) {
        if (!admin && (!environment.publishedRevisionId || environment.status === 'RETIRED')) {
          return response(404, { error: 'Environment not found' });
        }
        const revisions = admin ? await store.listRevisions(environmentId) : [];
        const publishedRevision = environment.publishedRevisionId
          ? await store.getRevision(environmentId, environment.publishedRevisionId)
          : null;
        return response(200, { environment, revisions, publishedRevision });
      }

      if (event.httpMethod !== 'GET' && environment.status === 'RETIRED') {
        return response(409, {
          error: 'Retired environments cannot be changed',
        });
      }

      if (event.httpMethod === 'PUT' && tail.length === 1) {
        const denied = requirePlatformAdmin(event);
        if (denied)
          return response(denied.statusCode, {
            error: denied.error,
            code: denied.code,
          });
        if (environmentId === 'standard') {
          return response(409, {
            error: 'The Standard environment follows the protected core runtime',
          });
        }
        const data = parseBody(event);
        const baseEnvironmentId =
          data.baseEnvironmentId || environment.baseEnvironmentId || 'standard';
        await assertAcyclicBase(store, environmentId, baseEnvironmentId);
        const prepared = await prepareRecipe(store, data.recipe, baseEnvironmentId);
        const revision = await store.createRevision({
          environment,
          recipe: prepared.recipe,
          flattenedRecipe: prepared.flattenedRecipe,
          createdBy: actor,
        });
        const updated = await store.updateEnvironment(environmentId, {
          ...(data.name?.trim() ? { name: data.name.trim() } : {}),
          ...(data.description !== undefined
            ? { description: String(data.description).trim() }
            : {}),
        });
        return response(200, { environment: updated, revision });
      }

      if (event.httpMethod === 'POST' && action === 'rebuild') {
        const denied = requirePlatformAdmin(event);
        if (denied)
          return response(denied.statusCode, {
            error: denied.error,
            code: denied.code,
          });
        const revision = await cloneOnLatestBase({ store, environment, actor });
        return response(
          202,
          await startBuild({
            store,
            environment: await store.getEnvironment(environmentId),
            revision,
            actor,
            deps,
          }),
        );
      }

      const effectiveRevisionId =
        revisionId || (action === 'build' ? environment.currentRevisionId : null);
      const revision = effectiveRevisionId
        ? await store.getRevision(environmentId, effectiveRevisionId)
        : null;

      if (event.httpMethod === 'GET' && revisionId && action === revisionId) {
        if (!admin && revisionId !== environment.publishedRevisionId) {
          return response(404, { error: 'Revision not found' });
        }
        return revision ? response(200, revision) : response(404, { error: 'Revision not found' });
      }

      if (event.httpMethod === 'GET' && action === 'logs') {
        if (!admin)
          return response(403, {
            error: 'Platform administrator access required',
          });
        return revision
          ? response(200, {
              buildId: revision.buildId,
              buildLogUrl: revision.buildLogUrl,
              failure: revision.failure,
              scanFindings: revision.scanFindings,
              verification: revision.verification,
            })
          : response(404, { error: 'Revision not found' });
      }

      if (event.httpMethod === 'POST' && action === 'build') {
        const denied = requirePlatformAdmin(event);
        if (denied)
          return response(denied.statusCode, {
            error: denied.error,
            code: denied.code,
          });
        if (!revision) return response(404, { error: 'Revision not found' });
        return response(202, await startBuild({ store, environment, revision, actor, deps }));
      }

      if (event.httpMethod === 'POST' && action === 'retry') {
        const denied = requirePlatformAdmin(event);
        if (denied)
          return response(denied.statusCode, {
            error: denied.error,
            code: denied.code,
          });
        if (!revision) return response(404, { error: 'Revision not found' });
        if (revision.status !== 'FAILED') {
          return response(409, {
            error: 'Only failed revisions can be retried',
          });
        }
        const replacement = await store.createRevision({
          environment,
          recipe: revision.recipe,
          flattenedRecipe: revision.flattenedRecipe,
          createdBy: actor,
          reason: 'retry',
        });
        return response(
          202,
          await startBuild({
            store,
            environment: await store.getEnvironment(environmentId),
            revision: replacement,
            actor,
            deps,
          }),
        );
      }

      if (event.httpMethod === 'POST' && action === 'acknowledge') {
        const denied = requirePlatformAdmin(event);
        if (denied)
          return response(denied.statusCode, {
            error: denied.error,
            code: denied.code,
          });
        if (!revision) return response(404, { error: 'Revision not found' });
        if (revision.status !== 'SECURITY_REVIEW') {
          return response(409, {
            error: 'Revision is not awaiting a security acknowledgement',
          });
        }
        const acknowledged = await store.updateRevision(
          environmentId,
          revision.revisionId,
          {
            highFindingsAcknowledgedAt: new Date().toISOString(),
            highFindingsAcknowledgedBy: actor,
          },
          { fromStatus: 'SECURITY_REVIEW' },
        );
        return response(202, {
          environment,
          revision: acknowledged,
          pending: true,
        });
      }

      if (event.httpMethod === 'POST' && action === 'publish') {
        const denied = requirePlatformAdmin(event);
        if (denied)
          return response(denied.statusCode, {
            error: denied.error,
            code: denied.code,
          });
        if (!revision) return response(404, { error: 'Revision not found' });
        if (revision.status !== 'READY') {
          return response(409, {
            error: 'Only READY revisions can be published',
          });
        }
        if (environmentId !== 'standard' && revision.recipe?.base?.environmentId) {
          await assertAcyclicBase(store, environmentId, revision.recipe.base.environmentId);
        }
        const published = await store.publishRevision({
          environment,
          revision,
          actor,
        });
        const dependents = await store.markDependentsUpdateAvailable(
          environmentId,
          revision.revisionId,
        );
        return response(200, { ...published, dependents });
      }

      if (
        (event.httpMethod === 'POST' && action === 'retire') ||
        (event.httpMethod === 'DELETE' && tail.length === 1)
      ) {
        const denied = requirePlatformAdmin(event);
        if (denied)
          return response(denied.statusCode, {
            error: denied.error,
            code: denied.code,
          });
        if (environmentId === 'standard') {
          return response(409, {
            error: 'The Standard environment cannot be retired',
          });
        }
        if (['BUILDING', 'VERIFYING'].includes(environment.status)) {
          return response(409, {
            error: 'Wait for active environment validation to finish before retiring',
          });
        }
        const retired = await store.updateEnvironment(environmentId, {
          status: 'RETIRED',
          retiredAt: new Date().toISOString(),
          retiredBy: actor,
        });
        return response(200, retired);
      }

      return response(405, { error: 'Method not allowed' });
    } catch (error) {
      console.error('Managed environment request failed:', error.message);
      return responseError(response, error);
    }
  };
};

export const handler = createHandler();

export { startBuild, cloneOnLatestBase, prepareRecipe, assertAcyclicBase };
