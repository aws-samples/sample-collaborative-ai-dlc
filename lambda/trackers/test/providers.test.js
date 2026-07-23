import { describe, expect, it, vi } from 'vitest';
import { getProvider, KNOWN_PROVIDERS, ProviderError } from '../providers/index.js';
import { provider as githubIssuesProvider } from '../providers/github-issues.js';

describe('tracker provider registry', () => {
  it('registers GitHub Issues', () => {
    expect(KNOWN_PROVIDERS).toContain('github-issues');
    expect(getProvider('github-issues', 'public')).toBe(githubIssuesProvider);
  });

  it('rejects unknown providers and instances', () => {
    expect(() => getProvider('unknown-provider', 'cloud')).toThrow(ProviderError);
    expect(() => getProvider('github-issues', 'enterprise')).toThrow(ProviderError);
  });
});

describe('GitHub Issues project binding adapter', () => {
  it('delegates issue operations without accepting credential fields', async () => {
    const sourceControl = vi.fn().mockResolvedValue({ items: [] });
    const result = await githubIssuesProvider.listIssues(
      { sourceControl, token: 'must-not-be-used' },
      'acme/widgets',
      { state: 'open' },
    );
    expect(result).toEqual({ items: [] });
    expect(sourceControl).toHaveBeenCalledWith({
      repository: 'acme/widgets',
      operation: 'list-issues',
      args: { state: 'open' },
    });
    expect(JSON.stringify(sourceControl.mock.calls)).not.toContain('must-not-be-used');
  });

  it('delegates detail, discussion, and comment writes', async () => {
    const sourceControl = vi.fn().mockResolvedValue({});
    const ctx = { sourceControl };
    await githubIssuesProvider.getIssue(ctx, 'acme/widgets', '42');
    await githubIssuesProvider.getIssueDiscussion(ctx, 'acme/widgets', '42');
    await githubIssuesProvider.addIssueComment(ctx, 'acme/widgets', '42', 'Ship it');
    expect(sourceControl.mock.calls.map(([request]) => request.operation)).toEqual([
      'get-issue',
      'list-issue-comments',
      'add-issue-comment',
    ]);
  });

  it('fails closed without the source-control service', async () => {
    expect(() => githubIssuesProvider.listIssues({}, 'acme/widgets', {})).toThrow(
      expect.objectContaining({ status: 503 }),
    );
  });
});
