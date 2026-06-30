import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { loadExecutionPlan } from '../v2-workflow-plan.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const TABLE = 'blocks-test';

// Minimal fixture: a workflow with two placed stages (a→b via produces/consumes)
// in scope "feature", plus the two STAGE blocks.
const wfItems = [
  { pk: 'WF#SYSTEM#aidlc-v2', sk: 'V#1#META', version: 1 },
  {
    pk: 'WF#SYSTEM#aidlc-v2',
    sk: 'V#1#PLACEMENT#stage-a',
    stageId: 'stage-a',
    order: 0,
    scopeMembership: { feature: 'EXECUTE' },
  },
  {
    pk: 'WF#SYSTEM#aidlc-v2',
    sk: 'V#1#PLACEMENT#stage-b',
    stageId: 'stage-b',
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
  },
  {
    GSI1PK: 'TENANT#SYSTEM#STAGE',
    id: 'stage-b',
    blockId: 'stage-b',
    version: 1,
    phase: 'construction',
  },
];

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(QueryCommand).callsFake((input) => {
    const values = input.ExpressionAttributeValues || {};
    if (input.IndexName === 'GSI1') {
      const pk = values[':pk'];
      if (pk === 'TENANT#SYSTEM#STAGE') return { Items: stageBlocks };
      return { Items: [] }; // sensors/rules/artifacts empty
    }
    // Workflow partition query: default tenant empty, SYSTEM has the items.
    if (values[':pk'] === 'WF#SYSTEM#aidlc-v2') return { Items: wfItems };
    return { Items: [] };
  });
});

describe('loadExecutionPlan', () => {
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
});
