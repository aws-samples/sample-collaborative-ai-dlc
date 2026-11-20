import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { captureNativeSourceBaseline } from '../../agentcore/native/source-baseline.js';
import { createNativeExecutionPorts } from '../../agentcore/native/execution-prepare.js';
import { snapshotNativeExecutionFiles } from '../../agentcore/native/execution-files.js';
import { NATIVE_DEPENDENCY_POLICY } from '../../shared/native-project-files.js';
import { nativeEngineFileDigest } from '../../shared/native-workflow-protocol.js';
import { createNativeArtifactRevisions } from '../../shared/native-artifact-revision.js';
import { verifyCompletedNativeTurn } from '../execution-lifecycle.js';
import { executionIdentity } from '../execution-runtime.js';
import { serialFixture } from './execution-serial-fixtures.js';
import { TABLE } from './fixtures.js';

const git = (cwd, args, input) =>
  execFileSync(
    '/usr/bin/git',
    ['-c', 'user.name=Native Test', '-c', 'user.email=native@example.invalid', ...args],
    {
      cwd,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    },
  );

const fixture = async (project) => {
  const write = async (path, content) => {
    await fs.mkdir(dirname(join(project, path)), { recursive: true });
    await fs.writeFile(join(project, path), content);
  };
  git(project, ['init', '--quiet', '-b', 'main']);
  for (const [path, bytes] of [
    ['run.sh', 'run\n'],
    ['plain.sh', 'plain\n'],
    ['delete.bin', Buffer.from([0, 254])],
    ['old/file', 'old'],
    ['old-file', 'old'],
    ['modify.bin', 'original'],
    ['untouched', 'kept'],
    ['AGENTS.md', 'tracked harness'],
    ['nested/node_modules/pkg/kept', 'tracked dependency'],
  ])
    await write(path, bytes);
  await fs.chmod(join(project, 'plain.sh'), 0o755);
  git(project, ['add', '-A']);
  git(project, ['commit', '--quiet', '-m', 'pinned source']);
  const source = { branch: 'main', commit: git(project, ['rev-parse', 'HEAD']).toString().trim() };
  const f = serialFixture({ source });
  await f.ready();
  const row = f.row();
  const identity = executionIdentity(row);
  const sourceBaseline = await captureNativeSourceBaseline({
    project,
    identity,
    readTree: () => git(project, ['ls-tree', '--full-tree', '-rtz', source.commit]).toString(),
    repository: row.configuration.repository,
    packageId: row.configuration.packageId,
    publications: f.publications,
  });
  const ports = createNativeExecutionPorts({
    env: {
      NATIVE_RUNTIME_MODE: 'isolated',
      NATIVE_EXECUTION_ENABLED: 'true',
      NATIVE_RUNTIME_PROJECT_ID: identity.projectId,
      NATIVE_RUNTIME_EXECUTION_ID: identity.executionId,
      NATIVE_RUNTIME_BINDING_ID: identity.bindingId,
      NATIVE_EXECUTION_ATTEMPT_ID: identity.attemptId,
      NATIVE_EXECUTION_EPOCH: String(identity.epoch),
      NATIVE_EXECUTION_RUNTIME_SESSION_ID: identity.runtimeSessionId,
    },
    publicationFactory: () => f.publications,
  });
  const signal = new AbortController().signal;
  const snapshot = () =>
    ports.snapshot({
      project,
      identity,
      sourceBaseline,
      signal,
      filesystemPolicy: NATIVE_DEPENDENCY_POLICY,
    });
  const publish = (captured, sequence = 1) =>
    ports.publish({
      identity,
      packageId: row.configuration.packageId,
      nativeSessionId: 'fixture-session',
      repository: source,
      outcome: 'STOPPED',
      sequence,
      sourceBaseline,
      signal,
      ...captured,
    });
  const admit = async (receipt, store = f.store) => {
    const interaction = await f.interactions.write({
      identity,
      sequence: receipt.sequence,
      nativeSessionId: receipt.nativeSessionId,
      packageId: row.configuration.packageId,
      harness: row.configuration.harness,
      publicationId: receipt.id,
      messages: [{ type: 'text', text: 'Next turn?' }],
    });
    const claim = await f.store.claim(f.bindingIdentity);
    const state = { row: claim.row };
    try {
      await verifyCompletedNativeTurn({
        state,
        report: { receipt, interaction },
        store,
        publications: f.publications,
        interactions: f.interactions,
        check: f.recheck,
        yieldPending: async () => {},
      });
    } finally {
      await f.store.release({ row: state.row });
    }
  };
  const read = (receipt) =>
    f.api.revision(
      f.prepared,
      {
        publicationId: receipt.id,
        publicationSequence: receipt.sequence,
        source: true,
      },
      f.recheck,
    );
  return { f, project, identity, source, sourceBaseline, snapshot, write, publish, admit, read };
};

it('reconstructs the named result from its Start commit and immutable files with Git', async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-git-result-')));
  const project = join(root, 'project');
  await fs.mkdir(project, { mode: 0o700 });
  try {
    const { f, source, snapshot, write, publish, admit, read } = await fixture(project);
    await fs.chmod(join(project, 'run.sh'), 0o755);
    await fs.chmod(join(project, 'plain.sh'), 0o644);
    await fs.rm(join(project, 'delete.bin'));
    await fs.rm(join(project, 'old'), { recursive: true });
    await write('old', 'replaced directory');
    await fs.rm(join(project, 'old-file'));
    await write('old-file/child', 'replaced file');
    await write('modify.bin', Buffer.from([0, 255, 13, 10]));
    await write('empty ü', Buffer.alloc(0));
    await fs.chmod(join(project, 'empty ü'), 0o700);
    await fs.rm(join(project, 'AGENTS.md'));
    await fs.rm(join(project, 'nested/node_modules'), { recursive: true });
    await write('aidlc/spaces/p/.aidlc-engine/review.json', 'public workflow evidence');
    await write('.native-control/private', 'private');
    // The coding workspace can even move HEAD. The producer uses the pre-turn receipt.
    git(project, ['add', '-A']);
    git(project, ['commit', '--quiet', '-m', 'untrusted later HEAD']);
    const captured = await snapshot();
    const { receipt } = await publish(captured);
    await admit(receipt);
    const first = await read(receipt);
    expect(first).toMatchObject({
      publicationId: receipt.id,
      publicationSequence: 1,
      gitChangeSet: {
        publicationId: receipt.id,
        publicationSequence: 1,
        sourceBaselineId: first.baseline.id,
        repository: {
          ...source,
          provider: f.row().configuration.repository.provider,
          repository: f.row().configuration.repository.repository,
        },
        review: 'not_verified',
      },
    });
    const { changes } = first.gitChangeSet;
    expect(changes.map(({ path }) => path)).toEqual([
      'delete.bin',
      'empty ü',
      'modify.bin',
      'old',
      'old-file',
      'old-file/child',
      'old/file',
      'plain.sh',
      'run.sh',
    ]);
    const run = changes.find((c) => c.path === 'run.sh');
    expect(run.after).toEqual({ ...run.before, mode: '100755' });
    const plain = changes.find((c) => c.path === 'plain.sh');
    expect(plain.after).toEqual({ ...plain.before, mode: '100644' });
    expect(changes.find((c) => c.path === 'delete.bin').after).toBeNull();
    expect(changes.find((c) => c.path === 'empty ü')).toMatchObject({
      before: null,
      after: { bytes: 0, mode: '100755' },
    });

    const reconstruct = join(root, 'reconstruct');
    git(root, ['clone', '-q', '--no-checkout', project, reconstruct]);
    git(reconstruct, ['read-tree', source.commit]);
    const revisions = createNativeArtifactRevisions({
      ddb: f.ddb,
      nativeTable: TABLE,
      publications: f.publications,
    });
    const target = { publicationId: receipt.id, publicationSequence: 1 };
    const row = structuredClone(f.row());
    row.configuration.repository.commit = 'f'.repeat(40);
    await expect(revisions.source(row, target)).rejects.toMatchObject({
      code: 'NATIVE_ARTIFACT_REVISION_INVALID',
    });
    const unavailableProof = vi.fn(async () => {
      throw new Error('unavailable');
    });
    expect(
      (
        await f
          .makeApi(true, unavailableProof)
          .revision(f.prepared, { ...target, source: true }, f.recheck)
      ).gitChangeSet,
    ).toEqual(first.gitChangeSet);
    expect(unavailableProof).not.toHaveBeenCalled();
    for (const { path } of changes.filter((c) => !c.after))
      git(reconstruct, ['update-index', '--force-remove', '--', path]);
    for (const { path, fileId, after } of changes.filter((c) => c.after)) {
      const bytes = await revisions.bytes(f.row(), { ...target, fileId, sha256: after.sha256 });
      const oid = git(reconstruct, ['hash-object', '-w', '--stdin'], bytes).toString().trim();
      git(reconstruct, ['update-index', '--add', '--cacheinfo', after.mode, oid, path]);
    }
    // Independently construct the expected tree from the real later commit,
    // restoring the excluded tracked assets and removing generated private data.
    const expected = git(project, ['rev-parse', 'HEAD']).toString().trim();
    const actualTree = git(reconstruct, ['write-tree']).toString().trim();
    git(reconstruct, ['read-tree', expected]);
    git(reconstruct, [
      'restore',
      '--staged',
      `--source=${source.commit}`,
      '--',
      'AGENTS.md',
      'nested/node_modules',
      '.native-control',
      'aidlc',
    ]);
    expect(actualTree).toBe(git(reconstruct, ['write-tree']).toString().trim());

    await f.respond();
    const claim = await f.store.claim(f.bindingIdentity);
    const dispatched = await f.store.dispatched({ row: claim.row });
    await f.store.release({ row: dispatched });
    await fs.chmod(join(project, 'run.sh'), 0o644);
    const next = await snapshot();
    // NE-11's inspected bytes are identical even though the Git change set differs.
    expect(nativeEngineFileDigest(next.files)).toBe(nativeEngineFileDigest(captured.files));
    expect(next.git.inventorySha256).not.toBe(captured.git.inventorySha256);
    const second = await publish(next, 2);
    await admit(second.receipt);
    expect((await read(second.receipt)).gitChangeSet).toMatchObject({
      review: 'not_verified',
      changes: changes.filter((change) => change.path !== 'run.sh'),
    });
    expect((await read(receipt)).gitChangeSet).toEqual(first.gitChangeSet);
    await expect(
      f.api.revision(f.prepared, { ...target, publicationSequence: 2, source: true }, f.recheck),
    ).rejects.toThrow();
    f.authorization.member = false;
    await expect(read(receipt)).rejects.toMatchObject({ code: 'NATIVE_PREPARATION_FORBIDDEN' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('requires an observed absence and a complete capture, and preserves excluded base entries', async () => {
  const project = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-git-errors-')));
  try {
    const { f, identity, sourceBaseline, snapshot, write, publish, admit, read } =
      await fixture(project);
    const base = await f.publications.read(identity, sourceBaseline.receipt);
    const unmodified = await publish(await snapshot());
    expect(
      (
        await f.publications.source(
          identity,
          await f.publications.read(identity, unmodified.receipt),
        )
      ).changes,
    ).toEqual([]);
    const filtered = {
      ...fs,
      readdir: async (path) => (await fs.readdir(path)).filter((p) => p !== 'untouched'),
    };
    await expect(
      snapshotNativeExecutionFiles({
        project,
        io: filtered,
        gitBaseline: base,
        filesystemPolicy: NATIVE_DEPENDENCY_POLICY,
      }),
    ).rejects.toMatchObject({ code: 'native_snapshot_changed' });
    await fs.rm(join(project, 'delete.bin'));
    await write('new', 'added');
    const capture = await snapshot();
    await expect(
      publish({ ...capture, files: capture.files.filter((file) => file.path !== 'new') }),
    ).rejects.toMatchObject({ code: 'NATIVE_PUBLICATION_INVALID' });
    await expect(
      publish({
        ...capture,
        files: capture.files.map((file) =>
          file.path === 'new' ? { ...file, mode: '100755' } : file,
        ),
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_PUBLICATION_INVALID' });
    for (const altered of [
      { deleted: [] },
      { deleted: ['delete.bin', 'unknown'] },
      { repository: 'another/repo' },
    ]) {
      const { receipt } = await publish({ ...capture, git: { ...capture.git, ...altered } });
      const store = { publish: vi.fn() };
      await expect(admit(receipt, store)).rejects.toMatchObject({
        code: 'NATIVE_PUBLICATION_INVALID',
      });
      expect(store.publish).not.toHaveBeenCalled();
    }
    await fs.rm(join(project, 'nested'), { recursive: true });
    await write('nested', 'would replace a tracked excluded dependency');
    const conflict = await snapshot();
    expect(conflict.git).toBeUndefined();
    const { receipt } = await publish(conflict);
    await admit(receipt);
    expect(await read(receipt)).toMatchObject({ status: 'captured', gitChangeSet: null });
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});
