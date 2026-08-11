import { describe, expect, it, vi } from 'vitest';
import { closeIssue as closeGithubIssue } from '../git-providers/github.js';
import { closeIssue as closeGitlabIssue } from '../git-providers/gitlab.js';

const response = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

describe('git-backed tracker close transport', () => {
  it('closes a GitHub issue', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        number: 42,
        html_url: 'https://github.com/acme/app/issues/42',
        title: 'Issue',
        state: 'closed',
        labels: [],
        user: { login: 'alice' },
      }),
    );

    const issue = await closeGithubIssue({ token: 'token', fetchImpl }, 'acme/app', 42);

    expect(issue.state).toBe('closed');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/app/issues/42',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ state: 'closed' }),
      }),
    );
  });

  it('closes a GitLab issue', async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        iid: 42,
        web_url: 'https://gitlab.com/acme/app/-/issues/42',
        title: 'Issue',
        state: 'closed',
        labels: [],
        author: { username: 'alice' },
      }),
    );

    const issue = await closeGitlabIssue({ token: 'token', fetchImpl }, 'acme/app', 42);

    expect(issue.state).toBe('closed');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/acme%2Fapp/issues/42',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ state_event: 'close' }),
      }),
    );
  });
});
