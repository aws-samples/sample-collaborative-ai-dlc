import { describe, expect, it, vi } from 'vitest';
import { getProvider, KNOWN_PROVIDERS } from '../providers/index.js';
import { provider as gitlabIssuesProvider } from '../providers/gitlab-issues.js';

describe('GitLab Issues project binding adapter', () => {
  it('is registered', () => {
    expect(KNOWN_PROVIDERS).toContain('gitlab-issues');
    expect(getProvider('gitlab-issues', 'public')).toBe(gitlabIssuesProvider);
  });

  it('delegates every issue call to project source control', async () => {
    const sourceControl = vi.fn().mockResolvedValue({});
    const ctx = { sourceControl };
    await gitlabIssuesProvider.listIssues(ctx, 'group/project', { state: 'closed' });
    await gitlabIssuesProvider.getIssue(ctx, 'group/project', '7');
    await gitlabIssuesProvider.getIssueDiscussion(ctx, 'group/project', '7');
    await gitlabIssuesProvider.addIssueComment(ctx, 'group/project', '7', 'Done');
    expect(sourceControl.mock.calls.map(([request]) => request)).toEqual([
      {
        repository: 'group/project',
        operation: 'list-issues',
        args: { state: 'closed' },
      },
      {
        repository: 'group/project',
        operation: 'get-issue',
        args: { number: '7' },
      },
      {
        repository: 'group/project',
        operation: 'list-issue-comments',
        args: { number: '7' },
      },
      {
        repository: 'group/project',
        operation: 'add-issue-comment',
        args: { number: '7', body: 'Done' },
      },
    ]);
  });
});
