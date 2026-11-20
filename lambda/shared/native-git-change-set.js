import { nativeFileExclusion, NATIVE_DEPENDENCY_POLICY } from './native-project-files.js';
import { createHash } from 'node:crypto';
import { canonicalJson } from './workflow-checkpoint.js';

// The publication walker prunes whole directories. The native checkout also
// reserves engine and session records that members can inspect in publications.
export const nativeGitExcludedRoot = (path) => {
  let prefix = '';
  for (const part of path.split('/')) {
    prefix = prefix ? `${prefix}/${part}` : part;
    if (
      part.toLowerCase() === '.git' ||
      ['.aidlc-engine', '.aidlc-sessions'].includes(part) ||
      nativeFileExclusion(prefix, NATIVE_DEPENDENCY_POLICY)
    )
      return prefix;
  }
  return null;
};

// Seal the quiescent capture before handing individual files to the publisher.
// Filtering even an added file or dropping a mode invalidates this inventory.
export const nativeGitInventorySha256 = (files) =>
  createHash('sha256')
    .update(
      canonicalJson(
        files
          .map(({ path, bytes, sha256, mode }) => ({ path, bytes, sha256, mode }))
          .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      ),
    )
    .digest('hex');

export const nativeGitDeltaSha256 = (delta) =>
  createHash('sha256').update(canonicalJson(delta)).digest('hex');

// Both manifests have already passed the publication codec. A deleted path
// must name a base file positively observed absent by the result capture.
const version = ({ mode, bytes, sha256 }) => ({ mode, bytes, sha256 });
const inventory = (files) =>
  new Map(files.filter((f) => !nativeGitExcludedRoot(f.path)).map((f) => [f.path, f]));

export const nativeGitChanges = (base, result) => {
  if (
    !base?.git?.preservedDirectories ||
    !result.git?.deleted ||
    base.git.provider !== result.git.provider ||
    base.git.repository !== result.git.repository
  )
    return null;
  const original = inventory(base.files);
  const published = inventory(result.files);
  const deleted = new Set(result.git.deleted);
  if (
    base.git.preservedDirectories.some((path) => published.has(path)) ||
    result.git.deleted.some((path) => !original.has(path) || published.has(path))
  )
    return null;
  const changes = [];
  for (const path of [...new Set([...original.keys(), ...published.keys()])].toSorted()) {
    const before = original.get(path);
    const after = published.get(path);
    if (!after && !deleted.has(path)) return null;
    if (before?.sha256 === after?.sha256 && before?.mode === after?.mode) continue;
    changes.push({
      path,
      fileId: (after ?? before).id,
      before: before ? version(before) : null,
      after: after ? version(after) : null,
    });
  }
  return changes;
};
