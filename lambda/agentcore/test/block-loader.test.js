import { describe, it, expect } from 'vitest';
import { __test } from '../block-loader.js';

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
