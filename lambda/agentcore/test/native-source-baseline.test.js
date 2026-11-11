import { expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, open, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureNativeSourceBaseline } from '../native/source-baseline.js';

it.each(['platform-credential.txt', 'oversized.bin'])(
  'records the actual %s capture failure without blocking execution',
  async (name) => {
    const project = await realpath(await mkdtemp(join(tmpdir(), 'source-baseline-')));
    const publications = { write: vi.fn() };
    try {
      if (name === 'platform-credential.txt')
        await writeFile(join(project, name), 'platform-issued-test-key');
      else {
        const file = await open(join(project, name), 'w');
        await file.truncate(17 * 1024 * 1024);
        await file.close();
      }
      expect(
        await captureNativeSourceBaseline({
          project,
          publications,
          forbiddenBytes: ['platform-issued-test-key'],
        }),
      ).toEqual({
        unavailable: name === 'platform-credential.txt' ? 'file_policy' : 'snapshot_limit',
      });
      expect(publications.write).not.toHaveBeenCalled();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  },
);

it('retains repository configuration exactly without judging credential-shaped filenames or values', async () => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'source-baseline-')));
  const receipt = { id: 'baseline-receipt' };
  const publications = { write: vi.fn(async () => receipt) };
  const files = [
    { path: '.env', content: Buffer.from('PASSWORD=repository-owned-value\r\n') },
    { path: '.npmrc', content: Buffer.from('//registry.example/:_authToken=${NPM_TOKEN}\n') },
    { path: '.env.example', content: Buffer.alloc(0) },
  ];
  try {
    for (const file of files) await writeFile(join(project, file.path), file.content);
    expect(
      await captureNativeSourceBaseline({
        project,
        identity: { epoch: 1 },
        publications,
        forbiddenBytes: ['platform-issued-test-key'],
      }),
    ).toEqual({ epoch: 1, receipt });
    const written = publications.write.mock.calls[0][0];
    expect(written.filesystemPolicy).toBe('node-dependencies-v1');
    expect(written.files).toHaveLength(files.length);
    for (const file of files)
      expect(written.files.find((entry) => entry.path === file.path)?.content).toEqual(
        file.content,
      );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
