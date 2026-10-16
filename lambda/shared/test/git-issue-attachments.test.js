import { describe, expect, it, vi } from 'vitest';
import github from '../git-providers/github.js';
import gitlab from '../git-providers/gitlab.js';

const json = (data, headers = {}) =>
  new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('Git issue attachment providers', () => {
  it('finds GitHub files in later comment pages and deduplicates the issue body', async () => {
    const asset = 'https://github.com/user-attachments/files/123/spec.pdf';
    const second = 'https://github.com/acme/app/files/234/spec.xlsx';
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ number: 42, body: `[Spec](${asset})`, labels: [], user: {} }))
      .mockResolvedValueOnce(
        json([{ id: 1, body: asset, user: {} }], {
          link: '<https://api.github.com/comments?page=2>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(json([{ id: 2, body: second, user: {} }]));
    const { attachments } = await github.issueAttachments(
      { token: 'test-token', fetchImpl },
      'acme/app',
      { number: 42 },
    );
    expect(attachments).toHaveLength(2);
    expect(attachments[1]).toMatchObject({ filename: 'spec.xlsx', commentId: '2' });
    expect(fetchImpl.mock.calls[2][0]).toContain('page=2');
  });

  it('downloads a GitLab upload through the bound project API and keeps auth off S3', async () => {
    const body = '[Spec](/uploads/0123456789abcdef0123456789abcdef/spec.pdf)';
    const fetchImpl = vi.fn().mockImplementation(async (url, options) => {
      if (url.endsWith('/issues/42'))
        return json({ iid: 42, description: body, labels: [], author: {} });
      if (url.includes('/notes?')) return json([]);
      if (url.includes('/uploads/'))
        return new Response('pdf-bytes', { headers: { 'content-type': 'application/pdf' } });
      if (options.method === 'PUT')
        return new Response('', { headers: { 'x-amz-version-id': 'v1' } });
      throw new Error(`Unexpected test URL: ${url}`);
    });
    const ctx = { token: 'test-token', fetchImpl };
    const { attachments } = await gitlab.issueAttachments(ctx, 'acme/app', { number: 42 });
    const result = await gitlab.issueAttachments(ctx, 'acme/app', {
      number: 42,
      attachmentId: attachments[0].id,
      maxBytes: 100,
      uploadUrl: 'https://artifacts.s3.amazonaws.com/signed',
    });
    expect(result).toMatchObject({ status: 'downloaded', filename: 'spec.pdf', size: 9 });
    const request = fetchImpl.mock.calls.find(([url]) => url.includes('/uploads/'));
    expect(request[0]).toContain('/api/v4/projects/acme%2Fapp/uploads/');
    expect(request[1].headers.Authorization).toContain('test-token');
    expect(fetchImpl.mock.calls.at(-1)[1].headers).not.toHaveProperty('Authorization');
  });

  it.each([github, gitlab])(
    'rejects an issue number that could escape the bound API path (%s)',
    async (provider) => {
      const fetchImpl = vi.fn();
      await expect(
        provider.issueAttachments({ fetchImpl }, 'acme/app', { number: '../../another-project' }),
      ).rejects.toMatchObject({ status: 400 });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});
