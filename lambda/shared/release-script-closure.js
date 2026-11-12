// Reads the sibling modules a pinned sensor script imports out of its release.
//
// A release's sensor script is one object in the closure; the modules it imports
// are others, published under the `runtime` role by path
// (`aidlc-release.js` `runtimeEntries`). This resolves the closure with the same
// walk the compatibility analyzer uses to claim the closure is complete, and
// fails closed: a dependency the release does not publish, or one whose bytes do
// not match the recorded digest, is a release integrity failure naming the path —
// never a partial materialization and never a fallback to a SYSTEM copy of the
// same file.
//
// Storage is injected (shared/ is a leaf foundation): the engine catalog runs it
// over its own clients locally and over engine-data's confined clients remotely.

import path from 'node:path';
import { ReleaseResolverError } from './release-resolver.js';
import { dependencyClosure, importSpecifiers, resolveRelativeImport } from './script-closure.js';

// A sensor whose release dependencies cannot be resolved: a release closure that
// does not match its pin, a missing/tampered object, an unpinned overlay, or an
// object that is absent from storage. An incompletely published closure is a
// release integrity failure exactly like a digest mismatch, so it must hold the
// stage rather than degrade to a best-effort advisory note.
export const isReleaseDependencyError = (error) =>
  ['ReleaseResolverError', 'AidlcReleaseError'].includes(error?.name) &&
  (String(error.code ?? '').startsWith('release_') ||
    ['runtime_file_missing', 'unpinned_user_block', 'user_block_missing'].includes(error.code));

// Fetch every relative import reachable from the entry, then re-derive the
// closure with the analyzer's own function so an incomplete read is reported by
// the same rule the promotion guard applies.
export const resolveScriptClosure = async ({ entryPath, entryContent, publishes, read }) => {
  const files = new Map([[entryPath, entryContent]]);
  const queue = [entryPath];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const specifier of importSpecifiers(files.get(current))) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveRelativeImport({ has: publishes }, current, specifier);
      if (files.has(resolved)) continue;
      if (!publishes(resolved)) {
        throw new ReleaseResolverError(
          'release_script_dependency_missing',
          `release-script-closure: ${entryPath} imports ${specifier}, which release object ${resolved} does not publish`,
          { details: { entryPath, specifier, resolved } },
        );
      }
      files.set(resolved, await read(resolved));
      queue.push(resolved);
    }
  }
  const closure = dependencyClosure(files, entryPath);
  if (closure.missing.length > 0) {
    throw new ReleaseResolverError(
      'release_script_dependency_missing',
      `release-script-closure: ${entryPath} is missing ${closure.missing.join(', ')}`,
      { details: { entryPath, missing: closure.missing } },
    );
  }
  const entryDir = path.posix.dirname(entryPath);
  return closure.files
    .filter((item) => item !== entryPath)
    .map((item) => ({
      relativePath: path.posix.relative(entryDir, item),
      content: files.get(item),
    }));
};

// Re-raise a raw closure or object read failure as a release dependency error.
//
// The resolver converts only a MISSING key into a typed error; a permissions
// failure, a transport error, or a body stream that dies mid-read rejects with
// whatever the SDK raised. Those names are not release dependency errors, so the
// runner's generic handler recorded the sensor BLOCKED without the fatal flag —
// an advisory pinned sensor whose script never ran let the stage continue, while
// the same sensor with an absent dependency correctly held it. A pinned
// dependency that cannot be READ is exactly as unverifiable as one that is
// absent, so it gets `release_object_unreadable`, the code the block loader
// already uses for an unreadable release object. Errors the runner already
// recognizes pass through untouched, so `runtime_file_missing` and
// `release_closure_mismatch` still reach the verdict as themselves.
export const asReleaseDependencyFailure = (error, { entryPath, repoPath = null }) => {
  if (isReleaseDependencyError(error)) return error;
  const subject = repoPath ? `pinned import ${repoPath}` : 'its release closure';
  return new ReleaseResolverError(
    'release_object_unreadable',
    `release-script-closure: ${entryPath} could not read ${subject}`,
    {
      cause: error,
      details: {
        entryPath,
        ...(repoPath ? { repoPath } : {}),
        reason: error?.name ?? 'Error',
      },
    },
  );
};

// Resolve `entryPath`'s import closure out of a release closure. `loadClosure`
// returns the verified release closure; `readRuntimeFile(closure, repoPath)`
// returns one digest-checked runtime file's content.
export const readReleaseScriptClosure = async ({
  entryPath,
  entryContent,
  loadClosure,
  readRuntimeFile,
}) => {
  let closure;
  try {
    closure = await loadClosure();
  } catch (error) {
    throw asReleaseDependencyFailure(error, { entryPath });
  }
  return resolveScriptClosure({
    entryPath,
    entryContent,
    publishes: (repoPath) => closure.runtimeFiles?.has(repoPath) ?? false,
    read: async (repoPath) => {
      try {
        return await readRuntimeFile(closure, repoPath);
      } catch (error) {
        throw asReleaseDependencyFailure(error, { entryPath, repoPath });
      }
    },
  });
};
