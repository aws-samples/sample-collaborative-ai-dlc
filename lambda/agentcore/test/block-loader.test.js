import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { __test, loadLibrary } from '../block-loader.js';

const { assembleWorkflow, keyById, loadPlacedStages } = __test;

describe('assembleWorkflow', () => {
  // Version snapshot rows are keyed V#<n>#<liveSk>; the loader strips the prefix.
  const rows = [
    { sk: 'V#2#META', type: 'Workflow' },
    { sk: 'V#2#PHASE#03#inception', phaseId: 'inception', path: '03' },
    {
      sk: 'V#2#PLACEMENT#requirements-analysis',
      stageId: 'requirements-analysis',
      stageTenant: 'default',
      pinnedVersion: 7,
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
        stageTenant: 'default',
        pinnedVersion: 7,
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

  it('preserves missing ownership metadata in legacy workflow snapshots', () => {
    const wf = assembleWorkflow(
      [
        { sk: 'V#2#META' },
        {
          sk: 'V#2#PLACEMENT#legacy-stage',
          stageId: 'legacy-stage',
          scopeMembership: { feature: 'EXECUTE' },
        },
      ],
      { workflowId: 'legacy', workflowVersion: 2 },
    );

    expect(wf.placements[0]).toMatchObject({
      stageId: 'legacy-stage',
      stageTenant: null,
      pinnedVersion: null,
    });
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

  it('resolves legacy placements without ownership metadata through the merged catalog', async () => {
    const legacyStage = {
      GSI1PK: 'TENANT#default#STAGE',
      id: 'legacy-stage',
      blockId: 'legacy-stage',
      version: 3,
    };
    ddbMock.on(QueryCommand).callsFake((input) => {
      const pk = input.ExpressionAttributeValues?.[':pk'];
      return { Items: pk === 'TENANT#default#STAGE' ? [legacyStage] : [] };
    });

    await expect(loadPlacedStages([{ stageId: 'legacy-stage' }])).resolves.toEqual([legacyStage]);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('drains 1MB-truncated workflow + catalog pages (a dropped page silently narrows the plan)', async () => {
    const wfRows = [
      { pk: 'WF#SYSTEM#aidlc-v2', sk: 'V#1#META' },
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
        pinnedVersion: 2,
        order: 1,
        scopeMembership: { feature: 'EXECUTE' },
      },
    ];
    const stageRows = [
      { GSI1PK: 'TENANT#SYSTEM#STAGE', id: 'stage-a', version: 1 },
      { GSI1PK: 'TENANT#SYSTEM#STAGE', id: 'stage-b', version: 2 },
    ];
    ddbMock.on(GetCommand).callsFake((input) => ({
      Item: stageRows.find(
        (stage) =>
          input.Key.pk === `BLOCK#SYSTEM#STAGE#${stage.id}` &&
          input.Key.sk === `V#${stage.version}`,
      ),
    }));
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
    expect(ddbMock.commandCalls(GetCommand).map((call) => call.args[0].input.Key)).toContainEqual({
      pk: 'BLOCK#SYSTEM#STAGE#stage-b',
      sk: 'V#2',
    });
  });

  it('loads supporting blocks from exact execution pins instead of catalog heads', async () => {
    const agent = {
      tenantId: 'SYSTEM',
      blockId: 'agent-x',
      version: 3,
      name: 'Pinned agent',
      sourceRef: 'a'.repeat(40),
    };
    ddbMock.on(GetCommand).callsFake((input) => ({
      Item: input.Key.pk === 'BLOCK#SYSTEM#AGENT#agent-x' && input.Key.sk === 'V#3' ? agent : null,
    }));
    ddbMock.on(QueryCommand).callsFake((input) => {
      const values = input.ExpressionAttributeValues || {};
      if (values[':pk'] === 'WF#SYSTEM#aidlc-v2') {
        return { Items: [{ sk: 'V#1#META', sourceRef: 'a'.repeat(40) }] };
      }
      return { Items: [] };
    });

    const { library } = await loadLibrary({
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
      aidlcRepoRef: 'a'.repeat(40),
      methodologyPins: {
        AGENT: { 'agent-x': { tenantId: 'SYSTEM', version: 3 } },
        SENSOR: {},
        RULE: {},
        ARTIFACT: {},
        KNOWLEDGE: {},
      },
    });

    expect(library.agentsById['agent-x']).toEqual(agent);
    expect(ddbMock.commandCalls(GetCommand).map((call) => call.args[0].input.Key)).toContainEqual({
      pk: 'BLOCK#SYSTEM#AGENT#agent-x',
      sk: 'V#3',
    });
  });

  it('rejects SYSTEM blocks that were reseeded from a different methodology revision', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        tenantId: 'SYSTEM',
        blockId: 'agent-x',
        version: 3,
        sourceRef: 'b'.repeat(40),
      },
    });
    ddbMock.on(QueryCommand).callsFake((input) => {
      const values = input.ExpressionAttributeValues || {};
      if (values[':pk'] === 'WF#SYSTEM#aidlc-v2') {
        return { Items: [{ sk: 'V#1#META', sourceRef: 'a'.repeat(40) }] };
      }
      return { Items: [] };
    });

    await expect(
      loadLibrary({
        workflowId: 'aidlc-v2',
        workflowVersion: 1,
        aidlcRepoRef: 'a'.repeat(40),
        methodologyPins: {
          AGENT: { 'agent-x': { tenantId: 'SYSTEM', version: 3 } },
          SENSOR: {},
          RULE: {},
          ARTIFACT: {},
          KNOWLEDGE: {},
        },
      }),
    ).rejects.toThrow(
      `Pinned methodology snapshot does not match AI-DLC repository ref ${'a'.repeat(40)}: AGENT agent-x@3 has sourceRef ${'b'.repeat(40)}`,
    );
  });

  it('does not apply SYSTEM source validation to custom tenant blocks', async () => {
    const customAgent = {
      tenantId: 'default',
      blockId: 'agent-x',
      version: 3,
      sourceRef: 'custom-source',
    };
    ddbMock.on(GetCommand).resolves({ Item: customAgent });
    ddbMock.on(QueryCommand).callsFake((input) => {
      const values = input.ExpressionAttributeValues || {};
      if (values[':pk'] === 'WF#default#custom-workflow') {
        return { Items: [{ sk: 'V#1#META', sourceRef: 'custom-source' }] };
      }
      return { Items: [] };
    });

    await expect(
      loadLibrary({
        workflowId: 'custom-workflow',
        workflowVersion: 1,
        aidlcRepoRef: 'a'.repeat(40),
        methodologyPins: {
          AGENT: { 'agent-x': { tenantId: 'default', version: 3 } },
          SENSOR: {},
          RULE: {},
          ARTIFACT: {},
          KNOWLEDGE: {},
        },
      }),
    ).resolves.toMatchObject({
      library: { agentsById: { 'agent-x': customAgent } },
    });
  });
});
