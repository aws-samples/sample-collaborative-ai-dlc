import { expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, open, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureNativeSourceBaseline } from '../native/source-baseline.js';

it.each(['.env', 'oversized.bin'])(
  'keeps %s out of a new baseline and records why without blocking execution',
  async (name) => {
    const project = await realpath(await mkdtemp(join(tmpdir(), 'source-baseline-')));
    const publications = { write: vi.fn() };
    try {
      if (name === '.env') await writeFile(join(project, name), 'example-only');
      else {
        const file = await open(join(project, name), 'w');
        await file.truncate(17 * 1024 * 1024);
        await file.close();
      }
      expect(await captureNativeSourceBaseline({ project, publications })).toEqual({
        unavailable: name === '.env' ? 'file_policy' : 'snapshot_limit',
      });
      expect(publications.write).not.toHaveBeenCalled();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  },
);
