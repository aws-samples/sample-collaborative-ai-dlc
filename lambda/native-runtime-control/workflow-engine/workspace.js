import { chmod, mkdir, lstat, readdir, readFile, writeFile, rm, rmdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareNativeEngine } from './package.js';
import {
  engineDigest,
  engineFailure,
  encodeNativeEngineFiles,
  nativeEngineFiles,
  nativeEngineAuthoredPath,
  nativeEngineFileDigest,
  NATIVE_ENGINE_SETTINGS_PATHS,
} from '../../shared/native-workflow-protocol.js';
import {
  nativeFileExclusion,
  NATIVE_DEPENDENCY_POLICY,
} from '../../shared/native-project-files.js';

const ADAPTER = dirname(fileURLToPath(import.meta.url));
const write = async (root, files) => {
  for (const file of files) {
    const path = join(root, file.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, file.content, { mode: 0o600 });
    if (file.mode) await chmod(path, file.mode === '100755' ? 0o700 : 0o600);
  }
};
const removeAuthored = async (project, path) => {
  const file = join(project, path);
  await rm(file, { force: true });
  // Permit a later regular file to replace a directory emptied by explicit edits.
  for (let parent = dirname(file); parent !== project; parent = dirname(parent)) {
    try {
      await rmdir(parent);
    } catch (error) {
      if (['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes(error.code)) break;
      throw error;
    }
  }
};
const collect = async (root, include = () => true) => {
  const files = [];
  let entries = 0;
  let bytes = 0;
  const walk = async (directory) => {
    for (const name of (await readdir(directory)).toSorted()) {
      if (++entries > 40_000) throw engineFailure('NATIVE_ENGINE_WORKSPACE_LIMIT');
      const path = join(directory, name);
      const rel = relative(root, path);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw engineFailure('NATIVE_ENGINE_WORKSPACE_INVALID');
      if (stat.isDirectory()) {
        if (rel.split('/').length > 64) throw engineFailure('NATIVE_ENGINE_WORKSPACE_LIMIT');
        await walk(path);
      } else if (stat.isFile() && stat.nlink === 1) {
        if (!include(rel)) continue;
        if (stat.size > 16 * 1024 * 1024 || (bytes += stat.size) > 128 * 1024 * 1024)
          throw engineFailure('NATIVE_ENGINE_WORKSPACE_LIMIT');
        files.push({
          path: rel,
          mode: stat.mode & 0o100 ? '100755' : '100644',
          content: await readFile(path),
        });
      } else throw engineFailure('NATIVE_ENGINE_WORKSPACE_INVALID');
    }
  };
  await walk(root);
  return nativeEngineFiles(encodeNativeEngineFiles(files));
};
const privateHomeFile = (path) =>
  !['modules.json', 'engine.bunfig.toml', 'engine.tsconfig.json'].includes(path);
const authoredPaths = (directive) =>
  [
    ...(directive?.produces ?? []),
    ...(directive?.wave?.entries ?? []).flatMap((entry) => entry.produces ?? []),
  ].filter((path) => typeof path === 'string');

// This workspace exists only in the protected Lambda, never on the coding
// runtime's EFS mount. /tmp paths stay stable across snapshot restoration.
export const openNativeEngineWorkspace = async ({
  archive,
  harness,
  snapshot,
  root = '/tmp/native-workflow-engine',
  adapterDirectory = ADAPTER,
}) => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { mode: 0o700 });
  const project = join(root, 'project');
  const home = join(root, 'home');
  await mkdir(home, { mode: 0o700 });
  const engine = await prepareNativeEngine({
    archive,
    harness,
    directory: project,
    adapterDirectory,
  });
  const staticPath = (path) =>
    path.startsWith(`${relative(project, engine.installation)}/`) ||
    path.startsWith('.agents/') ||
    ['AGENTS.md', 'CLAUDE.md', 'opencode.json', 'opencode.jsonc'].includes(path);
  const state = snapshot
    ? structuredClone(snapshot.state)
    : {
        schemaVersion: 1,
        directive: null,
        operations: [],
        decisions: [],
        observations: [],
        authored: [],
        initialMessage: null,
        presentations: [],
        unappliedReplies: [],
        awaitingApproval: null,
        requirements: [],
        unownedPublic: [],
        sourceSettings: null,
        terminalResult: null,
      };
  if (snapshot) {
    if (snapshot.schemaVersion !== 1 || state?.schemaVersion !== 1)
      throw engineFailure('NATIVE_ENGINE_STATE_INVALID');
    const restored = nativeEngineFiles(snapshot.project);
    if (restored.some((file) => staticPath(file.path)))
      throw engineFailure('NATIVE_ENGINE_STATE_INVALID');
    await write(project, restored);
    const privateFiles = nativeEngineFiles(snapshot.home);
    if (privateFiles.some((file) => !privateHomeFile(file.path)))
      throw engineFailure('NATIVE_ENGINE_STATE_INVALID');
    await write(home, privateFiles);
  }
  const publicProjection = async () => {
    const protectedFiles = await collect(
      project,
      (path) => !staticPath(path) && nativeFileExclusion(path, NATIVE_DEPENDENCY_POLICY) === null,
    );
    const merged = new Map(
      nativeEngineFiles(state.unownedPublic ?? []).map((file) => [file.path, file]),
    );
    for (const file of protectedFiles) merged.set(file.path, file);
    return nativeEngineFiles(encodeNativeEngineFiles([...merged.values()]));
  };
  return {
    project,
    home,
    engine,
    state,
    async initializeSettings(settings, commit) {
      if (state.sourceSettings) return;
      const files = nativeEngineFiles(settings?.files);
      if (
        settings.schemaVersion !== 1 ||
        settings.commit !== commit ||
        settings.filesSha256 !== nativeEngineFileDigest(files) ||
        files.some((file) => !NATIVE_ENGINE_SETTINGS_PATHS.includes(file.path))
      )
        throw engineFailure('NATIVE_ENGINE_SETTINGS_UNAVAILABLE');
      await write(project, files);
      state.sourceSettings = {
        commit,
        filesSha256: settings.filesSha256,
        files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
      };
    },
    async importAuthored(input, runner, sessionId) {
      const files = nativeEngineFiles(input);
      if (files.some((file) => nativeFileExclusion(file.path, NATIVE_DEPENDENCY_POLICY) !== null))
        throw engineFailure('NATIVE_ENGINE_INPUT_INVALID');
      const artifacts = authoredPaths(state.directive);
      const selected = files.filter((file) => nativeEngineAuthoredPath(file.path, artifacts));
      const incoming = new Map(selected.map((file) => [file.path, file]));
      const prior = new Map(state.authored.map((file) => [file.path, file]));
      for (const path of new Set([...prior.keys(), ...incoming.keys()])) {
        const next = incoming.get(path);
        const old = prior.get(path);
        // Authored stage outputs outside the current directive are retained as
        // read-only engine inputs. Removing a prior capability never deletes them.
        if (
          !nativeEngineAuthoredPath(path, artifacts) ||
          (next?.sha256 === old?.sha256 && (!next?.mode || next.mode === old?.mode))
        )
          continue;
        if (old || state.initialMessage) {
          const input = {
            hook_event_name: 'PreToolUse',
            session_id: sessionId,
            cwd: project,
            tool_name: 'Write',
            tool_input: {
              file_path: join(project, path),
              content: next?.content.toString('utf8') ?? '',
            },
          };
          for (const hook of ['aidlc-plan-approval-guard.ts', 'aidlc-review-freeze.ts']) {
            const checked = await runner.hook(hook, input);
            if (checked.exitCode !== 0) throw engineFailure('NATIVE_ENGINE_EDIT_DENIED');
          }
        }
        if (!next) {
          await removeAuthored(project, path);
          continue;
        }
        await write(project, [next]);
        // The pinned reviewer checks whether a stage document was written
        // under the current summary confirmation in this protected workspace.
        if (artifacts.includes(path) && next.sha256 !== old?.sha256) {
          const recorded = await runner.hook('aidlc-write-audit-log.ts', {
            hook_event_name: 'PostToolUse',
            session_id: sessionId,
            cwd: project,
            tool_name: 'Write',
            tool_input: { file_path: join(project, path) },
          });
          if (recorded.exitCode !== 0) throw engineFailure('NATIVE_ENGINE_EDIT_DENIED');
        }
      }
      state.authored = [
        ...state.authored.filter((file) => !nativeEngineAuthoredPath(file.path, artifacts)),
        ...selected.map(({ content: _content, ...file }) => file),
      ];
      // Repository records outside the active engine's ownership remain
      // public data. They are never restored into its private ledger or used
      // as policy. Retain only paths absent from the protected projection.
      const protectedPaths = new Set(
        (await collect(project, (path) => !staticPath(path))).map((file) => file.path),
      );
      state.unownedPublic = encodeNativeEngineFiles(
        files.filter((file) => !protectedPaths.has(file.path)),
      );
      return nativeEngineFileDigest(files);
    },
    publicFiles: publicProjection,
    async inspectCheck({ sensor, outputPath }) {
      const files = await publicProjection();
      const inspected = files.filter(
        (file) => file.path === outputPath || file.path.startsWith(`${outputPath}/`),
      );
      if (!inspected.length) throw engineFailure('NATIVE_ENGINE_CHECK_INPUT_UNAVAILABLE');
      return {
        checkedPath: outputPath,
        checkedSha256: nativeEngineFileDigest(inspected),
        sourceSha256: ['linter', 'type-check'].includes(sensor)
          ? nativeEngineFileDigest(files.filter((file) => nativeEngineAuthoredPath(file.path)))
          : null,
        filesSha256: nativeEngineFileDigest(files),
      };
    },
    async inspectionFiles() {
      return nativeEngineFiles(
        encodeNativeEngineFiles([
          ...(await publicProjection()),
          ...(await collect(project, (path) => path.startsWith('.git/'))),
        ]),
      );
    },
    async snapshot() {
      if (
        state.operations.length > 2_000 ||
        state.decisions.length > 2_000 ||
        (state.unappliedReplies?.length ?? 0) > 2_000 ||
        state.observations.length > 4_000
      )
        throw engineFailure('NATIVE_ENGINE_WORKSPACE_LIMIT');
      return {
        schemaVersion: 1,
        state,
        project: encodeNativeEngineFiles(await collect(project, (path) => !staticPath(path))),
        home: encodeNativeEngineFiles(await collect(home, privateHomeFile)),
      };
    },
    digest: engineDigest,
    close: () => rm(root, { recursive: true, force: true }),
  };
};
