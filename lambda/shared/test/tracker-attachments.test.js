import { describe, expect, it, vi } from 'vitest';
import { discoverLinkedAttachments, transferTrackerAttachment } from '../tracker-attachments.js';

const asset = 'https://github.com/user-attachments/assets/abc';
const discover = (body, comments = [], provider = 'github') =>
  discoverLinkedAttachments({
    provider,
    repository: 'acme/app',
    issue: { body, resourceUrl: 'https://github.com/acme/app/issues/1' },
    comments,
  });

describe('tracker attachment discovery', () => {
  it('accepts GitHub attachments created before user-attachments URLs', () => {
    const url = 'https://github.com/acme/app/files/123/design.pdf';
    const files = discover(`[Design](${url})`);
    expect(files[0]).toMatchObject({ url, filename: 'design.pdf' });
    expect(files[0].skipReason).toBeUndefined();
  });
  it('deduplicates images, HTML, raw URLs, and comment references while retaining provenance', () => {
    const files = discover(`![Image](${asset})\n<img src="${asset}">`, [
      {
        id: 'comment-1',
        body: `${asset}?raw=true\n[Design](https://github.com/user-attachments/files/123/design.pdf)`,
      },
    ]);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ url: asset, filename: 'abc', commentId: null });
    expect(files[1]).toMatchObject({ filename: 'design.pdf', commentId: 'comment-1' });
  });

  it('resolves GitLab upload links relative to the project', () => {
    const files = discover(
      '[Spec](/uploads/0123456789abcdef0123456789abcdef/spec.docx)',
      [],
      'gitlab',
    );
    expect(files[0]).toMatchObject({
      url: 'https://gitlab.com/acme/app/uploads/0123456789abcdef0123456789abcdef/spec.docx',
      filename: 'spec.docx',
    });
    expect(files[0].skipReason).toBeUndefined();
  });

  it('ignores ordinary links and reports external file links without making them fetchable', () => {
    const files = discover(
      '[Docs](https://example.com/docs)\n![Screenshot](https://example.com/private.png)',
    );
    expect(files).toHaveLength(1);
    expect(files[0].skipReason).toContain('External');
  });

  it.each([
    'https://github.com.evil.test/user-attachments/files/1/spec.pdf',
    'http://github.com/user-attachments/files/1/spec.pdf',
    'https://github.com:444/user-attachments/files/1/spec.pdf',
    'https://127.0.0.1/spec.pdf',
  ])('does not allow downloads from %s', (url) => {
    expect(discover(`[File](${url})`)[0].skipReason).toContain('External');
  });

  it('rejects credential-bearing links', () => {
    const url = new URL(asset);
    url.username = 'fixture-user';
    url.password = 'fixture-password';
    expect(discover(`[Image](${url.href})`)[0].skipReason).toContain('External');
  });

  it('ignores malformed percent encoding without losing other files', () => {
    expect(discover(`${asset}/bad%xx.pdf\n${asset}`)).toHaveLength(1);
  });
});

describe('tracker file transfer', () => {
  const attachment = { id: 'a', filename: 'image', url: asset };
  const transfer = (options) =>
    transferTrackerAttachment({
      attachment,
      maxBytes: 5,
      uploadUrl: 'https://uploads.example.test/signed',
      ...options,
    });
  const uploaded = () => new Response('', { headers: { 'x-amz-version-id': 'v1' } });

  it('uploads original bytes and returns only metadata and the object version', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(uploaded());
    const result = await transfer({
      request: vi.fn().mockResolvedValue(
        new Response('hello', {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="design.pdf"',
          },
        }),
      ),
      fetchImpl,
    });
    expect(result).toMatchObject({
      status: 'downloaded',
      size: 5,
      filename: 'design.pdf',
      versionId: 'v1',
    });
    expect(fetchImpl.mock.calls[0][1].body.toString()).toBe('hello');
    expect(result).not.toHaveProperty('body');
  });

  it.each([true, false])('enforces the byte limit with content-length=%s', async (withLength) => {
    const fetchImpl = vi.fn();
    const result = await transfer({
      request: async () =>
        new Response('too large', {
          headers: withLength ? { 'content-length': '9' } : {},
        }),
      fetchImpl,
    });
    expect(result.status).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('follows an approved signed redirect without forwarding credentials', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('file'))
      .mockResolvedValueOnce(uploaded());
    const result = await transfer({
      request: async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://assets.example.test/file?signature=value' },
        }),
      allowedRedirectHosts: ['assets.example.test'],
      fetchImpl,
    });
    expect(result.status).toBe('downloaded');
    expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty('headers');
  });

  it('rejects a redirect to a private address before fetching it', async () => {
    const fetchImpl = vi.fn();
    const result = await transfer({
      request: async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://169.254.169.254/latest' },
        }),
      fetchImpl,
    });
    expect(result.status).toBe('failed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports missing access and does not upload the error body', async () => {
    const fetchImpl = vi.fn();
    const result = await transfer({
      request: async () => new Response('denied', { status: 403 }),
      fetchImpl,
    });
    expect(result.reason).toContain('cannot access');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
