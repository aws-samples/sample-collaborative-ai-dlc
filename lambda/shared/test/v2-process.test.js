import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  executionMetaKey,
  stageKey,
  humanTaskKey,
  steeringKey,
  buildExecutionMeta,
  buildStageRow,
  buildHumanTaskRow,
  buildSteeringRow,
  executionTypeStateIndex,
  HUMAN_TASK_STATUSES,
  STEERING_KINDS,
  STEERING_STATUSES,
} from '../v2-process-keys.js';
import { createProcessStore } from '../v2-process-store.js';

describe('v2-process-keys', () => {
  it('namespaces every record under EXEC#<id>', () => {
    expect(executionMetaKey('e1')).toEqual({ pk: 'EXEC#e1', sk: 'META' });
    expect(stageKey('e1', 'si-1')).toEqual({ pk: 'EXEC#e1', sk: 'STAGE#si-1' });
    expect(humanTaskKey('e1', 'h1')).toEqual({ pk: 'EXEC#e1', sk: 'HUMAN#h1' });
  });

  it('projects GSI1 for project-status browse and GSI2 for type/state', () => {
    const meta = buildExecutionMeta({
      executionId: 'e1',
      projectId: 'p1',
      intentId: 'i1',
      status: 'RUNNING',
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(meta.GSI1PK).toBe('PROJECT#p1');
    expect(meta.GSI1SK).toBe('STATUS#RUNNING#STARTED#2026-01-01T00:00:00.000Z#EXEC#e1');
    expect(meta.GSI2SK).toBe('TYPE#EXECUTION#STATE#RUNNING#META');
  });

  it('stamps a stage row with startedAt only when RUNNING', () => {
    const running = buildStageRow({
      executionId: 'e1',
      stageInstanceId: 'si-1',
      stageId: 'req',
      state: 'RUNNING',
      now: 'T',
    });
    expect(running.startedAt).toBe('T');
    const pending = buildStageRow({
      executionId: 'e1',
      stageInstanceId: 'si-1',
      stageId: 'req',
      now: 'T',
    });
    expect(pending.startedAt).toBeNull();
  });

  it('carries the CLI session linkage (null by default) for park/resume', () => {
    const fresh = buildStageRow({ executionId: 'e1', stageInstanceId: 'si-1', now: 'T' });
    expect(fresh).toMatchObject({ cli: null, cliSessionId: null });
    const linked = buildStageRow({
      executionId: 'e1',
      stageInstanceId: 'si-1',
      cli: 'claude',
      cliSessionId: 'sess-7',
      now: 'T',
    });
    expect(linked).toMatchObject({ cli: 'claude', cliSessionId: 'sess-7' });
  });

  it('builds a question human-task carrying the structured payload', () => {
    const row = buildHumanTaskRow({
      executionId: 'e1',
      humanTaskId: 'h1',
      kind: 'question',
      questions: '[{"text":"?"}]',
      now: 'T',
    });
    expect(row).toMatchObject({
      type: 'HumanTask',
      kind: 'question',
      status: 'pending',
      questions: '[{"text":"?"}]',
    });
    expect(row.GSI2SK).toBe('TYPE#HUMAN#STATE#pending#h1');
  });
});

describe('createProcessStore', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  let store;
  beforeEach(() => {
    ddb.reset();
    let n = 0;
    store = createProcessStore({
      ddb,
      tableName: 'v2-proc',
      clock: () => 'T',
      ids: () => `id-${++n}`,
    });
  });

  it('createExecution writes META guarded against overwrite', async () => {
    ddb.on(PutCommand).resolves({});
    await store.createExecution({
      executionId: 'e1',
      projectId: 'p1',
      intentId: 'i1',
      status: 'CREATED',
      workflowId: 'w',
      workflowVersion: 1,
    });
    const call = ddb.commandCalls(PutCommand)[0].args[0].input;
    expect(call.Item.sk).toBe('META');
    expect(call.ConditionExpression).toContain('attribute_not_exists(pk)');
  });

  it('updateExecution sets status + re-stamps both indexes', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { status: 'RUNNING' } });
    await store.updateExecution({
      executionId: 'e1',
      projectId: 'p1',
      status: 'RUNNING',
      startedAt: 'T',
      currentStage: 'req',
    });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues[':status']).toBe('RUNNING');
    expect(input.ExpressionAttributeValues[':g1pk']).toBe('PROJECT#p1');
    expect(input.ExpressionAttributeValues[':cs']).toBe('req');
  });

  it('updateExecution back-fills GSI1 from META when a runtime caller omits projectId/startedAt', async () => {
    // process-bridge (park→WAITING) and run-stage only have executionId in scope.
    // The GSI1 re-stamp must still resolve projectId/startedAt (both immutable) from
    // the existing META row — otherwise the row lands at PROJECT#undefined /
    // STARTED#undefined and vanishes from listProjectExecutions.
    ddb
      .on(GetCommand)
      .resolves({ Item: { projectId: 'p1', startedAt: '2026-01-01T00:00:00.000Z' } });
    ddb.on(UpdateCommand).resolves({ Attributes: { status: 'WAITING' } });
    await store.updateExecution({ executionId: 'e1', status: 'WAITING' });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues[':g1pk']).toBe('PROJECT#p1');
    expect(input.ExpressionAttributeValues[':g1sk']).toBe(
      'STATUS#WAITING#STARTED#2026-01-01T00:00:00.000Z#EXEC#e1',
    );
  });

  it('updateStageState patches state + GSI2 + terminal completedAt', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: {} });
    await store.updateStageState({
      executionId: 'e1',
      stageInstanceId: 'si-1',
      state: 'SUCCEEDED',
      completedAt: true,
    });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues[':state']).toBe('SUCCEEDED');
    expect(input.ExpressionAttributeValues[':g2sk']).toBe(
      executionTypeStateIndex({ executionId: 'e1', type: 'STAGE', state: 'SUCCEEDED', id: 'si-1' })
        .GSI2SK,
    );
    expect(input.ExpressionAttributeValues[':ca']).toBe('T');
  });

  it('answerHumanTask is a CAS on pending and returns null on a lost race', async () => {
    ddb
      .on(UpdateCommand)
      .rejects(Object.assign(new Error('cas'), { name: 'ConditionalCheckFailedException' }));
    const res = await store.answerHumanTask({
      executionId: 'e1',
      humanTaskId: 'h1',
      status: 'answered',
      answer: {},
    });
    expect(res).toBeNull();
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ConditionExpression).toBe('#status = :pending');
  });

  it('getExecutionRecords groups rows by SK prefix', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        { sk: 'META' },
        { sk: 'STAGE#si-1' },
        { sk: 'EVENT#T#1' },
        { sk: 'HUMAN#h1' },
        { sk: 'METRIC#T#1' },
      ],
    });
    const grouped = await store.getExecutionRecords('e1');
    expect(grouped.meta).toEqual({ sk: 'META' });
    expect(grouped.stages).toHaveLength(1);
    expect(grouped.events).toHaveLength(1);
    expect(grouped.humanTasks).toHaveLength(1);
    expect(grouped.metrics).toHaveLength(1);
  });

  it('recordMetric stores the numeric bag', async () => {
    ddb.on(PutCommand).resolves({});
    await store.recordMetric({
      executionId: 'e1',
      stageInstanceId: 'si-1',
      metrics: { tokensInput: 10, contextWindowPct: 42 },
    });
    const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item;
    expect(item.metrics).toEqual({ tokensInput: 10, contextWindowPct: 42 });
    expect(item.sk).toMatch(/^METRIC#T#id-/);
  });

  it('listProjectExecutions queries GSI1 newest-first, optionally by status', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ sk: 'META', executionId: 'e1' }] });
    const all = await store.listProjectExecutions({ projectId: 'p1' });
    expect(all).toHaveLength(1);
    const input = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.IndexName).toBe('GSI1');
    expect(input.ExpressionAttributeValues[':pk']).toBe('PROJECT#p1');
    expect(input.ScanIndexForward).toBe(false);

    ddb.reset();
    ddb.on(QueryCommand).resolves({ Items: [] });
    await store.listProjectExecutions({ projectId: 'p1', status: 'DRAFT' });
    const byStatus = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(byStatus.KeyConditionExpression).toContain('begins_with(GSI1SK, :sk)');
    expect(byStatus.ExpressionAttributeValues[':sk']).toBe('STATUS#DRAFT#');
  });

  it('patchExecutionConfig only sets supplied intent-config fields', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: {} });
    await store.patchExecutionConfig({
      executionId: 'e1',
      prompt: 'do the thing',
      branch: 'aidlc/i1',
    });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues[':prompt']).toBe('do the thing');
    expect(input.ExpressionAttributeValues[':branch']).toBe('aidlc/i1');
    expect(input.ExpressionAttributeValues[':baseBranch']).toBeUndefined();
    expect(input.UpdateExpression).toContain('prompt = :prompt');
  });

  it('setGateCallbackId stamps the durable callbackId on the gate row', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { callbackId: 'cb-1' } });
    await store.setGateCallbackId({ executionId: 'e1', humanTaskId: 'h1', callbackId: 'cb-1' });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.Key).toEqual(humanTaskKey('e1', 'h1'));
    expect(input.ExpressionAttributeValues[':cb']).toBe('cb-1');
    expect(input.UpdateExpression).toContain('callbackId = :cb');
  });
});

describe('buildExecutionMeta intent-config + DRAFT', () => {
  it('carries prompt/branch/baseBranch/repos and supports DRAFT status', () => {
    const meta = buildExecutionMeta({
      executionId: 'e1',
      projectId: 'p1',
      intentId: 'i1',
      status: 'DRAFT',
      workflowId: 'aidlc-v2',
      workflowVersion: 3,
      scope: 'feature',
      startedAt: 'T',
      title: 'My intent',
      prompt: 'Build X',
      branch: 'aidlc/i1',
      baseBranch: 'main',
      repos: ['owner/repo'],
    });
    expect(meta).toMatchObject({
      status: 'DRAFT',
      title: 'My intent',
      prompt: 'Build X',
      branch: 'aidlc/i1',
      baseBranch: 'main',
      repos: ['owner/repo'],
    });
    expect(meta.GSI1SK).toBe('STATUS#DRAFT#STARTED#T#EXEC#e1');
  });

  it('carries cliModels + parkReleaseSeconds (the orchestrator run config)', () => {
    const meta = buildExecutionMeta({
      executionId: 'e1',
      projectId: 'p1',
      intentId: 'i1',
      workflowId: 'w',
      workflowVersion: 1,
      startedAt: 'T',
      agentCli: 'kiro',
      cliModels: { claude: 'us.anthropic.claude-opus-4-8' },
      parkReleaseSeconds: 120,
    });
    expect(meta.agentCli).toBe('kiro');
    expect(meta.cliModels).toEqual({ claude: 'us.anthropic.claude-opus-4-8' });
    expect(meta.parkReleaseSeconds).toBe(120);
  });

  it('defaults the config fields to null when omitted', () => {
    const meta = buildExecutionMeta({
      executionId: 'e1',
      projectId: 'p1',
      intentId: 'i1',
      workflowId: 'w',
      workflowVersion: 1,
      startedAt: 'T',
    });
    expect(meta).toMatchObject({
      title: null,
      prompt: null,
      branch: null,
      baseBranch: null,
      repos: null,
      agentCli: null,
      cliModels: null,
      parkReleaseSeconds: null,
      source: null,
    });
  });

  it('carries an optional tracker source (kick-off provenance)', () => {
    const source = {
      bindingId: 'tb-1',
      provider: 'github-issues',
      instance: 'public',
      resourceType: 'issue',
      resourceId: '42',
      resourceUrl: 'https://github.com/owner/repo/issues/42',
    };
    const meta = buildExecutionMeta({
      executionId: 'e1',
      projectId: 'p1',
      intentId: 'i1',
      workflowId: 'w',
      workflowVersion: 1,
      startedAt: 'T',
      source,
    });
    expect(meta.source).toEqual(source);
  });
});

// ── Steering (docs/v2-steering.md) ──

describe('steering keys + builders', () => {
  it('exposes the steering vocabularies and the superseded gate status', () => {
    expect(STEERING_KINDS).toEqual(['gate-steer', 'revision', 'rewind']);
    expect(STEERING_STATUSES).toEqual(['pending', 'consumed', 'superseded']);
    expect(HUMAN_TASK_STATUSES).toContain('superseded');
  });

  it('sorts STEER rows by creation time under the execution partition', () => {
    expect(steeringKey('e1', 'T', 'st-1')).toEqual({ pk: 'EXEC#e1', sk: 'STEER#T#st-1' });
  });

  it('builds a pending steering row with GSI2 keyed by status', () => {
    const row = buildSteeringRow({
      executionId: 'e1',
      steerId: 'st-1',
      kind: 'gate-steer',
      message: 'stop building REST — use the event bus',
      targetGateId: 'q-1',
      createdBy: 'user-1',
      createdByName: 'Ada',
      now: 'T',
    });
    expect(row).toMatchObject({
      type: 'Steering',
      status: 'pending',
      kind: 'gate-steer',
      targetGateId: 'q-1',
      targetStageId: null,
      consumedAt: null,
      supersededAt: null,
    });
    expect(row.GSI2SK).toBe('TYPE#STEER#STATE#pending#st-1');
  });

  it('META carries the orchestrator ownership token + rewind marker (null by default)', () => {
    const meta = buildExecutionMeta({
      executionId: 'e1',
      projectId: 'p1',
      intentId: 'i1',
      workflowId: 'w',
      workflowVersion: 1,
      startedAt: 'T',
    });
    expect(meta.orchestratorRunId).toBeNull();
    expect(meta.rewindFromStageId).toBeNull();
  });
});

describe('steering store methods', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  let store;
  beforeEach(() => {
    ddb.reset();
    let n = 0;
    store = createProcessStore({
      ddb,
      tableName: 'v2-proc',
      clock: () => 'T',
      ids: () => `id-${++n}`,
    });
  });

  it('createSteering writes an immutable pending row (guarded against overwrite)', async () => {
    ddb.on(PutCommand).resolves({});
    const row = await store.createSteering({
      executionId: 'e1',
      kind: 'rewind',
      message: 'redo the design event-driven',
      targetStageId: 'design',
    });
    expect(row.steerId).toBe('st-id-1');
    const input = ddb.commandCalls(PutCommand)[0].args[0].input;
    expect(input.Item.sk).toBe('STEER#T#st-id-1');
    expect(input.ConditionExpression).toContain('attribute_not_exists(pk)');
  });

  it('listPendingSteering queries GSI2 by TYPE#STEER#STATE#pending', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ sk: 'STEER#T#st-1', steerId: 'st-1' }] });
    const rows = await store.listPendingSteering('e1');
    expect(rows).toHaveLength(1);
    const input = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.IndexName).toBe('GSI2');
    expect(input.ExpressionAttributeValues[':p']).toBe('TYPE#STEER#STATE#pending#');
  });

  it('markSteeringConsumed is a CAS on pending; a lost race returns null', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { status: 'consumed' } });
    await store.markSteeringConsumed({
      executionId: 'e1',
      steerId: 'st-1',
      createdAt: 'T',
      stageInstanceId: 'si-1',
    });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.Key).toEqual(steeringKey('e1', 'T', 'st-1'));
    expect(input.ConditionExpression).toBe('#status = :pending');
    expect(input.ExpressionAttributeValues[':sid']).toBe('si-1');
    expect(input.ExpressionAttributeValues[':g2sk']).toBe('TYPE#STEER#STATE#consumed#st-1');

    ddb.reset();
    ddb
      .on(UpdateCommand)
      .rejects(Object.assign(new Error('cas'), { name: 'ConditionalCheckFailedException' }));
    const res = await store.markSteeringConsumed({
      executionId: 'e1',
      steerId: 'st-1',
      createdAt: 'T',
    });
    expect(res).toBeNull();
  });

  it('supersedeHumanTask retires ONLY a pending gate (CAS)', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { status: 'superseded' } });
    await store.supersedeHumanTask({ executionId: 'e1', humanTaskId: 'h1', supersededBy: 'st-1' });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ConditionExpression).toBe('#status = :pending');
    expect(input.ExpressionAttributeValues[':status']).toBe('superseded');
    expect(input.ExpressionAttributeValues[':g2sk']).toBe('TYPE#HUMAN#STATE#superseded#h1');

    ddb.reset();
    ddb
      .on(UpdateCommand)
      .rejects(Object.assign(new Error('cas'), { name: 'ConditionalCheckFailedException' }));
    const res = await store.supersedeHumanTask({ executionId: 'e1', humanTaskId: 'h1' });
    expect(res).toBeNull();
  });

  it('markGateRevised stamps the revision marker on a NON-pending gate only', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { revisedAt: 'T' } });
    await store.markGateRevised({ executionId: 'e1', humanTaskId: 'h1', steerId: 'st-1' });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ConditionExpression).toContain('#status <> :pending');
    expect(input.ExpressionAttributeValues[':sid']).toBe('st-1');
    expect(input.UpdateExpression).toContain('revisedAt = :ts');
  });

  it('resetStageRow flips a stage back to PENDING with attempt+1 and a cleared session', async () => {
    ddb.on(GetCommand).resolves({ Item: { stageInstanceId: 'si-1', attempt: 1, cli: 'claude' } });
    ddb.on(UpdateCommand).resolves({ Attributes: { state: 'PENDING', attempt: 2 } });
    const reset = await store.resetStageRow({ executionId: 'e1', stageInstanceId: 'si-1' });
    expect(reset).toMatchObject({ state: 'PENDING', attempt: 2 });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues[':state']).toBe('PENDING');
    expect(input.ExpressionAttributeValues[':attempt']).toBe(2);
    expect(input.UpdateExpression).toContain('cliSessionId = :null');
    expect(input.ExpressionAttributeValues[':g2sk']).toBe('TYPE#STAGE#STATE#PENDING#si-1');
  });

  it('resetStageRow is a no-op (null) for a stage that never ran', async () => {
    ddb.on(GetCommand).resolves({});
    const reset = await store.resetStageRow({ executionId: 'e1', stageInstanceId: 'si-x' });
    expect(reset).toBeNull();
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('updateExecution supports the orchestrator ownership CAS (ifOrchestratorRunId)', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { status: 'SUCCEEDED' } });
    await store.updateExecution({
      executionId: 'e1',
      projectId: 'p1',
      status: 'SUCCEEDED',
      startedAt: 'T',
      ifOrchestratorRunId: 'run-1',
    });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ConditionExpression).toBe('orchestratorRunId = :ifOrid');
    expect(input.ExpressionAttributeValues[':ifOrid']).toBe('run-1');
  });

  it('getExecutionRecords groups STEER rows', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ sk: 'META' }, { sk: 'STEER#T#st-1' }] });
    const grouped = await store.getExecutionRecords('e1');
    expect(grouped.steering).toHaveLength(1);
  });
});
