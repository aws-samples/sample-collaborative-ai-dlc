import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  executionMetaKey,
  stageKey,
  humanTaskKey,
  buildExecutionMeta,
  buildStageRow,
  buildHumanTaskRow,
  executionTypeStateIndex,
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
    });
  });
});
