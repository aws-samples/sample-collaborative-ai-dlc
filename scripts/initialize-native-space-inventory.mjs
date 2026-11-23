// Run once after the transactional draft writer is serving all commands and
// old writer invocations have drained. Direct Terraform and release tooling
// have the same ordering requirement. Owner HTTP requests never run this scan.
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  GetAliasCommand,
  GetFunctionConfigurationCommand,
  LambdaClient,
} from '@aws-sdk/client-lambda';
import { nativeRuntimeBindingKey } from '../lambda/shared/native-runtime-binding.js';
import {
  nativeSpaceInventoryKey,
  nativeSpaceRetentionKey,
} from '../lambda/shared/native-space-inventory.js';

export async function initializeNativeSpaceInventory({
  ddb,
  tableName,
  pageSize = 100,
  confirmWriter,
}) {
  let cursor;
  let bindings = 0;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        ConsistentRead: true,
        Limit: pageSize,
        ExclusiveStartKey: cursor,
        FilterExpression: 'sk = :runtime',
        ExpressionAttributeValues: { ':runtime': 'RUNTIME' },
        ProjectionExpression: 'pk, sk, projectId, executionId',
      }),
    );
    if (!Array.isArray(page.Items)) throw new Error('Incomplete native binding inventory');
    const projects = new Set();
    for (const row of page.Items) {
      const key = nativeRuntimeBindingKey(row);
      if (row.pk !== key.pk || row.sk !== key.sk) throw new Error('Invalid native binding scope');
      projects.add(row.projectId);
    }
    for (const projectId of projects) {
      await ddb.send(
        new PutCommand({ TableName: tableName, Item: nativeSpaceRetentionKey(projectId) }),
      );
    }
    bindings += page.Items.length;
    if (
      page.LastEvaluatedKey &&
      (typeof page.LastEvaluatedKey.pk !== 'string' ||
        typeof page.LastEvaluatedKey.sk !== 'string' ||
        (cursor?.pk === page.LastEvaluatedKey.pk && cursor?.sk === page.LastEvaluatedKey.sk))
    ) {
      throw new Error('Invalid native inventory cursor');
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  await confirmWriter?.();
  await ddb.send(
    new PutCommand({ TableName: tableName, Item: { ...nativeSpaceInventoryKey, version: 1 } }),
  );
  return { bindings };
}

// The previous deployed command authority has a 90-second invocation limit.
// Its pre-transaction writes must finish before the first consistent scan.
// A weighted alias or a changed alias revision cannot certify this inventory.
export async function initializeDeployedNativeSpaceInventory({
  ddb,
  lambda,
  tableName,
  wait = delay,
}) {
  const FunctionName = `${tableName}-authority`;
  const readAlias = () => lambda.send(new GetAliasCommand({ FunctionName, Name: 'commands' }));
  const alias = await readAlias();
  if (
    !alias.RevisionId ||
    !/^[1-9]\d*$/.test(alias.FunctionVersion) ||
    Object.keys(alias.RoutingConfig?.AdditionalVersionWeights ?? {}).length
  ) {
    throw new Error('Native commands must serve one published writer');
  }
  const config = await lambda.send(
    new GetFunctionConfigurationCommand({ FunctionName, Qualifier: alias.FunctionVersion }),
  );
  const env = config.Environment?.Variables;
  if (env?.NATIVE_RUNTIME_BINDINGS_TABLE !== tableName || !env.YJS_DOCUMENTS_TABLE)
    throw new Error('Deploy the space-fenced native writer before initializing inventory');
  const confirmWriter = async () => {
    if ((await readAlias()).RevisionId !== alias.RevisionId)
      throw new Error('Native command writer changed during inventory initialization');
  };
  await wait(91_000);
  await confirmWriter();
  return initializeNativeSpaceInventory({ ddb, tableName, confirmWriter });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const tableName = process.argv[2];
  if (!tableName)
    throw new Error('Usage: initialize-native-space-inventory.mjs <native-bindings-table>');
  const client = new DynamoDBClient({});
  const lambda = new LambdaClient({});
  try {
    console.log(
      JSON.stringify(
        await initializeDeployedNativeSpaceInventory({
          ddb: DynamoDBDocumentClient.from(client),
          tableName,
          lambda,
        }),
      ),
    );
  } finally {
    client.destroy();
    lambda.destroy();
  }
}
