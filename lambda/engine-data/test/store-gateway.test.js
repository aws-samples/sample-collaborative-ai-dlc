import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  BatchWriteCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { issueGatewayGrant, verifyGatewayGrant } from '../../shared/gateway-grant.js';
import { createProcessStore, isTransactionConflict } from '../../shared/v2-process-store.js';
import { ENGINE_DATA_STORE_METHODS } from '../../shared/engine-data-ops.js';
import { createRemoteProcessStore } from '../../agentcore/engine-data-client.js';
import { scopeStageAttempt } from '../../shared/stage-attempt.js';
import { stageInstanceId as planStageInstanceId } from '../../shared/v2-execution-plan.js';
import { createStoreGateway } from '../store-gateway.js';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const KID = 'kid-1';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const grantFor = (scope) =>
  issueGatewayGrant(scope, {
    keyId: KID,
    sign: async (m) => cryptoSign('sha256', m, privateKey),
    now: () => NOW,
    randomId: () => 'grant-1',
  });
const verifyGrant = (token) =>
  verifyGatewayGrant(token, {
    publicKeyFor: async (kid) => (kid === KID ? publicKey : null),
    now: () => NOW + 1000,
  });

const EXECUTION = { mode: 'execution', projectId: 'p-1', intentId: 'i-1', executionId: 'e-1' };
const META = {
  pk: 'EXEC#e-1',
  sk: 'META',
  executionId: 'e-1',
  projectId: 'p-1',
  intentId: 'i-1',
  status: 'RUNNING',
  orchestratorRunId: 'run-1',
};
const STAGE = {
  pk: 'EXEC#e-1',
  sk: 'STAGE#si-1',
  executionId: 'e-1',
  stageInstanceId: 'si-1',
  stageId: 'requirements-analysis',
  state: 'RUNNING',
  stageCallbackId: 'cb-1',
  orchestratorRunId: 'run-1',
};
const OWNERSHIP = { orchestratorRunId: 'run-1', stageCallbackId: 'cb-1', stageInstanceId: 'si-1' };

const ddb = mockClient(DynamoDBDocumentClient);
const items = (overrides = {}) => ({ META, 'STAGE#si-1': STAGE, ...overrides });

const seed = (rows = items()) => {
  ddb.reset();
  ddb.on(GetCommand).callsFake(({ Key }) => ({
    Item: Key.pk === 'EXEC#e-1' ? (rows[Key.sk] ?? undefined) : undefined,
  }));
  ddb.on(QueryCommand).resolves({ Items: [] });
  ddb.on(PutCommand).resolves({});
  ddb.on(UpdateCommand).resolves({ Attributes: { ...META, pk: 'EXEC#e-1' } });
  ddb.on(TransactWriteCommand).resolves({});
  ddb.on(BatchWriteCommand).resolves({});
  ddb.on(DeleteCommand).resolves({});
};

const newStore = () => {
  let n = 0;
  return createProcessStore({
    ddb,
    tableName: 'v2-proc',
    clock: () => '2026-10-18T12:00:00.000Z',
    ids: () => `id-${++n}`,
  });
};

const gatewayWith = (audit = []) =>
  createStoreGateway({ verifyGrant, createStore: newStore, audit: (r) => audit.push(r) });

// The JSON round trip the Lambda transport applies to events and responses.
const wire = (handler) => async (event) =>
  JSON.parse(JSON.stringify(await handler(JSON.parse(JSON.stringify(event)))));

const remoteStore = async ({ scope = EXECUTION, audit } = {}) => {
  const token = await grantFor(scope);
  return createRemoteProcessStore({ invoke: wire(gatewayWith(audit)), grant: () => token });
};

const commandInputs = () =>
  ddb.calls().map((call) => ({ name: call.args[0].constructor.name, input: call.args[0].input }));

// One representative call per allowlisted method, shaped like the runtime's.
const CALLS = {
  appendEvent: [{ executionId: 'e-1', type: 'v2.stage.running', stageInstanceId: 'si-1' }],
  getStage: ['e-1', 'si-1', { consistentRead: true }],
  getExecution: ['e-1', { consistentRead: true }],
  updateStageState: [
    { executionId: 'e-1', stageInstanceId: 'si-1', state: 'SUCCEEDED', completedAt: true },
  ],
  getHumanTask: ['e-1', 'h-1', { consistentRead: true }],
  updateExecution: [
    { executionId: 'e-1', status: 'RUNNING', currentPhase: 'inception', currentStage: 's' },
  ],
  recordMetric: [{ executionId: 'e-1', stageInstanceId: 'si-1', metrics: { tokensIn: 3 } }],
  recordSensorRun: [
    {
      executionId: 'e-1',
      stageInstanceId: 'si-1',
      sensorId: 'required-sections',
      kind: 'deterministic',
      result: 'PASS',
    },
  ],
  putStage: [
    {
      executionId: 'e-1',
      stageInstanceId: 'si-2',
      stageId: 'feasibility',
      phase: 'inception',
      state: 'RUNNING',
    },
  ],
  putReceipt: [
    {
      executionId: 'e-1',
      kind: 'summary-confirmation',
      stageInstanceId: 'si-1',
      attempt: 0,
      decidedBy: 'agent',
    },
  ],
  listReceipts: ['e-1', { stageInstanceId: 'si-1', consistentRead: true }],
  getUnitPlan: ['e-1', { consistentRead: true }],
  updateCompose: [{ executionId: 'e-1', composeId: 'c-1', state: 'READY', fields: { note: 'x' } }],
  syncUnitRows: [
    { executionId: 'e-1', units: [{ slug: 'api', dependsOn: [] }], batches: [['api']] },
  ],
  supersedeHumanTask: [{ executionId: 'e-1', humanTaskId: 'h-1', supersededBy: 'h-2' }],
  resumeStageRow: [{ executionId: 'e-1', stageInstanceId: 'si-1', cli: 'claude' }],
  putWorkflowCheckpoint: [
    {
      type: 'WorkflowCheckpoint',
      executionId: 'e-1',
      checkpointId: 'cp-1',
      orchestratorRunId: 'run-1',
      process: { stages: [] },
      artifactRefs: [],
      customRuleRefs: [],
    },
  ],
  putUnitPlan: [{ executionId: 'e-1', units: [{ slug: 'api' }], batches: [['api']] }],
  markSteeringConsumed: [
    { executionId: 'e-1', steerId: 'st-1', createdAt: '2026-10-18T11:00:00.000Z' },
  ],
  markLoopBackArchived: [{ executionId: 'e-1', stageInstanceId: 'si-1', loopBackId: 'lb-1' }],
  listSensorRuns: ['e-1', { stageInstanceId: 'si-1' }],
  listPendingSteering: ['e-1'],
  listEvents: ['e-1', { consistentRead: true }],
  getExecutionRecords: ['e-1', { includeOutputs: false }],
  createHumanTask: [
    { executionId: 'e-1', stageInstanceId: 'si-1', kind: 'question', questions: [{ text: 'q' }] },
  ],
  createExecution: [
    { executionId: 'e-1', projectId: 'p-1', intentId: 'i-1', status: 'CREATED', scope: 'feature' },
  ],
  claimStageAttempt: [
    { executionId: 'e-1', ownership: OWNERSHIP, stageId: 'requirements-analysis', phase: 'x' },
  ],
  appendOutput: [{ executionId: 'e-1', stageInstanceId: 'si-1', kind: 'text', content: 'hi' }],
  raiseStageCounter: [{ executionId: 'e-1', stageInstanceId: 'si-1', field: 'repairTurns', to: 1 }],
  getQuorumEdit: ['e-1', 'qe-1'],
  updateQuorumEdit: [{ executionId: 'e-1', editId: 'qe-1', state: 'PLANNED' }],
  recordGraphRead: [{ executionId: 'e-1', stageInstanceId: 'si-1', tool: 'get_artifact' }],
  setLoopBackRecommendation: [{ executionId: 'e-1', stageInstanceId: 'si-1', reason: 'r' }],
  getReceipt: ['e-1', { kind: 'summary-confirmation', stageInstanceId: 'si-1', attempt: 0 }],
};

// The scope reads engine-data adds before running the op: META, then each
// STAGE# row an argument names.
const scopeReads = (method) => {
  if (method === 'createExecution') return 0;
  const stageArgs = {
    updateStageState: 1,
    recordSensorRun: 1,
    putReceipt: 1,
    listReceipts: 1,
    resumeStageRow: 1,
    markLoopBackArchived: 1,
    listSensorRuns: 1,
    createHumanTask: 1,
    raiseStageCounter: 1,
    setLoopBackRecommendation: 1,
    getReceipt: 1,
  };
  return 1 + (stageArgs[method] ?? 0);
};

const outcome = async (fn) => {
  try {
    return { result: JSON.parse(JSON.stringify((await fn()) ?? null)) };
  } catch (error) {
    return { error: error.name, message: error.message };
  }
};

describe('engine-data transport equivalence', () => {
  it('covers every allowlisted method', () => {
    expect(Object.keys(CALLS).toSorted()).toEqual(ENGINE_DATA_STORE_METHODS.toSorted());
  });

  it.each(ENGINE_DATA_STORE_METHODS)(
    '%s issues the same DynamoDB calls and returns the same value',
    async (method) => {
      const rows = method === 'createExecution' ? items({ META: undefined }) : items();
      seed(rows);
      const local = await outcome(() => newStore()[method](...CALLS[method]));
      const localCalls = commandInputs();

      seed(rows);
      const audit = [];
      const remote = await remoteStore({ audit });
      const viaLambda = await outcome(() => remote[method](...CALLS[method]));
      const remoteCalls = commandInputs().slice(scopeReads(method));

      expect(audit.at(-1)).toMatchObject({ decision: 'allow' });
      expect(audit.at(-1).strippedKeys).toBeUndefined();
      expect(viaLambda).toEqual(local);
      expect(remoteCalls).toEqual(localCalls);
    },
  );
});

describe('engine-data authorization', () => {
  beforeEach(() => seed());

  const denied = async (promise, code) => {
    await expect(promise).rejects.toMatchObject({ name: 'EngineDataAccessDenied', code });
  };

  it('fails closed without a grant on the caller side', async () => {
    const store = createRemoteProcessStore({ invoke: wire(gatewayWith()), grant: () => null });
    await expect(store.getExecution('e-1')).rejects.toMatchObject({
      code: 'ENGINE_DATA_GRANT_MISSING',
    });
    expect(ddb.calls()).toHaveLength(0);
  });

  it('denies a missing, invalid or expired grant', async () => {
    const handler = gatewayWith();
    expect((await handler({ op: 'store.getExecution', args: ['e-1'] })).error.code).toBe(
      'missing_grant',
    );
    expect(
      (await handler({ op: 'store.getExecution', args: ['e-1'], grant: 'x.y.z' })).error.code,
    ).toBe('grant_invalid');
    const expired = createStoreGateway({
      verifyGrant: (token) =>
        verifyGatewayGrant(token, {
          publicKeyFor: async () => publicKey,
          now: () => NOW + 9 * 3600 * 1000,
        }),
      createStore: newStore,
    });
    const token = await grantFor(EXECUTION);
    expect(
      (await expired({ op: 'store.getExecution', args: ['e-1'], grant: token })).error.code,
    ).toBe('grant_expired');
    expect(ddb.calls()).toHaveLength(0);
  });

  it.each([
    'listActiveExecutions',
    'listStaleActiveExecutions',
    'listProjectExecutions',
    'deleteExecution',
    'answerHumanTask',
    'answerHumanTaskWithSteering',
    'patchExecutionConfig',
    'listUnitPrWaits',
    'claimTrackerSync',
    'toString',
    '__proto__',
  ])('never runs %s', async (method) => {
    const handler = gatewayWith();
    const result = await handler({
      op: `store.${method}`,
      args: ['e-1'],
      grant: await grantFor(EXECUTION),
    });
    expect(result.error).toMatchObject({ name: 'EngineDataAccessDenied', code: 'op_not_allowed' });
    expect(ddb.calls()).toHaveLength(0);
  });

  it.each([
    ['another execution', ['e-2', { consistentRead: true }]],
    ['no execution', [undefined]],
  ])('denies a call naming %s', async (_label, args) => {
    const store = await remoteStore();
    await expect(store.getExecution(...args)).rejects.toMatchObject({
      name: 'EngineDataAccessDenied',
    });
  });

  it.each([
    ['another project', { ...META, projectId: 'p-2' }],
    ['another intent', { ...META, intentId: 'i-2' }],
  ])('denies an execution that belongs to %s', async (_label, meta) => {
    seed(items({ META: meta }));
    const store = await remoteStore();
    await denied(store.appendEvent({ executionId: 'e-1', type: 'x' }), 'scope_mismatch');
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('denies a stage of another execution and a missing execution', async () => {
    seed(items({ 'STAGE#si-1': { ...STAGE, executionId: 'e-9' } }));
    const store = await remoteStore();
    await denied(
      store.updateStageState({ executionId: 'e-1', stageInstanceId: 'si-1', state: 'FAILED' }),
      'scope_mismatch',
    );
    seed(items({ META: undefined }));
    await denied(store.appendEvent({ executionId: 'e-1', type: 'x' }), 'execution_not_found');
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('acts on its own execution after it finished (no status gate)', async () => {
    seed(
      items({
        META: { ...META, status: 'SUCCEEDED' },
        'STAGE#si-1': { ...STAGE, state: 'SUCCEEDED' },
      }),
    );
    const store = await remoteStore();
    await store.appendEvent({
      executionId: 'e-1',
      type: 'v2.stage.succeeded',
      stageInstanceId: 'si-1',
    });
    expect(ddb.commandCalls(PutCommand)).toHaveLength(1);
  });

  it.each([
    [
      'additionalWrites',
      { additionalWrites: [{ Put: { TableName: 't', Item: { pk: 'X', sk: 'Y' } } }] },
    ],
    ['credentialBinding', { credentialBinding: { provider: 'bedrock', source: 'platform' } }],
    ['projectId', { projectId: 'p-2' }],
    ['startedAt', { startedAt: '2026-01-01T00:00:00.000Z' }],
    ['a GSI key', { GSI1PK: 'PROJECT#p-2' }],
  ])('refuses updateExecution with %s', async (_label, extra) => {
    const audit = [];
    const store = await remoteStore({ audit });
    await denied(
      store.updateExecution({ executionId: 'e-1', status: 'RUNNING', ...extra }),
      'invalid_arguments',
    );
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(JSON.stringify(audit)).not.toContain('PROJECT#p-2');
  });

  it('refuses a row key on any write and drops unknown fields with an audit trace', async () => {
    const audit = [];
    const store = await remoteStore({ audit });
    await denied(
      store.appendEvent({ executionId: 'e-1', type: 'x', pk: 'EXEC#e-2' }),
      'invalid_arguments',
    );
    await store.appendEvent({ executionId: 'e-1', type: 'x', unknownField: 'v' });
    expect(audit.at(-1)).toMatchObject({ decision: 'allow', strippedKeys: ['0.unknownField'] });
    expect(ddb.commandCalls(PutCommand)[0].args[0].input.Item).not.toHaveProperty('unknownField');
  });

  it('creates only its own execution and reports an existing one as the store does', async () => {
    seed(items({ META: undefined }));
    const store = await remoteStore();
    await denied(
      store.createExecution({ executionId: 'e-1', projectId: 'p-2', intentId: 'i-1' }),
      'scope_mismatch',
    );
    const cancelled = Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    ddb.on(TransactWriteCommand).rejects(cancelled);
    await expect(
      store.createExecution({ executionId: 'e-1', projectId: 'p-1', intentId: 'i-1' }),
    ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
  });

  it('carries transaction conflicts and META condition messages back unchanged', async () => {
    const store = await remoteStore();
    const conflict = Object.assign(new Error('conflict'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'TransactionConflict' }],
    });
    ddb.on(TransactWriteCommand).rejects(conflict);
    const error = await store
      .claimStageAttempt({ executionId: 'e-1', ownership: OWNERSHIP, stageId: 's' })
      .catch((e) => e);
    expect(isTransactionConflict(error)).toBe(true);

    seed();
    const local = await newStore()
      .updateExecution({ executionId: 'e-1', status: 'RUNNING', ifOrchestratorRunId: 'run-0' })
      .catch((e) => e);
    seed();
    ddb.on(UpdateCommand).rejects(
      Object.assign(new Error('The conditional request failed'), {
        name: 'ConditionalCheckFailedException',
      }),
    );
    const remote = await store
      .updateExecution({ executionId: 'e-1', status: 'RUNNING', ifOrchestratorRunId: 'run-0' })
      .catch((e) => e);
    expect(remote.name).toBe('ConditionalCheckFailedException');
    expect(typeof local).toBe('object');
  });

  describe('discussion grants', () => {
    const DISCUSSION = {
      mode: 'discussion',
      projectId: 'p-1',
      intentId: 'e-1',
      executionId: 'e-1',
    };
    const discussionStore = () => remoteStore({ scope: DISCUSSION });
    beforeEach(() => seed(items({ META: { ...META, intentId: 'e-1' } })));

    it('runs the assist calls on its own intent execution', async () => {
      const store = await discussionStore();
      await expect(store.getExecution('e-1', { consistentRead: true })).resolves.toMatchObject({
        executionId: 'e-1',
      });
      await expect(
        store.getExecutionRecords('e-1', { includeOutputs: false }),
      ).resolves.toMatchObject({ events: [] });
      expect(ddb.commandCalls(QueryCommand).length).toBeGreaterThan(0);
      await store.recordMetric({
        executionId: 'e-1',
        stageInstanceId: null,
        metrics: { tokensInput: 3, discussionAssistCalls: 1 },
        resolvedModel: 'm',
      });
      await store.appendEvent({
        executionId: 'e-1',
        type: 'v2.discussion_assist.completed',
        actor: 'quorum',
        summary: 'Quorum summarize completed for discussion d-1',
      });
      expect(ddb.commandCalls(PutCommand)).toHaveLength(2);
    });

    it('keeps every other method denied', async () => {
      const store = await discussionStore();
      await denied(
        store.updateExecution({ executionId: 'e-1', status: 'RUNNING' }),
        'op_not_allowed',
      );
      await denied(
        store.appendOutput({ executionId: 'e-1', kind: 'text', content: 'x' }),
        'op_not_allowed',
      );
      await denied(store.listEvents('e-1'), 'op_not_allowed');
      expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
      expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    it('denies another execution, a stage or a lane', async () => {
      const store = await discussionStore();
      await denied(store.getExecutionRecords('e-2'), 'scope_mismatch');
      await denied(store.appendEvent({ executionId: 'e-2', type: 'x' }), 'scope_mismatch');
      await denied(
        store.appendEvent({ executionId: 'e-1', type: 'x', stageInstanceId: 'si-1' }),
        'scope_mismatch',
      );
      await denied(
        store.recordMetric({ executionId: 'e-1', unitSlug: 'api', metrics: {} }),
        'scope_mismatch',
      );
      expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
    });

    it('denies an execution of another project or intent', async () => {
      for (const meta of [
        { ...META, intentId: 'e-1', projectId: 'p-2' },
        { ...META, intentId: 'i-other' },
      ]) {
        seed(items({ META: meta }));
        const store = await discussionStore();
        await denied(store.getExecutionRecords('e-1'), 'scope_mismatch');
        await denied(store.recordMetric({ executionId: 'e-1', metrics: {} }), 'scope_mismatch');
        await denied(store.appendEvent({ executionId: 'e-1', type: 'x' }), 'scope_mismatch');
        expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
      }
    });
  });

  describe('workflow checkpoint custom rule refs', () => {
    const RULE = { filename: 'standards.md', s3Key: 'custom-rules/p-1/standards.md' };
    const checkpoint = (customRuleRefs) => ({
      ...CALLS.putWorkflowCheckpoint[0],
      customRuleRefs,
    });
    beforeEach(() => seed(items({ META: { ...META, customRules: [RULE] } })));

    it('accepts a pinned ref to a rule META lists', async () => {
      const store = await remoteStore();
      await store.putWorkflowCheckpoint(checkpoint([{ ...RULE, versionId: 'v-1' }]));
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
    });

    it.each([
      ['another project key', { filename: 'standards.md', s3Key: 'custom-rules/p-2/standards.md' }],
      ['a rule META does not list', { filename: 'other.md', s3Key: 'custom-rules/p-1/other.md' }],
      ['a nested key', { filename: 'standards.md', s3Key: 'custom-rules/p-1/x/standards.md' }],
      ['a mismatched filename', { filename: 'other.md', s3Key: RULE.s3Key }],
    ])('denies %s', async (_label, ref) => {
      const store = await remoteStore();
      await denied(
        store.putWorkflowCheckpoint(checkpoint([{ ...ref, versionId: 'v-1' }])),
        'scope_mismatch',
      );
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });

    it('denies the foreign key even when META lists it for this execution', async () => {
      const foreign = { filename: 'standards.md', s3Key: 'custom-rules/p-2/standards.md' };
      seed(items({ META: { ...META, customRules: [foreign] } }));
      const store = await remoteStore();
      await denied(
        store.putWorkflowCheckpoint(checkpoint([{ ...foreign, versionId: 'v-1' }])),
        'scope_mismatch',
      );
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });

    it.each([
      ['no versionId', RULE],
      ['an empty versionId', { ...RULE, versionId: '' }],
      ['a non-string versionId', { ...RULE, versionId: 7 }],
      ['a non-object ref', 'custom-rules/p-1/standards.md'],
    ])('rejects %s', async (_label, ref) => {
      const store = await remoteStore();
      await denied(store.putWorkflowCheckpoint(checkpoint([ref])), 'invalid_arguments');
      expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });
  });

  it('never logs arguments or the grant', async () => {
    const audit = [];
    const store = await remoteStore({ audit });
    await store.appendOutput({ executionId: 'e-1', kind: 'text', content: 'secret-body' });
    const token = await grantFor(EXECUTION);
    expect(JSON.stringify(audit)).not.toContain('secret-body');
    expect(JSON.stringify(audit)).not.toContain(token);
    expect(audit.at(-1)).toMatchObject({
      op: 'store.appendOutput',
      decision: 'allow',
      projectId: 'p-1',
      executionId: 'e-1',
      grantId: 'grant-1',
      mode: 'execution',
    });
  });
});

describe('remote process store shape', () => {
  it('exposes exactly the allowlisted methods as own enumerable functions', async () => {
    const store = await remoteStore();
    expect(Object.keys(store).toSorted()).toEqual(ENGINE_DATA_STORE_METHODS.toSorted());
    expect(typeof store.markLoopBackArchived).toBe('function');
    expect(store.listActiveExecutions).toBeUndefined();
    expect(store.deleteExecution?.()).toBeUndefined();
  });

  it('survives the stage-attempt scoping spread', async () => {
    seed();
    const store = await remoteStore();
    const scoped = scopeStageAttempt(store, OWNERSHIP);
    expect(typeof scoped.getStage).toBe('function');
    await expect(scoped.getStage('e-1', 'si-1')).resolves.toMatchObject({
      stageInstanceId: 'si-1',
    });
  });
});

describe('stage grants act only as their own stage', () => {
  // run-stage resolves instance ids in the workflow-pin namespace.
  const PINNED = { ...META, workflowId: 'aidlc-v2', workflowVersion: 3 };
  const OWN = planStageInstanceId('aidlc-v2@3', 'requirements-analysis');
  const OTHER = planStageInstanceId('aidlc-v2@3', 'application-design');
  const LANE = planStageInstanceId('aidlc-v2@3', 'code-generation', 'api', 0);
  const STAGE_GRANT = {
    mode: 'stage',
    projectId: 'p-1',
    intentId: 'i-1',
    executionId: 'e-1',
    stageId: 'requirements-analysis',
    stageCallbackId: 'cb-1',
    orchestratorRunId: 'run-1',
  };
  const LANE_GRANT = {
    ...STAGE_GRANT,
    stageId: 'code-generation',
    unitSlug: 'api',
    sectionIndex: 0,
  };
  const leg = (stageInstanceId) => ({
    orchestratorRunId: 'run-1',
    stageCallbackId: 'cb-1',
    stageInstanceId,
  });
  const stageRow = (stageInstanceId, extra = {}) => ({
    ...STAGE,
    sk: `STAGE#${stageInstanceId}`,
    stageInstanceId,
    ...extra,
  });

  beforeEach(() =>
    seed({
      META: PINNED,
      [`STAGE#${OWN}`]: stageRow(OWN),
      [`STAGE#${OTHER}`]: stageRow(OTHER, { stageId: 'application-design' }),
      [`STAGE#${LANE}`]: stageRow(LANE, { stageId: 'code-generation', unitSlug: 'api' }),
      'HUMAN#h-own': { executionId: 'e-1', humanTaskId: 'h-own', stageInstanceId: OWN },
      'HUMAN#h-other': { executionId: 'e-1', humanTaskId: 'h-other', stageInstanceId: OTHER },
    }),
  );

  const call = async (scope, method, args) => {
    const audit = [];
    const response = await gatewayWith(audit)({
      op: `store.${method}`,
      args,
      grant: await grantFor(scope),
    });
    return { response, audit };
  };
  const writes = () =>
    ddb.calls().filter((c) => !['GetCommand', 'QueryCommand'].includes(c.args[0].constructor.name));

  it('allows the writes run-stage makes for its own stage and leg', async () => {
    for (const [method, args] of [
      [
        'updateStageState',
        [{ executionId: 'e-1', stageInstanceId: OWN, state: 'SUCCEEDED', ownership: leg(OWN) }],
      ],
      ['appendEvent', [{ executionId: 'e-1', type: 'v2.stage.running', stageInstanceId: OWN }]],
      ['appendEvent', [{ executionId: 'e-1', type: 'v2.stage.failed', stageInstanceId: null }]],
      [
        'recordSensorRun',
        [{ executionId: 'e-1', stageInstanceId: OWN, sensorId: 's', result: 'PASS' }],
      ],
      [
        'putReceipt',
        [{ executionId: 'e-1', kind: 'summary-confirmation', stageInstanceId: OWN, attempt: 0 }],
      ],
      ['updateExecution', [{ executionId: 'e-1', status: 'RUNNING', ownership: leg(OWN) }]],
      [
        'supersedeHumanTask',
        [{ executionId: 'e-1', humanTaskId: 'h-own', supersededBy: 'x', ownership: leg(OWN) }],
      ],
      [
        'claimStageAttempt',
        [{ executionId: 'e-1', ownership: leg(OWN), stageId: 'requirements-analysis' }],
      ],
      [
        'markSteeringConsumed',
        [{ executionId: 'e-1', steerId: 'st', createdAt: 't', stageInstanceId: OWN }],
      ],
    ]) {
      const { response } = await call(STAGE_GRANT, method, args);
      expect(response.error?.name, method).not.toBe('EngineDataAccessDenied');
    }
  });

  it('allows execution-wide reads, including other stages', async () => {
    for (const [method, args] of [
      ['getExecution', ['e-1', { consistentRead: true }]],
      ['getStage', ['e-1', OTHER, { consistentRead: true }]],
      ['listReceipts', ['e-1', { stageInstanceId: OTHER }]],
      ['listSensorRuns', ['e-1', { stageInstanceId: OTHER }]],
      ['listEvents', ['e-1']],
      ['getHumanTask', ['e-1', 'h-other']],
      ['getUnitPlan', ['e-1']],
    ]) {
      const { response } = await call(STAGE_GRANT, method, args);
      expect(response, method).toMatchObject({ ok: true });
    }
  });

  it.each([
    [
      'updateStageState',
      { executionId: 'e-1', stageInstanceId: OTHER, state: 'FAILED', ownership: leg(OTHER) },
    ],
    [
      'putStage',
      {
        executionId: 'e-1',
        stageInstanceId: OTHER,
        stageId: 'application-design',
        ownership: leg(OTHER),
      },
    ],
    ['resumeStageRow', { executionId: 'e-1', stageInstanceId: OTHER, ownership: leg(OTHER) }],
    ['appendEvent', { executionId: 'e-1', type: 'x', stageInstanceId: OTHER }],
    ['appendOutput', { executionId: 'e-1', stageInstanceId: OTHER, content: 'x' }],
    ['recordMetric', { executionId: 'e-1', stageInstanceId: OTHER, metrics: {} }],
    [
      'recordSensorRun',
      { executionId: 'e-1', stageInstanceId: OTHER, sensorId: 's', result: 'FAIL' },
    ],
    [
      'putReceipt',
      { executionId: 'e-1', kind: 'summary-confirmation', stageInstanceId: OTHER, attempt: 0 },
    ],
    [
      'createHumanTask',
      { executionId: 'e-1', stageInstanceId: OTHER, kind: 'question', ownership: leg(OWN) },
    ],
    ['markLoopBackArchived', { executionId: 'e-1', stageInstanceId: OTHER, loopBackId: 'lb' }],
    [
      'markSteeringConsumed',
      { executionId: 'e-1', steerId: 'st', createdAt: 't', stageInstanceId: OTHER },
    ],
    [
      'claimStageAttempt',
      { executionId: 'e-1', ownership: leg(OWN), stageId: 'application-design' },
    ],
    [
      'updateStageState',
      { executionId: 'e-1', stageInstanceId: OWN, state: 'RUNNING', ownership: leg(OTHER) },
    ],
    [
      'supersedeHumanTask',
      { executionId: 'e-1', humanTaskId: 'h-other', supersededBy: 'x', ownership: leg(OWN) },
    ],
  ])('denies a stage-A grant %s naming stage B', async (method, input) => {
    const { response } = await call(STAGE_GRANT, method, [input]);
    expect(response.error).toMatchObject({ name: 'EngineDataAccessDenied' });
    expect(writes()).toHaveLength(0);
  });

  it.each([
    ['another unit', { unitSlug: 'web' }],
    ['another section', { sectionIndex: 1 }],
    ['no lane', { unitSlug: null }],
  ])('denies a lane grant writing for %s', async (_label, lane) => {
    const { response } = await call(LANE_GRANT, 'appendEvent', [
      {
        executionId: 'e-1',
        type: 'x',
        stageInstanceId: LANE,
        unitSlug: 'api',
        sectionIndex: 0,
        ...lane,
      },
    ]);
    expect(response.error).toMatchObject({ code: 'scope_mismatch' });
    const own = await call(LANE_GRANT, 'appendEvent', [
      { executionId: 'e-1', type: 'x', stageInstanceId: LANE, unitSlug: 'api', sectionIndex: 0 },
    ]);
    expect(own.response).toMatchObject({ ok: true });
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['another run', { ...leg(OWN), orchestratorRunId: 'run-0' }],
    ['another callback', { ...leg(OWN), stageCallbackId: 'cb-0' }],
  ])('denies an attempt-fenced write whose ownership is %s', async (_label, ownership) => {
    const { response } = await call(STAGE_GRANT, 'updateStageState', [
      { executionId: 'e-1', stageInstanceId: OWN, state: 'SUCCEEDED', ownership },
    ]);
    expect(response.error).toMatchObject({ code: 'ownership_mismatch' });
    expect(writes()).toHaveLength(0);
  });

  it('denies a leg the grant did not sign and ownership a legless grant cannot prove', async () => {
    const legless = { ...STAGE_GRANT, stageCallbackId: null, orchestratorRunId: null };
    expect(
      (
        await call(legless, 'updateStageState', [
          { executionId: 'e-1', stageInstanceId: OWN, state: 'SUCCEEDED', ownership: leg(OWN) },
        ])
      ).response.error,
    ).toMatchObject({ code: 'ownership_mismatch' });
    expect(
      (
        await call(legless, 'updateStageState', [
          { executionId: 'e-1', stageInstanceId: OWN, state: 'SUCCEEDED' },
        ])
      ).response,
    ).toMatchObject({ ok: true });
    expect(
      (
        await call(STAGE_GRANT, 'putStage', [
          {
            executionId: 'e-1',
            stageInstanceId: OWN,
            stageCallbackId: 'cb-0',
            ownership: leg(OWN),
          },
        ])
      ).response.error,
    ).toMatchObject({ code: 'scope_mismatch' });
  });

  it.each([
    'putUnitPlan',
    'syncUnitRows',
    'updateCompose',
    'putWorkflowCheckpoint',
    'createExecution',
    'updateQuorumEdit',
    'setLoopBackRecommendation',
    'recordGraphRead',
  ])('leaves %s to execution grants', async (method) => {
    const { response } = await call(STAGE_GRANT, method, CALLS[method]);
    expect(response.error).toMatchObject({ name: 'EngineDataAccessDenied' });
  });

  it('raises a checkpoint repair counter on its own stage only', async () => {
    const raise = (stageInstanceId, field = 'summaryRepairAttempts') =>
      call(STAGE_GRANT, 'raiseStageCounter', [
        { executionId: 'e-1', stageInstanceId, field, to: 1 },
      ]);
    const counterWrites = () =>
      ddb
        .commandCalls(UpdateCommand)
        .filter((c) => c.args[0].input.ExpressionAttributeNames?.['#f'] !== undefined);

    expect((await raise(OWN)).response).toMatchObject({ ok: true, result: true });
    expect(counterWrites().map((c) => c.args[0].input.Key.sk)).toEqual([`STAGE#${OWN}`]);

    expect((await raise(OTHER)).response.error).toMatchObject({ code: 'scope_mismatch' });
    // The store's counter-field allowlist still applies behind the gateway.
    expect((await raise(OWN, 'attempt')).response.error).toMatchObject({
      message: expect.stringMatching(/unknown counter field/),
    });
    expect(counterWrites()).toHaveLength(1);
  });

  it('denies stage writes for an execution with no workflow pin', async () => {
    seed(items());
    const { response } = await call(STAGE_GRANT, 'appendEvent', [
      { executionId: 'e-1', type: 'x' },
    ]);
    expect(response.error).toMatchObject({ code: 'scope_mismatch' });
  });

  it('leaves execution grants unbound', async () => {
    const { response } = await call(EXECUTION, 'updateStageState', [
      { executionId: 'e-1', stageInstanceId: OTHER, state: 'FAILED' },
    ]);
    expect(response).toMatchObject({ ok: true });
  });
});
