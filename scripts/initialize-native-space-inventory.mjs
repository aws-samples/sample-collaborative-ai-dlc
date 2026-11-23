import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
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
import { isReadySpaceInventoryReceipt } from './lib/native-dependencies.mjs';

// Compare the exact generation read before bootstrap. A concurrent publication
// or invalidation requires a fresh read on retry.
function receiptCondition(previous) {
  if (!previous) return { ConditionExpression: 'attribute_not_exists(pk)' };
  const hasCoverage = previous.coverage !== undefined;
  return {
    ConditionExpression:
      '#version = :previous AND ' +
      (hasCoverage ? '#coverage = :coverage' : 'attribute_not_exists(#coverage)'),
    ExpressionAttributeNames: { '#version': 'version', '#coverage': 'coverage' },
    ExpressionAttributeValues: {
      ':previous': previous.version,
      ...(hasCoverage && { ':coverage': previous.coverage }),
    },
  };
}

function publishReady(ddb, tableName, coverage, previous) {
  return ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: { ...nativeSpaceInventoryKey, version: 1, ...(coverage && { coverage }) },
      ...(coverage && receiptCondition(previous)),
    }),
  );
}

export async function initializeNativeSpaceInventory({
  ddb,
  tableName,
  pageSize = 100,
  confirmWriter,
  coverage,
  previous,
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
  await publishReady(ddb, tableName, coverage, previous);
  return { bindings };
}

// The Projects handler serves $LATEST; draft admission serves the commands alias.
// A rollback and re-promotion changes the alias revision even if the version is reused.
// A restored/recreated table with the same name has a different TableId.
async function deployment({ ddb, lambda, tableName, environment }) {
  const suffix = `-native-runs-${environment}`;
  if (!environment || !tableName.endsWith(suffix) || tableName === suffix)
    throw new Error('Native table does not belong to the applied environment');
  const authority = `${tableName}-authority`;
  const projects = `${tableName.slice(0, -suffix.length)}-projects-${environment}`;
  const [{ Table }, alias, owner] = await Promise.all([
    ddb.send(new DescribeTableCommand({ TableName: tableName })),
    lambda.send(new GetAliasCommand({ FunctionName: authority, Name: 'commands' })),
    lambda.send(new GetFunctionConfigurationCommand({ FunctionName: projects })),
  ]);
  if (Table?.TableStatus !== 'ACTIVE' || !Table.TableId || !alias.RevisionId || !owner.RevisionId)
    throw new Error('Cannot identify the deployed native space inventory');
  const coverage = {
    tableId: Table.TableId,
    commandsRevision: alias.RevisionId,
    projectsRevision: owner.RevisionId,
  };
  return { coverage, authority, owner, alias };
}

const readReceipt = async ({ ddb, tableName }) =>
  (
    await ddb.send(
      new GetCommand({ TableName: tableName, Key: nativeSpaceInventoryKey, ConsistentRead: true }),
    )
  ).Item;

// Withdraw only the readiness flag. Keep every retention marker and binding.
// In particular a failed scan or lost acknowledgement can be retried from page one.
async function markPending({ ddb, tableName }, receipt) {
  if (!receipt) return;
  if (receipt.version === 1) {
    const condition = receiptCondition(receipt);
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: nativeSpaceInventoryKey,
        UpdateExpression: 'SET #version = :pending',
        ...condition,
        ExpressionAttributeValues: { ...condition.ExpressionAttributeValues, ':pending': 0 },
      }),
    );
  }
  if (
    ![0, 1].includes(receipt.version) ||
    !isReadySpaceInventoryReceipt({ ...receipt, version: 1 })
  )
    throw new Error('Unrecognized native space inventory receipt');
  return { ...receipt, version: 0 };
}

const sameWriter = (previous, current) =>
  previous?.tableId === current.tableId && previous.commandsRevision === current.commandsRevision;

const writerCovered = (receipt, coverage) =>
  isReadySpaceInventoryReceipt(receipt) && sameWriter(receipt.coverage, coverage);

// An older pinned release can serve an unfenced writer with the v1 row still
// present. Close stale readiness before a standard apply re-enables owner DELETE.
export async function prepareNativeSpaceInventoryApply(target) {
  const receipt = await readReceipt(target);
  if (!receipt || receipt.version === 0) return;
  if (receipt.coverage) {
    try {
      if (writerCovered(receipt, (await deployment(target)).coverage)) return;
    } catch (error) {
      // A downgrade may remove the alias entirely. Quarantine that receipt
      // before restoring the function. Access and other read errors stop apply.
      if (error.name !== 'ResourceNotFoundException') throw error;
    }
  }
  await markPending(target, receipt);
}

export async function initializeDeployedNativeSpaceInventory({ wait = delay, ...target }) {
  const { lambda, tableName, environment } = target;
  const serving = await deployment(target);
  const { alias, owner, authority, coverage } = serving;
  const receipt = await readReceipt(target);
  const inventoryReady = writerCovered(receipt, coverage);
  const sameProjects = receipt?.coverage?.projectsRevision === coverage.projectsRevision;
  const previous = inventoryReady ? receipt : await markPending(target, receipt);
  if (
    !/^[1-9]\d*$/.test(alias.FunctionVersion) ||
    Object.keys(alias.RoutingConfig?.AdditionalVersionWeights ?? {}).length
  )
    throw new Error('Native commands must serve one published writer');
  const writer = await lambda.send(
    new GetFunctionConfigurationCommand({
      FunctionName: authority,
      Qualifier: alias.FunctionVersion,
    }),
  );
  const ownerEnv = owner.Environment?.Variables;
  const writerEnv = writer.Environment?.Variables;
  if (
    owner.State !== 'Active' ||
    owner.LastUpdateStatus !== 'Successful' ||
    owner.Handler !== 'index.handler' ||
    ownerEnv?.ENVIRONMENT !== environment ||
    ownerEnv.NATIVE_RUNTIME_BINDINGS_TABLE !== tableName ||
    !ownerEnv.YJS_DOCUMENTS_TABLE ||
    writer.State !== 'Active' ||
    writer.Handler !== 'authority.handler' ||
    writerEnv?.NATIVE_RUNTIME_BINDINGS_TABLE !== tableName ||
    writerEnv.YJS_DOCUMENTS_TABLE !== ownerEnv.YJS_DOCUMENTS_TABLE
  )
    throw new Error(
      'Deploy the space-fenced Projects handler and native writer before initializing inventory',
    );
  if (inventoryReady && sameProjects) return { alreadyReady: true };
  const confirmWriter = async () => {
    const current = (await deployment(target)).coverage;
    if (!sameWriter(coverage, current) || current.projectsRevision !== coverage.projectsRevision)
      throw new Error('Native space deployment changed during inventory initialization');
  };
  // Old command and Projects invocations have 90s and 300s limits respectively.
  await wait(sameProjects ? 91_000 : 301_000);
  await confirmWriter();
  if (inventoryReady) {
    // Projects changed alone. The unchanged writer continued marking new bindings.
    await publishReady(target.ddb, tableName, coverage, previous);
    return { alreadyReady: true };
  }
  return initializeNativeSpaceInventory({ ...target, confirmWriter, coverage, previous });
}

function appliedTarget(outputs, environment) {
  const region = outputs?.aws_region?.value;
  if (
    !environment ||
    outputs?.environment?.value !== environment ||
    typeof region !== 'string' ||
    !region
  )
    throw new Error('Cannot verify the applied Terraform environment and region');
  const output = outputs.native_runtime_bindings_table_name;
  if (output === undefined || output?.value === null) return null;
  if (
    typeof output?.value !== 'string' ||
    !output.value.endsWith(`-native-runs-${environment}`) ||
    output.value === `-native-runs-${environment}`
  )
    throw new Error('Invalid native_runtime_bindings_table_name Terraform output');
  return { tableName: output.value, environment, region };
}

function cliTarget([mode, environment, planPath]) {
  if (mode === '--before-apply') {
    let plan;
    try {
      plan = JSON.parse(readFileSync(planPath, 'utf8'));
    } catch {
      throw new Error('Could not read saved Terraform plan');
    }
    const prior = plan.prior_state?.values?.outputs;
    if (
      prior?.native_runtime_bindings_table_name === undefined ||
      prior.native_runtime_bindings_table_name?.value === null ||
      plan.output_changes?.native_runtime_bindings_table_name?.actions?.includes('delete')
    )
      return null;
    return appliedTarget(prior, environment);
  }
  if (mode === '--applied-environment') {
    // Null outputs may be omitted. Parse successful Terraform output privately:
    // neither malformed JSON nor child-process errors may print unrelated outputs.
    let outputs;
    try {
      outputs = JSON.parse(
        execFileSync('terraform', ['output', '-json'], {
          cwd: fileURLToPath(new URL('../terraform/', import.meta.url)),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      );
    } catch {
      throw new Error('Could not read applied Terraform outputs');
    }
    return appliedTarget(outputs, environment);
  }
  if (!mode || mode.startsWith('-'))
    throw new Error(
      'Usage: initialize-native-space-inventory.mjs <native-bindings-table> or --applied-environment <environment>',
    );
  return { tableName: mode, environment: mode.split('-native-runs-').at(-1) };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const target = cliTarget(process.argv.slice(2));
  if (target) {
    const client = new DynamoDBClient({ region: target.region });
    const lambda = new LambdaClient({ region: target.region });
    try {
      const options = { ...target, ddb: DynamoDBDocumentClient.from(client), lambda };
      if (process.argv[2] === '--before-apply') await prepareNativeSpaceInventoryApply(options);
      else console.log(JSON.stringify(await initializeDeployedNativeSpaceInventory(options)));
    } finally {
      client.destroy();
      lambda.destroy();
    }
  }
}
