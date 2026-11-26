import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { inspectNativeEfsWorkspace } from './efs-workspace.js';

const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const root = '/mnt/native';
const identityKeys = ['projectId', 'executionId', 'bindingId', 'nonce'];
const envKeys = [
  'NATIVE_RUNTIME_PROJECT_ID',
  'NATIVE_RUNTIME_EXECUTION_ID',
  'NATIVE_RUNTIME_BINDING_ID',
  'NATIVE_RUNTIME_CHECK_NONCE',
];

export const nativeWorkspaceIdentity = (env) => {
  const identity = Object.fromEntries(identityKeys.map((key, i) => [key, env[envKeys[i]]]));
  if (
    env.NATIVE_RUNTIME_MODE !== 'isolated' ||
    ![identity.projectId, identity.executionId].every(
      (v) =>
        typeof v === 'string' &&
        Buffer.byteLength(v) > 0 &&
        Buffer.byteLength(v) <= 512 &&
        Array.from(v).every((c) => c.codePointAt(0) >= 32 && c.codePointAt(0) !== 127),
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      identity.bindingId ?? '',
    ) ||
    !/^[0-9a-f]{64}$/.test(identity.nonce ?? '')
  )
    fail('native_runtime_identity_invalid');
  return Object.freeze(identity);
};

export const workspaceCheckContent = (identity) =>
  Buffer.from(
    `${JSON.stringify({ format: 1, ...Object.fromEntries(identityKeys.map((k) => [k, identity[k]])) })}\n`,
  );

export const createNativeWorkspaceCheck = ({
  env = process.env,
  io = fs,
  inspectMount = inspectNativeEfsWorkspace,
} = {}) => {
  const identity = nativeWorkspaceIdentity(env);
  let active = false;
  return async (payload) => {
    if (
      !payload ||
      Array.isArray(payload) ||
      typeof payload !== 'object' ||
      Object.keys(payload).toSorted().join(',') !==
        ['command', ...identityKeys].toSorted().join(',') ||
      payload.command !== 'native-workspace-check' ||
      identityKeys.some((key) => payload[key] !== identity[key])
    )
      fail('native_workspace_scope_mismatch');
    if (active) fail('native_workspace_check_busy');
    active = true;
    let directory;
    let file;
    const owned = new Set();
    try {
      const mount = await inspectMount({ workspaceDir: root });
      const rootStat = await io.lstat(root);
      if (
        !rootStat.isDirectory() ||
        rootStat.isSymbolicLink() ||
        rootStat.uid !== 1000 ||
        rootStat.gid !== 1000 ||
        (rootStat.mode & 0o777) !== 0o700 ||
        (await io.realpath(root)) !== root
      ) {
        fail('native_workspace_owner_mismatch');
      }
      const control = `${root}/.control`;
      await io.mkdir(control, { mode: 0o700 }).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
      const controlStat = await io.lstat(control);
      if (
        !controlStat.isDirectory() ||
        controlStat.isSymbolicLink() ||
        controlStat.uid !== 1000 ||
        controlStat.gid !== 1000 ||
        (controlStat.mode & 0o777) !== 0o700 ||
        controlStat.dev !== rootStat.dev ||
        (await io.realpath(control)) !== control
      ) {
        fail('native_control_directory_invalid');
      }
      directory = await io.open(
        control,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const opened = await directory.stat();
      if (opened.dev !== controlStat.dev || opened.ino !== controlStat.ino) {
        fail('native_control_directory_changed');
      }
      // Anchor every operation to the opened directory, not a replaceable ancestor.
      const anchored = `/proc/self/fd/${directory.fd}`;
      const original = `${anchored}/workspace-check.tmp`;
      const linked = `${anchored}/workspace-check.link`;
      const renamed = `${anchored}/workspace-check.done`;
      for (const path of [original, linked, renamed]) {
        const existing = await io.lstat(path).catch((e) => {
          if (e.code === 'ENOENT') return null;
          throw e;
        });
        if (existing) fail('native_workspace_check_residue');
      }
      file = await io.open(
        original,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      owned.add(original);
      const content = workspaceCheckContent(identity);
      await file.writeFile(content);
      await file.sync();
      const initial = await file.stat();
      if (!initial.isFile() || initial.nlink !== 1 || initial.dev !== opened.dev)
        fail('native_workspace_file_invalid');
      await io.link(original, linked);
      owned.add(linked);
      const linkStat = await io.lstat(linked);
      const sourceStat = await file.stat();
      if (
        !linkStat.isFile() ||
        linkStat.ino !== initial.ino ||
        linkStat.dev !== initial.dev ||
        linkStat.nlink !== 2 ||
        sourceStat.nlink !== 2
      )
        fail('native_workspace_hardlink_failed');
      await io.rename(linked, renamed);
      owned.delete(linked);
      owned.add(renamed);
      const reader = await io.open(renamed, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes;
      try {
        const finalStat = await reader.stat();
        if (
          !finalStat.isFile() ||
          finalStat.ino !== initial.ino ||
          finalStat.dev !== initial.dev ||
          finalStat.size !== content.length ||
          finalStat.nlink !== 2
        )
          fail('native_workspace_rename_failed');
        const buffer = Buffer.alloc(content.length + 1);
        const read = await reader.read(buffer, 0, buffer.length, 0);
        bytes = buffer.subarray(0, read.bytesRead);
      } finally {
        await reader.close();
      }
      if (!bytes.equals(content)) fail('native_workspace_readback_failed');
      await file.close();
      file = null;
      for (const path of owned) {
        await io.unlink(path);
        owned.delete(path);
      }
      return {
        ok: true,
        command: 'native-workspace-check',
        ...identity,
        evidence: {
          mountPath: root,
          filesystemType: mount.filesystemType,
          uid: 1000,
          gid: 1000,
          bytes: content.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          hardlinkSameInode: true,
          linkCount: 2,
          atomicRename: true,
          cleanupComplete: true,
        },
      };
    } finally {
      await file?.close().catch(() => {});
      for (const path of owned) await io.unlink(path).catch(() => {});
      await directory?.close().catch(() => {});
      active = false;
    }
  };
};
