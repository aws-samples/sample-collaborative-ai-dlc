import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  SYSTEM_TOOL_TEMPLATE_REVISION,
  SYSTEM_TOOL_TEMPLATES,
  TOOL_VERSION_STATUSES,
  normalizeToolVersionDefinition,
} from './tool-catalog.js';
import { queryAll, scanAll } from './registry.js';

const toolPk = (toolId) => `TOOL#${toolId}`;
const toolKey = (toolId) => ({ pk: toolPk(toolId), sk: 'META' });
const toolVersionKey = (toolId, versionId) => ({
  pk: toolPk(toolId),
  sk: `VERSION#${versionId}`,
});
const toolVersionAliasKey = (toolId, version) => ({
  pk: toolPk(toolId),
  sk: `VERSION_NAME#${version}`,
});
const lookupKey = (kind, id) => ({ pk: `TOOL_${kind}#${id}`, sk: 'LOOKUP' });
const versionStatusIndex = (status, updatedAt, toolId, versionId) => ({
  GSI1PK: `TOOL_VERSION_STATUS#${status}`,
  GSI1SK: `${updatedAt}#${toolId}#${versionId}`,
});

const ALLOWED_TRANSITIONS = {
  DRAFT: new Set(['QUEUED', 'FAILED']),
  QUEUED: new Set(['BUILDING', 'FAILED']),
  BUILDING: new Set(['SCANNING', 'FAILED']),
  SCANNING: new Set(['SECURITY_REVIEW', 'READY', 'FAILED']),
  SECURITY_REVIEW: new Set(['READY', 'QUEUED', 'FAILED']),
  READY: new Set(['PUBLISHED', 'QUEUED', 'FAILED']),
  PUBLISHED: new Set(),
  FAILED: new Set(['QUEUED']),
};

const assertTransition = (from, to) => {
  if (!TOOL_VERSION_STATUSES.includes(from) || !TOOL_VERSION_STATUSES.includes(to)) {
    throw new Error(`Unknown tool version transition: ${from} -> ${to}`);
  }
  if (from === to) return;
  if (!ALLOWED_TRANSITIONS[from].has(to)) {
    throw Object.assign(new Error(`Invalid tool version transition: ${from} -> ${to}`), {
      statusCode: 409,
    });
  }
};

export const createToolStore = ({ ddb, tableName, clock, ids } = {}) => {
  if (!ddb) throw new Error('createToolStore requires a DynamoDB DocumentClient');
  const table = () => tableName ?? process.env.ENVIRONMENT_REGISTRY_TABLE;
  const now = () => (clock ? clock() : new Date().toISOString());
  const nextId = () => (ids ? ids() : randomUUID());

  const getTool = async (toolId) => {
    const { Item } = await ddb.send(
      new GetCommand({ TableName: table(), Key: toolKey(toolId), ConsistentRead: true }),
    );
    return Item ?? null;
  };

  const getVersion = async (toolId, versionId) => {
    const { Item } = await ddb.send(
      new GetCommand({
        TableName: table(),
        Key: toolVersionKey(toolId, versionId),
        ConsistentRead: true,
      }),
    );
    return Item ?? null;
  };

  const getVersionByName = async (toolId, version) => {
    const { Item: alias } = await ddb.send(
      new GetCommand({
        TableName: table(),
        Key: toolVersionAliasKey(toolId, version),
        ConsistentRead: true,
      }),
    );
    return alias?.versionId ? getVersion(toolId, alias.versionId) : null;
  };

  const listTools = async () =>
    queryAll(ddb, {
      TableName: table(),
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': 'TOOLS' },
      ScanIndexForward: true,
    });

  const listVersions = async (toolId, { publishedOnly = false } = {}) =>
    (
      await queryAll(ddb, {
        TableName: table(),
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :version)',
        ExpressionAttributeValues: { ':pk': toolPk(toolId), ':version': 'VERSION#' },
        ScanIndexForward: false,
      })
    )
      .filter((version) => version.type === 'ToolVersion')
      .filter((version) => !publishedOnly || version.status === 'PUBLISHED')
      .toSorted((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));

  const listAllVersions = async ({ publishedOnly = false } = {}) => {
    const items = await scanAll(ddb, {
      TableName: table(),
      FilterExpression: '#type = :type',
      ExpressionAttributeNames: { '#type': 'type' },
      ExpressionAttributeValues: { ':type': 'ToolVersion' },
    });
    return items.filter((version) => !publishedOnly || version.status === 'PUBLISHED');
  };

  const listVersionsByStatus = async (status) =>
    queryAll(ddb, {
      TableName: table(),
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `TOOL_VERSION_STATUS#${status}` },
    });

  const createTool = async ({
    toolId,
    name,
    description = '',
    category = 'cli',
    publisher = '',
    system = false,
    createdBy,
  }) => {
    const createdAt = now();
    const tool = {
      ...toolKey(toolId),
      GSI1PK: 'TOOLS',
      GSI1SK: `${system ? '0' : '1'}#${name.toLowerCase()}#${toolId}`,
      type: 'Tool',
      toolId,
      name,
      description,
      category,
      publisher,
      system,
      recommendedVersionId: null,
      createdAt,
      createdBy,
      updatedAt: createdAt,
    };
    await ddb.send(
      new PutCommand({
        TableName: table(),
        Item: tool,
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return tool;
  };

  const createVersion = async ({
    tool,
    definition,
    createdBy,
    system = false,
    autoBuild = false,
    systemTemplateRevision = null,
  }) => {
    const normalized = normalizeToolVersionDefinition(definition);
    const createdAt = now();
    const versionId = `tv-${nextId()}`;
    const version = {
      ...toolVersionKey(tool.toolId, versionId),
      ...versionStatusIndex('DRAFT', createdAt, tool.toolId, versionId),
      type: 'ToolVersion',
      toolId: tool.toolId,
      versionId,
      status: 'DRAFT',
      definition: normalized,
      system,
      autoBuild,
      systemTemplateRevision,
      buildAttempt: 0,
      contextPrefix: null,
      buildId: null,
      buildArn: null,
      buildLogUrl: null,
      imageTag: null,
      imageUri: null,
      imageDigest: null,
      imageSizeBytes: null,
      source: null,
      scanFindings: null,
      verification: null,
      failure: null,
      securityFindingsAcceptedAt: null,
      securityFindingsAcceptedBy: null,
      createdAt,
      createdBy,
      updatedAt: createdAt,
      publishedAt: null,
      publishedBy: null,
    };
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: table(),
              Item: version,
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Put: {
              TableName: table(),
              Item: {
                ...toolVersionAliasKey(tool.toolId, normalized.version),
                type: 'ToolVersionAlias',
                toolId: tool.toolId,
                versionId,
                version: normalized.version,
                createdAt,
              },
              ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
            },
          },
          {
            Update: {
              TableName: table(),
              Key: toolKey(tool.toolId),
              UpdateExpression: 'SET updatedAt = :updated',
              ExpressionAttributeValues: { ':updated': createdAt },
            },
          },
        ],
      }),
    );
    return version;
  };

  const updateTool = async (toolId, patch) => {
    const names = { '#updatedAt': 'updatedAt' };
    const values = { ':updated': now() };
    const sets = ['#updatedAt = :updated'];
    const allowed = new Set(['name', 'description', 'category', 'publisher']);
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.has(key)) continue;
      const target = `#${key}`;
      names[target] = key;
      sets.push(`${target} = :${key}`);
      values[`:${key}`] = value;
    }
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: table(),
        Key: toolKey(toolId),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return Attributes;
  };

  const updateVersion = async (toolId, versionId, patch, { fromStatus = null } = {}) => {
    const existing = await getVersion(toolId, versionId);
    if (!existing) throw Object.assign(new Error('Tool version not found'), { statusCode: 404 });
    if (patch.definition && !['DRAFT', 'FAILED'].includes(existing.status)) {
      throw Object.assign(new Error('Tool definitions are immutable after build starts'), {
        statusCode: 409,
      });
    }
    if (patch.definition) patch.definition = normalizeToolVersionDefinition(patch.definition);
    if (patch.status) assertTransition(existing.status, patch.status);
    const updatedAt = now();
    const status = patch.status ?? existing.status;
    const names = {
      '#updatedAt': 'updatedAt',
      '#gsiPk': 'GSI1PK',
      '#gsiSk': 'GSI1SK',
    };
    const values = {
      ':updated': updatedAt,
      ':gsiPk': `TOOL_VERSION_STATUS#${status}`,
      ':gsiSk': `${updatedAt}#${toolId}#${versionId}`,
    };
    const sets = ['#updatedAt = :updated', '#gsiPk = :gsiPk', '#gsiSk = :gsiSk'];
    const allowed = new Set([
      'status',
      'definition',
      'autoBuild',
      'systemTemplateRevision',
      'buildAttempt',
      'contextPrefix',
      'buildId',
      'buildArn',
      'buildLogUrl',
      'imageTag',
      'imageUri',
      'imageDigest',
      'imageSizeBytes',
      'source',
      'scanFindings',
      'verification',
      'failure',
      'securityFindingsAcceptedAt',
      'securityFindingsAcceptedBy',
      'publishedAt',
      'publishedBy',
    ]);
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.has(key)) continue;
      const target = `#${key}`;
      names[target] = key;
      sets.push(`${target} = :${key}`);
      values[`:${key}`] = value;
    }
    const input = {
      TableName: table(),
      Key: toolVersionKey(toolId, versionId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    };
    if (fromStatus) {
      names['#status'] = 'status';
      input.ConditionExpression = '#status = :fromStatus';
      values[':fromStatus'] = fromStatus;
    }
    const { Attributes } = await ddb.send(new UpdateCommand(input));
    if (patch.buildId) await putLookup('BUILD', patch.buildId, toolId, versionId);
    if (patch.buildArn) await putLookup('BUILD', patch.buildArn, toolId, versionId);
    if (patch.imageDigest) await putLookup('IMAGE', patch.imageDigest, toolId, versionId);
    return Attributes;
  };

  const publishVersion = async ({ tool, version, actor }) => {
    if (version.status !== 'READY') {
      throw Object.assign(new Error('Only READY tool versions can be published'), {
        statusCode: 409,
      });
    }
    const publishedAt = now();
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: table(),
              Key: toolVersionKey(tool.toolId, version.versionId),
              ConditionExpression: '#status = :ready',
              UpdateExpression:
                'SET #status = :published, GSI1PK = :gsiPk, GSI1SK = :gsiSk, publishedAt = :publishedAt, publishedBy = :actor, updatedAt = :publishedAt',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':ready': 'READY',
                ':published': 'PUBLISHED',
                ':gsiPk': 'TOOL_VERSION_STATUS#PUBLISHED',
                ':gsiSk': `${publishedAt}#${tool.toolId}#${version.versionId}`,
                ':publishedAt': publishedAt,
                ':actor': actor,
              },
            },
          },
          {
            Update: {
              TableName: table(),
              Key: toolKey(tool.toolId),
              UpdateExpression: 'SET updatedAt = :updated',
              ExpressionAttributeValues: { ':updated': publishedAt },
            },
          },
        ],
      }),
    );
    return getVersion(tool.toolId, version.versionId);
  };

  const setRecommendedVersion = async ({ toolId, versionId, actor }) => {
    const updatedAt = now();
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: table(),
              Key: toolVersionKey(toolId, versionId),
              ConditionExpression: '#status = :published',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':published': 'PUBLISHED' },
            },
          },
          {
            Update: {
              TableName: table(),
              Key: toolKey(toolId),
              UpdateExpression:
                'SET recommendedVersionId = :versionId, recommendedAt = :updated, recommendedBy = :actor, updatedAt = :updated',
              ExpressionAttributeValues: {
                ':versionId': versionId,
                ':updated': updatedAt,
                ':actor': actor,
              },
            },
          },
        ],
      }),
    );
    return getTool(toolId);
  };

  const putLookup = async (kind, id, toolId, versionId) => {
    if (!id) return;
    await ddb.send(
      new PutCommand({
        TableName: table(),
        Item: {
          ...lookupKey(kind, id),
          type: 'ToolLookup',
          toolId,
          versionId,
          createdAt: now(),
        },
      }),
    );
  };

  const getLookup = async (kind, id) => {
    const { Item } = await ddb.send(
      new GetCommand({ TableName: table(), Key: lookupKey(kind, id) }),
    );
    return Item ?? null;
  };

  const seedSystemTools = async ({ actor = 'platform' } = {}) => {
    const created = [];
    for (const template of SYSTEM_TOOL_TEMPLATES) {
      let tool = await getTool(template.toolId);
      if (!tool) {
        try {
          tool = await createTool({
            toolId: template.toolId,
            name: template.name,
            description: template.description,
            category: template.category,
            publisher: template.publisher,
            system: true,
            createdBy: actor,
          });
        } catch (error) {
          if (error?.name !== 'ConditionalCheckFailedException') throw error;
          tool = await getTool(template.toolId);
        }
      }
      const existing = await getVersionByName(template.toolId, template.version.version);
      if (existing) {
        if (
          existing.system &&
          ['DRAFT', 'FAILED'].includes(existing.status) &&
          Number(existing.systemTemplateRevision ?? 0) < SYSTEM_TOOL_TEMPLATE_REVISION
        ) {
          created.push(
            await updateVersion(template.toolId, existing.versionId, {
              definition: template.version,
              autoBuild: true,
              systemTemplateRevision: SYSTEM_TOOL_TEMPLATE_REVISION,
            }),
          );
        }
        continue;
      }
      try {
        created.push(
          await createVersion({
            tool,
            definition: template.version,
            createdBy: actor,
            system: true,
            autoBuild: true,
            systemTemplateRevision: SYSTEM_TOOL_TEMPLATE_REVISION,
          }),
        );
      } catch (error) {
        if (
          !['TransactionCanceledException', 'ConditionalCheckFailedException'].includes(error?.name)
        ) {
          throw error;
        }
      }
    }
    return created;
  };

  return {
    getTool,
    getVersion,
    getVersionByName,
    listTools,
    listVersions,
    listAllVersions,
    listVersionsByStatus,
    createTool,
    createVersion,
    updateTool,
    updateVersion,
    publishVersion,
    setRecommendedVersion,
    putLookup,
    getLookup,
    seedSystemTools,
  };
};
