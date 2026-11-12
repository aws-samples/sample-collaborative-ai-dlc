import { createHash } from 'node:crypto';
import gremlin from 'gremlin';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const __ = gremlin.process.statics;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const DEFAULT_BASELINE_TIME = '1970-01-01T00:00:00.000Z';

const graphValue = (row, key) => {
  const value = row instanceof Map ? row.get(key) : row?.[key];
  return Array.isArray(value) ? value[0] : value;
};

const normalizedRole = (role) => (role === 'owner' || role === 'admin' ? 'owner' : 'member');
const baselineId = (spaceId, userId) =>
  createHash('sha256').update(`${spaceId}\0${userId}`).digest('hex').slice(0, 32);

const migrationItems = ({ spaceId, userId, role, now }) => {
  const membershipRole = normalizedRole(role);
  const id = baselineId(spaceId, userId);
  const membership = {
    pk: `SPACE#${spaceId}`,
    sk: `MEMBER#${userId}`,
    spaceId,
    userId,
    membershipRole,
    createdAt: now,
    updatedAt: now,
  };
  return {
    membership,
    audit: {
      pk: `SPACE#${spaceId}`,
      sk: `AUDIT#${now}#${id}`,
      spaceId,
      actorId: 'membership-migration',
      action: 'migration_baseline',
      targetUserId: userId,
      before: { membershipRole: role || 'member', source: 'neptune' },
      after: membership,
      changedAt: now,
      changeId: id,
    },
  };
};

const copyMembership = async (client, source, now) => {
  const { membership, audit } = migrationItems({ ...source, now });
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: process.env.ACCESS_TABLE,
              Item: membership,
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Put: {
              TableName: process.env.AUDIT_TABLE,
              Item: audit,
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
        ],
      }),
    );
    return 'copied';
  } catch (error) {
    if (error?.name !== 'TransactionCanceledException') throw error;
    const existing = await client.send(
      new GetCommand({
        TableName: process.env.ACCESS_TABLE,
        Key: { pk: membership.pk, sk: membership.sk },
        ConsistentRead: true,
      }),
    );
    if (!existing.Item) throw error;
    return 'preserved';
  }
};

const migrateMemberships = async ({
  client,
  sources,
  now = process.env.MEMBERSHIP_MIGRATION_BASELINE_TIME || DEFAULT_BASELINE_TIME,
}) => {
  let copied = 0;
  let preserved = 0;
  for (const source of sources) {
    const result = await copyMembership(client, source, now);
    if (result === 'copied') copied += 1;
    else preserved += 1;
  }
  for (const source of sources) {
    const result = await client.send(
      new GetCommand({
        TableName: process.env.ACCESS_TABLE,
        Key: { pk: `SPACE#${source.spaceId}`, sk: `MEMBER#${source.userId}` },
        ConsistentRead: true,
      }),
    );
    if (!result.Item) throw new Error(`Membership verification failed for ${source.spaceId}`);
  }
  return { sourceCount: sources.length, copied, preserved };
};

const getConnection = async () => {
  const credentials = await fromNodeProviderChain()();
  credentials.region = process.env.AWS_REGION ?? 'us-east-1';
  const { url, headers } = getUrlAndHeaders(
    process.env.NEPTUNE_ENDPOINT,
    '8182',
    credentials,
    '/gremlin',
    'wss',
  );
  return new gremlin.driver.DriverRemoteConnection(url, { headers });
};

const readSources = async (g) => {
  const rows = await g
    .V()
    .hasLabel('Project')
    .as('space')
    .outE('HAS_MEMBER')
    .as('membership')
    .inV()
    .hasLabel('User')
    .as('user')
    .select('space', 'membership', 'user')
    .by(__.valueMap())
    .toList();
  return rows.map((row) => {
    const space = row instanceof Map ? row.get('space') : row.space;
    const membership = row instanceof Map ? row.get('membership') : row.membership;
    const user = row instanceof Map ? row.get('user') : row.user;
    return {
      spaceId: graphValue(space, 'id'),
      userId: graphValue(user, 'id'),
      role: graphValue(membership, 'role') || 'member',
    };
  });
};

export const handler = async (event = {}) => {
  const conn = await getConnection();
  try {
    const g = traversal().withRemote(conn);
    if (event.action === 'cleanup') {
      const count = await g.E().hasLabel('HAS_MEMBER').count().next();
      await g.E().hasLabel('HAS_MEMBER').drop().next();
      return { cleaned: Number(count.value) };
    }
    const sources = await readSources(g);
    if (sources.length === 0) return { sourceCount: 0, copied: 0, preserved: 0 };
    return migrateMemberships({ client: ddb, sources });
  } finally {
    await conn.close();
  }
};

export { baselineId, migrateMemberships, migrationItems, normalizedRole };
