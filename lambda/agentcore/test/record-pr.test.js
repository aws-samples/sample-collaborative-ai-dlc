import { describe, it, expect, vi } from 'vitest';
import { recordPr } from '../commands/record-pr.js';

const pr = (overrides = {}) => ({
  repoId: 'owner/repo',
  prUrl: 'https://github.com/owner/repo/pull/1',
  prNumber: 1,
  branch: 'aidlc/intent-1',
  baseBranch: 'main',
  ...overrides,
});

describe('recordPr', () => {
  it('writes one vertex per PR and broadcasts agent.pr (no success event — the orchestrator emits it)', async () => {
    const writer = {
      recordPullRequest: vi.fn(async ({ repoId }) => ({ id: `pr:i:${repoId}`, repoId })),
    };
    const store = { appendEvent: vi.fn(async () => {}) };
    const broadcast = vi.fn(async () => {});
    const out = await recordPr(
      { projectId: 'p', intentId: 'i', executionId: 'e', prs: [pr(), pr({ repoId: 'owner/web' })] },
      { openGraph: async () => ({}), createWriter: () => writer, store, broadcast },
    );
    expect(out).toMatchObject({ ok: true });
    expect(out.recorded).toHaveLength(2);
    expect(writer.recordPullRequest).toHaveBeenCalledTimes(2);
    // No timeline event on success (dedup: the orchestrator owns v2.pr.recorded).
    expect(store.appendEvent).not.toHaveBeenCalled();
    expect(broadcast.mock.calls[0][0]).toMatchObject({ action: 'agent.pr' });
  });

  it('returns missing_input without opening the graph (no identity)', async () => {
    const openGraph = vi.fn();
    await expect(recordPr({ prs: [pr()] }, { openGraph })).resolves.toEqual({
      ok: false,
      reason: 'missing_input',
    });
    expect(openGraph).not.toHaveBeenCalled();
  });

  it('returns missing_input without opening the graph (empty prs)', async () => {
    const openGraph = vi.fn();
    await expect(
      recordPr({ intentId: 'i', executionId: 'e', prs: [] }, { openGraph }),
    ).resolves.toEqual({ ok: false, reason: 'missing_input' });
    expect(openGraph).not.toHaveBeenCalled();
  });

  it('never throws on a graph failure: records v2.pr.record_failed and returns ok:false', async () => {
    const writer = {
      recordPullRequest: vi.fn(async () => {
        throw new Error('neptune down');
      }),
    };
    const store = { appendEvent: vi.fn(async () => {}) };
    const out = await recordPr(
      { projectId: 'p', intentId: 'i', executionId: 'e', prs: [pr()] },
      { openGraph: async () => ({}), createWriter: () => writer, store, broadcast: async () => {} },
    );
    expect(out).toMatchObject({ ok: false, reason: 'record_failed', detail: 'neptune down' });
    expect(store.appendEvent.mock.calls.at(-1)[0].type).toBe('v2.pr.record_failed');
  });
});
