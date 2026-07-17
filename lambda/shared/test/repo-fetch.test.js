import { describe, it, expect, vi, afterEach } from 'vitest';
import zlib from 'node:zlib';
import tar from 'tar-stream';
import { fetchCoreFiles, tarballUrl } from '../repo-fetch.js';

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
    await expect(fetchCoreFiles('abc123')).rejects.toThrow(/no core\/ files/);
  });

  it('requires a ref', async () => {
    await expect(fetchCoreFiles('')).rejects.toThrow(/ref/);
  });
});
