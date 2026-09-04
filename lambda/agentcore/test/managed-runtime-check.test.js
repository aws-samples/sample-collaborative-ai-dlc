import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { managedRuntimeCheck } from '../commands/managed-runtime-check.js';

const paths = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe('managedRuntimeCheck', () => {
  it('reports writable workspace and protected runtime evidence', async () => {
    const workspaceDir = await mkdtemp(path.join(tmpdir(), 'managed-workspace-'));
    paths.push(workspaceDir);
    const runtimeFile = path.join(workspaceDir, 'http-server.js');
    await writeFile(runtimeFile, 'export default {};\n');

    await expect(
      managedRuntimeCheck(
        { nonce: 'check-1' },
        { workspaceDir, runtimeFile, compatibilityVersion: '7' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      nonce: 'check-1',
      compatibilityVersion: '7',
      workspaceWritable: true,
      protectedRuntime: true,
    });
  });

  it('fails when the protected runtime file is unavailable', async () => {
    const workspaceDir = await mkdtemp(path.join(tmpdir(), 'managed-workspace-'));
    paths.push(workspaceDir);
    const result = await managedRuntimeCheck(
      { nonce: 'check-2' },
      {
        workspaceDir,
        runtimeFile: path.join(workspaceDir, 'missing.js'),
        compatibilityVersion: '1',
      },
    );
    expect(result).toMatchObject({
      ok: false,
      workspaceWritable: true,
      protectedRuntime: false,
    });
  });
});
