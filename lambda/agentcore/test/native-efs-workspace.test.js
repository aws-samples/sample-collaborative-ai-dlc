import { describe, expect, it, vi } from 'vitest';
import { inspectNativeEfsWorkspace } from '../native/efs-workspace.js';

const mount = '39 25 0:40 / /mnt/native rw,relatime - nfs4 127.0.0.1:/ rw,vers=4.1';
// Shape captured from AgentCore: the EFS mount is stacked over an overlay at
// the same path, with the managed session mount on a third device.
const overlay =
  '579 554 0:22 /mnt/native /mnt/native rw,noatime master:1 - overlay overlayfs:/overlay/root rw,lowerdir=/,upperdir=/overlay/root,workdir=/overlay/work';
const nfs =
  '521 579 0:51 / /mnt/native rw,relatime master:263 - nfs4 127.0.0.1:/ rw,vers=4.1,rsize=1048576,wsize=1048576,proto=tcp,port=20362';
const session =
  '578 554 0:49 / /mnt/workspace rw,relatime master:247 - nfs4 127.0.0.1:/export rw,vers=4.0';
const pathStats = (dev = 40n) => ({
  dev,
  isDirectory: () => true,
  isSymbolicLink: () => false,
});
const inspect = (overrides = {}) =>
  inspectNativeEfsWorkspace({
    workspaceDir: '/mnt/native',
    inspectPath: async () => pathStats(),
    resolvePath: async () => '/mnt/native',
    inspectFilesystem: async () => ({ type: 0x6969 }),
    readMountInfo: async () => mount,
    ...overrides,
  });

describe('native EFS workspace prerequisite', () => {
  it('accepts the fixed writable NFS mount, including TLS localhost mount sources', async () => {
    await expect(inspect()).resolves.toEqual({
      mountPath: '/mnt/native',
      filesystemType: 'nfs4',
    });
  });

  it.each([`${session}\n${overlay}\n${nfs}`, `${nfs}\n${overlay}\n${session}`])(
    'selects the visible NFS device in a stacked mount table',
    async (mountInfo) => {
      const inspectPath = vi.fn(async () => pathStats(51n));
      await expect(inspect({ inspectPath, readMountInfo: async () => mountInfo })).resolves.toEqual(
        {
          mountPath: '/mnt/native',
          filesystemType: 'nfs4',
        },
      );
      expect(inspectPath).toHaveBeenCalledWith('/mnt/native', { bigint: true });
    },
  );

  it.each([
    [40, '0:40'],
    [0x801n, '8:1'],
    [0x100001n, '0:257'],
    [0x123456789abcdef0n, '305421534:1737075696'],
    [0xffffffffffffffffn, '4294967295:4294967295'],
  ])('decodes Linux device %s as %s without truncation', async (dev, deviceId) => {
    await expect(
      inspect({
        inspectPath: async () => pathStats(dev),
        readMountInfo: async () => mount.replace('0:40', deviceId),
      }),
    ).resolves.toEqual({ mountPath: '/mnt/native', filesystemType: 'nfs4' });
  });

  it.each([0x794c7630, 0x6969])(
    'refuses hidden NFS beneath the visible overlay, even with filesystem magic %s',
    async (type) => {
      await expect(
        inspect({
          inspectPath: async () => pathStats(22n),
          inspectFilesystem: async () => ({ type }),
          readMountInfo: async () => `${nfs}\n${overlay}`,
        }),
      ).rejects.toThrow('not NFS');
    },
  );

  it('refuses an NFS entry whose device does not match the observed path', async () => {
    await expect(
      inspect({
        inspectPath: async () => pathStats(52n),
        readMountInfo: async () => `${overlay}\n${nfs}`,
      }),
    ).rejects.toThrow('not NFS');
  });

  it('refuses multiple mount entries matching the observed path and device', async () => {
    await expect(
      inspect({
        inspectPath: async () => pathStats(51n),
        readMountInfo: async () => `${overlay}\n${nfs}\n${nfs.replace('521 579', '522 521')}`,
      }),
    ).rejects.toThrow('not NFS');
  });

  it.each([undefined, null, '40', 40.5, NaN, Infinity, -1, -1n, 2 ** 53, 1n << 64n])(
    'refuses invalid or imprecise stat devices: %s',
    async (dev) => {
      await expect(inspect({ inspectPath: async () => ({ ...pathStats(), dev }) })).rejects.toThrow(
        'invalid device',
      );
    },
  );

  it.each(['0:not-a-device', '0:-40', '40', '0:40:1', '0:4294967296'])(
    'refuses invalid mountinfo devices: %s',
    async (device) => {
      await expect(
        inspect({ readMountInfo: async () => mount.replace('0:40', device) }),
      ).rejects.toThrow('not NFS');
    },
  );

  it.each([
    '',
    mount.replace('/mnt/native', '/mnt/workspace'),
    mount.replace('nfs4', 'ext4'),
    mount.replace('rw,relatime', 'ro,relatime'),
    mount.replace('rw,vers=4.1', 'ro,vers=4.1'),
    `${mount}\n${mount}`,
  ])('refuses missing, different, local, read-only or ambiguous mounts: %s', async (mountInfo) => {
    await expect(inspect({ readMountInfo: async () => mountInfo })).rejects.toThrow(
      'Native EFS mount is missing, read-only or not NFS',
    );
  });

  it('checks the filesystem as well as the mount table', async () => {
    await expect(
      inspect({ inspectFilesystem: async () => ({ type: 0x794c7630 }) }),
    ).rejects.toThrow('not NFS');
  });

  it.each([
    { resolvePath: async () => '/mnt/workspace' },
    { inspectPath: async () => ({ isDirectory: () => true, isSymbolicLink: () => true }) },
    { inspectPath: async () => ({ isDirectory: () => false, isSymbolicLink: () => false }) },
  ])('refuses redirected paths or non-directories', async (overrides) => {
    await expect(inspect(overrides)).rejects.toThrow('not a direct directory');
  });

  it('refuses caller-selected mount paths and propagates inspection failures', async () => {
    await expect(inspect({ workspaceDir: '/tmp' })).rejects.toThrow('Unexpected native EFS');
    await expect(
      inspect({
        readMountInfo: async () => {
          throw new Error('Mount inspection unavailable');
        },
      }),
    ).rejects.toThrow('Mount inspection unavailable');
  });
});
