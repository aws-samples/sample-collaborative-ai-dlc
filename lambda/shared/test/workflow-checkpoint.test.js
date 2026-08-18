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

  it('retains external-development metadata used by unit handoff projection', () => {
    const checkpoint = buildWorkflowCheckpoint({
      executionId: 'i1',
      createdAt: '2026-08-17T10:00:00.000Z',
      records: {
        ...records,
        humanTasks: [
          {
            executionId: 'i1',
            humanTaskId: 'external-1',
            stageInstanceId: 's1',
            unitSlug: 'auth',
            sectionIndex: 0,
            kind: 'external-development',
            status: 'pending',
            externalDevelopment: {
              stageAttempt: 1,
              harness: 'codex',
              repositories: [
                {
                  name: 'api',
                  baseSha: 'a'.repeat(40),
                  branch: 'aidlc/i1/auth/a1',
                },
              ],
            },
          },
        ],
      },
    });

    expect(checkpoint.process.humanTasks[0].externalDevelopment).toMatchObject({
      stageAttempt: 1,
      harness: 'codex',
    });
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
