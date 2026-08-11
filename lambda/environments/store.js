import { randomUUID } from 'node:crypto';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  CURRENT_RUNTIME_COMPATIBILITY_VERSION,
  SYSTEM_ENVIRONMENT_TEMPLATES,
  assertRevisionTransition,
  flattenRecipe,
  generateDockerfile,
} from './recipe.js';

const environmentPk = (environmentId) => `ENV#${environmentId}`;
const environmentKey = (environmentId) => ({ pk: environmentPk(environmentId), sk: 'META' });
const revisionKey = (environmentId, revisionId) => ({
  pk: environmentPk(environmentId),
  sk: `REV#${revisionId}`,
});
const lookupKey = (kind, id) => ({ pk: `${kind}#${id}`, sk: 'LOOKUP' });
const revisionStatusIndex = (status, updatedAt, environmentId, revisionId) => ({
  GSI1PK: `REVISION_STATUS#${status}`,
  GSI1SK: `${updatedAt}#${environmentId}#${revisionId}`,
});

const queryAll = async (ddb, input) => {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
};

export const createEnvironmentStore = ({ ddb, tableName, clock, ids } = {}) => {
  if (!ddb) throw new Error('createEnvironmentStore requires a DynamoDB DocumentClient');
  const table = () => tableName ?? process.env.ENVIRONMENT_REGISTRY_TABLE;
  const now = () => (clock ? clock() : new Date().toISOString());
  const nextId = () => (ids ? ids() : randomUUID());
  const compatibilityVersion = () =>
    process.env.RUNTIME_COMPATIBILITY_VERSION || CURRENT_RUNTIME_COMPATIBILITY_VERSION;

  const getEnvironment = async (environmentId) => {
    const { Item } = await ddb.send(
      new GetCommand({ TableName: table(), Key: environmentKey(environmentId) }),
    );
    return Item ?? null;
  };

  const getRevision = async (environmentId, revisionId) => {
    const { Item } = await ddb.send(
      new GetCommand({ TableName: table(), Key: revisionKey(environmentId, revisionId) }),
    );
    return Item ?? null;
  };

  const listEnvironments = async ({ publishedOnly = false } = {}) => {
    const items = await queryAll(ddb, {
      TableName: table(),
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': 'ENVIRONMENTS' },
      ScanIndexForward: true,
    });
    return items.filter(
      (item) => !publishedOnly || (item.publishedRevisionId && item.status !== 'RETIRED'),
    );
  };

  const listRevisions = async (environmentId) =>
    (
      await queryAll(ddb, {
        TableName: table(),
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :revision)',
        ExpressionAttributeValues: { ':pk': environmentPk(environmentId), ':revision': 'REV#' },
        ScanIndexForward: false,
      })
    ).toSorted((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const putLookup = async (kind, id, environmentId, revisionId) => {
    if (!id) return;
    await ddb.send(
      new PutCommand({
        TableName: table(),
        Item: {
          ...lookupKey(kind, id),
          environmentId,
          revisionId,
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

  const createEnvironment = async ({
    environmentId,
    name,
    description = '',
    baseEnvironmentId = 'standard',
    recipe,
    flattenedRecipe = recipe,
    createdBy,
    system = false,
  }) => {
    const createdAt = now();
    const revisionId = `r-${nextId()}`;
    const environment = {
      ...environmentKey(environmentId),
      GSI1PK: 'ENVIRONMENTS',
      GSI1SK: `${system ? '0' : '1'}#${name.toLowerCase()}#${environmentId}`,
      type: 'Environment',
      environmentId,
      name,
      description,
      system,
      status: 'DRAFT',
      baseEnvironmentId,
      currentRevisionId: revisionId,
      publishedRevisionId: null,
      updateAvailable: false,
      createdAt,
      createdBy,
      updatedAt: createdAt,
    };
    const revision = {
      ...revisionKey(environmentId, revisionId),
      ...revisionStatusIndex('DRAFT', createdAt, environmentId, revisionId),
      type: 'EnvironmentRevision',
      environmentId,
      revisionId,
      status: 'DRAFT',
      recipe,
      flattenedRecipe,
      runtimeCompatibilityVersion: compatibilityVersion(),
      createdAt,
      createdBy,
      updatedAt: createdAt,
      imageUri: null,
      imageDigest: null,
      runtimeArn: null,
      runtimeEndpoint: null,
      generatedDockerfile: generateDockerfile(flattenedRecipe),
      verification: null,
      scanFindings: null,
    };
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: table(),
              Item: environment,
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Put: {
              TableName: table(),
              Item: revision,
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
        ],
      }),
    );
    return { environment, revision };
  };

  const createRevision = async ({
    environment,
    recipe,
    flattenedRecipe = recipe,
    createdBy,
    reason = 'edited',
  }) => {
    const createdAt = now();
    const revisionId = `r-${nextId()}`;
    const revision = {
      ...revisionKey(environment.environmentId, revisionId),
      ...revisionStatusIndex('DRAFT', createdAt, environment.environmentId, revisionId),
      type: 'EnvironmentRevision',
      environmentId: environment.environmentId,
      revisionId,
      status: 'DRAFT',
      recipe,
      flattenedRecipe,
      reason,
      runtimeCompatibilityVersion: compatibilityVersion(),
      createdAt,
      createdBy,
      updatedAt: createdAt,
      imageUri: null,
      imageDigest: null,
      runtimeArn: null,
      runtimeEndpoint: null,
      generatedDockerfile: generateDockerfile(flattenedRecipe),
      verification: null,
      scanFindings: null,
    };
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: table(),
              Item: revision,
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Update: {
              TableName: table(),
              Key: environmentKey(environment.environmentId),
              UpdateExpression:
                'SET currentRevisionId = :revision, #status = :status, updatedAt = :updated',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':revision': revisionId,
                ':status': 'DRAFT',
                ':updated': createdAt,
              },
            },
          },
        ],
      }),
    );
    return revision;
  };

  const updateEnvironment = async (
    environmentId,
    patch,
    { ifCurrentRevisionId = null, unlessRetired = false } = {},
  ) => {
    const names = {};
    const values = { ':updated': now() };
    const sets = ['updatedAt = :updated'];
    const conditions = [];
    const allowed = {
      name: '#name',
      description: 'description',
      status: '#status',
      baseEnvironmentId: 'baseEnvironmentId',
      currentRevisionId: 'currentRevisionId',
      publishedRevisionId: 'publishedRevisionId',
      updateAvailable: 'updateAvailable',
      retiredAt: 'retiredAt',
      retiredBy: 'retiredBy',
    };
    for (const [key, value] of Object.entries(patch)) {
      const target = allowed[key];
      if (!target) continue;
      if (target === '#name') names['#name'] = 'name';
      if (target === '#status') names['#status'] = 'status';
      const token = `:${key}`;
      sets.push(`${target} = ${token}`);
      values[token] = value;
    }
    if (ifCurrentRevisionId) {
      conditions.push('currentRevisionId = :expectedCurrentRevision');
      values[':expectedCurrentRevision'] = ifCurrentRevisionId;
    }
    if (unlessRetired) {
      names['#status'] = 'status';
      conditions.push('#status <> :retired');
      values[':retired'] = 'RETIRED';
    }
    const input = {
      TableName: table(),
      Key: environmentKey(environmentId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    };
    if (Object.keys(names).length) input.ExpressionAttributeNames = names;
    if (conditions.length) input.ConditionExpression = conditions.join(' AND ');
    const { Attributes } = await ddb.send(new UpdateCommand(input));
    return Attributes;
  };

  const updateRevision = async (environmentId, revisionId, patch, { fromStatus = null } = {}) => {
    const existing = await getRevision(environmentId, revisionId);
    if (!existing) throw new Error('Environment revision not found');
    if (patch.status) assertRevisionTransition(existing.status, patch.status);
    const updatedAt = now();
    const nextStatus = patch.status ?? existing.status;
    const names = {};
    const values = {
      ':updated': updatedAt,
      ':g1pk': `REVISION_STATUS#${nextStatus}`,
      ':g1sk': `${updatedAt}#${environmentId}#${revisionId}`,
    };
    const sets = ['updatedAt = :updated', 'GSI1PK = :g1pk', 'GSI1SK = :g1sk'];
    const allowed = new Set([
      'status',
      'buildId',
      'buildArn',
      'buildLogUrl',
      'contextPrefix',
      'generatedDockerfile',
      'imageUri',
      'imageDigest',
      'scanFindings',
      'highFindingsAcknowledgedAt',
      'highFindingsAcknowledgedBy',
      'runtimeArn',
      'runtimeId',
      'runtimeVersion',
      'runtimeEndpoint',
      'runtimeEndpointArn',
      'verification',
      'failure',
      'publishedAt',
      'publishedBy',
      'retiredAt',
      'retiredBy',
    ]);
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.has(key)) continue;
      const name = key === 'status' ? '#status' : key;
      if (key === 'status') names['#status'] = 'status';
      const token = `:${key}`;
      sets.push(`${name} = ${token}`);
      values[token] = value;
    }
    const input = {
      TableName: table(),
      Key: revisionKey(environmentId, revisionId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    };
    if (fromStatus) {
      names['#status'] = 'status';
      input.ConditionExpression = '#status = :fromStatus';
      input.ExpressionAttributeValues[':fromStatus'] = fromStatus;
    }
    if (Object.keys(names).length) input.ExpressionAttributeNames = names;
    else delete input.ExpressionAttributeNames;
    const { Attributes } = await ddb.send(new UpdateCommand(input));
    if (patch.buildId) await putLookup('BUILD', patch.buildId, environmentId, revisionId);
    if (patch.buildArn) await putLookup('BUILD', patch.buildArn, environmentId, revisionId);
    if (patch.imageDigest) {
      await putLookup('IMAGE', patch.imageDigest, environmentId, revisionId);
    }
    return Attributes;
  };

  const publishRevision = async ({ environment, revision, actor }) => {
    if (revision.status !== 'READY') throw new Error('Only READY revisions can be published');
    const publishedAt = now();
    const baseEnvironmentId =
      environment.environmentId === 'standard'
        ? null
        : (revision.recipe?.base?.environmentId ?? environment.baseEnvironmentId);
    const environmentCondition = environment.publishedRevisionId
      ? {
          expression: 'publishedRevisionId = :previousPublished AND #status <> :retired',
          values: { ':previousPublished': environment.publishedRevisionId },
        }
      : {
          expression:
            '(attribute_not_exists(publishedRevisionId) OR attribute_type(publishedRevisionId, :nullType)) AND #status <> :retired',
          values: { ':nullType': 'NULL' },
        };
    const transactions = [
      {
        Update: {
          TableName: table(),
          Key: revisionKey(environment.environmentId, revision.revisionId),
          ConditionExpression: '#status = :ready',
          UpdateExpression:
            'SET #status = :published, GSI1PK = :g1pk, GSI1SK = :g1sk, publishedAt = :at, publishedBy = :actor, updatedAt = :at',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':ready': 'READY',
            ':published': 'PUBLISHED',
            ':g1pk': 'REVISION_STATUS#PUBLISHED',
            ':g1sk': `${publishedAt}#${environment.environmentId}#${revision.revisionId}`,
            ':at': publishedAt,
            ':actor': actor,
          },
        },
      },
      {
        Update: {
          TableName: table(),
          Key: environmentKey(environment.environmentId),
          ConditionExpression: environmentCondition.expression,
          UpdateExpression:
            'SET publishedRevisionId = :revision, currentRevisionId = :revision, baseEnvironmentId = :base, #status = :published, updateAvailable = :no, updatedAt = :at',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':revision': revision.revisionId,
            ':base': baseEnvironmentId,
            ':published': 'PUBLISHED',
            ':no': false,
            ':at': publishedAt,
            ':retired': 'RETIRED',
            ...environmentCondition.values,
          },
        },
      },
    ];
    if (
      environment.publishedRevisionId &&
      environment.publishedRevisionId !== revision.revisionId
    ) {
      transactions.push({
        Update: {
          TableName: table(),
          Key: revisionKey(environment.environmentId, environment.publishedRevisionId),
          UpdateExpression:
            'SET #status = :superseded, GSI1PK = :g1pk, GSI1SK = :g1sk, updatedAt = :at',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':superseded': 'SUPERSEDED',
            ':g1pk': 'REVISION_STATUS#SUPERSEDED',
            ':g1sk': `${publishedAt}#${environment.environmentId}#${environment.publishedRevisionId}`,
            ':at': publishedAt,
          },
        },
      });
    }
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: transactions }));
    } catch (error) {
      if (error?.name === 'TransactionCanceledException') {
        throw Object.assign(new Error('Environment changed before publication; reload and retry'), {
          statusCode: 409,
          code: 'PUBLISH_CONFLICT',
        });
      }
      throw error;
    }
    return {
      ...(await getEnvironment(environment.environmentId)),
      revision: await getRevision(environment.environmentId, revision.revisionId),
    };
  };

  const listRevisionsByStatus = async (status) =>
    queryAll(ddb, {
      TableName: table(),
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `REVISION_STATUS#${status}` },
    });

  const markDependentsUpdateAvailable = async (baseEnvironmentId, baseRevisionId) => {
    const environments = await listEnvironments();
    const changed = [];
    for (const environment of environments) {
      if (
        environment.baseEnvironmentId !== baseEnvironmentId ||
        !environment.publishedRevisionId ||
        environment.status === 'RETIRED'
      ) {
        continue;
      }
      const published = await getRevision(
        environment.environmentId,
        environment.publishedRevisionId,
      );
      if (published?.recipe?.base?.revisionId === baseRevisionId) continue;
      changed.push(
        await updateEnvironment(environment.environmentId, {
          updateAvailable: true,
          ...(environment.status === 'PUBLISHED' ? { status: 'UPDATE_AVAILABLE' } : {}),
        }),
      );
    }
    return changed;
  };

  const removeLookup = async (kind, id) => {
    if (!id) return;
    await ddb.send(new DeleteCommand({ TableName: table(), Key: lookupKey(kind, id) }));
  };

  const scanRegistry = async () => {
    const items = [];
    let ExclusiveStartKey;
    do {
      const result = await ddb.send(
        new ScanCommand({ TableName: table(), ExclusiveStartKey, ConsistentRead: true }),
      );
      items.push(...(result.Items ?? []));
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  };

  const seedSystemEnvironments = async ({
    coreImageUri,
    coreImageDigest,
    coreRuntimeArn,
    coreRuntimeVersion = '1',
    actor = 'platform',
  }) => {
    const createdAt = now();
    const standardRevisionId = `core-${coreRuntimeVersion}`;
    const flattenedById = new Map();
    for (const template of SYSTEM_ENVIRONMENT_TEMPLATES) {
      const existing = await getEnvironment(template.id);
      if (existing) {
        const existingRevision = existing.currentRevisionId
          ? await getRevision(template.id, existing.currentRevisionId)
          : null;
        if (existingRevision?.flattenedRecipe) {
          flattenedById.set(template.id, existingRevision.flattenedRecipe);
        }
        continue;
      }
      const revisionId = template.id === 'standard' ? standardRevisionId : `seed-${template.id}-1`;
      const base =
        template.id === 'standard'
          ? {
              environmentId: 'core',
              revisionId: standardRevisionId,
              imageUri: coreImageUri,
              imageDigest: coreImageDigest,
            }
          : {
              environmentId: 'standard',
              revisionId: standardRevisionId,
              imageUri: coreImageUri,
              imageDigest: coreImageDigest,
            };
      const recipe = { ...template.recipe, base };
      const parentRecipe = template.baseEnvironmentId
        ? flattenedById.get(template.baseEnvironmentId)
        : null;
      const flattenedRecipe = flattenRecipe(recipe, parentRecipe);
      flattenedById.set(template.id, flattenedRecipe);
      const environmentStatus = template.id === 'standard' ? 'PUBLISHED' : 'DRAFT';
      const revisionStatus = template.id === 'standard' ? 'PUBLISHED' : 'DRAFT';
      const environment = {
        ...environmentKey(template.id),
        GSI1PK: 'ENVIRONMENTS',
        GSI1SK: `0#${template.name.toLowerCase()}#${template.id}`,
        type: 'Environment',
        environmentId: template.id,
        name: template.name,
        description: template.description,
        system: true,
        status: environmentStatus,
        baseEnvironmentId: template.baseEnvironmentId,
        currentRevisionId: revisionId,
        publishedRevisionId: template.id === 'standard' ? revisionId : null,
        updateAvailable: false,
        createdAt,
        createdBy: actor,
        updatedAt: createdAt,
      };
      const revision = {
        ...revisionKey(template.id, revisionId),
        ...revisionStatusIndex(revisionStatus, createdAt, template.id, revisionId),
        type: 'EnvironmentRevision',
        environmentId: template.id,
        revisionId,
        status: revisionStatus,
        recipe,
        flattenedRecipe,
        runtimeCompatibilityVersion: compatibilityVersion(),
        createdAt,
        createdBy: actor,
        updatedAt: createdAt,
        imageUri: template.id === 'standard' ? coreImageUri : null,
        imageDigest: template.id === 'standard' ? coreImageDigest : null,
        runtimeArn: template.id === 'standard' ? coreRuntimeArn : null,
        runtimeVersion: template.id === 'standard' ? coreRuntimeVersion : null,
        runtimeEndpoint: null,
        generatedDockerfile: generateDockerfile(flattenedRecipe),
        verification:
          template.id === 'standard'
            ? {
                status: 'PASSED',
                source: 'core-runtime',
                completedAt: createdAt,
              }
            : null,
        scanFindings: null,
        publishedAt: template.id === 'standard' ? createdAt : null,
        publishedBy: template.id === 'standard' ? actor : null,
      };
      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: table(),
                  Item: environment,
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
              {
                Put: {
                  TableName: table(),
                  Item: revision,
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
            ],
          }),
        );
      } catch (error) {
        if (error?.name !== 'TransactionCanceledException') throw error;
      }
    }
    return listEnvironments();
  };

  const stageCoreRevision = async ({
    coreImageUri,
    coreImageDigest,
    coreRuntimeArn,
    coreRuntimeVersion = '1',
    actor = 'platform',
  }) => {
    const environment = await getEnvironment('standard');
    if (!environment?.publishedRevisionId) return null;
    const published = await getRevision('standard', environment.publishedRevisionId);
    if (published?.imageDigest === coreImageDigest) return null;

    const revisionId = `core-${coreRuntimeVersion}-${String(coreImageDigest)
      .replace(/^sha256:/, '')
      .slice(0, 12)}`;
    const existing = await getRevision('standard', revisionId);
    if (existing) return existing;

    const createdAt = now();
    const recipe = {
      ...published.recipe,
      base: {
        environmentId: 'core',
        revisionId,
        imageUri: coreImageUri,
        imageDigest: coreImageDigest,
      },
    };
    const flattenedRecipe = flattenRecipe(recipe);
    const revision = {
      ...revisionKey('standard', revisionId),
      ...revisionStatusIndex('READY', createdAt, 'standard', revisionId),
      type: 'EnvironmentRevision',
      environmentId: 'standard',
      revisionId,
      status: 'READY',
      recipe,
      flattenedRecipe,
      reason: 'core-update',
      runtimeCompatibilityVersion: compatibilityVersion(),
      createdAt,
      createdBy: actor,
      updatedAt: createdAt,
      imageUri: coreImageUri,
      imageDigest: coreImageDigest,
      runtimeArn: coreRuntimeArn,
      runtimeVersion: coreRuntimeVersion,
      runtimeEndpoint: null,
      generatedDockerfile: generateDockerfile(flattenedRecipe),
      verification: {
        status: 'PASSED',
        source: 'core-runtime',
        completedAt: createdAt,
      },
      scanFindings: null,
    };
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: table(),
                Item: revision,
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Update: {
                TableName: table(),
                Key: environmentKey('standard'),
                UpdateExpression:
                  'SET currentRevisionId = :revision, #status = :status, updateAvailable = :yes, updatedAt = :updated',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':revision': revisionId,
                  ':status': 'UPDATE_AVAILABLE',
                  ':yes': true,
                  ':updated': createdAt,
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (error?.name !== 'TransactionCanceledException') throw error;
    }
    return getRevision('standard', revisionId);
  };

  return {
    getEnvironment,
    getRevision,
    listEnvironments,
    listRevisions,
    createEnvironment,
    createRevision,
    updateEnvironment,
    updateRevision,
    publishRevision,
    listRevisionsByStatus,
    markDependentsUpdateAvailable,
    putLookup,
    getLookup,
    removeLookup,
    scanRegistry,
    seedSystemEnvironments,
    stageCoreRevision,
  };
};

export default { createEnvironmentStore };
