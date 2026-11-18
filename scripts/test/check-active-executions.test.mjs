import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activatedFlags,
  checkActiveExecutions,
  deactivatedFlags,
  existingExecutionsTable,
} from '../check-active-executions.mjs';

const TABLE_ARN = 'arn:aws:dynamodb:eu-west-1:000000000000:table/test-v2-executions';
const table = (actions = ['no-op']) => ({
  address: 'module.agentcore.aws_dynamodb_table.v2_executions',
  mode: 'managed',
  type: 'aws_dynamodb_table',
  name: 'v2_executions',
  change: {
    actions,
    before: actions[0] === 'create' ? null : { name: 'test-v2-executions', arn: TABLE_ARN },
  },
});
const BASE_ENV = { V2_PROCESS_TABLE: 'test-v2-executions' };
const GATEWAY_ENV = { AIDLC_MCP_GATEWAY_URL: 'https://gw', AIDLC_MCP_GATEWAY_TARGET: 'aidlc' };
// The runtime's environment before and after the apply; `unknown` lists keys
// whose value is only known after apply (a Gateway created in the same apply).
const runtime = ({
  before = BASE_ENV,
  after = before,
  unknown = {},
  actions = ['update'],
} = {}) => ({
  address: 'module.agentcore.awscc_bedrockagentcore_runtime.stage_executor',
  mode: 'managed',
  type: 'awscc_bedrockagentcore_runtime',
  name: 'stage_executor',
  change: {
    actions,
    before: before && { environment_variables: before },
    after: { environment_variables: after },
    after_unknown: { environment_variables: unknown },
  },
});
const plan = (...resource_changes) => ({ resource_changes });
const rows = [
  { executionId: 'e-run', projectId: 'p-1', status: 'RUNNING' },
  { executionId: 'e-park', projectId: 'p-1', status: 'WAITING' },
  { executionId: 'e-queued', projectId: 'p-2', status: 'CREATED' },
  { executionId: 'e-draft', projectId: 'p-2', status: 'DRAFT' },
];

test('the runtime gaining the Gateway URL turns the Gateway path on', () => {
  const known = { AIDLC_MCP_GATEWAY_TARGET: GATEWAY_ENV.AIDLC_MCP_GATEWAY_TARGET };
  assert.deepEqual(
    activatedFlags(
      plan(
        table(),
        runtime({
          after: { ...BASE_ENV, ...known },
          unknown: { AIDLC_MCP_GATEWAY_URL: true },
        }),
      ),
    ),
    ['enable_mcp_gateway'],
  );
  assert.deepEqual(
    activatedFlags(plan(table(), runtime({ after: { ...BASE_ENV, ...GATEWAY_ENV } }))),
    ['enable_mcp_gateway'],
  );
});

test('a plan that keeps, removes or never had the Gateway activates nothing', () => {
  const on = { ...BASE_ENV, ...GATEWAY_ENV };
  assert.deepEqual(activatedFlags(plan(table(), runtime({ before: on }))), []);
  assert.deepEqual(activatedFlags(plan(table(), runtime({ before: on, after: BASE_ENV }))), []);
  assert.deepEqual(activatedFlags(plan(table(), runtime())), []);
  assert.deepEqual(activatedFlags(plan(table())), []);
  assert.deepEqual(
    activatedFlags(
      plan(table(['create']), runtime({ before: null, after: on, actions: ['create'] })),
    ),
    [],
  );
});

test('a retry after an apply that created the Gateway but not the runtime change still activates', () => {
  // The Gateway already exists (no-op); only the runtime is still switching.
  const gatewayAlreadyCreated = {
    mode: 'managed',
    type: 'aws_bedrockagentcore_gateway',
    name: 'mcp',
    change: { actions: ['no-op'] },
  };
  assert.deepEqual(
    activatedFlags(
      plan(table(), gatewayAlreadyCreated, runtime({ after: { ...BASE_ENV, ...GATEWAY_ENV } })),
    ),
    ['enable_mcp_gateway'],
  );
});

test('turning engine-data on later is an activation of its own', () => {
  const gateway = { ...BASE_ENV, ...GATEWAY_ENV };
  const engineData = { ...gateway, ENGINE_DATA_FUNCTION: 'test-engine-data' };
  assert.deepEqual(activatedFlags(plan(table(), runtime({ before: gateway, after: engineData }))), [
    'enable_engine_data',
  ]);
  assert.deepEqual(activatedFlags(plan(table(), runtime({ after: engineData }))), [
    'enable_mcp_gateway',
    'enable_engine_data',
  ]);
  assert.deepEqual(activatedFlags(plan(table(), runtime({ before: engineData }))), []);
  assert.deepEqual(
    activatedFlags(plan(table(), runtime({ before: engineData, after: gateway }))),
    [],
  );
});

test('the runtime losing the engine-data function turns engine-data off', () => {
  const gateway = { ...BASE_ENV, ...GATEWAY_ENV };
  const engineData = { ...gateway, ENGINE_DATA_FUNCTION: 'test-engine-data' };
  assert.deepEqual(
    deactivatedFlags(plan(table(), runtime({ before: engineData, after: gateway }))),
    ['enable_engine_data'],
  );
  assert.deepEqual(deactivatedFlags(plan(table(), runtime({ before: engineData }))), []);
  assert.deepEqual(
    deactivatedFlags(
      plan(
        table(),
        runtime({
          before: engineData,
          after: gateway,
          unknown: { ENGINE_DATA_FUNCTION: true },
        }),
      ),
    ),
    [],
  );
  assert.deepEqual(deactivatedFlags(plan(table(), runtime({ after: engineData }))), []);
  // Destroying the runtime strands no warm session.
  const destroyed = runtime({ before: engineData, actions: ['delete'] });
  destroyed.change.after = null;
  assert.deepEqual(deactivatedFlags(plan(table(), destroyed)), []);
  // Disabling the Gateway alone is not guarded.
  assert.deepEqual(
    deactivatedFlags(plan(table(), runtime({ before: gateway, after: BASE_ENV }))),
    [],
  );
});

test('reads the existing process table from the plan, not a fresh one', () => {
  assert.deepEqual(existingExecutionsTable(plan(table())), {
    name: 'test-v2-executions',
    region: 'eu-west-1',
  });
  assert.equal(existingExecutionsTable(plan(table(['create']))), null);
});

const activating = () => plan(table(), runtime({ after: { ...BASE_ENV, ...GATEWAY_ENV } }));

test('refuses activation while executions are running, parked or started but not yet running', async () => {
  const seen = [];
  const result = await checkActiveExecutions({
    plan: activating(),
    listActiveExecutions: async (target) => {
      seen.push(target);
      return rows;
    },
    env: {},
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.active.map((row) => row.executionId),
    ['e-run', 'e-park', 'e-queued'],
  );
  assert.deepEqual(seen, [{ name: 'test-v2-executions', region: 'eu-west-1' }]);
});

test('passes once only drafts remain, and on plans that activate nothing', async () => {
  const drafts = async () => rows.filter((row) => row.status === 'DRAFT');
  assert.equal(
    (await checkActiveExecutions({ plan: activating(), listActiveExecutions: drafts, env: {} })).ok,
    true,
  );
  const untouched = await checkActiveExecutions({
    plan: plan(table(), runtime()),
    listActiveExecutions: async () => assert.fail('no activation, no table read'),
    env: {},
  });
  assert.equal(untouched.ok, true);
});

test('skips the table on a fresh install', async () => {
  const result = await checkActiveExecutions({
    plan: plan(table(['create']), runtime({ after: { ...BASE_ENV, ...GATEWAY_ENV } })),
    listActiveExecutions: async () => assert.fail('a table being created holds no executions'),
    env: {},
  });
  assert.equal(result.ok, true);
});

test('a table read failure fails the check', async () => {
  await assert.rejects(
    checkActiveExecutions({
      plan: activating(),
      listActiveExecutions: async () => {
        throw new Error('AccessDenied');
      },
      env: {},
    }),
    /AccessDenied/,
  );
});

const disabling = () =>
  plan(
    table(),
    runtime({
      before: { ...BASE_ENV, ...GATEWAY_ENV, ENGINE_DATA_FUNCTION: 'test-engine-data' },
      after: { ...BASE_ENV, ...GATEWAY_ENV },
    }),
  );

test('refuses turning engine-data off while executions are running, parked or queued', async () => {
  const result = await checkActiveExecutions({
    plan: disabling(),
    listActiveExecutions: async () => rows,
    env: {},
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.flags, []);
  assert.deepEqual(result.deactivated, ['enable_engine_data']);
  assert.deepEqual(
    result.active.map((row) => row.executionId),
    ['e-run', 'e-park', 'e-queued'],
  );
  const drained = await checkActiveExecutions({
    plan: disabling(),
    listActiveExecutions: async () => rows.filter((row) => row.status === 'DRAFT'),
    env: {},
  });
  assert.equal(drained.ok, true);
  const overridden = await checkActiveExecutions({
    plan: disabling(),
    listActiveExecutions: async () => rows,
    env: { AIDLC_ALLOW_ACTIVE_EXECUTIONS: '1' },
  });
  assert.equal(overridden.ok, true);
  assert.equal(overridden.overridden, true);
});

test('an explicit override applies anyway and still reports the executions', async () => {
  const result = await checkActiveExecutions({
    plan: activating(),
    listActiveExecutions: async () => rows,
    env: { AIDLC_ALLOW_ACTIVE_EXECUTIONS: '1' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.overridden, true);
  assert.equal(result.active.length, 3);
});
