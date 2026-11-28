import { constants } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { NATIVE_WORKSPACE_ROOT, nativeWorkspaceAvailable } from '../native-workspace.js';

const NFS = { type: 0x6969 };

describe('nativeWorkspaceAvailable', () => {
  it('is true for a writable NFS mount at the workspace root', async () => {
    const inspectFilesystem = vi.fn(async () => NFS);
    const checkAccess = vi.fn(async () => undefined);
    await expect(nativeWorkspaceAvailable({ inspectFilesystem, checkAccess })).resolves.toBe(true);
    expect(NATIVE_WORKSPACE_ROOT).toBe('/mnt/aidlc');
    expect(inspectFilesystem).toHaveBeenCalledWith('/mnt/aidlc');
    expect(checkAccess).toHaveBeenCalledWith('/mnt/aidlc', constants.W_OK | constants.X_OK);
  });

  it('accepts the file system type as a bigint', async () => {
    await expect(
      nativeWorkspaceAvailable({
        inspectFilesystem: async () => ({ type: 0x6969n }),
        checkAccess: async () => undefined,
      }),
    ).resolves.toBe(true);
  });

  it('is false when the directory does not exist', async () => {
    const checkAccess = vi.fn();
    await expect(
      nativeWorkspaceAvailable({
        inspectFilesystem: async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        checkAccess,
      }),
    ).resolves.toBe(false);
    expect(checkAccess).not.toHaveBeenCalled();
  });

  // A directory baked into an image, or the session storage, is not the
  // shared workspace storage even when it is writable.
  it.each([
    ['ext4', 0xef53],
    ['overlayfs', 0x794c7630],
    ['tmpfs', 0x01021994],
  ])('is false for a writable directory on %s', async (_name, type) => {
    const checkAccess = vi.fn(async () => undefined);
    await expect(
      nativeWorkspaceAvailable({ inspectFilesystem: async () => ({ type }), checkAccess }),
    ).resolves.toBe(false);
    expect(checkAccess).not.toHaveBeenCalled();
  });

  it('is false for an NFS mount this process cannot write to', async () => {
    await expect(
      nativeWorkspaceAvailable({
        inspectFilesystem: async () => NFS,
        checkAccess: async () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        },
      }),
    ).resolves.toBe(false);
  });

  it('is false for a real directory that is not an NFS mount', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-workspace-'));
    try {
      await expect(nativeWorkspaceAvailable({ root })).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is false on a machine without the mount', async () => {
    await expect(nativeWorkspaceAvailable()).resolves.toBe(false);
  });
});
