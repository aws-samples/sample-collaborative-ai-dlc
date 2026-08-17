import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  __test,
  assembleWorkflow,
  loadExecutionPlan,
  loadWorkflowScopes,
} from '../v2-workflow-plan.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const TABLE = 'blocks-test';
const SOURCE_REF = 'a'.repeat(40);

// Minimal fixture: a workflow with two placed stages (a→b via produces/consumes)
// in scope "feature", plus the two STAGE blocks.
const wfItems = [
  { pk: 'WF#SYSTEM#aidlc-v2', sk: 'V#1#META', version: 1, sourceRef: SOURCE_REF },
  {
    pk: 'WF#SYSTEM#aidlc-v2',
    sk: 'V#1#PLACEMENT#stage-a',
    stageId: 'stage-a',
    stageTenant: 'SYSTEM',
    pinnedVersion: 1,
    order: 0,
    scopeMembership: { feature: 'EXECUTE' },
  },
  {
    pk: 'WF#SYSTEM#aidlc-v2',
    sk: 'V#1#PLACEMENT#stage-b',
    stageId: 'stage-b',
    stageTenant: 'SYSTEM',
    pinnedVersion: 1,
    order: 1,
    scopeMembership: { feature: 'EXECUTE' },
  },
  { pk: 'WF#SYSTEM#aidlc-v2', sk: 'V#1#SCOPEREF#feature', scopeId: 'feature' },
];

const stageBlocks = [
  {
    GSI1PK: 'TENANT#SYSTEM#STAGE',
    id: 'stage-a',
    blockId: 'stage-a',
    version: 1,
    phase: 'inception',
    leadAgent: 'agent-x',
    sourceRef: SOURCE_REF,
  },
  {
    GSI1PK: 'TENANT#SYSTEM#STAGE',
    id: 'stage-b',
    blockId: 'stage-b',
    version: 1,
    phase: 'construction',
    leadAgent: 'agent-x',
    reviewer: 'agent-x',
    sourceRef: SOURCE_REF,
  },
];

// The AGENT blocks the stages above reference. loadExecutionPlan must load these
// into agentsById or every agent-bearing stage fails `unresolved_agent`.
const agentBlocks = [
  {
    GSI1PK: 'TENANT#SYSTEM#AGENT',
    tenantId: 'SYSTEM',
    id: 'agent-x',
    blockId: 'agent-x',
    version: 4,
    sourceRef: SOURCE_REF,
  },
];

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(GetCommand).callsFake((input) => ({
    Item:
      stageBlocks.find(
        (stage) =>
          input.Key.pk === `BLOCK#SYSTEM#STAGE#${stage.blockId}` &&
          input.Key.sk === `V#${stage.version}`,
      ) ??
      agentBlocks.find(
        (agent) =>
          input.Key.pk === `BLOCK#SYSTEM#AGENT#${agent.blockId}` &&
          input.Key.sk === `V#${agent.version}`,
      ),
  }));
  ddbMock.on(QueryCommand).callsFake((input) => {
    const values = input.ExpressionAttributeValues || {};
    if (input.IndexName === 'GSI1') {
      const pk = values[':pk'];
      if (pk === 'TENANT#SYSTEM#STAGE') return { Items: stageBlocks };
      if (pk === 'TENANT#SYSTEM#AGENT') return { Items: agentBlocks };
      return { Items: [] }; // sensors/rules/artifacts empty
    }
    // Workflow partition query: default tenant empty, SYSTEM has the items.
    if (values[':pk'] === 'WF#SYSTEM#aidlc-v2') return { Items: wfItems };
    return { Items: [] };
  });
});

describe('loadExecutionPlan', () => {
  it('resolves legacy placements without ownership metadata through the merged catalog', async () => {
    const legacyStage = {
      GSI1PK: 'TENANT#default#STAGE',
      id: 'legacy-stage',
      blockId: 'legacy-stage',
      version: 3,
    };
    ddbMock.reset();
    ddbMock.on(QueryCommand).callsFake((input) => {
      const pk = input.ExpressionAttributeValues?.[':pk'];
      return { Items: pk === 'TENANT#default#STAGE' ? [legacyStage] : [] };
    });

    await expect(
      __test.loadPlacedStages(ddbMock, TABLE, [{ stageId: 'legacy-stage' }]),
    ).resolves.toEqual([legacyStage]);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('preserves missing ownership metadata when assembling a legacy workflow snapshot', () => {
    const workflow = assembleWorkflow(
      [
        { sk: 'V#1#META' },
        {
          sk: 'V#1#PLACEMENT#legacy-stage',
          stageId: 'legacy-stage',
          scopeMembership: { feature: 'EXECUTE' },
        },
      ],
      { workflowId: 'legacy', workflowVersion: 1 },
    );

    expect(workflow.placements[0]).toMatchObject({
      stageId: 'legacy-stage',
      stageTenant: null,
      pinnedVersion: null,
    });
  });

  it('returns the ordered in-scope stage list for a pinned workflow', async () => {
    const result = await loadExecutionPlan({
      ddb: ddbMock,
      tableName: TABLE,
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
      scope: 'feature',
    });
    expect(result.valid).toBe(true);
    expect(result.plan.stages.map((s) => s.stageId)).toEqual(['stage-a', 'stage-b']);
  });

  it('resolves stage agents (lead + reviewer) so the plan does not fail unresolved_agent', async () => {
    const result = await loadExecutionPlan({
      ddb: ddbMock,
      tableName: TABLE,
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
      scope: 'feature',
    });
    expect(result.valid).toBe(true);
    expect((result.errors ?? []).map((e) => e.code)).not.toContain('unresolved_agent');
    expect(result.methodologyPins.AGENT).toEqual({
      'agent-x': { tenantId: 'SYSTEM', version: 4 },
    });
    expect(result.methodologySourceRefs).toEqual([SOURCE_REF]);
  });

  it('reloads supporting methodology from exact create-time version pins', async () => {
    const result = await loadExecutionPlan({
      ddb: ddbMock,
      tableName: TABLE,
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
      scope: 'feature',
      methodologyPins: {
        AGENT: { 'agent-x': { tenantId: 'SYSTEM', version: 4 } },
        SENSOR: {},
        RULE: {},
        ARTIFACT: {},
        KNOWLEDGE: {},
      },
    });
    expect(result.valid).toBe(true);
    expect(ddbMock.commandCalls(GetCommand).map((call) => call.args[0].input.Key)).toContainEqual({
      pk: 'BLOCK#SYSTEM#AGENT#agent-x',
      sk: 'V#4',
    });
  });

  it('loads the immutable stage version pinned by the workflow snapshot', async () => {
    const result = await loadExecutionPlan({
      ddb: ddbMock,
      tableName: TABLE,
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
      scope: 'feature',
    });
    expect(result.valid).toBe(true);
    const gets = ddbMock.commandCalls(GetCommand).map((call) => call.args[0].input.Key);
    expect(gets).toContainEqual({
      pk: 'BLOCK#SYSTEM#STAGE#stage-a',
      sk: 'V#1',
    });
    expect(gets).toContainEqual({
      pk: 'BLOCK#SYSTEM#STAGE#stage-b',
      sk: 'V#1',
    });
  });

  it('fails closed when the workflow version is not found', async () => {
    const result = await loadExecutionPlan({
      ddb: ddbMock,
      tableName: TABLE,
      workflowId: 'missing',
      workflowVersion: 9,
      scope: 'feature',
    });
    expect(result.valid).toBe(false);
    expect(result.plan).toBeNull();
  });

  it('rejects a scope the workflow does not offer', async () => {
    const result = await loadExecutionPlan({
      ddb: ddbMock,
      tableName: TABLE,
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
      scope: 'nonexistent',
    });
    expect(result.valid).toBe(false);
  });

  describe('loadWorkflowScopes', () => {
    it('lists the scopes a pinned workflow offers', async () => {
      const scopes = await loadWorkflowScopes({
        ddb: ddbMock,
        tableName: TABLE,
        workflowId: 'aidlc-v2',
        workflowVersion: 1,
      });
      expect(scopes).toEqual(['feature']);
    });

    it('returns [] when the workflow snapshot is missing', async () => {
      const scopes = await loadWorkflowScopes({
        ddb: ddbMock,
        tableName: TABLE,
        workflowId: 'missing',
        workflowVersion: 9,
      });
      expect(scopes).toEqual([]);
    });
  });

  it('a default-tenant workflow shadows the SYSTEM baseline of the same id', async () => {
    // The default (user fork) carries only stage-a in scope; SYSTEM carries a+b.
    // loadWorkflowItems reads default FIRST and must not fall through to SYSTEM.
    const defaultWfItems = [
      { pk: 'WF#default#aidlc-v2', sk: 'V#1#META', version: 1 },
      {
        pk: 'WF#default#aidlc-v2',
        sk: 'V#1#PLACEMENT#stage-a',
        stageId: 'stage-a',
        stageTenant: 'SYSTEM',
        pinnedVersion: 1,
        order: 0,
        scopeMembership: { feature: 'EXECUTE' },
      },
      { pk: 'WF#default#aidlc-v2', sk: 'V#1#SCOPEREF#feature', scopeId: 'feature' },
    ];
    ddbMock.reset();
    ddbMock.on(GetCommand).callsFake((input) => ({
      Item: stageBlocks.find(
        (stage) =>
          input.Key.pk === `BLOCK#SYSTEM#STAGE#${stage.blockId}` &&
          input.Key.sk === `V#${stage.version}`,
      ),
    }));
    ddbMock.on(QueryCommand).callsFake((input) => {
      const values = input.ExpressionAttributeValues || {};
      if (input.IndexName === 'GSI1') {
        if (values[':pk'] === 'TENANT#SYSTEM#STAGE') return { Items: stageBlocks };
        if (values[':pk'] === 'TENANT#SYSTEM#AGENT') return { Items: agentBlocks };
        return { Items: [] };
      }
      if (values[':pk'] === 'WF#default#aidlc-v2') return { Items: defaultWfItems };
      if (values[':pk'] === 'WF#SYSTEM#aidlc-v2') return { Items: wfItems };
      return { Items: [] };
    });
    const result = await loadExecutionPlan({
      ddb: ddbMock,
      tableName: TABLE,
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
      scope: 'feature',
    });
    expect(result.valid).toBe(true);
    // The fork (stage-a only) wins; SYSTEM's stage-b is NOT pulled in.
    expect(result.plan.stages.map((s) => s.stageId)).toEqual(['stage-a']);
  });

  it('drains paginated workflow + catalog queries (a truncated page would silently narrow the plan)', async () => {
    // Split BOTH the workflow snapshot rows and the STAGE catalog across two
    // 1MB pages: a dropped second page loses PLACEMENT#stage-b (stage silently
    // skipped) or its STAGE block (plan fails unresolved_stage).
    ddbMock.reset();
    ddbMock.on(GetCommand).callsFake((input) => ({
      Item: stageBlocks.find(
        (stage) =>
          input.Key.pk === `BLOCK#SYSTEM#STAGE#${stage.blockId}` &&
          input.Key.sk === `V#${stage.version}`,
      ),
    }));
    ddbMock.on(QueryCommand).callsFake((input) => {
      const values = input.ExpressionAttributeValues || {};
      if (input.IndexName === 'GSI1') {
        if (values[':pk'] === 'TENANT#SYSTEM#STAGE') {
          return input.ExclusiveStartKey
            ? { Items: [stageBlocks[1]] }
            : { Items: [stageBlocks[0]], LastEvaluatedKey: { pk: 'x', sk: 'y' } };
        }
        if (values[':pk'] === 'TENANT#SYSTEM#AGENT') return { Items: agentBlocks };
        return { Items: [] };
      }
      if (values[':pk'] === 'WF#SYSTEM#aidlc-v2') {
        return input.ExclusiveStartKey
          ? { Items: wfItems.slice(2) }
          : { Items: wfItems.slice(0, 2), LastEvaluatedKey: { pk: 'x', sk: 'y' } };
      }
      return { Items: [] };
    });
    const result = await loadExecutionPlan({
      ddb: ddbMock,
      tableName: TABLE,
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
      scope: 'feature',
    });
    expect(result.valid).toBe(true);
    expect(result.plan.stages.map((s) => s.stageId)).toEqual(['stage-a', 'stage-b']);
  });
});
