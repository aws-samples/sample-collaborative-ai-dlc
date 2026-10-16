import { createHash } from 'node:crypto';

const fileExtension = /\.(?:pdf|docx|xlsx|txt|md|csv|html|png|jpe?g|webp|svg)$/i;

const attachmentId = (url) => createHash('sha256').update(url).digest('hex');

// Only recognize provider uploads and explicit file/image references. Ordinary
// links in a discussion (documentation, other issues, etc.) are not attachments.
export const discoverLinkedAttachments = ({ provider, repository, issue, comments }) => {
  const found = new Map();
  for (const entry of [{ body: issue.body }, ...comments]) {
    const text = entry.body || '';
    const references = [];
    for (const match of text.matchAll(/!?\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      references.push({ label: match[1], url: match[2], image: match[0].startsWith('!') });
    }
    for (const match of text.matchAll(
      /<(?:img|a)\b[^>]*?\b(?:src|href)=["']([^"']+)["'][^>]*>/gi,
    )) {
      references.push({ url: match[1], image: /^<img/i.test(match[0]) });
    }
    for (const match of text.matchAll(/https:\/\/[^\s<>"')]+/g)) references.push({ url: match[0] });
    for (const reference of references) {
      let url;
      try {
        const base =
          provider === 'gitlab' ? `https://gitlab.com/${repository}/` : issue.resourceUrl;
        // GitLab's Markdown upload paths are relative to the project, even
        // though their leading slash resembles an origin-relative URL.
        url = new URL(
          provider === 'gitlab' && reference.url.startsWith('/uploads/')
            ? reference.url.slice(1)
            : reference.url,
          base,
        );
      } catch {
        continue;
      }
      const githubUpload =
        (url.hostname === 'github.com' &&
          (/^\/user-attachments\/(?:assets|files)\//.test(url.pathname) ||
            /^\/[^/]+\/[^/]+\/(?:assets|files)\//.test(url.pathname))) ||
        url.hostname === 'user-images.githubusercontent.com';
      const gitlabUpload =
        url.hostname === 'gitlab.com' && url.pathname.startsWith(`/${repository}/uploads/`);
      let filename;
      try {
        filename = decodeURIComponent(url.pathname.split('/').pop() || '');
      } catch {
        continue;
      }
      if (!githubUpload && !gitlabUpload && !reference.image && !fileExtension.test(filename)) {
        continue;
      }
      url.hash = '';
      const supported =
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.port &&
        (provider === 'github' ? githubUpload : gitlabUpload);
      const key = supported ? `${url.origin}${url.pathname}` : url.href;
      if (found.has(key)) continue;
      found.set(key, {
        id: attachmentId(key),
        url: url.href,
        filename: fileExtension.test(reference.label || '') ? reference.label : filename,
        commentId: entry.id || null,
        ...(!supported
          ? { skipReason: 'External file links are not supported; attach the file to the issue.' }
          : {}),
      });
    }
  }
  return [...found.values()];
};

const filenameFromResponse = (response, fallback) => {
  const disposition = response.headers.get('content-disposition') || '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quoted = disposition.match(/filename="([^"]+)"/i)?.[1];
  const bare = disposition.match(/filename=([^;\s]+)/i)?.[1];
  try {
    return encoded ? decodeURIComponent(encoded) : quoted || bare || fallback;
  } catch {
    return fallback;
  }
};

// Bytes stay in the credential-owning Lambda and go straight to an
// intent-scoped, short-lived S3 upload URL. They never cross a Lambda JSON
// response (a 5 MB file would exceed that response limit after base64 encoding).
export const transferTrackerAttachment = async ({
  attachment,
  request,
  uploadUrl,
  maxBytes,
  fetchImpl = fetch,
  allowedRedirectHosts = [],
}) => {
  if (attachment.skipReason) return { status: 'skipped', reason: attachment.skipReason };
  const signal = AbortSignal.timeout(15_000);
  try {
    let response = await request({ signal, redirect: 'manual' });
    for (let redirects = 0; response.status >= 300 && response.status < 400; redirects += 1) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects >= 3)
        throw new Error('The attachment redirect could not be followed.');
      const target = new URL(location);
      if (
        target.protocol !== 'https:' ||
        target.username ||
        target.password ||
        target.port ||
        !allowedRedirectHosts.includes(target.hostname)
      ) {
        return {
          status: 'failed',
          reason: 'The provider redirected the file to an unsupported host.',
        };
      }
      // Signed provider redirects authenticate themselves. Never forward the
      // repository or Jira credential to the object storage host.
      response = await fetchImpl(target.href, { signal, redirect: 'manual' });
    }
    if (!response.ok) {
      await response.body?.cancel();
      return {
        status: 'failed',
        reason: [401, 403, 404].includes(response.status)
          ? 'The attachment is missing or the connected account cannot access it.'
          : `The provider could not download the attachment (HTTP ${response.status}).`,
      };
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      return { status: 'skipped', reason: 'The attachment exceeds the 5 MB per-file limit.' };
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) {
        return { status: 'skipped', reason: 'The attachment exceeds the 5 MB per-file limit.' };
      }
      chunks.push(Buffer.from(chunk));
    }
    if (!size) return { status: 'skipped', reason: 'The attachment is empty.' };
    const mimeType = (response.headers.get('content-type') || 'application/octet-stream')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const upload = await fetchImpl(uploadUrl, {
      method: 'PUT',
      body: Buffer.concat(chunks),
      headers: { 'Content-Type': mimeType },
      signal,
    });
    if (!upload.ok) throw new Error('The attachment could not be stored.');
    const versionId = upload.headers.get('x-amz-version-id');
    if (!versionId) throw new Error('The attachment upload did not return an object version.');
    return {
      status: 'downloaded',
      filename: filenameFromResponse(response, attachment.filename),
      mimeType,
      size,
      versionId,
      source: attachment,
    };
  } catch (error) {
    return {
      status: 'failed',
      reason:
        error.name === 'TimeoutError' || signal.aborted
          ? 'The attachment download timed out.'
          : 'The attachment could not be downloaded or stored.',
    };
  }
};
