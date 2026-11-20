// Called only by trusted checkout preparation before the first package command.
// Never reconstruct a missing baseline from the first generated publication.
import { snapshotNativeExecutionFiles } from './execution-files.js';
import { NATIVE_PUBLICATION_LIMITS } from '../../shared/native-publication.js';
import {
  canonicalNativePath,
  NATIVE_DEPENDENCY_POLICY,
} from '../../shared/native-project-files.js';
import {
  nativeGitExcludedRoot,
  nativeGitObjectFormat,
  nativeGitInventorySha256,
} from '../../shared/native-git-change-set.js';
import { createHash } from 'node:crypto';

// The preparer reads the complete tree of the fetched commit before any
// package command. Checkout attributes can transform bytes. Such a checkout
// remains a readable source baseline, but cannot establish this Git base.
const checkoutGitBase = (files, tree, source) => {
  if (typeof tree !== 'string' || (tree && !tree.endsWith('\0'))) return undefined;
  const checked = new Map(
    files.filter((f) => !nativeGitExcludedRoot(f.path)).map((f) => [f.path, f]),
  );
  const preserved = new Set();
  const algorithm = nativeGitObjectFormat(source.commit);
  const emptyTree = createHash(algorithm).update('tree 0\0').digest('hex');
  for (const entry of tree ? tree.slice(0, -1).split('\0') : []) {
    // A nested empty Git tree has no regular-file representation in an index.
    if (entry.startsWith(`040000 tree ${emptyTree}\t`)) return undefined;
    if (entry.startsWith('040000 tree ')) continue;
    const match = /^(100644|100755) blob ([a-f0-9]+)\t(.*)$/su.exec(entry);
    if (!match) return undefined;
    const [, mode, oid, path] = match;
    if (
      !canonicalNativePath(path) ||
      path.includes('\uFFFD') ||
      oid.length !== source.commit.length
    )
      return undefined;
    const excluded = nativeGitExcludedRoot(path);
    if (excluded) {
      const parents = excluded.split('/').slice(0, -1);
      while (parents.length) {
        preserved.add(parents.join('/'));
        parents.pop();
      }
      continue;
    }
    const file = checked.get(path);
    if (!file || mode !== file.mode) return undefined;
    const blob = createHash(algorithm)
      .update(`blob ${file.bytes}\0`)
      .update(file.content)
      .digest('hex');
    if (blob !== oid) return undefined;
    checked.delete(path);
  }
  if (checked.size || preserved.size > NATIVE_PUBLICATION_LIMITS.files) return undefined;
  return {
    provider: source.provider,
    repository: source.repository,
    inventorySha256: nativeGitInventorySha256(files),
    preservedDirectories: [...preserved].toSorted(),
  };
};

export const captureNativeSourceBaseline = async ({
  project,
  identity,
  repository,
  readTree,
  readCommit,
  packageId,
  publications,
  signal,
  forbiddenBytes,
}) => {
  let snapshot;
  try {
    snapshot = await snapshotNativeExecutionFiles({
      project,
      signal,
      forbiddenBytes,
      filesystemPolicy: NATIVE_DEPENDENCY_POLICY,
    });
  } catch (error) {
    if (error.code === 'native_snapshot_limit') return { unavailable: 'snapshot_limit' };
    if (error.code === 'native_snapshot_credential_content') return { unavailable: 'file_policy' };
    throw error;
  }
  if (snapshot.files.length > NATIVE_PUBLICATION_LIMITS.files)
    return { unavailable: 'snapshot_limit' };
  const tree = await readTree?.();
  const git = checkoutGitBase(snapshot.files, tree, repository);
  if (git && readCommit) {
    // Preserve the original commit and tree entries before the coding harness starts.
    // No excluded blob bytes enter the result store. Verify the raw commit object ID.
    const commit = await readCommit();
    const index = tree
      .split('\0')
      .filter((entry) => /^(100644|100755) blob /.test(entry))
      .join('\0');
    if (
      Buffer.isBuffer(commit) &&
      createHash(nativeGitObjectFormat(repository.commit))
        .update(`commit ${Buffer.byteLength(commit)}\0`)
        .update(commit)
        .digest('hex') === repository.commit &&
      !(forbiddenBytes ?? []).some(
        (value) => value && (commit.includes(value) || Buffer.from(index).includes(value)),
      )
    ) {
      const objects = await publications
        .writeGitBase(identity, {
          commit: commit.toString('base64'),
          index: index ? `${index}\0` : '',
        })
        .catch(() => null);
      if (objects) git.baseObjects = objects;
    }
  }
  const receipt = await publications.write({
    identity,
    repository: { branch: repository?.branch, commit: repository?.commit },
    packageId,
    nativeSessionId: null,
    outcome: 'STOPPED',
    sequence: 1,
    files: snapshot.files,
    filesystemPolicy: snapshot.filesystemPolicy,
    git,
  });
  return { epoch: identity.epoch, receipt };
};
