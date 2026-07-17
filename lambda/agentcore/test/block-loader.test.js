import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { __test, loadLibrary } from '../block-loader.js';

const { assembleWorkflow, keyById } = __test;

describe('assembleWorkflow', () => {
  // Version snapshot rows are keyed V#<n>#<liveSk>; the loader strips the prefix.
  const rows = [
    { sk: 'V#2#META', type: 'Workflow' },
    { sk: 'V#2#PHASE#03#inception', phaseId: 'inception', path: '03' },
    {
      sk: 'V#2#PLACEMENT#requirements-analysis',
      stageId: 'requirements-analysis',
      order: 5,
      phasePath: '03',
      scopeMembership: { feature: 'EXECUTE' },
    },
    { sk: 'V#2#RULEREF#org#aidlc-org', layer: 'org', ruleId: 'aidlc-org' },
    { sk: 'V#2#SCOPEREF#feature', scopeId: 'feature' },
  ];

  it('reassembles placements, rule refs, scope refs and phases from version rows', () => {
    const wf = assembleWorkflow(rows, { workflowId: 'aidlc-v2', workflowVersion: 2 });
    expect(wf).toMatchObject({ workflowId: 'aidlc-v2', workflowVersion: 2 });
    expect(wf.placements).toEqual([
      {
        stageId: 'requirements-analysis',
        order: 5,
        phasePath: '03',
        scopeMembership: { feature: 'EXECUTE' },
      },
    ]);
    expect(wf.ruleRefs).toEqual([{ layer: 'org', ruleId: 'aidlc-org' }]);
    expect(wf.scopeRefs).toEqual([{ scopeId: 'feature' }]);
    expect(wf.phases).toEqual([{ phaseId: 'inception', path: '03' }]);
  });

  it('feeds straight into the plan resolver via workflowScopes (membership)', () => {
    const wf = assembleWorkflow(rows, { workflowId: 'aidlc-v2', workflowVersion: 2 });
    // scopeRefs present → scope resolves from refs.
    expect(wf.scopeRefs.map((r) => r.scopeId)).toContain('feature');
  });
});

describe('keyById', () => {
  it('keys blocks by id or blockId', () => {
    const map = keyById([
      { id: 'a', x: 1 },
      { blockId: 'b', y: 2 },
    ]);
    expect(map.a).toEqual({ id: 'a', x: 1 });
    expect(map.b).toEqual({ blockId: 'b', y: 2 });
  });
});

describe('loadLibrary — paginated table reads', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    ddbMock.reset();
    process.env.BLOCKS_TABLE = 'blocks-test';
  });
  afterAll(() => {
    ddbMock.restore();
    delete process.env.BLOCKS_TABLE;
  });

  it('drains 1MB-truncated workflow + catalog pages (a dropped page silently narrows the plan)', async () => {
    const wfRows = [
      { pk: 'WF#SYSTEM#aidlc-v2', sk: 'V#1#META' },
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
    ];
    const stageRows = [
      { GSI1PK: 'TENANT#SYSTEM#STAGE', id: 'stage-a', version: 1 },
      { GSI1PK: 'TENANT#SYSTEM#STAGE', id: 'stage-b', version: 1 },
    ];
    ddbMock.on(QueryCommand).callsFake((input) => {
      const values = input.ExpressionAttributeValues || {};
      if (input.IndexName === 'GSI1') {
        if (values[':pk'] === 'TENANT#SYSTEM#STAGE') {
          // The STAGE catalog splits across two pages.
          return input.ExclusiveStartKey
            ? { Items: [stageRows[1]] }
            : { Items: [stageRows[0]], LastEvaluatedKey: { pk: 'x', sk: 'y' } };
        }
        return { Items: [] };
      }
      if (values[':pk'] === 'WF#SYSTEM#aidlc-v2') {
        // The workflow snapshot splits too — PLACEMENT#stage-b on page 2.
        return input.ExclusiveStartKey
          ? { Items: wfRows.slice(2) }
          : { Items: wfRows.slice(0, 2), LastEvaluatedKey: { pk: 'x', sk: 'y' } };
      }
      return { Items: [] };
    });

    const { workflow, library } = await loadLibrary({ workflowId: 'aidlc-v2', workflowVersion: 1 });
    expect(workflow.placements.map((p) => p.stageId)).toEqual(['stage-a', 'stage-b']);
    expect(Object.keys(library.stagesById).toSorted()).toEqual(['stage-a', 'stage-b']);
  });
});
