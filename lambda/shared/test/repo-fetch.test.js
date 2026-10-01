import { describe, it, expect, vi, afterEach } from 'vitest';
import zlib from 'node:zlib';
import tar from 'tar-stream';
import {
  extractFiles,
  fetchCoreFiles,
  fetchRepoFiles,
  responseToBuffer,
  tarballUrl,
} from '../repo-fetch.js';

// Builds a gzipped tarball whose entries are nested under a top-level
// `<repo>-<ref>/` dir, mirroring GitHub's codeload archive layout.
const makeTarball = (files, top = 'aidlc-workflows-abc123') =>
  new Promise((resolve, reject) => {
    const pack = tar.pack();
    for (const [name, content] of Object.entries(files)) {
      pack.entry({ name: `${top}/${name}` }, content);
    }
    pack.finalize();
    const chunks = [];
    const gzip = zlib.createGzip();
    pack.pipe(gzip);
    gzip.on('data', (c) => chunks.push(c));
    gzip.on('end', () => resolve(Buffer.concat(chunks)));
    gzip.on('error', reject);
  });

const mockFetchReturning = (buffer, ok = true, status = 200) => {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Not Found',
    arrayBuffer: async () => buffer,
  });
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchCoreFiles', () => {
  it('downloads, gunzips, untars, and keeps only repo-relative core/ files', async () => {
    const tarball = await makeTarball({
      'core/agents/aidlc-product-agent.md': '# Product Agent',
      'core/tools/aidlc-orchestrate.ts': '// engine',
      'README.md': 'not core',
      'docs/guide/intro.md': 'also not core',
    });
    mockFetchReturning(tarball);

    const files = await fetchCoreFiles('abc123');
    expect([...files.keys()].toSorted()).toEqual([
      'core/agents/aidlc-product-agent.md',
      'core/tools/aidlc-orchestrate.ts',
    ]);
    expect(files.get('core/agents/aidlc-product-agent.md')).toBe('# Product Agent');
  });

  it('requests the codeload tarball for the given ref', async () => {
    const tarball = await makeTarball({ 'core/x.md': 'x' });
    mockFetchReturning(tarball);
    await fetchCoreFiles('v2');
    expect(globalThis.fetch).toHaveBeenCalledWith(tarballUrl('v2'), expect.any(Object));
    expect(tarballUrl('v2')).toBe('https://codeload.github.com/awslabs/aidlc-workflows/tar.gz/v2');
  });

  it('hard-fails on a non-OK response (no fallback)', async () => {
    mockFetchReturning(Buffer.alloc(0), false, 404);
    await expect(fetchCoreFiles('nope')).rejects.toThrow(/404/);
  });

  it('hard-fails when the tarball has no core/ files', async () => {
    const tarball = await makeTarball({ 'README.md': 'only readme' });
    mockFetchReturning(tarball);
    await expect(fetchCoreFiles('abc123')).rejects.toThrow(/no files found for prefixes core\//);
  });

  it('requires a ref', async () => {
    await expect(fetchCoreFiles('')).rejects.toThrow(/ref/);
  });
});

describe('fetchRepoFiles', () => {
  it('returns binary-safe files from all requested prefixes', async () => {
    const tarball = await makeTarball({
      'core/stages/a.md': '# Stage A',
      'dist/codex/AGENTS.md': '# Codex',
      'README.md': 'ignored',
    });
    mockFetchReturning(tarball);
    const files = await fetchRepoFiles('abc123', { prefixes: ['core/', 'dist/codex/'] });
    expect(Buffer.isBuffer(files.get('core/stages/a.md'))).toBe(true);
    expect(files.get('dist/codex/AGENTS.md').toString('utf8')).toContain('Codex');
  });

  it('rejects a response whose declared size exceeds the download limit', async () => {
    await expect(
      responseToBuffer(
        {
          headers: { get: () => '11' },
          arrayBuffer: async () => Buffer.alloc(0),
        },
        10,
      ),
    ).rejects.toThrow(/tarball exceeds 10 bytes/);
  });

  it('rejects a streamed response that exceeds the download limit', async () => {
    await expect(
      responseToBuffer(
        {
          headers: { get: () => null },
          body: {
            async *[Symbol.asyncIterator]() {
              yield Buffer.alloc(6);
              yield Buffer.alloc(5);
            },
          },
        },
        10,
      ),
    ).rejects.toThrow(/tarball exceeds 10 bytes/);
  });

  it('bounds matching files while extracting the tarball', async () => {
    const tarball = await makeTarball({
      'dist/codex/a.txt': '123456',
      'dist/codex/b.txt': '123456',
    });
    await expect(extractFiles(tarball, ['dist/codex/'], { maxRetainedBytes: 10 })).rejects.toThrow(
      /matching files exceed 10 bytes/,
    );
  });

  it('bounds the total expanded tarball size', async () => {
    const tarball = await makeTarball({ 'README.md': 'x'.repeat(10_000) });
    await expect(extractFiles(tarball, ['core/'], { maxUncompressedBytes: 1_000 })).rejects.toThrow(
      /tarball expands beyond 1000 bytes/,
    );
  });
});

// Custom fork sources (issue #482 follow-up). The property under test: the
// default call shape is untouched, and a non-official source is only reachable
// through a validated owner/name plus an exact commit SHA.
describe('custom fork sources', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';

  it('keeps the official URL byte-identical whether or not the source is passed', () => {
    expect(tarballUrl('v2')).toBe(tarballUrl('v2', {}));
    expect(tarballUrl('v2', { owner: 'awslabs', repo: 'aidlc-workflows' })).toBe(
      'https://codeload.github.com/awslabs/aidlc-workflows/tar.gz/v2',
    );
  });

  it('builds a custom source URL for a full commit SHA', () => {
    expect(tarballUrl(SHA, { owner: 'acme', repo: 'aidlc-fork' })).toBe(
      `https://codeload.github.com/acme/aidlc-fork/tar.gz/${SHA}`,
    );
  });

  it('refuses a mutable ref for a custom source but allows it for the official repo', () => {
    for (const ref of ['v2', 'main', SHA.slice(0, 7), `${SHA}0`]) {
      expect(() => tarballUrl(ref, { owner: 'acme', repo: 'aidlc-fork' })).toThrow(
        /requires a full 40-hex commit SHA/,
      );
    }
    expect(() => tarballUrl('main')).not.toThrow();
  });

  it('refuses an owner or repo that could escape the URL path', () => {
    expect(() => tarballUrl(SHA, { owner: 'a/b', repo: 'fork' })).toThrow(
      /not a valid GitHub owner/,
    );
    expect(() => tarballUrl(SHA, { owner: 'acme', repo: '../escape' })).toThrow(
      /not a valid GitHub repository name/,
    );
    expect(() => tarballUrl(SHA, { owner: 'acme', repo: '..' })).toThrow(
      /not a valid GitHub repository name/,
    );
  });

  it('fetches core files from a custom fork', async () => {
    const tarball = await makeTarball({ 'core/agents/a.md': '# fork agent' }, `aidlc-fork-${SHA}`);
    mockFetchReturning(tarball);
    const files = await fetchCoreFiles(SHA, { owner: 'acme', repo: 'aidlc-fork' });
    expect([...files.keys()]).toEqual(['core/agents/a.md']);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `https://codeload.github.com/acme/aidlc-fork/tar.gz/${SHA}`,
      expect.any(Object),
    );
  });

  it('never reaches the network when the custom source is rejected', async () => {
    globalThis.fetch = vi.fn();
    await expect(
      fetchRepoFiles('main', { prefixes: ['core/'], owner: 'acme', repo: 'aidlc-fork' }),
    ).rejects.toThrow(/requires a full 40-hex commit SHA/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
