import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  BatchWriteCommand,
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
  unitPlanKey,
  unitKey,
  buildExecutionMeta,
  buildStageRow,
  buildEventRow,
  buildHumanTaskRow,
  buildOutputRow,
  buildMetricRow,
  buildSensorRow,
  buildSteeringRow,
  buildUnitPlanRow,
  buildUnitRow,
  executionTypeStateIndex,
  HUMAN_TASK_STATUSES,
  STEERING_KINDS,
  STEERING_STATUSES,
  UNIT_STATES,
  CONSTRUCTION_AUTONOMY_MODES,
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

  it('updateStageState stamps parkedAt on a park (human-wait accounting)', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: {} });
    await store.updateStageState({
      executionId: 'e1',
      stageInstanceId: 'si-1',
      state: 'WAITING_FOR_HUMAN',
      parkedAt: true,
    });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.UpdateExpression).toContain('parkedAt = :pa');
    expect(input.ExpressionAttributeValues[':pa']).toBe('T');
  });

  it('updateStageState leaves parkedAt untouched when not supplied', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: {} });
    await store.updateStageState({ executionId: 'e1', stageInstanceId: 'si-1', state: 'RUNNING' });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.UpdateExpression).not.toContain('parkedAt');
  });

  it('resumeStageRow folds the open park window into waitMs, clears parkedAt, preserves startedAt/attempt', async () => {
    // A resume PATCHES the parked row — rebuilding it (putStage) was the
    // "stage duration resets when a question is answered" bug.
    const isoStore = createProcessStore({
      ddb,
      tableName: 'v2-proc',
      clock: () => '2026-01-01T00:10:00.000Z',
    });
    ddb.on(GetCommand).resolves({
      Item: {
        startedAt: '2026-01-01T00:00:00.000Z',
        parkedAt: '2026-01-01T00:04:00.000Z', // parked 6 min before the resume
        waitMs: 30_000, // an earlier park/resume cycle
        attempt: 2,
      },
    });
    ddb.on(UpdateCommand).resolves({ Attributes: {} });
    await isoStore.resumeStageRow({
      executionId: 'e1',
      stageInstanceId: 'si-1',
      cli: 'claude',
      cliSessionId: 'sess-1',
      stageCallbackId: 'cb-2',
    });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues[':state']).toBe('RUNNING');
    // 30s prior + 6min open window = 390s.
    expect(input.ExpressionAttributeValues[':wait']).toBe(390_000);
    expect(input.UpdateExpression).toContain('parkedAt = :null');
    // The patch never touches first-start or attempt bookkeeping.
    expect(input.UpdateExpression).not.toContain('startedAt');
    expect(input.UpdateExpression).not.toContain('attempt');
    expect(input.ExpressionAttributeValues[':csid']).toBe('sess-1');
    expect(input.ExpressionAttributeValues[':scb']).toBe('cb-2');
  });

  it('resumeStageRow tolerates a missing/unparsable park stamp (waitMs unchanged, no NaN)', async () => {
    ddb.on(GetCommand).resolves({ Item: { waitMs: 12_000, parkedAt: null } });
    ddb.on(UpdateCommand).resolves({ Attributes: {} });
    await store.resumeStageRow({ executionId: 'e1', stageInstanceId: 'si-1' });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues[':wait']).toBe(12_000);
  });

  it('resetStageRow clears the wait accounting for the next attempt', async () => {
    ddb.on(GetCommand).resolves({ Item: { attempt: 0, waitMs: 9000, parkedAt: 'T' } });
    ddb.on(UpdateCommand).resolves({ Attributes: {} });
    await store.resetStageRow({ executionId: 'e1', stageInstanceId: 'si-1' });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.UpdateExpression).toContain('parkedAt = :null');
    expect(input.UpdateExpression).toContain('waitMs = :zero');
    expect(input.ExpressionAttributeValues[':zero']).toBe(0);
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

  it('listEvents queries the EVENT# prefix time-ordered and drains pagination', async () => {
    // The PR fan-in reads this to detect recorded git activity — a dropped
    // page could hide a push failure (the 2026-07 lost-work signal).
    ddb
      .on(QueryCommand)
      .resolvesOnce({
        Items: [{ sk: 'EVENT#T1#a', eventType: 'v2.git.push_failed' }],
        LastEvaluatedKey: { pk: 'EXEC#e1', sk: 'EVENT#T1#a' },
      })
      .resolvesOnce({
        Items: [{ sk: 'EVENT#T2#b', eventType: 'v2.pr.skipped' }],
      });
    const events = await store.listEvents('e1');
    expect(events.map((e) => e.eventType)).toEqual(['v2.git.push_failed', 'v2.pr.skipped']);
    const input = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.KeyConditionExpression).toBe('pk = :pk AND begins_with(sk, :p)');
    expect(input.ExpressionAttributeValues[':p']).toBe('EVENT#');
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(2);
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

  it('getExecutionRecords drains every 1MB Query page (STAGE rows sort past OUTPUT)', async () => {
    // The regression: OUTPUT# chunks filled the first 1MB page, LastEvaluatedKey
    // was ignored, and every STAGE# row (sorting after OUTPUT#) vanished — the
    // UI rendered a healthy run as all-PENDING.
    ddb
      .on(QueryCommand)
      .resolvesOnce({
        Items: [{ sk: 'META' }, { sk: 'OUTPUT#000000000001', seq: 1 }],
        LastEvaluatedKey: { pk: 'EXEC#e1', sk: 'OUTPUT#000000000001' },
      })
      .resolvesOnce({
        Items: [{ sk: 'OUTPUT#000000000002', seq: 2 }, { sk: 'STAGE#si-1' }],
      });
    const grouped = await store.getExecutionRecords('e1');
    expect(grouped.meta).toEqual({ sk: 'META' });
    expect(grouped.outputs).toHaveLength(2);
    expect(grouped.stages).toHaveLength(1);
    const calls = ddb.commandCalls(QueryCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1].args[0].input.ExclusiveStartKey).toEqual({
      pk: 'EXEC#e1',
      sk: 'OUTPUT#000000000001',
    });
  });

  it('getExecutionRecords includeOutputs:false skips the OUTPUT# range entirely', async () => {
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ sk: 'META' }, { sk: 'HUMAN#h1' }] })
      .resolvesOnce({ Items: [{ sk: 'STAGE#si-1' }, { sk: 'UNITPLAN' }] });
    const grouped = await store.getExecutionRecords('e1', { includeOutputs: false });
    expect(grouped.meta).toEqual({ sk: 'META' });
    expect(grouped.stages).toHaveLength(1);
    expect(grouped.unitPlan).toEqual({ sk: 'UNITPLAN' });
    expect(grouped.outputs).toHaveLength(0);
    const [below, above] = ddb.commandCalls(QueryCommand).map((c) => c.args[0].input);
    expect(below.KeyConditionExpression).toBe('pk = :pk AND sk < :lo');
    expect(below.ExpressionAttributeValues[':lo']).toBe('OUTPUT#');
    expect(above.KeyConditionExpression).toBe('pk = :pk AND sk >= :hi');
    expect(above.ExpressionAttributeValues[':hi']).toBe('OUTPUT$');
  });

  it('deleteExecution drains the whole partition keys-only and BatchWrite-deletes in chunks of 25', async () => {
    // 30 rows → 2 batches (25 + 5). The Query must be keys-only (OUTPUT# rows
    // can be megabytes the delete never needs).
    const keys = Array.from({ length: 30 }, (_, i) => ({
      pk: 'EXEC#e1',
      sk: `EVENT#T#${String(i).padStart(2, '0')}`,
    }));
    ddb.on(QueryCommand).resolves({ Items: keys });
    ddb.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    const { deleted } = await store.deleteExecution('e1');
    expect(deleted).toBe(30);
    const query = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(query.KeyConditionExpression).toBe('pk = :pk');
    expect(query.ExpressionAttributeValues[':pk']).toBe('EXEC#e1');
    expect(query.ProjectionExpression).toBe('pk, sk');
    const batches = ddb.commandCalls(BatchWriteCommand).map((c) => c.args[0].input);
    expect(batches).toHaveLength(2);
    expect(batches[0].RequestItems['v2-proc']).toHaveLength(25);
    expect(batches[1].RequestItems['v2-proc']).toHaveLength(5);
    expect(batches[0].RequestItems['v2-proc'][0]).toEqual({
      DeleteRequest: { Key: { pk: 'EXEC#e1', sk: 'EVENT#T#00' } },
    });
  });

  it('deleteExecution retries UnprocessedItems until the batch fully lands', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        { pk: 'EXEC#e1', sk: 'META' },
        { pk: 'EXEC#e1', sk: 'STAGE#si-1' },
      ],
    });
    const leftover = [{ DeleteRequest: { Key: { pk: 'EXEC#e1', sk: 'STAGE#si-1' } } }];
    ddb
      .on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: { 'v2-proc': leftover } })
      .resolvesOnce({ UnprocessedItems: {} });
    const { deleted } = await store.deleteExecution('e1');
    expect(deleted).toBe(2);
    const batches = ddb.commandCalls(BatchWriteCommand).map((c) => c.args[0].input);
    expect(batches).toHaveLength(2);
    expect(batches[1].RequestItems['v2-proc']).toEqual(leftover);
  });

  it('deleteExecution is a no-op on an empty partition', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    const { deleted } = await store.deleteExecution('gone');
    expect(deleted).toBe(0);
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('getOutputs filters by stageInstanceId (null → stage-less bucket) and afterSeq', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    await store.getOutputs('e1', { stageInstanceId: 'si-1', afterSeq: 7 });
    let input = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.KeyConditionExpression).toBe('pk = :pk AND begins_with(sk, :p)');
    expect(input.FilterExpression).toBe('(stageInstanceId = :sid) AND (seq > :after)');
    expect(input.ExpressionAttributeValues[':sid']).toBe('si-1');
    expect(input.ExpressionAttributeValues[':after']).toBe(7);

    ddb.reset();
    ddb.on(QueryCommand).resolves({ Items: [] });
    await store.getOutputs('e1', { stageInstanceId: null });
    input = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.FilterExpression).toBe(
      '(attribute_not_exists(stageInstanceId) OR stageInstanceId = :null)',
    );

    ddb.reset();
    ddb.on(QueryCommand).resolves({ Items: [] });
    await store.getOutputs('e1');
    input = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.FilterExpression).toBeUndefined();
  });

  it('getOutputs drains every Query page (transcripts exceed 1MB)', async () => {
    ddb
      .on(QueryCommand)
      .resolvesOnce({
        Items: [{ sk: 'OUTPUT#000000000001', seq: 1 }],
        LastEvaluatedKey: { pk: 'EXEC#e1', sk: 'OUTPUT#000000000001' },
      })
      .resolvesOnce({ Items: [{ sk: 'OUTPUT#000000000002', seq: 2 }] });
    const rows = await store.getOutputs('e1');
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(2);
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

  it('recordGraphRead stores graph read ledger samples', async () => {
    ddb.on(PutCommand).resolves({});
    await store.recordGraphRead({
      executionId: 'e1',
      stageInstanceId: 'si-1',
      tool: 'get_items',
      bytes: 123,
      resultCount: 2,
      args: { itemType: 'Story' },
    });
    const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item;
    expect(item).toMatchObject({
      type: 'GraphRead',
      executionId: 'e1',
      stageInstanceId: 'si-1',
      tool: 'get_items',
      bytes: 123,
      resultCount: 2,
      args: { itemType: 'Story' },
    });
    expect(item.sk).toMatch(/^READ#T#id-/);
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

  it('listProjectExecutions drains 1MB-truncated pages up to `limit` (META rows carry unbounded prompts)', async () => {
    // DynamoDB stops a page at min(Limit, 1MB) — a page can come back with
    // FEWER than `limit` items AND a LastEvaluatedKey. The old single-shot read
    // returned that short page as if it were the whole project.
    ddb
      .on(QueryCommand)
      .resolvesOnce({
        Items: [{ sk: 'META', executionId: 'e1' }],
        LastEvaluatedKey: { pk: 'x', sk: 'y' },
      })
      .resolvesOnce({ Items: [{ sk: 'META', executionId: 'e2' }] });
    const all = await store.listProjectExecutions({ projectId: 'p1', limit: 5 });
    expect(all.map((i) => i.executionId)).toEqual(['e1', 'e2']);
    const calls = ddb.commandCalls(QueryCommand);
    expect(calls).toHaveLength(2);
    // The second page only asks for what is still missing.
    expect(calls[1].args[0].input.Limit).toBe(4);
    expect(calls[1].args[0].input.ExclusiveStartKey).toEqual({ pk: 'x', sk: 'y' });
  });

  it('listProjectExecutions stops paging once `limit` rows have arrived', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [{ sk: 'META', executionId: 'e1' }],
      LastEvaluatedKey: { pk: 'x', sk: 'y' },
    });
    const all = await store.listProjectExecutions({ projectId: 'p1', limit: 1 });
    expect(all).toHaveLength(1);
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(1);
  });

  it('listUnits drains every Query page (lanes must never be invisible to the scheduler)', async () => {
    ddb
      .on(QueryCommand)
      .resolvesOnce({
        Items: [{ sk: 'UNIT#auth', slug: 'auth' }],
        LastEvaluatedKey: { pk: 'x', sk: 'y' },
      })
      .resolvesOnce({ Items: [{ sk: 'UNIT#billing', slug: 'billing' }] });
    const units = await store.listUnits('e1');
    expect(units.map((u) => u.slug)).toEqual(['auth', 'billing']);
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(2);
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
    expect(input.ExpressionAttributeValues[':baseBranches']).toBeUndefined();
    expect(input.UpdateExpression).toContain('prompt = :prompt');
  });

  it('patchExecutionConfig sets baseBranches (per-repo override) when supplied', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: {} });
    await store.patchExecutionConfig({
      executionId: 'e1',
      baseBranches: { 'owner/repo': 'develop' },
    });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues[':baseBranches']).toEqual({ 'owner/repo': 'develop' });
    expect(input.UpdateExpression).toContain('baseBranches = :baseBranches');
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
      baseBranches: { 'owner/web': 'develop' },
      repos: ['owner/repo', 'owner/web'],
    });
    expect(meta).toMatchObject({
      status: 'DRAFT',
      title: 'My intent',
      prompt: 'Build X',
      branch: 'aidlc/i1',
      baseBranch: 'main',
      baseBranches: { 'owner/web': 'develop' },
      repos: ['owner/repo', 'owner/web'],
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
      deriveEnrichment: 'llm',
      parkReleaseSeconds: 120,
    });
    expect(meta.agentCli).toBe('kiro');
    expect(meta.cliModels).toEqual({ claude: 'us.anthropic.claude-opus-4-8' });
    expect(meta.deriveEnrichment).toBe('llm');
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
      baseBranches: null,
      repos: null,
      agentCli: null,
      cliModels: null,
      deriveEnrichment: null,
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

// ── WP3: unit-of-work promotion data model (docs/v2-parallel.md) ──

describe('unit keys + builders', () => {
  it('UNITPLAN is a singleton SK; UNIT#<slug> per lane (no prefix collision)', () => {
    expect(unitPlanKey('e1')).toEqual({ pk: 'EXEC#e1', sk: 'UNITPLAN' });
    expect(unitKey('e1', 'auth')).toEqual({ pk: 'EXEC#e1', sk: 'UNIT#auth' });
  });

  it('buildUnitPlanRow freezes the scheduling snapshot with decision defaults', () => {
    const row = buildUnitPlanRow({
      executionId: 'e1',
      units: [
        { slug: 'auth', dependsOn: [] },
        { slug: 'checkout', dependsOn: ['auth'] },
      ],
      batches: [['auth'], ['checkout']],
      sourceArtifactId: 'art-1',
      producedByStageInstanceId: 'si-units',
      walkingSkeleton: 'auth',
      now: 'T',
    });
    expect(row.sk).toBe('UNITPLAN');
    expect(row.type).toBe('UnitPlan');
    expect(row.unitCount).toBe(2);
    expect(row.skipMatrix).toEqual({});
    expect(row.walkingSkeleton).toBe('auth');
    expect(row.autonomyMode).toBeNull();
    expect(row.GSI2SK).toBe('TYPE#UNITPLAN#STATE#ACTIVE#UNITPLAN');
    expect(row.promotedAt).toBe('T');
  });

  it('buildUnitRow starts a lane PENDING with GSI2 keyed on the lane state', () => {
    const row = buildUnitRow({
      executionId: 'e1',
      slug: 'checkout',
      dependsOn: ['auth', 'catalog'],
      batchIndex: 1,
      now: 'T',
    });
    expect(row.sk).toBe('UNIT#checkout');
    expect(row.type).toBe('Unit');
    expect(row.state).toBe('PENDING');
    expect(row.dependsOn).toEqual(['auth', 'catalog']);
    expect(row.GSI2SK).toBe('TYPE#UNIT#STATE#PENDING#checkout');
    expect(row.branch).toBeNull();
    expect(row.mergedAt).toBeNull();
  });

  it('exports the lane-state and autonomy vocabularies', () => {
    expect(UNIT_STATES).toEqual([
      'PENDING',
      'READY',
      'RUNNING',
      'MERGING',
      'MERGED',
      'FAILED',
      'BLOCKED',
    ]);
    expect(CONSTRUCTION_AUTONOMY_MODES).toEqual(['gated', 'autonomous']);
  });
});

describe('unit store methods', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  let store;
  beforeEach(() => {
    ddb.reset();
    store = createProcessStore({ ddb, tableName: 'v2-proc', clock: () => 'T' });
  });

  it('putUnitPlan is a plain snapshot put (re-promotion replaces it)', async () => {
    ddb.on(PutCommand).resolves({});
    const row = await store.putUnitPlan({
      executionId: 'e1',
      units: [{ slug: 'auth', dependsOn: [] }],
      batches: [['auth']],
    });
    expect(row.sk).toBe('UNITPLAN');
    const input = ddb.commandCalls(PutCommand)[0].args[0].input;
    expect(input.ConditionExpression).toBeUndefined();
  });

  it('listUnits queries the exact UNIT# prefix (never matches UNITPLAN)', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ sk: 'UNIT#auth', slug: 'auth' }] });
    const rows = await store.listUnits('e1');
    expect(rows).toHaveLength(1);
    const input = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues[':p']).toBe('UNIT#');
  });

  it('syncUnitRows creates missing lanes, refreshes PENDING/READY, preserves active, reports orphans', async () => {
    // Existing: auth (RUNNING — must be preserved), catalog (PENDING — updated),
    // legacy (PENDING — orphaned: not in the new DAG).
    ddb.on(QueryCommand).resolves({
      Items: [
        { sk: 'UNIT#auth', slug: 'auth', state: 'RUNNING' },
        { sk: 'UNIT#catalog', slug: 'catalog', state: 'PENDING' },
        { sk: 'UNIT#legacy', slug: 'legacy', state: 'PENDING' },
      ],
    });
    ddb.on(PutCommand).resolves({});
    ddb.on(UpdateCommand).resolves({ Attributes: {} });
    const res = await store.syncUnitRows({
      executionId: 'e1',
      units: [
        { slug: 'auth', dependsOn: [] },
        { slug: 'catalog', dependsOn: ['auth'] },
        { slug: 'payments', dependsOn: [] },
      ],
      batches: [['auth', 'payments'], ['catalog']],
    });
    expect(res).toEqual({
      created: ['payments'],
      updated: ['catalog'],
      preserved: ['auth'],
      orphaned: ['legacy'],
    });
    // The created row is a fresh PENDING lane in wave 0.
    const put = ddb.commandCalls(PutCommand)[0].args[0].input;
    expect(put.Item).toMatchObject({ sk: 'UNIT#payments', state: 'PENDING', batchIndex: 0 });
    // The refreshed row re-derives deps + resets to PENDING.
    const upd = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.Key).toEqual(unitKey('e1', 'catalog'));
    expect(upd.ExpressionAttributeValues[':deps']).toEqual(['auth']);
    expect(upd.ExpressionAttributeValues[':state']).toBe('PENDING');
    // The RUNNING lane was never written.
    const touched = [
      ...ddb.commandCalls(PutCommand).map((c) => c.args[0].input.Item?.sk),
      ...ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input.Key?.sk),
    ];
    expect(touched).not.toContain('UNIT#auth');
  });

  it('updateUnitState CASes on fromStates and re-stamps GSI2; a lost race returns null', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { state: 'RUNNING' } });
    await store.updateUnitState({
      executionId: 'e1',
      slug: 'auth',
      state: 'RUNNING',
      fromStates: ['READY'],
      fields: { startedAt: true, sessionId: 's-1', branch: 'ai-dlc/i1--unit-auth' },
    });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ConditionExpression).toBe('#state IN (:from0)');
    expect(input.ExpressionAttributeValues[':from0']).toBe('READY');
    expect(input.ExpressionAttributeValues[':g2sk']).toBe('TYPE#UNIT#STATE#RUNNING#auth');
    expect(input.ExpressionAttributeValues[':f_startedAt']).toBe('T'); // true → now
    expect(input.ExpressionAttributeValues[':f_branch']).toBe('ai-dlc/i1--unit-auth');

    ddb.reset();
    ddb
      .on(UpdateCommand)
      .rejects(Object.assign(new Error('cas'), { name: 'ConditionalCheckFailedException' }));
    const lost = await store.updateUnitState({
      executionId: 'e1',
      slug: 'auth',
      state: 'RUNNING',
      fromStates: ['READY'],
    });
    expect(lost).toBeNull();
  });

  it('updateUnitState refuses an unknown lane state', async () => {
    await expect(
      store.updateUnitState({ executionId: 'e1', slug: 'auth', state: 'DONE' }),
    ).rejects.toThrow('invalid unit state');
  });

  it('updateUnitPlanDecisions patches only the supplied decision fields on an existing plan', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { autonomyMode: 'autonomous' } });
    await store.updateUnitPlanDecisions({ executionId: 'e1', autonomyMode: 'autonomous' });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.Key).toEqual(unitPlanKey('e1'));
    expect(input.UpdateExpression).toContain('autonomyMode = :am');
    expect(input.UpdateExpression).not.toContain('skipMatrix');
    expect(input.ConditionExpression).toBe('attribute_exists(pk)');
  });

  it('getExecutionRecords groups UNITPLAN + UNIT rows', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [{ sk: 'META' }, { sk: 'UNITPLAN' }, { sk: 'UNIT#auth' }, { sk: 'UNIT#catalog' }],
    });
    const grouped = await store.getExecutionRecords('e1');
    expect(grouped.unitPlan).toEqual({ sk: 'UNITPLAN' });
    expect(grouped.units).toHaveLength(2);
    // UNITPLAN never leaks into the units list.
    expect(grouped.units.map((r) => r.sk)).toEqual(['UNIT#auth', 'UNIT#catalog']);
  });
});

// ── WP4: the unit dimension on stage-scoped rows (docs/v2-parallel.md) ───────
// Every row a unit lane writes must be attributable to its lane; rows written
// outside a lane default to unitSlug null so existing writers are untouched.

describe('unit dimension on row builders', () => {
  const base = { executionId: 'e1', now: 'T' };

  it('defaults unitSlug to null on every stage-scoped builder', () => {
    expect(buildStageRow({ ...base, stageInstanceId: 'si-1' }).unitSlug).toBeNull();
    expect(
      buildEventRow({ ...base, type: 'v2.x', actor: 'engine', eventId: 'ev1' }).unitSlug,
    ).toBeNull();
    expect(buildHumanTaskRow({ ...base, humanTaskId: 'h1', kind: 'question' }).unitSlug).toBeNull();
    expect(buildOutputRow({ ...base, seq: 1, content: 'x' }).unitSlug).toBeNull();
    expect(buildMetricRow({ ...base, metricId: 'm1', metrics: {} }).unitSlug).toBeNull();
    expect(
      buildSensorRow({
        ...base,
        sensorRunId: 's1',
        sensorId: 'lint',
        kind: 'script',
        severity: 'advisory',
        result: 'PASS',
      }).unitSlug,
    ).toBeNull();
  });

  it('carries unitSlug when supplied', () => {
    expect(buildStageRow({ ...base, stageInstanceId: 'si-1', unitSlug: 'auth' }).unitSlug).toBe(
      'auth',
    );
    expect(
      buildEventRow({ ...base, type: 'v2.x', actor: 'engine', eventId: 'ev1', unitSlug: 'auth' })
        .unitSlug,
    ).toBe('auth');
    expect(
      buildHumanTaskRow({ ...base, humanTaskId: 'h1', kind: 'question', unitSlug: 'auth' })
        .unitSlug,
    ).toBe('auth');
    expect(buildOutputRow({ ...base, seq: 1, content: 'x', unitSlug: 'auth' }).unitSlug).toBe(
      'auth',
    );
    expect(
      buildMetricRow({ ...base, metricId: 'm1', metrics: {}, unitSlug: 'auth' }).unitSlug,
    ).toBe('auth');
    expect(
      buildSensorRow({
        ...base,
        sensorRunId: 's1',
        sensorId: 'lint',
        kind: 'script',
        severity: 'advisory',
        result: 'PASS',
        unitSlug: 'auth',
      }).unitSlug,
    ).toBe('auth');
  });
});

describe('unit dimension through the store', () => {
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

  it('putStage / appendEvent / createHumanTask persist the lane attribution', async () => {
    ddb.on(PutCommand).resolves({});
    await store.putStage({ executionId: 'e1', stageInstanceId: 'si-1', unitSlug: 'auth' });
    await store.appendEvent({
      executionId: 'e1',
      type: 'v2.stage.running',
      stageInstanceId: 'si-1',
      unitSlug: 'auth',
      actor: 'engine',
      summary: 'x',
    });
    await store.createHumanTask({
      executionId: 'e1',
      stageInstanceId: 'si-1',
      unitSlug: 'auth',
      kind: 'question',
    });
    const items = ddb.commandCalls(PutCommand).map((c) => c.args[0].input.Item);
    expect(items.map((i) => i.unitSlug)).toEqual(['auth', 'auth', 'auth']);
  });

  it('recordMetric / recordSensorRun / appendOutput persist the lane attribution', async () => {
    ddb.on(PutCommand).resolves({});
    ddb.on(UpdateCommand).resolves({ Attributes: { outputSeq: 1 } });
    await store.recordMetric({
      executionId: 'e1',
      stageInstanceId: 'si-1',
      unitSlug: 'auth',
      metrics: { tokensInput: 1 },
    });
    await store.recordSensorRun({
      executionId: 'e1',
      stageInstanceId: 'si-1',
      unitSlug: 'auth',
      sensorId: 'lint',
      kind: 'script',
      severity: 'advisory',
      result: 'PASS',
    });
    await store.appendOutput({
      executionId: 'e1',
      stageInstanceId: 'si-1',
      unitSlug: 'auth',
      content: 'hello',
    });
    const items = ddb.commandCalls(PutCommand).map((c) => c.args[0].input.Item);
    expect(items.map((i) => i.unitSlug)).toEqual(['auth', 'auth', 'auth']);
  });

  it('omitting unitSlug stays null end-to-end (existing writers untouched)', async () => {
    ddb.on(PutCommand).resolves({});
    await store.appendEvent({
      executionId: 'e1',
      type: 'v2.stage.running',
      stageInstanceId: 'si-1',
      actor: 'engine',
      summary: 'x',
    });
    const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item;
    expect(item.unitSlug).toBeNull();
  });
});

// ── WP5: lane concurrency + autonomy-ladder fields on META ──────────────────

describe('WP5 META fields', () => {
  it('buildExecutionMeta carries maxParallelUnits + constructionAutonomyMode (null defaults)', () => {
    const meta = buildExecutionMeta({
      executionId: 'e1',
      projectId: 'p1',
      intentId: 'i1',
      workflowId: 'w',
      workflowVersion: 1,
      startedAt: 'T',
    });
    expect(meta.maxParallelUnits).toBeNull();
    expect(meta.constructionAutonomyMode).toBeNull();
    const configured = buildExecutionMeta({
      executionId: 'e1',
      projectId: 'p1',
      intentId: 'i1',
      workflowId: 'w',
      workflowVersion: 1,
      startedAt: 'T',
      maxParallelUnits: 3,
      constructionAutonomyMode: 'gated',
    });
    expect(configured.maxParallelUnits).toBe(3);
    expect(configured.constructionAutonomyMode).toBe('gated');
  });

  it('updateExecution stamps a VALID constructionAutonomyMode and rejects garbage', async () => {
    const ddb = mockClient(DynamoDBDocumentClient);
    ddb.on(UpdateCommand).resolves({ Attributes: { constructionAutonomyMode: 'autonomous' } });
    const store = createProcessStore({ ddb, tableName: 't', clock: () => 'T' });
    await store.updateExecution({ executionId: 'e1', constructionAutonomyMode: 'autonomous' });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.UpdateExpression).toContain('constructionAutonomyMode = :cam');
    expect(input.ExpressionAttributeValues[':cam']).toBe('autonomous');
    // A malformed ladder answer must never poison the scheduling mode.
    await expect(
      store.updateExecution({ executionId: 'e1', constructionAutonomyMode: 'yolo' }),
    ).rejects.toThrow('invalid constructionAutonomyMode');
    ddb.restore();
  });
});
