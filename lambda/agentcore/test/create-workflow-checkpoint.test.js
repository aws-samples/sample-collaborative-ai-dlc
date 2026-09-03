import { describe, expect, it, vi } from 'vitest';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { createWorkflowCheckpoint } from '../commands/create-workflow-checkpoint.js';

describe('create-workflow-checkpoint', () => {
  it('freezes artifact and custom-rule references into the latest checkpoint', async () => {
    const putWorkflowCheckpoint = vi.fn(async (checkpoint) => checkpoint);
    const s3 = {
      send: vi.fn(async (command) => {
        expect(command).toBeInstanceOf(HeadObjectCommand);
        return { VersionId: 'rule-version-1' };
      }),
    };
    const result = await createWorkflowCheckpoint(
      {
        projectId: 'p1',
        intentId: 'i1',
        executionId: 'i1',
        orchestratorRunId: 'run-1',
        sourceStageInstanceId: 's1',
      },
      {
        store: {
          getExecutionRecords: vi.fn(async () => ({
            meta: {
              executionId: 'i1',
              projectId: 'p1',
              customRules: [{ filename: 'rules.md', s3Key: 'custom-rules/p1/rules.md' }],
            },
            stages: [],
            humanTasks: [],
            units: [],
          })),
          putWorkflowCheckpoint,
        },
        openGraph: vi.fn(async () => ({})),
        snapshotArtifacts: vi.fn(async () => [
          { artifactId: 'a1', versionId: 'a1:sha256:abc', snapshotHash: 'abc' },
        ]),
        s3,
        bucket: 'artifacts',
        clock: () => '2026-08-14T10:00:00.000Z',
      },
    );
    expect(result).toMatchObject({ ok: true, artifactCount: 1, customRuleCount: 1 });
    expect(putWorkflowCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceStageInstanceId: 's1',
        orchestratorRunId: 'run-1',
        customRuleRefs: [
          {
            filename: 'rules.md',
            s3Key: 'custom-rules/p1/rules.md',
            versionId: 'rule-version-1',
          },
        ],
      }),
    );
  });

  it('keeps the previous checkpoint when publication fails', async () => {
    const putWorkflowCheckpoint = vi.fn(async () => {
      throw new Error('checkpoint ownership lost');
    });
    const result = await createWorkflowCheckpoint(
      {
        projectId: 'p1',
        intentId: 'i1',
        executionId: 'i1',
        orchestratorRunId: 'run-1',
      },
      {
        store: {
          getExecutionRecords: vi.fn(async () => ({
            meta: { executionId: 'i1', projectId: 'p1', customRules: [] },
            stages: [],
            humanTasks: [],
            units: [],
          })),
          putWorkflowCheckpoint,
        },
        openGraph: vi.fn(async () => ({})),
        snapshotArtifacts: vi.fn(async () => []),
        s3: { send: vi.fn() },
        bucket: 'artifacts',
      },
    );
    expect(result).toEqual({
      ok: false,
      reason: 'checkpoint_failed',
      detail: 'checkpoint ownership lost',
    });
    expect(putWorkflowCheckpoint).toHaveBeenCalledOnce();
  });
});
