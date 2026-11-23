import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { inspectNativeRuntimeArchive } from '../../shared/native-runtime-package.js';
import { createNativeReleaseFixture } from '../../shared/test/fixtures/native-release.js';
import {
  engineDigest,
  NATIVE_ENGINE_PROFILE,
  prepareNativeEngine,
} from '../workflow-engine/package.js';

vi.mock('../../shared/native-runtime-package.js', { spy: true });
vi.mock('../../shared/native-workflow-protocol.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, NATIVE_ENGINE_PROFILE: { ...actual.NATIVE_ENGINE_PROFILE } };
});

it('reuses only verified upstream files and rematerializes each protected workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-projection-'));
  try {
    const fixture = await createNativeReleaseFixture(join(root, 'release'), {
      version: NATIVE_ENGINE_PROFILE.version,
    });
    const archive = await readFile(join(fixture.directory, fixture.runtimeName));
    NATIVE_ENGINE_PROFILE.runtimeSha256 = engineDigest(archive);
    const prepare = (bytes, harness, directory) =>
      prepareNativeEngine({
        archive: bytes,
        harness,
        directory: join(root, directory),
        adapterDirectory: root,
      });
    const mutable = Buffer.from(archive);
    const first = prepare(mutable, 'codex', 'first');
    mutable.fill(0);
    const { installation } = await first;
    const path = 'tools/native.js';
    const original = await readFile(join(installation, path));
    await writeFile(join(installation, path), 'changed in previous workspace');
    await expect(prepare(mutable, 'codex', 'invalid')).rejects.toMatchObject({
      code: 'NATIVE_ENGINE_PACKAGE_UNSUPPORTED',
    });
    const second = await prepare(archive, 'codex', 'second');
    expect(await readFile(join(second.installation, path))).toEqual(original);
    expect(inspectNativeRuntimeArchive).toHaveBeenCalledTimes(1);

    vi.mocked(inspectNativeRuntimeArchive).mockRejectedValueOnce(new Error('inspection failed'));
    await expect(prepare(archive, 'claude', 'failed')).rejects.toThrow('inspection failed');
    const claude = await prepare(archive, 'claude', 'third');
    expect(claude.installation).toBe(join(root, 'third/.claude'));
    await prepare(archive, 'codex', 'fourth');
    expect(inspectNativeRuntimeArchive).toHaveBeenCalledTimes(4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
