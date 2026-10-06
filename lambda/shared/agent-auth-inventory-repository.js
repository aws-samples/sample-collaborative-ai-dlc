import { PutCommand, QueryCommand, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { authError } from './agent-auth-protocol.js';
import {
  AUTH_INVENTORY_KEY,
  authenticationScope,
  authScopeKey,
  inventoryReferenceWrites,
  scopeContainsRow,
  isMaterialAuthInventoryRow,
} from './agent-auth-inventory.js';

// Scope discovery and backfill share the connection repository's consistent reader.
export const createAgentAuthInventoryRepository = ({ ddb, tableName, get, requireTable }) => {
  const repository = {
    async loadInventory(candidate = {}) {
      const scope = authenticationScope(candidate);
      if (scope.source === 'platform') return repository.scanInventory();
      requireTable();
      const readiness = await get(AUTH_INVENTORY_KEY);
      if (readiness?.version !== 1)
        throw authError(
          'AGENT_AUTH_INVENTORY_NOT_READY',
          'The scoped authentication inventory must be initialized before reviewing credentials',
        );
      const rows = [];
      const now = Date.now();
      const keep = (row) => {
        if (!row || !isMaterialAuthInventoryRow(row, now)) return;
        rows.push(row);
        if (rows.length > 5000)
          throw authError(
            'AGENT_AUTH_INVENTORY_TOO_LARGE',
            'This scope requires an administrator inventory review',
          );
      };
      let ExclusiveStartKey;
      do {
        const page = await ddb.send(
          new QueryCommand({
            TableName: tableName,
            ConsistentRead: true,
            ExclusiveStartKey,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: { ':pk': authScopeKey(scope).pk, ':prefix': 'REF#' },
            Limit: 100,
          }),
        );
        const targets = await Promise.all(
          (page.Items ?? []).map((reference) => get(reference.target)),
        );
        for (const row of targets) {
          if (row && scopeContainsRow(scope, row)) keep(row);
        }
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      // Auxiliary records inherit their execution binding. Query only their key
      // prefixes, never the execution's potentially large output/event partition.
      for (const execution of rows.filter((row) => row.type === 'Execution')) {
        for (const prefix of ['COMPOSE#', 'QEDIT#']) {
          let cursor;
          do {
            const page = await ddb.send(
              new QueryCommand({
                TableName: tableName,
                ConsistentRead: true,
                ExclusiveStartKey: cursor,
                KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
                ExpressionAttributeValues: { ':pk': execution.pk, ':prefix': prefix },
                Limit: 100,
              }),
            );
            for (const row of page.Items ?? []) keep(row);
            cursor = page.LastEvaluatedKey;
          } while (cursor);
        }
      }
      return rows;
    },
    async initializeInventory() {
      // Deployment backfill. Never called from personal/space HTTP paths.
      requireTable();
      if ((await get(AUTH_INVENTORY_KEY))?.version === 1) return { initialized: false, records: 0 };
      const rows = await repository.scanInventory();
      for (let row of rows) {
        while (row) {
          const writes = inventoryReferenceWrites(tableName, row);
          if (!writes.length) break;
          const Key = { pk: row.pk, sk: row.sk };
          try {
            await ddb.send(
              new TransactWriteCommand({
                TransactItems: [
                  {
                    ConditionCheck: {
                      TableName: tableName,
                      Key,
                      // Completion and deletion can race the deployment scan.
                      // Never restore a deleted reference or erase a newer TTL.
                      ConditionExpression:
                        'attribute_exists(pk) AND ' +
                        (row.agentAuthTtl
                          ? 'agentAuthTtl = :ttl'
                          : 'attribute_not_exists(agentAuthTtl)'),
                      ...(row.agentAuthTtl
                        ? { ExpressionAttributeValues: { ':ttl': row.agentAuthTtl } }
                        : {}),
                    },
                  },
                  ...writes,
                ],
              }),
            );
            break;
          } catch (error) {
            if (
              error?.name !== 'TransactionCanceledException' ||
              error.CancellationReasons?.[0]?.Code !== 'ConditionalCheckFailed'
            )
              throw error;
            row = await get(Key);
          }
        }
      }
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: { ...AUTH_INVENTORY_KEY, version: 1, initializedAt: new Date().toISOString() },
        }),
      );
      return { initialized: true, records: rows.length };
    },
    async scanInventory() {
      requireTable();
      const items = [];
      let ExclusiveStartKey;
      do {
        const page = await ddb.send(
          new ScanCommand({
            TableName: tableName,
            ConsistentRead: true,
            ExclusiveStartKey,
            FilterExpression:
              'begins_with(pk, :auth) OR begins_with(pk, :execution) OR begins_with(pk, :environment)',
            ExpressionAttributeValues: {
              ':auth': 'AGENTAUTH#',
              ':execution': 'EXEC#',
              ':environment': 'ENV#',
            },
          }),
        );
        const relevant = (page.Items ?? []).filter((row) =>
          [
            'Execution',
            'AgentConnectionHead',
            'AgentInvocation',
            'AgentSelection',
            'EnvironmentRevision',
            'Compose',
            'QuorumEdit',
          ].includes(row.type),
        );
        const currentRows = await Promise.all(
          relevant.map((row) => get({ pk: row.pk, sk: row.sk })),
        );
        items.push(...currentRows.filter(Boolean));
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return items;
    },
  };
  return repository;
};
