// Fetches the official aidlc-workflows repo at a pinned commit (or any ref) and
// returns its `core/**` files in memory. This is the seed job's single source
// of truth: rather than hand-transcribe the baseline, we read the real repo at
// an exact ref so the seeded library can never drift from upstream.
//
// Mechanism: download the GitHub codeload tarball for the ref, gunzip + untar
// in memory (no /tmp, no git binary), and collect every file under the repo's
// `core/` directory keyed by its repo-relative path (e.g.
// `core/agents/aidlc-product-agent.md`). Hard-fails on any network/extract
// error — a partial or stale seed is worse than a clear failure the operator
// retries.

import zlib from 'node:zlib';
import tar from 'tar-stream';

const REPO_OWNER = 'awslabs';
const REPO_NAME = 'aidlc-workflows';
const MAX_REPO_TARBALL_BYTES = 50 * 1024 * 1024;
const MAX_REPO_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;
const MAX_REPO_FILES = 5_000;
const MAX_REPO_RETAINED_BYTES = 50 * 1024 * 1024;

// codeload serves a gzipped tarball for any ref (branch, tag, or full/short
// SHA). The archive's top-level dir is `<repo>-<ref>/`, which we strip so keys
// are repo-relative.
const tarballUrl = (ref) => `https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/${ref}`;

// Drops the archive's top-level `<repo>-<ref>/` segment, returning the
// repo-relative path (or null for the root entry itself).
const stripTopLevel = (name) => {
  const slash = name.indexOf('/');
  return slash === -1 ? null : name.slice(slash + 1);
};

// Streams the gzipped tarball through the extractor, collecting file entries
// whose repo-relative path starts with one of `prefixes`. Returns Map<path, Buffer>.
const extractFiles = (
  gzBuffer,
  prefixes,
  {
    maxFiles = MAX_REPO_FILES,
    maxRetainedBytes = MAX_REPO_RETAINED_BYTES,
    maxUncompressedBytes = MAX_REPO_UNCOMPRESSED_BYTES,
  } = {},
) =>
  new Promise((resolve, reject) => {
    const files = new Map();
    let fileBytes = 0;
    let uncompressedBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const extract = tar.extract();

    extract.on('entry', (header, stream, next) => {
      const rel = stripTopLevel(header.name);
      const keep =
        header.type === 'file' && rel && prefixes.some((prefix) => rel.startsWith(prefix));
      if (!keep) {
        stream.on('end', next);
        stream.resume();
        return;
      }
      if (files.size >= maxFiles) {
        stream.on('end', next);
        stream.resume();
        fail(new Error(`repo-fetch: exceeds ${maxFiles} matching files`));
        return;
      }
      const chunks = [];
      stream.on('data', (chunk) => {
        if (settled) return;
        fileBytes += chunk.length;
        if (fileBytes > maxRetainedBytes) {
          fail(new Error(`repo-fetch: matching files exceed ${maxRetainedBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => {
        if (!settled) files.set(rel, Buffer.concat(chunks));
        next();
      });
      stream.on('error', fail);
    });

    extract.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve(files);
    });
    extract.on('error', fail);

    const gunzip = zlib.createGunzip();
    gunzip.on('data', (chunk) => {
      uncompressedBytes += chunk.length;
      if (uncompressedBytes > maxUncompressedBytes) {
        fail(new Error(`repo-fetch: tarball expands beyond ${maxUncompressedBytes} bytes`));
        gunzip.destroy();
      }
    });
    gunzip.on('error', fail);
    gunzip.pipe(extract);
    gunzip.end(gzBuffer);
  });

const responseToBuffer = async (res, maxBytes) => {
  const declaredBytes = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    throw new Error(`repo-fetch: tarball exceeds ${maxBytes} bytes`);
  }

  const chunks = [];
  let bytes = 0;
  if (res.body?.[Symbol.asyncIterator]) {
    for await (const chunk of res.body) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error(`repo-fetch: tarball exceeds ${maxBytes} bytes`);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error(`repo-fetch: tarball exceeds ${maxBytes} bytes`);
  return buffer;
};

const fetchRepoFiles = async (
  ref,
  {
    prefixes,
    maxTarballBytes = MAX_REPO_TARBALL_BYTES,
    maxFiles = MAX_REPO_FILES,
    maxRetainedBytes = MAX_REPO_RETAINED_BYTES,
    maxUncompressedBytes = MAX_REPO_UNCOMPRESSED_BYTES,
  },
) => {
  if (!ref || typeof ref !== 'string') {
    throw new Error('repo-fetch: a ref (commit SHA, tag, or branch) is required');
  }
  if (!Array.isArray(prefixes) || prefixes.length === 0) {
    throw new Error('repo-fetch: at least one path prefix is required');
  }
  const url = tarballUrl(ref);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'collaborative-ai-dlc', Accept: 'application/x-gzip' },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`repo-fetch: ${url} returned ${res.status} ${res.statusText}`);
  }
  const gzBuffer = await responseToBuffer(res, maxTarballBytes);
  const files = await extractFiles(gzBuffer, prefixes, {
    maxFiles,
    maxRetainedBytes,
    maxUncompressedBytes,
  });
  if (files.size === 0) {
    throw new Error(
      `repo-fetch: no files found for prefixes ${prefixes.join(', ')} in tarball for ref ${ref}`,
    );
  }
  return files;
};

// Downloads + extracts the repo's core/ files at `ref`. Throws on any failure.
const fetchCoreFiles = async (ref) => {
  const files = await fetchRepoFiles(ref, { prefixes: ['core/'] });
  return new Map([...files].map(([path, body]) => [path, body.toString('utf8')]));
};

export {
  MAX_REPO_FILES,
  MAX_REPO_RETAINED_BYTES,
  MAX_REPO_TARBALL_BYTES,
  MAX_REPO_UNCOMPRESSED_BYTES,
  fetchCoreFiles,
  fetchRepoFiles,
  extractFiles,
  responseToBuffer,
  tarballUrl,
  REPO_OWNER,
  REPO_NAME,
};
export default { fetchCoreFiles, fetchRepoFiles, extractFiles, tarballUrl, REPO_OWNER, REPO_NAME };
