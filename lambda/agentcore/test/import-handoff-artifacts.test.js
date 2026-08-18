import { describe, expect, it, vi } from 'vitest';
import { importHandoffArtifacts } from '../commands/import-handoff-artifacts.js';

const payload = {
  projectId: 'project-1',
  intentId: 'intent-1',
  executionId: 'execution-1',
  humanTaskId: 'task-1',
  stageInstanceId: 'stage-1',
  stageAttempt: 2,
  unitSlug: 'payments',
  sectionIndex: 3,
  workspaceDir: '/workspace',
  repositories: [
    {
      name: 'api',
      repository: 'owner/api',
      provider: 'github',
      branch: 'aidlc/unit/payments',
      baseSha: 'a'.repeat(40),
      submittedSha: 'b'.repeat(40),
    },
  ],
  documents: {
    'code-generation-plan': {
      content: '# Plan',
      sha256: 'plan-hash',
    },
    'code-summary': {
      content: '# Summary',
      sha256: 'summary-hash',
    },
  },
};

const dependencies = () => {
  const createArtifact = vi.fn(async ({ id }) => ({ id }));
  return {
    createArtifact,
    deps: {
      statFn: vi.fn(async () => ({
        isDirectory: () => true,
        isFile: () => false,
      })),
      checkoutRepo: vi.fn(),
      checkoutRemoteRevision: vi.fn(async () => ({ ready: true })),
      openGraph: vi.fn(async () => ({})),
      createWriter: vi.fn(() => ({ createArtifact })),
      deriveArtifacts: vi.fn(async () => ({ ok: true })),
    },
  };
};

describe('importHandoffArtifacts', () => {
  it('checks out every frozen revision and imports both documents', async () => {
    const { deps, createArtifact } = dependencies();

    const result = await importHandoffArtifacts(payload, deps);

    expect(result.ok).toBe(true);
    expect(deps.checkoutRemoteRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'aidlc/unit/payments',
        sha: 'b'.repeat(40),
      }),
    );
    expect(createArtifact).toHaveBeenCalledTimes(2);
    expect(createArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactType: 'code-generation-plan',
        id: 'payments-code-generation-plan',
        content: '# Plan',
        props: expect.objectContaining({
          handoff_task_id: 'task-1',
          handoff_content_sha256: 'plan-hash',
        }),
      }),
    );
    expect(deps.deriveArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        stageInstanceId: 'stage-1',
        artifactTypes: ['code-generation-plan', 'code-summary'],
      }),
    );
  });

  it('does not import artifacts when an exact revision cannot be checked out', async () => {
    const { deps, createArtifact } = dependencies();
    deps.checkoutRemoteRevision.mockResolvedValue({
      ready: false,
      reason: 'remote_head_changed',
    });

    const result = await importHandoffArtifacts(payload, deps);

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        reason: 'remote_head_changed',
        repository: 'owner/api',
      }),
    );
    expect(createArtifact).not.toHaveBeenCalled();
    expect(deps.openGraph).not.toHaveBeenCalled();
  });

  it('restores the checkout when .git is neither a file nor a directory', async () => {
    const { deps } = dependencies();
    deps.statFn.mockResolvedValue({
      isDirectory: () => false,
      isFile: () => false,
    });
    deps.checkoutRepo.mockResolvedValue({ cloned: true, branchOk: true });

    const result = await importHandoffArtifacts(payload, deps);

    expect(result.ok).toBe(true);
    expect(deps.checkoutRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'owner/api',
        targetDir: '/workspace',
      }),
    );
  });
});
