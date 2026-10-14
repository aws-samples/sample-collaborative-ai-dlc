import { expect, it } from 'vitest';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { buildNativeResultArchive, RESULT_ARCHIVE_BYTES } from '../result-archive.js';

it('streams the full admitted 256 MiB and 1000-file inventory into a bounded archive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'result-limit-test-'));
  const path = join(directory, 'result.zip');
  const block = Buffer.alloc(32 * 1024 * 1024, 254);
  const files = Array.from({ length: 1000 }, (_, n) => ({
    path: `files/${n}`,
    bytes: n < 8 ? block.length : 0,
  }));
  try {
    let reading = false;
    const result = await buildNativeResultArchive({
      destination: path,
      files,
      provenance: { files },
      signal: AbortSignal.timeout(30_000),
      readFile: async (file) => {
        expect(reading).toBe(false);
        reading = true;
        await Promise.resolve();
        reading = false;
        return file.bytes ? block : Buffer.alloc(0);
      },
    });
    expect(result.bytes).toBeGreaterThan(256 * 1024 * 1024);
    expect(result.bytes).toBeLessThan(RESULT_ARCHIVE_BYTES);
    expect((await stat(path)).size).toBe(result.bytes);
    const hash = createHash('sha256');
    for await (const part of createReadStream(path)) hash.update(part);
    expect(hash.digest('hex')).toBe(result.sha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 40_000);

it('rejects an aborted archive without reporting partial output as complete', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'result-abort-test-'));
  const controller = new AbortController();
  try {
    await expect(
      buildNativeResultArchive({
        destination: join(directory, 'result'),
        files: [{ path: 'a' }],
        provenance: {},
        signal: controller.signal,
        readFile: async () => {
          controller.abort();
          return Buffer.from('partial');
        },
      }),
    ).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
