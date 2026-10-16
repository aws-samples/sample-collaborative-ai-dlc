import { describe, expect, it, vi } from 'vitest';
import github from '../git-providers/github.js';
import gitlab from '../git-providers/gitlab.js';

const json = (data, headers = {}) =>
  new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json', ...headers },
  });

const imageId = '11111111-2222-4333-8444-555555555555';
const image = `https://github.com/user-attachments/assets/${imageId}`;
const signedImage = `https://private-user-images.githubusercontent.com/123/456-${imageId}.png?jwt=test-signature`;

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

  it.each(['issue', 'comment'])(
    'downloads a private image from the rendered %s using its exact asset ID',
    async (location) => {
      const body = `<img width="430" height="1050" alt="Image" src="${image}" />`;
      const html = `<img src="https://private-user-images.githubusercontent.com/123/999-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png?jwt=another"><img src="${signedImage}">`;
      const fetchImpl = vi.fn(async (url, options) => {
        const full = options.headers?.Accept === 'application/vnd.github.full+json';
        if (url.endsWith('/issues/42')) {
          return json({
            number: 42,
            labels: [],
            user: {},
            body: location === 'issue' ? body : 'See comments.',
            ...(full && location === 'issue' ? { body_html: html } : {}),
          });
        }
        if (url.includes('/comments?')) {
          if (location !== 'comment') return json([]);
          if (url.endsWith('page=1')) {
            return json([{ id: 1, body: 'First comment', user: {} }], {
              link: '<https://api.github.com/comments?page=2>; rel="next"',
            });
          }
          return json([{ id: 2, body, user: {}, ...(full ? { body_html: html } : {}) }]);
        }
        if (url === signedImage)
          return new Response('image-bytes', { headers: { 'content-type': 'image/png' } });
        if (url === image) return new Response('Not Found', { status: 404 });
        if (options.method === 'PUT')
          return new Response('', { headers: { 'x-amz-version-id': 'v1' } });
        throw new Error('Unexpected URL');
      });
      const ctx = { token: 'app-installation-token', fetchImpl };
      const { attachments } = await github.issueAttachments(ctx, 'acme/app', { number: 42 });
      expect(attachments).toHaveLength(1);
      expect(JSON.stringify(attachments)).not.toContain('jwt=');
      const result = await github.issueAttachments(ctx, 'acme/app', {
        number: 42,
        attachmentId: attachments[0].id,
        maxBytes: 100,
        uploadUrl: 'https://artifacts.s3.amazonaws.com/signed',
      });
      expect(result).toMatchObject({
        status: 'downloaded',
        mimeType: 'image/png',
        size: 11,
        source: { url: image, commentId: location === 'comment' ? '2' : null },
      });
      expect(fetchImpl.mock.calls.find(([url]) => url === signedImage)[1]).not.toHaveProperty(
        'headers',
      );
      expect(fetchImpl.mock.calls.at(-1)[1].headers).not.toHaveProperty('Authorization');
      expect(fetchImpl.mock.calls.some(([url]) => url === image)).toBe(false);
      expect(JSON.stringify(result)).not.toContain('jwt=');
    },
  );

  it.each([
    '',
    'not-a-url',
    signedImage.replace('private-user-images.githubusercontent.com', 'other.example.test'),
    signedImage.replace('https:', 'http:'),
    signedImage.replace('https://', 'https://user@'),
    signedImage.replace('.com/', '.com:444/'),
    signedImage.replace(`${imageId}.png`, `${imageId}-other.png`),
    `https://private-user-images.githubusercontent.com/unrelated.png?id=${imageId}`,
  ])('does not substitute an unrelated or unsafe rendered image URL: %s', async (renderedUrl) => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/issues/42'))
        return json({
          number: 42,
          body: `![Image](${image})`,
          body_html: `<img src="${renderedUrl}">`,
          labels: [],
          user: {},
        });
      if (url.includes('/comments?')) return json([]);
      if (url === image) return new Response('Not Found', { status: 404 });
      throw new Error('Unexpected URL');
    });
    const ctx = { token: 'app-installation-token', fetchImpl };
    const { attachments } = await github.issueAttachments(ctx, 'acme/app', { number: 42 });
    const result = await github.issueAttachments(ctx, 'acme/app', {
      number: 42,
      attachmentId: attachments[0].id,
      maxBytes: 100,
      uploadUrl: 'https://artifacts.s3.amazonaws.com/signed',
    });
    expect(result).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('cannot access'),
    });
    expect(fetchImpl.mock.calls.at(-1)[0]).toBe(image);
    expect(fetchImpl.mock.calls.some(([url]) => url === renderedUrl)).toBe(false);
  });

  it('follows GitHub’s observed S3 asset redirect without forwarding the repository token', async () => {
    const storage =
      'https://github-production-user-asset-6210df.s3.amazonaws.com/file.png?signed=value';
    const fetchImpl = vi.fn(async (url, options) => {
      if (url.endsWith('/issues/42'))
        return json({ number: 42, body: `![Image](${image})`, labels: [], user: {} });
      if (url.includes('/comments?')) return json([]);
      if (url === image) return new Response(null, { status: 302, headers: { location: storage } });
      if (url === storage)
        return new Response('image', { headers: { 'content-type': 'image/png' } });
      if (options.method === 'PUT')
        return new Response('', { headers: { 'x-amz-version-id': 'v1' } });
      throw new Error('Unexpected URL');
    });
    const ctx = { token: 'test-token', fetchImpl };
    const { attachments } = await github.issueAttachments(ctx, 'acme/app', { number: 42 });
    const result = await github.issueAttachments(ctx, 'acme/app', {
      number: 42,
      attachmentId: attachments[0].id,
      maxBytes: 100,
      uploadUrl: 'https://artifacts.s3.amazonaws.com/signed',
    });
    expect(result.status).toBe('downloaded');
    expect(fetchImpl.mock.calls.find(([url]) => url === image)[1].headers.Authorization).toBe(
      'Bearer test-token',
    );
    expect(fetchImpl.mock.calls.find(([url]) => url === storage)[1]).not.toHaveProperty('headers');
    expect(fetchImpl.mock.calls.at(-1)[1].headers).not.toHaveProperty('Authorization');
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
