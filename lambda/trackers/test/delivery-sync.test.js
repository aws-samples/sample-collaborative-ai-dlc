import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREATED_PHRASE,
  CREATED_TASK_PHRASE,
  MERGED_PHRASE,
  MERGED_MR_PHRASE,
  branchUrlFor,
  createDeliverySynchronizer,
} from '../delivery-sync.js';

const NOW = new Date('2026-08-10T12:00:00.000Z');

const syncRow = (overrides = {}) => ({
  executionId: 'e1',
  projectId: 'p1',
  intentId: 'i1',
  intentTitle: 'Implement login',
  workflowId: 'aidlc-v2',
  workflowVersion: 4,
  scope: 'feature',
  branch: 'feat/login',
  source: {
    bindingId: 'tb1',
    provider: 'github-issues',
    instance: 'public',
    resourceId: '42',
    resourceUrl: 'https://github.com/acme/app/issues/42',
  },
  pullRequests: [
    {
      provider: 'github',
      repoId: 'acme/app',
      prNumber: 7,
      prUrl: 'https://github.com/acme/app/pull/7',
      branch: 'feat/login',
      baseBranch: 'main',
    },
  ],
  state: 'PR_CREATED',
  attempts: 0,
  ...overrides,
});

describe('tracker delivery synchronizer', () => {
  let store;
  let provider;
  let getPullRequestStatus;
  let resolveBinding;
  let broadcast;
  let candidate;
  let synchronizer;

  beforeEach(() => {
    candidate = syncRow();
    store = {
      claimTrackerSync: vi.fn(async () => candidate),
      updateTrackerSync: vi.fn(async () => ({})),
      listTrackerSyncs: vi.fn(async () => [candidate]),
      appendEvent: vi.fn(async () => ({})),
    };
    provider = {
      getIssueDiscussion: vi.fn(async () => []),
      addIssueComment: vi.fn(async () => ({})),
      closeIssue: vi.fn(async () => ({})),
    };
    getPullRequestStatus = vi.fn(async () => ({ state: 'open' }));
    resolveBinding = vi.fn(async () => ({
      id: 'tb1',
      provider: 'github-issues',
      instance: 'public',
      externalProjectKey: 'acme/app',
      createdBy: 'u1',
    }));
    broadcast = vi.fn(async () => {});
    synchronizer = createDeliverySynchronizer({
      store,
      resolveBinding,
      getTrackerProvider: () => provider,
      trackerContext: () => ({}),
      getPullRequestStatus,
      applicationUrl: 'https://aidlc.example',
      broadcast,
      clock: () => NOW,
      ids: () => 'claim-1',
    });
  });

  it.each([
    [
      'github',
      'https://github.com/acme/app/pull/7',
      'https://github.com/acme/app/tree/aidlc/login',
    ],
    [
      'gitlab',
      'https://gitlab.com/acme/app/-/merge_requests/7',
      'https://gitlab.com/acme/app/-/tree/aidlc/login',
    ],
    [
      'bitbucket',
      'https://bitbucket.org/acme/app/pull-requests/7',
      'https://bitbucket.org/acme/app/branch/aidlc/login',
    ],
  ])('preserves branch path separators in %s links', (providerName, prUrl, expected) => {
    expect(
      branchUrlFor(
        {
          provider: providerName,
          repoId: 'acme/app',
          prUrl,
          branch: 'aidlc/login',
        },
        null,
      ),
    ).toBe(expected);
  });

  it('posts the created comment and advances to merge polling', async () => {
    await synchronizer.process(candidate);

    expect(provider.addIssueComment).toHaveBeenCalledOnce();
    const body = provider.addIssueComment.mock.calls[0][3];
    expect(body).toContain(CREATED_PHRASE);
    expect(body).toContain('https://aidlc.example/space/p1/intent/i1');
    expect(body).toContain('[`feat/login`](https://github.com/acme/app/tree/feat/login)');
    expect(body).toContain('https://github.com/acme/app/pull/7');
    expect(store.updateTrackerSync).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'WAITING_FOR_MERGE',
        fields: expect.objectContaining({ attempts: 0, createdCommentedAt: NOW.toISOString() }),
      }),
    );
    expect(broadcast).toHaveBeenCalledWith('i1', {
      action: 'agent.note',
      executionId: 'e1',
      intentId: 'i1',
      projectId: 'p1',
      noteType: 'v2.tracker.commented',
      summary: 'Added tracker delivery comment',
    });
  });

  it('does not duplicate an existing created comment', async () => {
    provider.getIssueDiscussion.mockResolvedValue([
      {
        body: `${CREATED_PHRASE}\nhttps://aidlc.example/space/p1/intent/i1`,
      },
    ]);

    await synchronizer.process(candidate);

    expect(provider.addIssueComment).not.toHaveBeenCalled();
    expect(store.updateTrackerSync).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'WAITING_FOR_MERGE' }),
    );
  });

  it('calls Jira sources tasks and keeps the task-specific idempotency signature', async () => {
    candidate = syncRow({
      source: {
        bindingId: 'tb-jira',
        provider: 'jira-cloud',
        instance: 'cloud-1',
        resourceId: 'PROJ-42',
        resourceUrl: 'https://acme.atlassian.net/browse/PROJ-42',
      },
    });
    store.claimTrackerSync.mockResolvedValue(candidate);

    await synchronizer.process(candidate);

    const body = provider.addIssueComment.mock.calls[0][3];
    expect(body).toContain(CREATED_TASK_PHRASE);
    expect(body).not.toContain(CREATED_PHRASE);
  });

  it('requires every mixed-provider final PR to be merged', async () => {
    candidate = syncRow({
      state: 'WAITING_FOR_MERGE',
      pullRequests: [
        { provider: 'github', repoId: 'acme/app', prNumber: 7, prUrl: 'gh' },
        { provider: 'bitbucket', repoId: 'acme/web', prNumber: 9, prUrl: 'bb' },
      ],
    });
    store.claimTrackerSync.mockResolvedValue(candidate);
    getPullRequestStatus.mockResolvedValueOnce({ state: 'merged' }).mockResolvedValueOnce({
      state: 'open',
    });

    await synchronizer.process(candidate);

    expect(getPullRequestStatus.mock.calls.map(([request]) => request.provider)).toEqual([
      'github',
      'bitbucket',
    ]);
    expect(store.updateTrackerSync).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'WAITING_FOR_MERGE' }),
    );
  });

  it('advances after every final PR is merged', async () => {
    candidate = syncRow({ state: 'WAITING_FOR_MERGE' });
    store.claimTrackerSync.mockResolvedValue(candidate);
    getPullRequestStatus.mockResolvedValue({ state: 'merged' });

    await synchronizer.process(candidate);

    expect(store.updateTrackerSync).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'PR_MERGED' }),
    );
  });

  it('blocks a structurally incomplete final merge request instead of polling forever', async () => {
    candidate = syncRow({
      state: 'WAITING_FOR_MERGE',
      pullRequests: [
        {
          provider: 'gitlab',
          repoId: 'acme/app',
          prNumber: null,
          prUrl: 'https://gitlab.com/acme/app/-/merge_requests/7',
        },
      ],
    });
    store.claimTrackerSync.mockResolvedValue(candidate);

    await synchronizer.process(candidate);

    expect(getPullRequestStatus).not.toHaveBeenCalled();
    expect(store.updateTrackerSync).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'BLOCKED',
        fields: expect.objectContaining({
          lastError: expect.objectContaining({ code: 'PR_IDENTITY_INCOMPLETE' }),
        }),
      }),
    );
    expect(store.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'v2.tracker.blocked',
        summary:
          'Tracker synchronization stopped because final pull request identity is incomplete',
      }),
    );
  });

  it('blocks and stops polling when a final PR is closed without merge', async () => {
    candidate = syncRow({ state: 'WAITING_FOR_MERGE' });
    store.claimTrackerSync.mockResolvedValue(candidate);
    getPullRequestStatus.mockResolvedValue({ state: 'closed' });

    await synchronizer.process(candidate);

    expect(store.updateTrackerSync).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'BLOCKED',
        fields: expect.objectContaining({
          lastError: expect.objectContaining({ code: 'PR_CLOSED_WITHOUT_MERGE' }),
        }),
      }),
    );
  });

  it('posts the merged comment and completes providers without close capability', async () => {
    candidate = syncRow({ state: 'PR_MERGED' });
    store.claimTrackerSync.mockResolvedValue(candidate);
    delete provider.closeIssue;

    await synchronizer.process(candidate);

    expect(provider.addIssueComment.mock.calls[0][3]).toBe(
      `${MERGED_PHRASE}\n\n- \`acme/app\`: [#7](https://github.com/acme/app/pull/7)`,
    );
    expect(store.updateTrackerSync).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'COMPLETED' }),
    );
  });

  it('posts the merged comment and closes trackers with close capability', async () => {
    candidate = syncRow({ state: 'PR_MERGED' });
    store.claimTrackerSync.mockResolvedValue(candidate);

    await synchronizer.process(candidate);

    expect(provider.addIssueComment.mock.calls[0][3]).toBe(
      `${MERGED_PHRASE}\n\n- \`acme/app\`: [#7](https://github.com/acme/app/pull/7)`,
    );
    expect(provider.closeIssue).toHaveBeenCalledWith({}, 'acme/app', '42');
    expect(store.updateTrackerSync).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'COMPLETED' }),
    );
    expect(store.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'v2.tracker.closed',
        summary: 'Closed Issue #42',
      }),
    );
    expect(broadcast).toHaveBeenCalledWith(
      'i1',
      expect.objectContaining({
        action: 'agent.note',
        noteType: 'v2.tracker.closed',
        summary: 'Closed Issue #42',
      }),
    );
  });

  it('uses native merge request notation in simplified GitLab comments', async () => {
    candidate = syncRow({
      state: 'PR_MERGED',
      pullRequests: [
        {
          provider: 'gitlab',
          repoId: 'acme/app',
          prNumber: 7,
          prUrl: 'https://gitlab.com/acme/app/-/merge_requests/7',
        },
      ],
    });
    store.claimTrackerSync.mockResolvedValue(candidate);
    delete provider.closeIssue;

    await synchronizer.process(candidate);

    expect(provider.addIssueComment.mock.calls[0][3]).toBe(
      `${MERGED_MR_PHRASE}\n\n- \`acme/app\`: [!7](https://gitlab.com/acme/app/-/merge_requests/7)`,
    );
  });

  it('does not duplicate an existing simplified merged comment', async () => {
    candidate = syncRow({ state: 'PR_MERGED' });
    store.claimTrackerSync.mockResolvedValue(candidate);
    provider.getIssueDiscussion.mockResolvedValue([
      {
        body: `${MERGED_PHRASE}\n\n\n\n- \`acme/app\`: [#7](https://github.com/acme/app/pull/7)`,
      },
    ]);

    await synchronizer.process(candidate);

    expect(provider.addIssueComment).not.toHaveBeenCalled();
  });

  it('blocks every tracker provider after ten consecutive write failures', async () => {
    candidate = syncRow({ state: 'PR_CREATED', attempts: 9 });
    store.claimTrackerSync.mockResolvedValue(candidate);
    provider.addIssueComment.mockRejectedValue(new Error('permission denied'));

    await synchronizer.process(candidate);

    expect(store.updateTrackerSync).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'BLOCKED',
        fields: expect.objectContaining({ attempts: 10 }),
      }),
    );
  });

  it('blocks immediately when tracker authorization cannot permit the write', async () => {
    candidate = syncRow({ state: 'PR_CREATED' });
    store.claimTrackerSync.mockResolvedValue(candidate);
    provider.addIssueComment.mockRejectedValue(
      Object.assign(new Error('comment permission denied'), { status: 403 }),
    );

    await synchronizer.process(candidate);

    expect(store.updateTrackerSync).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'BLOCKED',
        fields: expect.objectContaining({ attempts: 1 }),
      }),
    );
  });

  it('surfaces a reconnect instruction for stale Jira grants', async () => {
    candidate = syncRow({
      source: {
        bindingId: 'tb-jira',
        provider: 'jira-cloud',
        instance: 'cloud',
        resourceId: 'PROJ-42',
      },
    });
    store.claimTrackerSync.mockResolvedValue(candidate);
    provider.addIssueComment.mockRejectedValue(
      Object.assign(new Error('Jira connection is missing write:jira-work'), {
        status: 403,
        code: 'MISSING_SCOPES',
        extra: { reconnect: true },
      }),
    );

    await synchronizer.process(candidate);

    expect(store.updateTrackerSync).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'BLOCKED',
        fields: expect.objectContaining({
          lastError: expect.objectContaining({
            code: 'MISSING_SCOPES',
            reconnect: true,
          }),
        }),
      }),
    );
    expect(store.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'v2.tracker.blocked',
        summary: 'Reconnect Jira to resume tracker synchronization',
      }),
    );
  });

  it('processes scheduled sync records with bounded concurrency', async () => {
    const candidates = [syncRow({ executionId: 'e1' }), syncRow({ executionId: 'e2' })];
    store.listTrackerSyncs.mockResolvedValue(candidates);
    let releaseFirst;
    const firstClaim = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    store.claimTrackerSync.mockImplementation(async ({ executionId }) => {
      if (executionId === 'e1') await firstClaim;
      return candidates.find((item) => item.executionId === executionId);
    });

    const scheduled = synchronizer.runScheduled({ concurrency: 2 });
    await vi.waitFor(() =>
      expect(store.claimTrackerSync).toHaveBeenCalledWith(
        expect.objectContaining({ executionId: 'e2' }),
      ),
    );
    releaseFirst();

    await expect(scheduled).resolves.toMatchObject({ processed: 2 });
  });
});
