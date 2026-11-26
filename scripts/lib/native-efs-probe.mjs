/* eslint-disable unicorn/consistent-function-scoping -- Embedded probe functions must remain self-contained. */
import * as filesystem from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomFillSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const NATIVE_MOUNT = '/mnt/native';
export const CAPACITY_BYTES = 1024 ** 3 + 8 * 1024 ** 2;
export const PROBE_TIMEOUT_MS = 600_000;
export const COMMAND_TIMEOUT_SECONDS = PROBE_TIMEOUT_MS / 1000 + 60;
export const OUTPUT_LIMIT_BYTES = 64 * 1024;

export function probeError(code) {
  return Object.assign(new Error(code), { code });
}

// AgentCore exposes the backing overlay and its EFS overmount at the same path.
// Match the device actually reached by lstat; a hidden NFS entry must never
// qualify an ordinary local directory for the capacity test.
export function requireNfsMount(mountinfo, statfs, device, mountPoint = NATIVE_MOUNT) {
  if (
    (typeof device !== 'bigint' && !Number.isSafeInteger(device)) ||
    device < 0 ||
    BigInt(device) > 0xffffffffffffffffn
  )
    throw probeError('not_writable_nfs_mount');
  const dev = BigInt(device);
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
  const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
  const deviceId = `${major}:${minor}`;
  const decode = (field) =>
    field.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  const entries = mountinfo
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [left, right, extra] = line.split(' - ');
      const fields = left?.split(' ');
      const after = right?.split(' ');
      if (!right || extra || fields.length < 6 || after.length < 3) return null;
      return {
        mountId: Number(fields[0]),
        device: fields[2],
        mountPoint: decode(fields[4]),
        options: fields[5].split(','),
        filesystem: after[0],
        filesystemOptions: after[2].split(','),
      };
    })
    .filter((entry) => entry?.mountPoint === mountPoint && entry.device === deviceId);
  if (
    entries.length !== 1 ||
    !Number.isSafeInteger(entries[0].mountId) ||
    entries[0].mountId <= 0 ||
    !['nfs', 'nfs4'].includes(entries[0].filesystem) ||
    !entries[0].options.includes('rw') ||
    !entries[0].filesystemOptions.includes('rw') ||
    Number(statfs.type) !== 0x6969
  ) {
    throw probeError('not_writable_nfs_mount');
  }
  return {
    mountPoint,
    filesystem: entries[0].filesystem,
    mountId: entries[0].mountId,
    device: deviceId,
    statfsType: Number(statfs.type),
  };
}

// No truncate, fallocate, or skipped offsets. Every byte is actually written;
// fresh random blocks avoid an all-zero/sparse capacity test.
export async function writeAndVerifyCapacity({
  path,
  bytes = CAPACITY_BYTES,
  fs = filesystem,
  checkTime = () => {},
}) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw probeError('invalid_test_size');
  const block = Buffer.alloc(Math.min(1024 ** 2, bytes));
  const expected = createHash('sha256');
  let written = 0;
  const writer = await fs.open(path, 'wx', 0o600);
  try {
    while (written < bytes) {
      checkTime();
      const length = Math.min(block.length, bytes - written);
      randomFillSync(block, 0, length);
      let offset = 0;
      while (offset < length) {
        checkTime();
        const result = await writer.write(block, offset, length - offset, written + offset);
        if (result.bytesWritten <= 0 || result.bytesWritten > length - offset)
          throw probeError('short_write');
        offset += result.bytesWritten;
      }
      expected.update(block.subarray(0, length));
      written += length;
    }
    await writer.sync();
  } finally {
    await writer.close();
  }
  checkTime();
  const reader = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const actual = createHash('sha256');
  let read = 0;
  let allocatedBytes;
  try {
    const stat = await reader.stat({ bigint: true });
    if (!stat.isFile() || stat.size !== BigInt(bytes) || stat.nlink !== 1n)
      throw probeError('capacity_file_changed');
    allocatedBytes = Number(stat.blocks) * 512;
    if (!Number.isSafeInteger(allocatedBytes) || allocatedBytes < bytes)
      throw probeError('allocation_not_verified');
    while (read < bytes) {
      checkTime();
      const length = Math.min(block.length, bytes - read);
      const result = await reader.read(block, 0, length, read);
      if (result.bytesRead <= 0 || result.bytesRead > length) throw probeError('short_read');
      actual.update(block.subarray(0, result.bytesRead));
      read += result.bytesRead;
    }
  } finally {
    await reader.close();
  }
  const expectedSha256 = expected.digest('hex');
  const actualSha256 = actual.digest('hex');
  if (expectedSha256 !== actualSha256) throw probeError('readback_mismatch');
  return {
    passed: true,
    bytesWritten: written,
    bytesRead: read,
    allocatedBytes,
    synced: true,
    expectedSha256,
    actualSha256,
  };
}

// Overrides exist for small, local unit tests only. The operator command below
// invokes this with fixed defaults and exposes no path/size/command arguments.
export async function runNativeEfsProbe({
  root = NATIVE_MOUNT,
  bytes = CAPACITY_BYTES,
  fs = filesystem,
  execute = promisify(execFile),
  now = Date.now,
  timeoutMs = PROBE_TIMEOUT_MS,
  onStart = () => {},
} = {}) {
  const began = now();
  const checkTime = () => {
    if (now() - began >= timeoutMs) throw probeError('deadline_exceeded');
  };
  const report = {
    schemaVersion: 1,
    type: 'result',
    ok: false,
    root,
    probeDirectory: null,
    mount: null,
    checks: {},
    cleanup: 'not-created',
  };
  let stage = 'mount';
  let rootIdentity;
  let directoryIdentity;
  const identity = async (path) => {
    const stat = await fs.lstat(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(path)) !== path)
      throw probeError('unsafe_directory');
    return stat;
  };
  const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
  try {
    rootIdentity = await identity(root);
    report.mount = requireNfsMount(
      await fs.readFile('/proc/self/mountinfo', 'utf8'),
      await fs.statfs(root),
      rootIdentity.dev,
      root,
    );
    checkTime();
    stage = 'create';
    report.probeDirectory = await fs.mkdtemp(`${root}/.aidlc-efs-probe-`);
    report.cleanup = 'pending';
    await fs.chmod(report.probeDirectory, 0o700);
    directoryIdentity = await identity(report.probeDirectory);
    if (!same(rootIdentity, await identity(root))) throw probeError('unsafe_directory');
    onStart({
      schemaVersion: 1,
      type: 'started',
      root,
      probeDirectory: report.probeDirectory,
    });
    const file = (name) => `${report.probeDirectory}/${name}`;

    stage = 'hardlink';
    await fs.writeFile(file('original'), 'native-efs-original\n', { flag: 'wx', mode: 0o600 });
    await fs.link(file('original'), file('hardlink'));
    const original = await fs.lstat(file('original'), { bigint: true });
    const linked = await fs.lstat(file('hardlink'), { bigint: true });
    if (!same(original, linked) || original.nlink !== 2n || linked.nlink !== 2n)
      throw probeError('hardlink_mismatch');
    report.checks.hardlink = {
      passed: true,
      // This runtime exposes high-bit EFS inode IDs as signed bigint values.
      // Preserve all 64 bits in the unsigned decimal evidence representation.
      inode: BigInt.asUintN(64, original.ino).toString(),
      device: original.dev.toString(),
      nlink: 2,
    };

    stage = 'symlink';
    await fs.symlink('original', file('symlink'));
    if (
      !(await fs.lstat(file('symlink'))).isSymbolicLink() ||
      (await fs.readlink(file('symlink'))) !== 'original' ||
      (await fs.readFile(file('symlink'), 'utf8')) !== 'native-efs-original\n'
    ) {
      throw probeError('symlink_mismatch');
    }
    report.checks.symlink = { passed: true };

    stage = 'rename';
    await fs.writeFile(file('destination'), 'old\n', { flag: 'wx', mode: 0o600 });
    await fs.writeFile(file('replacement'), 'new\n', { flag: 'wx', mode: 0o600 });
    let stopReading = false;
    const observe = async () => {
      // The concurrent rename sets stopReading in its finally block.
      // eslint-disable-next-line no-unmodified-loop-condition
      while (!stopReading) {
        checkTime();
        const text = await fs.readFile(file('destination'), 'utf8');
        if (text !== 'old\n' && text !== 'new\n') throw probeError('rename_mismatch');
      }
    };
    // Attach a rejection handler immediately while rename is in flight.
    const observer = observe().then(
      () => null,
      (error) => error,
    );
    let renameError;
    try {
      await fs.rename(file('replacement'), file('destination'));
    } catch (error) {
      renameError = error;
    } finally {
      stopReading = true;
    }
    const observerError = await observer;
    if (renameError) throw renameError;
    if (observerError) throw observerError;
    if ((await fs.readFile(file('destination'), 'utf8')) !== 'new\n')
      throw probeError('rename_mismatch');
    try {
      await fs.lstat(file('replacement'));
      throw probeError('rename_mismatch');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const directory = await fs.open(report.probeDirectory, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    report.checks.rename = { passed: true, directorySynced: true };

    stage = 'executable';
    await fs.writeFile(file('executable'), '#!/bin/sh\nexit 0\n', { flag: 'wx', mode: 0o600 });
    await fs.chmod(file('executable'), 0o700);
    if (((await fs.lstat(file('executable'))).mode & 0o777) !== 0o700)
      throw probeError('chmod_mismatch');
    checkTime();
    await execute(file('executable'), [], {
      env: { PATH: '/usr/bin:/bin' },
      timeout: Math.min(10_000, timeoutMs - (now() - began)),
      maxBuffer: 1024,
    });
    report.checks.executable = { passed: true, mode: '0700' };

    stage = 'capacity';
    report.checks.capacity = await writeAndVerifyCapacity({
      path: file('capacity.bin'),
      bytes,
      fs,
      checkTime,
    });
    report.ok = true;
  } catch (error) {
    const allowed = new Set([
      'not_writable_nfs_mount',
      'unsafe_directory',
      'deadline_exceeded',
      'hardlink_mismatch',
      'symlink_mismatch',
      'rename_mismatch',
      'chmod_mismatch',
      'short_write',
      'short_read',
      'capacity_file_changed',
      'allocation_not_verified',
      'readback_mismatch',
      'EACCES',
      'EPERM',
      'ENOENT',
      'EEXIST',
      'ENOSPC',
      'EDQUOT',
      'EROFS',
      'EIO',
      'ENOTSUP',
      'EOPNOTSUPP',
      'ETIMEDOUT',
      'ESTALE',
      'EXDEV',
    ]);
    report.failure = { stage, code: allowed.has(error.code) ? error.code : 'operation_failed' };
  } finally {
    if (report.probeDirectory) {
      try {
        if (
          directoryIdentity &&
          same(rootIdentity, await identity(root)) &&
          same(directoryIdentity, await identity(report.probeDirectory))
        ) {
          await fs.rm(report.probeDirectory, { recursive: true, force: true });
          report.cleanup = 'removed';
        }
      } catch {
        // Keep cleanup unconfirmed if identity validation or deletion fails.
      }
      if (report.cleanup !== 'removed') {
        report.ok = false;
        report.cleanup = 'unconfirmed';
        report.failure ??= { stage: 'cleanup', code: 'cleanup_failed' };
      }
    }
    report.durationMs = Math.max(0, now() - began);
  }
  return report;
}

export function fixedProbeSource() {
  return [
    "import * as filesystem from 'node:fs/promises';",
    "import { constants } from 'node:fs';",
    "import { createHash, randomFillSync } from 'node:crypto';",
    "import { execFile } from 'node:child_process';",
    "import { promisify } from 'node:util';",
    `const NATIVE_MOUNT = ${JSON.stringify(NATIVE_MOUNT)};`,
    `const CAPACITY_BYTES = ${CAPACITY_BYTES};`,
    `const PROBE_TIMEOUT_MS = ${PROBE_TIMEOUT_MS};`,
    probeError.toString(),
    requireNfsMount.toString(),
    writeAndVerifyCapacity.toString(),
    runNativeEfsProbe.toString(),
    'const report = await runNativeEfsProbe({onStart: value => console.log(JSON.stringify(value))});',
    'console.log(JSON.stringify(report)); process.exitCode = report.ok ? 0 : 1;',
  ].join('\n');
}

export function fixedProbeCommand() {
  // POSIX single quoting, including literal apostrophes. No heredoc or caller
  // text is interpolated into the shell command.
  return `node --input-type=module -e '${fixedProbeSource().replaceAll("'", "'\\''")}'`;
}
