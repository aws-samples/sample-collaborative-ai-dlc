#!/usr/bin/env node
// Refuses a plan that moves the runtime onto a grant-verified path while
// executions started without grants are still running or parked: their
// orchestrator cannot issue the grants the new path requires, so they would
// fail when they next invoke the runtime.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OVERRIDE = 'AIDLC_ALLOW_ACTIVE_EXECUTIONS';
// ACTIVE_EXECUTION_STATUSES: CREATED is a started execution whose
// orchestrator has not reached its first stage yet, not a draft.
const DRAINED_STATUSES = new Set(['CREATED', 'RUNNING', 'WAITING']);

// The runtime environment variable that switches it onto each remote path.
// Detecting its arrival on the runtime, rather than the creation of a
// resource, also catches a retry after an apply that failed before the runtime
// was updated.
const ACTIVATIONS = [
  { flag: 'enable_mcp_gateway', variable: 'AIDLC_MCP_GATEWAY_URL' },
  { flag: 'enable_engine_data', variable: 'ENGINE_DATA_FUNCTION' },
];

const isRuntime = (change) =>
  change.mode === 'managed' &&
  change.type === 'awscc_bedrockagentcore_runtime' &&
  change.name === 'stage_executor';

const gains = (change, variable) => {
  const before = change.change?.before?.environment_variables;
  if (!before || Object.hasOwn(before, variable)) return false;
  const after = change.change?.after?.environment_variables;
  const unknown = change.change?.after_unknown?.environment_variables;
  return Boolean(
    (after && Object.hasOwn(after, variable)) || (unknown && Object.hasOwn(unknown, variable)),
  );
};

export const activatedFlags = (plan) => {
  const runtime = (plan.resource_changes ?? []).find(isRuntime);
  if (!runtime) return [];
  return ACTIVATIONS.filter(({ variable }) => gains(runtime, variable)).map(({ flag }) => flag);
};

// The process table as it exists before this apply; null on a fresh install.
export const existingExecutionsTable = (plan) => {
  const change = (plan.resource_changes ?? []).find(
    (candidate) =>
      candidate.type === 'aws_dynamodb_table' &&
      candidate.name === 'v2_executions' &&
      candidate.mode === 'managed',
  );
  const before = change?.change?.before;
  if (!before?.name || !before?.arn) return null;
  return { name: before.name, region: before.arn.split(':')[3] };
};

export const checkActiveExecutions = async ({ plan, listActiveExecutions, env = process.env }) => {
  const flags = activatedFlags(plan);
  if (flags.length === 0) return { ok: true, flags };
  const table = existingExecutionsTable(plan);
  if (!table) return { ok: true, flags };
  const active = (await listActiveExecutions(table)).filter((row) =>
    DRAINED_STATUSES.has(row.status),
  );
  if (active.length === 0) return { ok: true, flags };
  return {
    ok: env[OVERRIDE] === '1',
    overridden: env[OVERRIDE] === '1',
    flags,
    active,
  };
};

const listFromTable = async ({ name, region }) => {
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
  const { createProcessStore } = await import('../lambda/shared/v2-process-store.js');
  const client = new DynamoDBClient({ region });
  try {
    return await createProcessStore({
      ddb: DynamoDBDocumentClient.from(client),
      tableName: name,
    }).listActiveExecutions();
  } finally {
    client.destroy();
  }
};

const report = ({ flags, active, overridden }) => {
  const log = overridden ? console.warn : console.error;
  log(
    `${overridden ? 'Warning' : 'Refusing Terraform plan'}: it turns on ${flags.join(', ')} ` +
      `while ${active.length} execution(s) started without runtime grants are running or parked:`,
  );
  for (const row of active) {
    log(`  - ${row.executionId} (project ${row.projectId}, ${row.status})`);
  }
  if (overridden) {
    log(`${OVERRIDE}=1 is set: these executions will fail when they next invoke the runtime.`);
    return;
  }
  log(
    'Stop starting new intents until the deployment has succeeded, retries included. Wait for ' +
      'RUNNING executions to park or finish, cancel the parked (WAITING) and queued (CREATED) ' +
      'ones, re-plan and apply, then rewind each cancelled execution to its current stage (its ' +
      'first stage if it had not reached one): the rewind relaunches it with grants. To apply ' +
      `anyway, set ${OVERRIDE}=1; the executions listed will fail when they next invoke the runtime.`,
  );
};

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const planPath = process.argv[2];
  if (!planPath) {
    console.error('Usage: check-active-executions.mjs <terraform-plan.json>');
    process.exit(2);
  }
  const result = await checkActiveExecutions({
    plan: JSON.parse(readFileSync(planPath, 'utf8')),
    listActiveExecutions: listFromTable,
  });
  if (result.active) report(result);
  if (!result.ok) process.exit(1);
  if (result.flags.length) console.log('Active execution check passed.');
}
