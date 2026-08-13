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
const extractFiles = (gzBuffer, prefixes) =>
  new Promise((resolve, reject) => {
    const files = new Map();
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
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        files.set(rel, Buffer.concat(chunks));
        next();
      });
      stream.on('error', reject);
    });

    extract.on('finish', () => resolve(files));
    extract.on('error', reject);

    const gunzip = zlib.createGunzip();
    gunzip.on('error', reject);
    gunzip.pipe(extract);
    gunzip.end(gzBuffer);
  });

const fetchRepoFiles = async (ref, { prefixes }) => {
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
  const gzBuffer = Buffer.from(await res.arrayBuffer());
  const files = await extractFiles(gzBuffer, prefixes);
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

export { fetchCoreFiles, fetchRepoFiles, extractFiles, tarballUrl, REPO_OWNER, REPO_NAME };
export default { fetchCoreFiles, fetchRepoFiles, extractFiles, tarballUrl, REPO_OWNER, REPO_NAME };
