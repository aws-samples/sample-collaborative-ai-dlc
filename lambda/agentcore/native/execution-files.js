// Exact publication input, never a redacted diagnostic snapshot. The caller
// must first stop all workspace writers (including descendants). Portable Node
// traversal detects observed mutations; it is not an openat sandbox against a
// hostile same-UID process. Publication bounds fail the entire snapshot.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { nativePublicationPath } from '../../shared/native-publication.js';
import { canonicalNativePath, nativeFileExclusion } from '../../shared/native-project-files.js';
import { nativeSnapshotDiagnostic } from '../../shared/native-execution-failure.js';
import { NATIVE_DEPENDENCY_POLICY } from '../../shared/native-dependency-links.js';
export { canonicalNativePath, nativeFileExclusion } from '../../shared/native-project-files.js';

export const NATIVE_SNAPSHOT_LIMITS = Object.freeze({
  maxFiles: 20_000,
  maxEntries: 40_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxDepth: 64,
});
export class NativeSnapshotError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = 'NativeSnapshotError';
  }
}
const fail = (code) => {
  throw new NativeSnapshotError(code);
};
export const nativeFileRole = (path) => {
  if (!path.startsWith('aidlc/')) return 'code';
  if (/(?:^|\/)[^/]*questions?\.md$/.test(path)) return 'question';
  if (path.endsWith('/aidlc-state.md') || path.includes('/.aidlc-engine/')) return 'state';
  return 'artifact';
};
const equalNode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const equalStat = (a, b) =>
  equalNode(a, b) &&
  ['mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every((key) => a[key] === b[key]);

const rejectLink = (path, counts, onDiagnostic) => {
  const parts = path.split('/');
  const dependency = parts.indexOf('node_modules');
  const diagnostic = nativeSnapshotDiagnostic({
    reason: 'symbolic_link',
    pathClass:
      dependency >= 0
        ? parts[dependency + 1] === '.bin'
          ? 'dependency_bin'
          : 'dependency'
        : parts[0] === 'aidlc'
          ? 'workflow'
          : 'other',
    pathDepth: parts.length,
    pathSha256: createHash('sha256').update(path).digest('hex'),
    ...counts,
  });
  try {
    onDiagnostic?.(diagnostic);
  } catch {
    // Telemetry must not alter the rejection or introduce another filesystem read.
  }
  throw Object.assign(new NativeSnapshotError('native_snapshot_link'), {
    snapshotDiagnostic: diagnostic,
  });
};

/**
 * snapshotNativeExecutionFiles({project, signal?, limits?, io?, onDiagnostic?}) returns
 * {schemaVersion:1, complete:true, files:[{path,bytes,sha256,role,content:Buffer}],
 * totalBytes, exclusions:[{path,reason}]}. Contents are exact, including binary
 * files, empty files, BOMs and CRLF. No text decoding or redaction is performed.
 * io exists for deterministic race tests; production uses node:fs/promises.
 */
export const snapshotNativeExecutionFiles = async ({
  project,
  signal,
  limits: overrides = {},
  forbiddenBytes = [],
  io = fs,
  onDiagnostic,
  filesystemPolicy,
} = {}) => {
  const limits = { ...NATIVE_SNAPSHOT_LIMITS, ...overrides };
  if (
    typeof project !== 'string' ||
    !isAbsolute(project) ||
    resolve(project) !== project ||
    (filesystemPolicy !== undefined && filesystemPolicy !== NATIVE_DEPENDENCY_POLICY) ||
    (signal !== undefined && !(signal instanceof AbortSignal)) ||
    !Array.isArray(forbiddenBytes) ||
    forbiddenBytes.length > 64 ||
    forbiddenBytes.some(
      (value) =>
        !(typeof value === 'string' || Buffer.isBuffer(value)) ||
        Buffer.byteLength(value) < 1 ||
        Buffer.byteLength(value) > 64 * 1024,
    ) ||
    Object.entries(limits).some(
      ([key, value]) =>
        !Object.hasOwn(NATIVE_SNAPSHOT_LIMITS, key) || !Number.isSafeInteger(value) || value <= 0,
    )
  )
    fail('native_snapshot_arguments_invalid');
  const secrets = forbiddenBytes.map((value) => Buffer.from(value));
  const checkAbort = () => {
    if (signal?.aborted) fail('native_snapshot_cancelled');
  };
  const observe = async (path) => {
    checkAbort();
    return io.lstat(path, { bigint: true });
  };
  try {
    const root = await observe(project);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      (root.mode & 0o077n) !== 0n ||
      (typeof process.geteuid === 'function' && root.uid !== BigInt(process.geteuid())) ||
      (await io.realpath(project)) !== project
    )
      fail('native_snapshot_root_invalid');
    const inventory = new Map();
    const exclusions = [];
    let entryCount = 0;
    let totalBytes = 0;
    const files = [];
    const unchanged = async (name, before) => {
      const current = await observe(name ? join(project, name) : project);
      if (!equalStat(before, current)) fail('native_snapshot_changed');
    };
    const walk = async (name, before, depth) => {
      if (++entryCount > limits.maxEntries || depth > limits.maxDepth)
        fail('native_snapshot_limit');
      const path = name ? join(project, name) : project;
      if (before.isSymbolicLink())
        rejectLink(
          name,
          { entries: entryCount, files: files.length, bytes: totalBytes },
          onDiagnostic,
        );
      if (before.dev !== root.dev) fail('native_snapshot_mount');
      inventory.set(name, before);
      if (before.isDirectory()) {
        const names = (await io.readdir(path)).toSorted();
        for (const child of names) {
          const relative = name ? `${name}/${child}` : child;
          if (!canonicalNativePath(relative)) fail('native_snapshot_path_invalid');
          const excluded = nativeFileExclusion(relative, filesystemPolicy);
          if (excluded) {
            if (++entryCount > limits.maxEntries) fail('native_snapshot_limit');
            exclusions.push({ path: relative, reason: excluded });
            continue;
          }
          nativePublicationPath(relative);
          await walk(relative, await observe(join(project, relative)), depth + 1);
        }
        await unchanged(name, before);
        return;
      }
      if (!before.isFile()) fail('native_snapshot_special_file');
      if (before.nlink !== 1n) fail('native_snapshot_hardlink');
      if (
        files.length >= limits.maxFiles ||
        before.size > BigInt(limits.maxFileBytes) ||
        before.size > BigInt(limits.maxTotalBytes - totalBytes)
      )
        fail('native_snapshot_limit');
      // NONBLOCK avoids a replaced FIFO hanging the publisher. NOFOLLOW
      // rejects a replaced leaf link; ancestor identities are rechecked below.
      const handle = await io.open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        if (!equalStat(before, await handle.stat({ bigint: true })))
          fail('native_snapshot_changed');
        const content = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < content.length) {
          checkAbort();
          const { bytesRead } = await handle.read(
            content,
            offset,
            Math.min(64 * 1024, content.length - offset),
            offset,
          );
          if (!bytesRead) fail('native_snapshot_changed');
          offset += bytesRead;
        }
        if (!equalStat(before, await handle.stat({ bigint: true })))
          fail('native_snapshot_changed');
        await unchanged(name, before);
        if (secrets.some((secret) => content.includes(secret)))
          fail('native_snapshot_credential_content');
        files.push({
          path: name,
          bytes: content.length,
          sha256: createHash('sha256').update(content).digest('hex'),
          role: nativeFileRole(name),
          content,
        });
        totalBytes += content.length;
      } finally {
        await handle.close();
      }
    };
    await walk('', root, 0);
    // Detect late changes to previously read files and additions/deletions in
    // any traversed directory, not just changes during an individual read.
    for (const [path, stat] of inventory) await unchanged(path, stat);
    if ((await io.realpath(project)) !== project) fail('native_snapshot_changed');
    checkAbort();
    return {
      schemaVersion: 1,
      complete: true,
      files,
      totalBytes,
      exclusions,
      ...(filesystemPolicy ? { filesystemPolicy } : {}),
    };
  } catch (error) {
    if (error instanceof NativeSnapshotError) throw error;
    fail('native_snapshot_io_failed');
  }
};
