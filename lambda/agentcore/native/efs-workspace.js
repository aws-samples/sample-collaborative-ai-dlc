import { lstat, readFile, realpath, statfs } from 'node:fs/promises';

const linuxDeviceId = (value) => {
  const device = typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value;
  if (typeof device !== 'bigint' || device < 0n || device > 0xffffffffffffffffn)
    throw new Error('Native EFS path has an invalid device');
  // Linux/glibc dev_t packs the 32-bit major/minor numbers into a 64-bit value.
  const major = ((device & 0x00000000000fff00n) >> 8n) | ((device & 0xfffff00000000000n) >> 32n);
  const minor = (device & 0xffn) | ((device & 0x00000ffffff00000n) >> 12n);
  return `${major}:${minor}`;
};

// This confirms the configured test path is a writable NFS mount, not the
// backing local directory. Terraform and the deployment review establish the
// EFS access-point identity; mountinfo alone cannot identify the AWS resource.
export const inspectNativeEfsWorkspace = async ({
  workspaceDir,
  inspectPath = lstat,
  resolvePath = realpath,
  inspectFilesystem = statfs,
  readMountInfo = () => readFile('/proc/self/mountinfo', 'utf8'),
}) => {
  if (workspaceDir !== '/mnt/native') throw new Error('Unexpected native EFS mount path');
  const [path, resolved, filesystem, mountInfo] = await Promise.all([
    inspectPath(workspaceDir, { bigint: true }),
    resolvePath(workspaceDir),
    inspectFilesystem(workspaceDir),
    readMountInfo(),
  ]);
  if (!path.isDirectory() || path.isSymbolicLink() || resolved !== workspaceDir)
    throw new Error('Native EFS path is not a direct directory');
  const device = linuxDeviceId(path.dev);
  const mounts = mountInfo
    .trim()
    .split('\n')
    .map((line) => {
      const [mount, filesystemFields] = line.split(' - ');
      const fields = mount.split(' ');
      const fs = filesystemFields?.split(' ');
      return {
        device: fields[2],
        path: fields[4],
        options: fields[5]?.split(','),
        type: fs?.[0],
        fsOptions: fs?.[2]?.split(','),
      };
    })
    // Stacked mounts can share a path. Only the device observed by lstat is
    // visible there; a hidden NFS entry must not qualify a local filesystem.
    .filter((mount) => mount.path === workspaceDir && mount.device === device);
  if (
    mounts.length !== 1 ||
    !['nfs', 'nfs4'].includes(mounts[0].type) ||
    !mounts[0].options?.includes('rw') ||
    !mounts[0].fsOptions?.includes('rw') ||
    Number(filesystem.type) !== 0x6969
  )
    throw new Error('Native EFS mount is missing, read-only or not NFS');
  return { mountPath: workspaceDir, filesystemType: mounts[0].type };
};
