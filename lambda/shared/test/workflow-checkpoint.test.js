import { describe, expect, it } from 'vitest';
import {
  MAX_WORKFLOW_CHECKPOINT_BYTES,
  buildWorkflowCheckpoint,
  canonicalJson,
  checkpointProjection,
} from '../workflow-checkpoint.js';

describe('workflow checkpoint', () => {
  const records = {
    meta: { pk: 'EXEC#i1', sk: 'META', executionId: 'i1', projectId: 'p1' },
    stages: [{ pk: 'EXEC#i1', sk: 'STAGE#s1', stageInstanceId: 's1', state: 'SUCCEEDED' }],
    humanTasks: [],
    unitPlan: null,
    units: [],
  };

  it('creates a deterministic projector snapshot without infrastructure keys', () => {
    const input = {
      executionId: 'i1',
      createdAt: '2026-08-14T10:00:00.000Z',
      sourceStageInstanceId: 's1',
      records,
      artifactRefs: [{ artifactId: 'a1', versionId: 'a1:sha256:1', snapshotHash: '1' }],
    };
    const first = buildWorkflowCheckpoint(input);
    const second = buildWorkflowCheckpoint({ ...input, createdAt: 'later' });
    expect(first.checkpointId).toBe(second.checkpointId);
    expect(first.process.meta).not.toHaveProperty('pk');
    expect(checkpointProjection(first)).toEqual({
      meta: { executionId: 'i1', projectId: 'p1' },
      stages: [{ stageInstanceId: 's1', state: 'SUCCEEDED' }],
      humanTasks: [],
      unitPlan: null,
      units: [],
    });
  });

  it('carries the release pin through the projection so a rewind stays on the same release', () => {
    const methodologyRelease = {
      releaseId: 'aidlc:83ed7a812c4024904f2c5e4d744e28077e0a5acd',
      sourceSha: '83ed7a812c4024904f2c5e4d744e28077e0a5acd',
      importerRevision: 1,
      closureDigest: 'a'.repeat(64),
      catalogKey: 'aidlc-releases/v1/83ed7a812c4024904f2c5e4d744e28077e0a5acd/i1/catalog.json',
      manifestKey: 'aidlc-releases/v1/83ed7a812c4024904f2c5e4d744e28077e0a5acd/i1/manifest.json',
    };
    const checkpoint = buildWorkflowCheckpoint({
      executionId: 'i1',
      createdAt: '2026-08-14T10:00:00.000Z',
      sourceStageInstanceId: 's1',
      records: { ...records, meta: { ...records.meta, methodologyRelease } },
      artifactRefs: [],
    });

    expect(checkpoint.process.meta.methodologyRelease).toEqual(methodologyRelease);
    expect(checkpointProjection(checkpoint).meta.methodologyRelease).toEqual(methodologyRelease);
  });

  it('canonicalizes nested object properties independently of insertion order', () => {
    const first = {
      stageRows: [
        {
          stageInstanceId: 's1',
          state: 'WAITING',
          metadata: { phase: 'inception', stageId: 'requirements-analysis' },
        },
      ],
    };
    const second = {
      stageRows: [
        {
          metadata: { stageId: 'requirements-analysis', phase: 'inception' },
          state: 'WAITING',
          stageInstanceId: 's1',
        },
      ],
    };

    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  it('refuses a checkpoint that could exceed the DynamoDB item limit', () => {
    expect(() =>
      buildWorkflowCheckpoint({
        executionId: 'i1',
        createdAt: 'T',
        records: {
          ...records,
          humanTasks: [{ humanTaskId: 'h1', answer: 'x'.repeat(MAX_WORKFLOW_CHECKPOINT_BYTES) }],
        },
      }),
    ).toThrow(/exceeds/);
  });
});
