import { describe, expect, it, vi } from 'vitest';
import { recordUnitPr } from '../commands/record-unit-pr.js';

const unitPr = {
  sectionIndex: 2,
  unitSlug: 'auth',
  repoId: 'owner/api',
  provider: 'github',
  prUrl: 'https://example.test/pr/7',
  prNumber: 7,
  sourceBranch: 'unit',
  targetBranch: 'intent',
};

describe('recordUnitPr', () => {
  it('records and broadcasts unit review PRs independently from final PRs', async () => {
    const writer = {
      recordUnitPullRequest: vi.fn(async (pr) => ({
        id: `unit-pr:i:s${pr.sectionIndex}:${pr.unitSlug}:${pr.repoId}:${pr.provider}:${pr.prNumber}`,
      })),
    };
    const broadcast = vi.fn(async () => {});
    const output = await recordUnitPr(
      { projectId: 'p', intentId: 'i', executionId: 'e', unitPrs: [unitPr] },
      {
        openGraph: async () => ({}),
        createWriter: () => writer,
        store: { appendEvent: vi.fn() },
        broadcast,
      },
    );
    expect(output).toMatchObject({
      ok: true,
      recorded: [{ id: expect.stringMatching(/^unit-pr:/) }],
    });
    expect(writer.recordUnitPullRequest).toHaveBeenCalledWith(unitPr);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent.unit-pr', unitPrs: output.recorded }),
    );
  });

  it('fails open when the graph projection is unavailable', async () => {
    const appendEvent = vi.fn(async () => {});
    await expect(
      recordUnitPr(
        { intentId: 'i', executionId: 'e', unitPrs: [unitPr] },
        {
          openGraph: async () => {
            throw new Error('neptune unavailable');
          },
          store: { appendEvent },
        },
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'record_failed' });
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'v2.unit_pr.record_failed' }),
    );
  });
});
