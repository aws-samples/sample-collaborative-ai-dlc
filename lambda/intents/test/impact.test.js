import { describe, it, expect } from 'vitest';
import {
  collectConsumingStages,
  isExecutionActive,
  activeQuorumEdit,
  editBlockReason,
} from '../impact.js';

// The pure halves of the artifact-impact assembly: stage-consumption evidence
// (declared plan inputs + the READ# ledger) and the edit-blocking vocabulary
// shared by the impact GET and the mutation guards. The graph closure half is
// covered by lambda/shared/test/artifact-edit.test.js.

describe('collectConsumingStages', () => {
  const plan = {
    stages: [
      {
        stageId: 'requirements-analysis',
        inputArtifacts: [{ artifact: 'market-research', required: true }],
      },
      { stageId: 'application-design', inputArtifacts: [{ artifact: 'requirements' }] },
      { stageId: 'legacy-shape', consumes: ['market-research'] },
    ],
  };
  const stages = [
    { stageInstanceId: 'si-req', stageId: 'requirements-analysis' },
    { stageInstanceId: 'si-design', stageId: 'application-design' },
  ];

  it('unions declared plan inputs with actual READ# ledger evidence', () => {
    const out = collectConsumingStages({
      plan,
      stages,
      graphReads: [
        // application-design actually READ the market-research doc by id.
        { stageInstanceId: 'si-design', tool: 'get_artifact', args: { id: 'mr-1' } },
        // an unrelated read never counts
        { stageInstanceId: 'si-design', tool: 'get_artifact', args: { id: 'other' } },
      ],
      artifactId: 'mr-1',
      artifactType: 'market-research',
    });
    expect(out).toEqual([
      { stageId: 'application-design', via: ['read'] },
      { stageId: 'legacy-shape', via: ['declared'] },
      { stageId: 'requirements-analysis', via: ['declared'] },
    ]);
  });

  it('counts type-level reads (lookup_artifacts) and merges evidence per stage', () => {
    const out = collectConsumingStages({
      plan,
      stages,
      graphReads: [
        {
          stageInstanceId: 'si-req',
          tool: 'lookup_artifacts',
          args: { artifactType: 'market-research' },
        },
      ],
      artifactId: 'mr-1',
      artifactType: 'market-research',
    });
    const req = out.find((s) => s.stageId === 'requirements-analysis');
    expect(req.via).toEqual(['declared', 'read']);
  });

  it('degrades to read evidence alone when the plan is unresolvable', () => {
    const out = collectConsumingStages({
      plan: null,
      stages,
      graphReads: [{ stageInstanceId: 'si-req', tool: 'get_artifact', args: { id: 'mr-1' } }],
      artifactId: 'mr-1',
      artifactType: 'market-research',
    });
    expect(out).toEqual([{ stageId: 'requirements-analysis', via: ['read'] }]);
  });

  it('ignores stage-less reads (workspace/init bucket)', () => {
    const out = collectConsumingStages({
      plan: null,
      stages,
      graphReads: [{ stageInstanceId: null, tool: 'get_artifact', args: { id: 'mr-1' } }],
      artifactId: 'mr-1',
      artifactType: 'market-research',
    });
    expect(out).toEqual([]);
  });
});

describe('edit blocking', () => {
  it('only a genuinely executing run (CREATED/RUNNING) blocks; WAITING and terminal states do not', () => {
    for (const status of ['CREATED', 'RUNNING']) {
      expect(isExecutionActive({ status })).toBe(true);
      expect(editBlockReason({ meta: { status } })).toBe('execution_active');
    }
    // WAITING (parked on a human gate) is the established safe mutation point
    // (rewind/cancel/steering) — v2 runs park constantly, so blocking it would
    // make editing effectively impossible.
    for (const status of ['DRAFT', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED']) {
      expect(isExecutionActive({ status })).toBe(false);
      expect(editBlockReason({ meta: { status } })).toBeNull();
    }
  });

  it('a live quorum edit blocks; terminal sessions do not', () => {
    const meta = { status: 'SUCCEEDED' };
    expect(
      editBlockReason({ meta, quorumEdits: [{ editId: 'qe-1', state: 'AWAITING_APPROVAL' }] }),
    ).toBe('quorum_edit_active');
    expect(
      editBlockReason({
        meta,
        quorumEdits: [
          { editId: 'qe-1', state: 'REJECTED' },
          { editId: 'qe-2', state: 'SUCCEEDED' },
          { editId: 'qe-3', state: 'FAILED' },
          { editId: 'qe-4', state: 'CANCELLED' },
        ],
      }),
    ).toBeNull();
    expect(activeQuorumEdit([{ editId: 'qe-1', state: 'APPLYING' }])?.editId).toBe('qe-1');
    expect(activeQuorumEdit([])).toBeNull();
  });

  it('an active run outranks a live quorum edit in the reason vocabulary', () => {
    expect(
      editBlockReason({
        meta: { status: 'RUNNING' },
        quorumEdits: [{ state: 'PLANNING' }],
      }),
    ).toBe('execution_active');
  });
});
