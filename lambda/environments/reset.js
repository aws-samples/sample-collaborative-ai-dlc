import { randomUUID } from 'node:crypto';
import gremlin from 'gremlin';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { BatchDeleteImageCommand, ECRClient, ListImagesCommand } from '@aws-sdk/client-ecr';
import {
  BedrockAgentCoreControlClient,
  DeleteAgentRuntimeCommand,
  DeleteAgentRuntimeEndpointCommand,
  GetAgentRuntimeCommand,
  GetAgentRuntimeEndpointCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import {
  BedrockAgentCoreClient,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  InvokeCommand,
  LambdaClient,
  ListDurableExecutionsByFunctionCommand,
  StopDurableExecutionCommand,
} from '@aws-sdk/client-lambda';
import { buildResponse } from '../shared/response.js';
import { requirePlatformAdmin } from '../shared/authz.js';
import { runtimeTargetInput } from '../shared/runtime-target.js';
import { createProcessStore } from '../shared/v2-process-store.js';
import { createEnvironmentStore } from './store.js';

const RESET_ID = 'managed-tool-catalog-reset';
const RESET_CONFIRMATION = 'RESET MANAGED ENVIRONMENTS';
const RESET_STALE_MS = 20 * 60 * 1000;
const markerKey = { pk: `MIGRATION#${RESET_ID}`, sk: 'META' };
const terminalRuntimeErrors = new Set(['ResourceNotFoundException']);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ecr = new ECRClient({});
const runtimeControl = new BedrockAgentCoreControlClient({});
const runtimeData = new BedrockAgentCoreClient({});
const lambda = new LambdaClient({});
const environmentStore = createEnvironmentStore({ ddb });
const processStore = createProcessStore({ ddb, tableName: process.env.V2_EXECUTIONS_TABLE });

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const { cardinality, P } = gremlin.process;

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

const getConnection = async () => {
  const credentials = await fromNodeProviderChain()();
  credentials.region = process.env.AWS_REGION ?? 'us-east-1';
  const { url, headers } = getUrlAndHeaders(
    process.env.NEPTUNE_ENDPOINT,
    process.env.GREMLIN_PORT ?? '8182',
    credentials,
    '/gremlin',
    process.env.GREMLIN_PROTOCOL ?? 'wss',
  );
  return new DriverRemoteConnection(url, { headers });
};

const listProjects = async (g) => {
  const rows = await g
    .V()
    .hasLabel('Project')
    .has('environment_id')
    .has('environment_id', P.neq('standard'))
    .project('projectId', 'environmentId')
    .by('id')
    .by('environment_id')
    .toList();
  return rows.map((row) => ({
    projectId: row.get('projectId'),
    environmentId: row.get('environmentId'),
  }));
};

const listImages = async (client = ecr) => {
  const images = [];
  let nextToken;
  do {
    const result = await client.send(
      new ListImagesCommand({
        repositoryName: process.env.ENVIRONMENT_ECR_REPOSITORY_NAME,
        nextToken,
      }),
    );
    images.push(...(result.imageIds ?? []));
    nextToken = result.nextToken;
  } while (nextToken);
  return images;
};

export const relevantRegistryItems = (items) => {
  const environmentIds = new Set(
    items
      .filter(
        (item) =>
          String(item.pk).startsWith('ENV#') &&
          item.environmentId &&
          item.environmentId !== 'standard',
      )
      .map((item) => item.environmentId),
  );
  return {
    environmentIds,
    items: items.filter(
      (item) =>
        (String(item.pk).startsWith('ENV#') && item.environmentId !== 'standard') ||
        (item.environmentId !== 'standard' &&
          environmentIds.has(item.environmentId) &&
          item.sk === 'LOOKUP'),
    ),
  };
};

const activeManagedIntents = async (store = processStore) =>
  (await store.listActiveExecutions({ limit: 10_000 })).filter(
    (meta) => meta.environment?.environmentId && meta.environment.environmentId !== 'standard',
  );

const dryRun = async ({ g, store = environmentStore, process = processStore, ecrClient = ecr }) => {
  const [projects, activeIntents, registry, images] = await Promise.all([
    listProjects(g),
    activeManagedIntents(process),
    store.scanRegistry(),
    listImages(ecrClient),
  ]);
  const relevant = relevantRegistryItems(registry);
  const revisions = relevant.items.filter((item) => item.type === 'EnvironmentRevision');
  return {
    projects: projects.length,
    activeIntents: activeIntents.length,
    environments: relevant.environmentIds.size,
    revisions: revisions.length,
    runtimes: new Set(revisions.map((revision) => revision.runtimeId).filter(Boolean)).size,
    images: images.length,
  };
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitUntilMissing = async (read, { attempts = 60, intervalMs = 5000 } = {}) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await read();
    } catch (error) {
      if (terminalRuntimeErrors.has(error?.name)) return;
      throw error;
    }
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for AgentCore resource deletion');
};

const deleteRuntimeArtifacts = async (revisions, client = runtimeControl) => {
  const resources = new Map();
  for (const revision of revisions) {
    if (!revision.runtimeId) continue;
    const value = resources.get(revision.runtimeId) ?? {
      runtimeId: revision.runtimeId,
      versions: new Set(),
      endpoints: new Set(),
    };
    if (revision.runtimeVersion) value.versions.add(String(revision.runtimeVersion));
    if (revision.runtimeEndpoint) value.endpoints.add(revision.runtimeEndpoint);
    resources.set(revision.runtimeId, value);
  }
  for (const resource of resources.values()) {
    for (const endpointName of resource.endpoints) {
      try {
        await client.send(
          new DeleteAgentRuntimeEndpointCommand({
            agentRuntimeId: resource.runtimeId,
            endpointName,
            clientToken: randomUUID(),
          }),
        );
        await waitUntilMissing(() =>
          client.send(
            new GetAgentRuntimeEndpointCommand({
              agentRuntimeId: resource.runtimeId,
              endpointName,
            }),
          ),
        );
      } catch (error) {
        if (!terminalRuntimeErrors.has(error?.name)) throw error;
      }
    }
    const versions = resource.versions.size ? [...resource.versions] : [null];
    for (const runtimeVersion of versions) {
      try {
        await client.send(
          new DeleteAgentRuntimeCommand({
            agentRuntimeId: resource.runtimeId,
            ...(runtimeVersion ? { agentRuntimeVersion: runtimeVersion } : {}),
            clientToken: randomUUID(),
          }),
        );
        await waitUntilMissing(() =>
          client.send(
            new GetAgentRuntimeCommand({
              agentRuntimeId: resource.runtimeId,
              ...(runtimeVersion ? { agentRuntimeVersion: runtimeVersion } : {}),
            }),
          ),
        );
      } catch (error) {
        if (!terminalRuntimeErrors.has(error?.name)) throw error;
      }
    }
  }
};

const durableExecutionArn = async (meta, client = lambda) => {
  if (meta.durableExecutionArn) return meta.durableExecutionArn;
  if (!meta.durableExecutionName || !process.env.V2_ORCHESTRATOR_FUNCTION) return null;
  const result = await client.send(
    new ListDurableExecutionsByFunctionCommand({
      FunctionName: process.env.V2_ORCHESTRATOR_FUNCTION,
      DurableExecutionName: meta.durableExecutionName,
      MaxItems: 1,
    }),
  );
  return result.DurableExecutions?.[0]?.DurableExecutionArn ?? null;
};

const runtimeSessionIdFor = (intentId) => `aidlc-intent-${intentId}`.padEnd(33, '0');
const laneSessionIdFor = (intentId, sectionIndex, slug) =>
  `aidlc-intent-${intentId}-s${sectionIndex}-${slug}`.padEnd(33, '0');

const cancelIntent = async ({
  meta,
  process = processStore,
  lambdaClient = lambda,
  runtimeClient = runtimeData,
  actor,
}) => {
  const arn = await durableExecutionArn(meta, lambdaClient);
  if (arn) {
    try {
      await lambdaClient.send(
        new StopDurableExecutionCommand({
          DurableExecutionArn: arn,
          Error: {
            ErrorType: 'ManagedEnvironmentReset',
            ErrorMessage: 'Managed environment removed by a platform administrator',
          },
        }),
      );
    } catch (error) {
      if (
        !['ResourceNotFoundException', 'DurableExecutionNotFoundException'].includes(error?.name)
      ) {
        throw error;
      }
    }
  }
  const records = await process.getExecutionRecords(meta.executionId, { includeOutputs: false });
  const sessionIds = [
    runtimeSessionIdFor(meta.executionId),
    ...records.units
      .filter((unit) => unit.sectionIndex !== undefined && unit.slug)
      .map((unit) => laneSessionIdFor(meta.executionId, unit.sectionIndex, unit.slug)),
  ];
  const target = runtimeTargetInput(meta);
  if (target.agentRuntimeArn) {
    await Promise.all(
      sessionIds.map(async (runtimeSessionId) => {
        try {
          await runtimeClient.send(new StopRuntimeSessionCommand({ ...target, runtimeSessionId }));
        } catch (error) {
          if (!['ResourceNotFoundException', 'ValidationException'].includes(error?.name)) {
            throw error;
          }
        }
      }),
    );
  }
  await process.updateExecution({
    executionId: meta.executionId,
    projectId: meta.projectId,
    status: 'CANCELLED',
    fromStatus: meta.status,
    startedAt: meta.startedAt,
    pendingHumanTaskId: null,
    completedAt: new Date().toISOString(),
    failureReason: 'managed_environment_reset',
  });
  await process.appendEvent({
    executionId: meta.executionId,
    type: 'v2.execution.cancelled',
    actor,
    summary: 'Run cancelled because its managed environment was removed',
  });
};

const deleteImages = async (images, client = ecr) => {
  for (let index = 0; index < images.length; index += 100) {
    const batch = images.slice(index, index + 100);
    const result = await client.send(
      new BatchDeleteImageCommand({
        repositoryName: process.env.ENVIRONMENT_ECR_REPOSITORY_NAME,
        imageIds: batch,
      }),
    );
    if (result.failures?.length) {
      throw new Error(`ECR rejected ${result.failures.length} managed image deletions`);
    }
  }
};

const deleteRegistryItems = async (items, documentClient = ddb) => {
  for (let index = 0; index < items.length; index += 25) {
    let requests = items.slice(index, index + 25).map((item) => ({
      DeleteRequest: { Key: { pk: item.pk, sk: item.sk } },
    }));
    while (requests.length) {
      const result = await documentClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [process.env.ENVIRONMENT_REGISTRY_TABLE]: requests,
          },
        }),
      );
      requests = result.UnprocessedItems?.[process.env.ENVIRONMENT_REGISTRY_TABLE] ?? [];
      if (requests.length) await sleep(250);
    }
  }
};

const getMarker = async (documentClient = ddb) => {
  const result = await documentClient.send(
    new GetCommand({
      TableName: process.env.ENVIRONMENT_REGISTRY_TABLE,
      Key: markerKey,
      ConsistentRead: true,
    }),
  );
  return result.Item ?? null;
};

export const recoverStaleMarker = async (marker, documentClient = ddb) => {
  if (marker?.status !== 'IN_PROGRESS') return marker;
  const updatedAt = Date.parse(marker.updatedAt ?? marker.startedAt ?? '');
  if (Number.isFinite(updatedAt) && Date.now() - updatedAt <= RESET_STALE_MS) return marker;
  const failedAt = new Date().toISOString();
  const expectedTimestamp = marker.updatedAt ?? marker.startedAt;
  const timestampName = marker.updatedAt ? 'updatedAt' : 'startedAt';
  try {
    await documentClient.send(
      new UpdateCommand({
        TableName: process.env.ENVIRONMENT_REGISTRY_TABLE,
        Key: markerKey,
        ConditionExpression: expectedTimestamp
          ? `#status = :inProgress AND #timestamp = :expected`
          : '#status = :inProgress',
        UpdateExpression:
          'SET #status = :failed, failedAt = :failedAt, updatedAt = :failedAt, failure = :failure',
        ExpressionAttributeNames: {
          '#status': 'status',
          ...(expectedTimestamp ? { '#timestamp': timestampName } : {}),
        },
        ExpressionAttributeValues: {
          ':inProgress': 'IN_PROGRESS',
          ...(expectedTimestamp ? { ':expected': expectedTimestamp } : {}),
          ':failed': 'FAILED',
          ':failedAt': failedAt,
          ':failure': { message: 'The previous reset did not complete before its timeout' },
        },
      }),
    );
    return {
      ...marker,
      status: 'FAILED',
      failedAt,
      updatedAt: failedAt,
      failure: { message: 'The previous reset did not complete before its timeout' },
    };
  } catch (error) {
    if (error?.name !== 'ConditionalCheckFailedException') throw error;
    return getMarker(documentClient);
  }
};

const beginReset = async (actor, documentClient = ddb) => {
  const existing = await recoverStaleMarker(await getMarker(documentClient), documentClient);
  if (existing?.status === 'COMPLETE') return { complete: true, marker: existing };
  if (existing?.status === 'IN_PROGRESS') {
    throw Object.assign(new Error('Managed environment reset is already running'), {
      statusCode: 409,
    });
  }
  const now = new Date().toISOString();
  const marker = {
    ...markerKey,
    type: 'Migration',
    migrationId: RESET_ID,
    status: 'IN_PROGRESS',
    executionToken: randomUUID(),
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
    startedBy: existing?.startedBy ?? actor,
    attempt: Number(existing?.attempt ?? 0) + 1,
  };
  await documentClient.send(
    new PutCommand({
      TableName: process.env.ENVIRONMENT_REGISTRY_TABLE,
      Item: marker,
      ConditionExpression: 'attribute_not_exists(pk) OR #status = :failed',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':failed': 'FAILED' },
    }),
  );
  return { complete: false, marker };
};

const finishReset = async (status, patch, documentClient = ddb, { executionToken = null } = {}) => {
  const names = { '#status': 'status' };
  const values = { ':status': status, ':updated': new Date().toISOString() };
  const sets = ['#status = :status', 'updatedAt = :updated'];
  for (const [name, value] of Object.entries(patch)) {
    sets.push(`${name} = :${name}`);
    values[`:${name}`] = value;
  }
  await documentClient.send(
    new UpdateCommand({
      TableName: process.env.ENVIRONMENT_REGISTRY_TABLE,
      Key: markerKey,
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ...(executionToken
        ? {
            ConditionExpression: '#status = :inProgress AND executionToken = :executionToken',
            ExpressionAttributeValues: {
              ...values,
              ':inProgress': 'IN_PROGRESS',
              ':executionToken': executionToken,
            },
          }
        : {}),
    }),
  );
};

export const claimResetExecution = async (marker, executionToken, documentClient = ddb) => {
  if (
    marker?.status !== 'IN_PROGRESS' ||
    !executionToken ||
    marker.executionToken !== executionToken
  ) {
    return false;
  }
  try {
    await documentClient.send(
      new UpdateCommand({
        TableName: process.env.ENVIRONMENT_REGISTRY_TABLE,
        Key: markerKey,
        ConditionExpression:
          '#status = :inProgress AND executionToken = :executionToken AND attribute_not_exists(executionClaimedAt)',
        UpdateExpression: 'SET executionClaimedAt = :claimedAt, updatedAt = :claimedAt',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':inProgress': 'IN_PROGRESS',
          ':executionToken': executionToken,
          ':claimedAt': new Date().toISOString(),
        },
      }),
    );
    return true;
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') return false;
    throw error;
  }
};

export const executeReset = async ({
  g,
  actor,
  store = environmentStore,
  process = processStore,
  documentClient = ddb,
  ecrClient = ecr,
  controlClient = runtimeControl,
  runtimeClient = runtimeData,
  lambdaClient = lambda,
  begin = true,
  executionToken = null,
}) => {
  let activeExecutionToken = executionToken;
  if (begin) {
    const started = await beginReset(actor, documentClient);
    if (started.complete) return started.marker.result;
    activeExecutionToken = started.marker.executionToken;
  }
  try {
    const [projects, activeIntents, registry, images] = await Promise.all([
      listProjects(g),
      activeManagedIntents(process),
      store.scanRegistry(),
      listImages(ecrClient),
    ]);
    const relevant = relevantRegistryItems(registry);
    const revisions = relevant.items.filter((item) => item.type === 'EnvironmentRevision');
    const runtimeCount = new Set(revisions.map((revision) => revision.runtimeId).filter(Boolean))
      .size;

    if (projects.length) {
      await g
        .V()
        .hasLabel('Project')
        .has('environment_id')
        .has('environment_id', P.neq('standard'))
        .property(cardinality.single, 'environment_id', 'standard')
        .iterate();
    }
    for (const meta of activeIntents) {
      await cancelIntent({ meta, process, lambdaClient, runtimeClient, actor });
    }
    await deleteRuntimeArtifacts(revisions, controlClient);
    await deleteImages(images, ecrClient);
    await deleteRegistryItems(relevant.items, documentClient);

    const result = {
      projectsReassigned: projects.length,
      intentsCancelled: activeIntents.length,
      environmentsDeleted: relevant.environmentIds.size,
      revisionsDeleted: revisions.length,
      runtimesDeleted: runtimeCount,
      imagesDeleted: images.length,
    };
    await finishReset(
      'COMPLETE',
      { completedAt: new Date().toISOString(), completedBy: actor, result },
      documentClient,
      { executionToken: activeExecutionToken },
    );
    return result;
  } catch (error) {
    await finishReset(
      'FAILED',
      {
        failedAt: new Date().toISOString(),
        failure: { message: error.message },
      },
      documentClient,
      { executionToken: activeExecutionToken },
    ).catch(() => undefined);
    throw error;
  }
};

export const createResetHandler =
  ({
    connectionFactory = getConnection,
    store = environmentStore,
    process = processStore,
    documentClient = ddb,
    ecrClient = ecr,
    controlClient = runtimeControl,
    runtimeClient = runtimeData,
    lambdaClient = lambda,
  } = {}) =>
  async (event) => {
    if (event?.action === 'execute') {
      const marker = await recoverStaleMarker(await getMarker(documentClient), documentClient);
      const claimed = await claimResetExecution(marker, event.executionToken, documentClient);
      if (!claimed) {
        return { ignored: true, status: marker?.status ?? null };
      }
      let connection;
      try {
        connection = await connectionFactory();
        const g = traversal().withRemote(connection);
        const result = await executeReset({
          g,
          actor: event.actor ?? marker.startedBy ?? 'platform',
          store,
          process,
          documentClient,
          ecrClient,
          controlClient,
          runtimeClient,
          lambdaClient,
          begin: false,
          executionToken: event.executionToken,
        });
        return { result };
      } catch (error) {
        await finishReset(
          'FAILED',
          {
            failedAt: new Date().toISOString(),
            failure: { message: error.message },
          },
          documentClient,
          { executionToken: event.executionToken },
        ).catch(() => undefined);
        throw error;
      } finally {
        await connection?.close().catch(() => undefined);
      }
    }

    const response = buildResponse(event);
    if (event.httpMethod === 'OPTIONS') return response(200, {});
    const denied = requirePlatformAdmin(event);
    if (denied) return response(denied.statusCode, { error: denied.error, code: denied.code });
    let connection;
    try {
      const marker = await recoverStaleMarker(await getMarker(documentClient), documentClient);
      if (event.httpMethod === 'GET') {
        connection = await connectionFactory();
        const g = traversal().withRemote(connection);
        return response(200, {
          confirmation: RESET_CONFIRMATION,
          marker,
          counts: await dryRun({ g, store, process, ecrClient }),
        });
      }
      if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
      const body = parseBody(event);
      if (body.confirmation !== RESET_CONFIRMATION) {
        return response(400, { error: `confirmation must equal ${RESET_CONFIRMATION}` });
      }
      const actor = actorFrom(event);
      const started = await beginReset(actor, documentClient);
      if (started.complete) {
        return response(200, { result: started.marker.result, marker: started.marker });
      }
      try {
        await lambdaClient.send(
          new InvokeCommand({
            FunctionName: globalThis.process.env.AWS_LAMBDA_FUNCTION_NAME,
            InvocationType: 'Event',
            Payload: Buffer.from(
              JSON.stringify({
                action: 'execute',
                actor,
                executionToken: started.marker.executionToken,
              }),
            ),
          }),
        );
      } catch (error) {
        await finishReset(
          'FAILED',
          {
            failedAt: new Date().toISOString(),
            failure: { message: `Unable to start reset: ${error.message}` },
          },
          documentClient,
          { executionToken: started.marker.executionToken },
        );
        throw error;
      }
      return response(202, { marker: started.marker });
    } catch (error) {
      console.error('Managed environment reset failed:', error);
      return response(error.statusCode ?? 500, {
        error: error.statusCode ? error.message : 'Managed environment reset failed',
      });
    } finally {
      await connection?.close().catch(() => undefined);
    }
  };

export const handler = createResetHandler();
