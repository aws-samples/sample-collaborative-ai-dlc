import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeExecutionPorts } from '../native/execution-prepare.js';
import { runNativeCommand } from '../native/command-runner.js';
import { withGitCredential } from '../git-auth.js';
import { loadNativePackage } from '../native/package-loader.js';
import { createNativePackageArchive } from '../../shared/native-package-archive.js';
import { verifyNativeReleaseDirectory } from '../../shared/native-runtime-package.js';
import { describeNativePackagePin } from '../../shared/native-package-pin.js';
import { workflowSourceIdentity } from '../../shared/workflow-source-bindings.js';
import { createNativeReleaseFixture } from '../../shared/test/fixtures/native-release.js';
import { createNativePackageS3 } from '../../shared/test/fixtures/native-package-s3.js';
import { nativeExecutionFenceKey } from '../../shared/native-execution-fence.js';
import { createNativePublications } from '../../shared/native-publication.js';

const execute = promisify(execFile);
const bucket = 'native-package-prepare-fixture';
const account = '123456789012';
let temp;
beforeEach(async () => {
  temp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-execution-prepare-')));
});
const removable = async (path) => {
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  await fs.chmod(path, 0o700);
  for (const entry of await fs.readdir(path, { withFileTypes: true }))
    if (entry.isDirectory()) await removable(join(path, entry.name));
};
afterEach(async () => {
  await removable(temp);
  await fs.rm(temp, { recursive: true, force: true });
});
const gitAt = async (cwd, ...args) => {
  const { stdout } = await execute(
    '/usr/bin/git',
    [
      '-c',
      'user.name=Native Test',
      '-c',
      'user.email=native@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    },
  );
  return stdout.trim();
};
const fixture = async () => {
  const root = join(temp, 'mount');
  const project = join(root, 'project');
  const home = join(temp, 'home');
  const origin = join(temp, 'origin');
  const askpassRoot = join(temp, 'askpass');
  for (const path of [root, project, home, origin, askpassRoot])
    await fs.mkdir(path, { mode: 0o700 });
  await gitAt(origin, 'init', '--quiet', '-b', 'main');
  await fs.writeFile(join(origin, 'game.js'), 'original exact source\n');
  await gitAt(origin, 'add', 'game.js');
  await gitAt(origin, 'commit', '--quiet', '-m', 'original');
  const commit = await gitAt(origin, 'rev-parse', 'HEAD');
  await fs.writeFile(join(origin, 'game.js'), 'newer branch source must not be checked out\n');
  await gitAt(origin, 'commit', '--quiet', '-am', 'newer');
  const newerCommit = await gitAt(origin, 'rev-parse', 'HEAD');

  const release = await createNativeReleaseFixture(join(temp, 'release'));
  const packagePin = await verifyNativeReleaseDirectory(release);
  const pin = describeNativePackagePin(packagePin, null);
  const loaded = await loadNativePackage({
    releaseDirectory: release.directory,
    cacheDirectory: join(temp, 'initial-cache'),
    pin: packagePin,
    attestation: null,
  });
  const memory = createNativePackageS3({ expectedBucketOwner: account });
  memory.beforeSend = async ({ name, input }) => {
    if (name === 'PutObjectCommand' && input.Key.startsWith('native-executions/')) {
      expect(input.ChecksumSHA256).toBe(createHash('sha256').update(input.Body).digest('base64'));
      const stored = memory.putVersion(input.Key, input.Body);
      return { VersionId: stored.versionId };
    }
  };
  const sourceId = workflowSourceIdentity(
    release.source.provider,
    release.source.repository,
  ).sourceId;
  const identity = {
    projectId: randomUUID(),
    executionId: randomUUID(),
    bindingId: randomUUID(),
    attemptId: randomUUID(),
    epoch: 1,
    runtimeSessionId: randomUUID(),
  };
  const archive = createNativePackageArchive({
    s3: memory.s3,
    bucket,
    expectedBucketOwner: account,
    workRoot: join(temp, 'publish-work'),
    materialize: loadNativePackage,
  });
  const archiveReceipt = await archive.publish({
    projectId: identity.projectId,
    sourceId,
    materialization: loaded,
    beforeCommit: async () => {},
  });
  memory.operations.length = 0;
  const env = {
    NATIVE_RUNTIME_MODE: 'isolated',
    NATIVE_EXECUTION_ENABLED: 'true',
    NATIVE_RUNTIME_PROJECT_ID: identity.projectId,
    NATIVE_RUNTIME_EXECUTION_ID: identity.executionId,
    NATIVE_RUNTIME_BINDING_ID: identity.bindingId,
    NATIVE_EXECUTION_ATTEMPT_ID: identity.attemptId,
    NATIVE_EXECUTION_EPOCH: '1',
    NATIVE_EXECUTION_RUNTIME_SESSION_ID: identity.runtimeSessionId,
    NATIVE_RUNTIME_ACCOUNT_ID: account,
    NATIVE_PACKAGE_BUCKET: bucket,
    NATIVE_PUBLICATION_BUCKET: 'native-publications-fixture',
    AWS_REGION: 'us-east-1',
  };
  const fenceKey = nativeExecutionFenceKey(identity);
  const { epoch: _epoch, ...fenceIdentity } = identity;
  const fenceRecord = { schemaVersion: 1, state: 'ACTIVE', ...fenceIdentity };
  memory.putVersion(fenceKey, Buffer.from(JSON.stringify(fenceRecord)), 'trusted-active-version');
  const payload = {
    command: 'native-start',
    schemaVersion: 1,
    ...identity,
    configuration: {
      harness: 'codex',
      model: 'configured-model',
      prompt: 'Fix the pipe visualization',
      packageVersion: '2.9.0',
      repository: { provider: 'github', repository: 'owner/flappy-bird', branch: 'main', commit },
    },
    package: {
      candidate: {
        projectId: identity.projectId,
        sourceId,
        packagePin,
        attestation: null,
        materializationId: pin.materializationId,
      },
      archiveReceipt,
    },
    credentials: {
      model: { provider: 'bedrock', value: 'inert-model-secret' },
      git: { username: 'inert-git-user', password: 'inert-git-secret' },
    },
  };
  const calls = [];
  const commandRunner = vi.fn(async (input) => {
    calls.push({ ...input, args: [...input.args], env: { ...input.env } });
    let args = [...input.args];
    const fetchIndex = args.indexOf('fetch');
    if (fetchIndex !== -1) {
      // The production command is asserted below. Only this inert test runner
      // substitutes the HTTPS origin with a local source and permits file://.
      args = input.args.flatMap((arg, index) => {
        if (arg === 'protocol.file.allow=never') return ['protocol.file.allow=always'];
        if (index === input.args.indexOf('origin', fetchIndex)) return [origin];
        return [arg];
      });
    }
    return runNativeCommand({ ...input, args });
  });
  const gitCredential = vi.fn(async (context, operation, options) =>
    withGitCredential(
      context,
      async (credentials) => {
        const helper = credentials.env.GIT_ASKPASS;
        expect(helper.startsWith(`${askpassRoot}/`)).toBe(true);
        const content = await fs.readFile(helper, 'utf8');
        expect(content).not.toContain(payload.credentials.git.password);
        return operation(credentials);
      },
      { ...options, tempRoot: askpassRoot },
    ),
  );
  const ports = createNativeExecutionPorts({ env, s3: memory.s3, commandRunner, gitCredential });
  const signal = new AbortController().signal;
  const input = { payload, root, project, home, signal };
  return {
    ports,
    input,
    identity,
    env,
    memory,
    origin,
    commit,
    newerCommit,
    project,
    home,
    root,
    commandRunner,
    calls,
    gitCredential,
    askpassRoot,
    fenceKey,
    fenceRecord,
  };
};

describe('native execution preparation with real local Git and versioned package bytes', () => {
  it('restores the exact archived package, accepts mode 0500, and checks out the exact SHA rather than branch tip', async () => {
    const f = await fixture();
    const prepared = await f.ports.prepare(f.input);
    expect(prepared.repositoryCommit).toBe(f.commit);
    expect(prepared.repositoryCommit).not.toBe(f.newerCommit);
    expect(await fs.readFile(join(f.project, 'game.js'), 'utf8')).toBe('original exact source\n');
    expect((await fs.lstat(prepared.package.directory)).mode & 0o777).toBe(0o500);
    expect(prepared.package.packageId).toBe(f.input.payload.package.candidate.packagePin.packageId);
    expect(prepared.authEnv).toEqual({
      AWS_BEARER_TOKEN_BEDROCK: 'inert-model-secret',
      BEDROCK_REGION: 'us-east-1',
    });
    expect(prepared.forbiddenBytes).toEqual(['inert-git-secret', 'inert-model-secret']);
    expect(f.memory.operations.length).toBeGreaterThan(0);
    expect(
      f.memory.operations.every(
        (op) =>
          (op.name === 'PutObjectCommand' && op.input.Key.startsWith('native-executions/')) ||
          (op.name === 'GetObjectCommand' &&
            (op.input.Key === f.fenceKey
              ? !Object.hasOwn(op.input, 'VersionId')
              : op.input.VersionId)),
      ),
    ).toBe(true);
    const publications = createNativePublications({
      s3: f.memory.s3,
      bucket: f.env.NATIVE_PUBLICATION_BUCKET,
      accountId: account,
    });
    const baseline = await publications.read(f.identity, prepared.sourceBaseline.receipt, {
      verifyFiles: true,
    });
    await fs.writeFile(join(f.project, 'game.js'), 'changed after trusted preparation\n');
    expect(baseline.repository.commit).toBe(f.commit);
    expect(baseline.files.map((file) => file.path)).toEqual(['game.js']);
    expect(
      (await publications.file(f.identity, baseline, baseline.files[0].id)).bytes.toString(),
    ).toBe('original exact source\n');
    const fetch = f.calls.find((call) => call.args.includes('fetch'));
    expect(fetch.args.slice(fetch.args.indexOf('fetch'))).toEqual([
      'fetch',
      '--depth=1',
      '--no-tags',
      '--no-recurse-submodules',
      'origin',
      f.commit,
    ]);
    expect(fetch.env.AIDLC_GIT_PASSWORD).toBe('inert-git-secret');
    expect(fetch.args.join(' ')).not.toContain('inert-git-secret');
    for (const call of f.calls.filter((entry) => !entry.args.includes('fetch'))) {
      expect(call.env).not.toHaveProperty('AIDLC_GIT_PASSWORD');
      expect(call.env).not.toHaveProperty('AWS_BEARER_TOKEN_BEDROCK');
    }
    const config = await fs.readFile(join(f.project, '.git/config'), 'utf8');
    expect(config).toContain('https://github.com/owner/flappy-bird.git');
    expect(config).not.toMatch(/inert-git-secret|inert-model-secret|askpass/);
    expect(await fs.readdir(f.askpassRoot)).toEqual([]);
    expect(await fs.readdir(f.home)).toEqual([]);
    expect(await fs.readdir(join(f.root, 'package-downloads'))).toEqual([]);
    const exclude = await fs.readFile(join(f.project, '.git/info/exclude'), 'utf8');
    expect(exclude).toContain('aidlc/**/.aidlc-engine/');
    expect(exclude).toContain('aidlc/.aidlc-sessions/');
  });

  it.each(['attemptId', 'bindingId', 'runtimeSessionId', 'projectId', 'epoch'])(
    'rejects a mismatched %s before reading archives or invoking Git',
    async (field) => {
      const f = await fixture();
      f.input.payload[field] = field === 'epoch' ? 2 : randomUUID();
      await expect(f.ports.prepare(f.input)).rejects.toMatchObject({
        code: 'native_execution_scope_mismatch',
      });
      expect(f.memory.operations).toEqual([]);
      expect(f.commandRunner).not.toHaveBeenCalled();
    },
  );

  it.each([
    'model-provider',
    'missing-git',
    'pin-id',
    'package-project',
    'source-id',
    'materialization',
    'missing-receipt',
  ])('rejects %s without fallback or Git activity', async (kind) => {
    const f = await fixture();
    const p = f.input.payload;
    if (kind === 'model-provider') p.credentials.model.provider = 'kiro';
    if (kind === 'missing-git') delete p.credentials.git.password;
    if (kind === 'pin-id') p.package.candidate.packagePin.packageId = `sha256:${'0'.repeat(64)}`;
    if (kind === 'package-project') p.package.candidate.projectId = randomUUID();
    if (kind === 'source-id') p.package.candidate.sourceId = '0'.repeat(64);
    if (kind === 'materialization')
      p.package.candidate.materializationId = `sha256:${'0'.repeat(64)}`;
    if (kind === 'missing-receipt') delete p.package.archiveReceipt;
    await expect(f.ports.prepare(f.input)).rejects.toMatchObject({
      code:
        kind === 'model-provider' || kind === 'missing-git'
          ? 'native_execution_preparation_invalid'
          : 'native_execution_package_invalid',
    });
    expect(
      f.memory.operations.every(
        (op) => op.name === 'GetObjectCommand' && op.input.Key === f.fenceKey,
      ),
    ).toBe(true);
    expect(f.commandRunner).not.toHaveBeenCalled();
  });

  it.each(['file', 'symlink'])('refuses an existing unsafe checkout: %s', async (kind) => {
    const f = await fixture();
    if (kind === 'file') await fs.writeFile(join(f.project, 'keep'), 'existing');
    else {
      await fs.rmdir(f.project);
      await fs.symlink(f.origin, f.project);
    }
    await expect(f.ports.prepare(f.input)).rejects.toMatchObject({
      code:
        kind === 'file' ? 'native_execution_checkout_exists' : 'native_execution_directory_invalid',
    });
    expect(
      f.memory.operations.every(
        (op) => op.name === 'GetObjectCommand' && op.input.Key === f.fenceKey,
      ),
    ).toBe(true);
    expect(f.commandRunner).not.toHaveBeenCalled();
  });

  it('does not substitute an available package or fetch when the pinned archive is missing', async () => {
    const f = await fixture();
    for (const key of f.memory.objects.keys()) if (key !== f.fenceKey) f.memory.objects.delete(key);
    await expect(f.ports.prepare(f.input)).rejects.toMatchObject({
      code: 'native_package_archive_not_found',
    });
    expect(f.commandRunner).not.toHaveBeenCalled();
    expect(await fs.readdir(f.project)).toEqual([]);
    expect(f.memory.operations.every((op) => op.name === 'GetObjectCommand')).toBe(true);
  });

  it('rejects substituted materializer results before Git', async () => {
    const f = await fixture();
    const ports = createNativeExecutionPorts({
      env: f.env,
      s3: f.memory.s3,
      commandRunner: f.commandRunner,
      packageArchive: () => ({ restore: async () => ({ directory: '/arbitrary/fallback' }) }),
    });
    await expect(ports.prepare(f.input)).rejects.toMatchObject({
      code: 'native_execution_package_invalid',
    });
    expect(f.commandRunner).not.toHaveBeenCalled();
  });

  it.each(['symlink', 'private-state', 'submodule', 'lfs'])(
    'rejects checked-out %s before any model can run',
    async (kind) => {
      const f = await fixture();
      if (kind === 'symlink') await fs.symlink('/etc/passwd', join(f.origin, 'unsafe'));
      if (kind === 'private-state') {
        await fs.mkdir(join(f.origin, 'aidlc/spaces/default/intents/example/.aidlc-engine'), {
          recursive: true,
        });
        await fs.writeFile(
          join(f.origin, 'aidlc/spaces/default/intents/example/.aidlc-engine/steering-token-key'),
          'tracked-key',
        );
      }
      if (kind === 'lfs') {
        await fs.writeFile(
          join(f.origin, '.gitattributes'),
          '*.bin filter=lfs diff=lfs merge=lfs -text\n',
        );
        await fs.writeFile(
          join(f.origin, 'asset.bin'),
          `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 123\n`,
        );
      }
      await gitAt(f.origin, 'add', '.');
      if (kind === 'submodule')
        await gitAt(
          f.origin,
          'update-index',
          '--add',
          '--cacheinfo',
          `160000,${f.commit},nested-repo`,
        );
      await gitAt(f.origin, 'commit', '--quiet', '-m', 'unsafe checkout fixture');
      f.input.payload.configuration.repository.commit = await gitAt(f.origin, 'rev-parse', 'HEAD');
      await expect(f.ports.prepare(f.input)).rejects.toMatchObject({
        code:
          kind === 'symlink'
            ? 'native_execution_checkout_link'
            : kind === 'submodule'
              ? 'native_execution_submodules_unavailable'
              : kind === 'lfs'
                ? 'native_execution_lfs_unavailable'
                : 'native_execution_private_state_tracked',
      });
      expect(await fs.readdir(f.askpassRoot)).toEqual([]);
    },
  );

  it('rejects a different observed HEAD and removes the ephemeral credential helper on failure', async () => {
    const f = await fixture();
    const runner = async (input) => {
      const result = await f.commandRunner(input);
      return input.args.includes('rev-parse')
        ? { ...result, stdout: `${'0'.repeat(40)}\n` }
        : result;
    };
    const ports = createNativeExecutionPorts({
      env: f.env,
      s3: f.memory.s3,
      commandRunner: runner,
      gitCredential: f.gitCredential,
    });
    await expect(ports.prepare(f.input)).rejects.toMatchObject({
      code: 'native_execution_checkout_commit_mismatch',
    });
    expect(await fs.readdir(f.askpassRoot)).toEqual([]);
  });

  it('honors cancellation before archive reads and Git', async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(f.ports.prepare({ ...f.input, signal: controller.signal })).rejects.toMatchObject({
      code: 'native_execution_cancelled',
    });
    expect(f.memory.operations).toEqual([]);
    expect(f.commandRunner).not.toHaveBeenCalled();
  });
});

describe('native upload-only publication port', () => {
  it('refreshes only a supplied model credential for continuation, with a fresh cancellation read and no checkout', async () => {
    const f = await fixture();
    const model = f.input.payload.credentials.model;
    const payload = {
      ...f.input.payload,
      command: 'native-continue',
      credentials: { model },
    };
    const result = await f.ports.prepareContinuation({ payload, signal: f.input.signal });
    expect(result.authEnv.AWS_BEARER_TOKEN_BEDROCK).toBe(model.value);
    expect(result.forbiddenBytes).toEqual([model.value]);
    expect(f.commandRunner).not.toHaveBeenCalled();
    expect(f.memory.operations.every((operation) => operation.input.Key === f.fenceKey)).toBe(true);
    for (const changes of [
      { attemptId: randomUUID() },
      { credentials: { model: { provider: 'kiro', value: 'wrong-provider' } } },
      { credentials: {} },
    ])
      await expect(
        f.ports.prepareContinuation({
          payload: { ...payload, ...changes },
          signal: f.input.signal,
        }),
      ).rejects.toBeTruthy();
    expect(f.commandRunner).not.toHaveBeenCalled();
  });
  it('writes interaction with complete scope and exact sequence/publication pairing', async () => {
    const f = await fixture();
    const write = vi.fn(async () => ({ id: 'receipt' }));
    const ports = createNativeExecutionPorts({
      env: f.env,
      s3: f.memory.s3,
      interactionFactory: () => ({ write }),
    });
    const input = {
      identity: f.identity,
      sequence: 2,
      publicationId: 'a'.repeat(64),
      nativeSessionId: 'native-session',
      harness: 'codex',
      packageId: f.input.payload.package.candidate.packagePin.packageId,
      messages: [{ type: 'text', text: 'Proposal\nQuestion?' }],
      signal: new AbortController().signal,
    };
    expect(await ports.publishInteraction(input)).toEqual({ id: 'receipt' });
    const { signal: _signal, ...expected } = input;
    expect(write).toHaveBeenCalledWith(expected);
    await expect(
      ports.publishInteraction({
        ...input,
        identity: { ...f.identity, runtimeSessionId: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: 'native_execution_scope_mismatch' });
    expect(write).toHaveBeenCalledOnce();
  });
  it('uses the final flat contract and returns uploaded receipt without authority commit', async () => {
    const f = await fixture();
    const receipt = { id: 'test-uploaded-receipt' };
    const write = vi.fn(async () => receipt);
    const ports = createNativeExecutionPorts({
      env: f.env,
      s3: f.memory.s3,
      publicationFactory: () => ({ write }),
    });
    const input = {
      identity: f.identity,
      packageId: f.input.payload.package.candidate.packagePin.packageId,
      nativeSessionId: null,
      outcome: 'STOPPED',
      repository: { branch: 'main', commit: f.commit },
      files: [{ path: 'src/game.js', role: 'code', content: Buffer.from('exact\r\n') }],
      questionPath: null,
      signal: new AbortController().signal,
    };
    expect(await ports.publish(input)).toEqual({ uploaded: true, receipt });
    const { signal: _signal, ...expected } = input;
    expect(write).toHaveBeenCalledWith({ ...expected, sequence: 1 });
    expect(write.mock.calls[0][0].nativeSessionId).toBeNull();
    await expect(
      ports.publish({ ...input, identity: { ...f.identity, attemptId: randomUUID() } }),
    ).rejects.toMatchObject({ code: 'native_execution_scope_mismatch' });
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('trusted latest cancellation fence in production execution ports', () => {
  it.each(['cancelled', 'missing', 'malformed', 'other-identity', 'no-version', 'read-error'])(
    'denies preparation before filesystem/package/Git activity for %s fence',
    async (kind) => {
      const f = await fixture();
      if (kind === 'cancelled')
        f.memory.putVersion(
          f.fenceKey,
          Buffer.from(JSON.stringify({ ...f.fenceRecord, state: 'CANCELLED' })),
          'trusted-cancelled',
        );
      if (kind === 'missing') f.memory.objects.delete(f.fenceKey);
      if (kind === 'malformed')
        f.memory.putVersion(f.fenceKey, Buffer.from('{"bad":'), 'trusted-malformed');
      if (kind === 'other-identity')
        f.memory.putVersion(
          f.fenceKey,
          Buffer.from(JSON.stringify({ ...f.fenceRecord, runtimeSessionId: randomUUID() })),
          'trusted-other',
        );
      if (kind === 'no-version')
        f.memory.afterSend = ({ response }) => ({ ...response, VersionId: 'null' });
      if (kind === 'read-error')
        f.memory.beforeSend = () => {
          throw new Error('private SDK details');
        };
      await expect(f.ports.prepare(f.input)).rejects.toMatchObject({
        code: 'native_execution_cancelled',
        message: 'native_execution_cancelled',
      });
      expect(f.commandRunner).not.toHaveBeenCalled();
      expect(await fs.readdir(f.project)).toEqual([]);
      expect(await fs.readdir(f.root)).toEqual(['project']);
      expect(f.memory.operations).toHaveLength(1);
      expect(f.memory.operations[0].input).toMatchObject({
        Bucket: f.env.NATIVE_PUBLICATION_BUCKET,
        Key: f.fenceKey,
        ExpectedBucketOwner: f.env.NATIVE_RUNTIME_ACCOUNT_ID,
      });
      expect(f.memory.operations[0].input).not.toHaveProperty('VersionId');
    },
  );

  it('rereads latest after ACTIVE and observes a controller cancellation at the next epoch', async () => {
    const f = await fixture();
    const input = { identity: f.identity, signal: f.input.signal };
    await expect(f.ports.assertActive(input)).resolves.toBeUndefined();
    const nextEpochKey = nativeExecutionFenceKey({ ...f.identity, epoch: 2 });
    expect(nextEpochKey).toBe(f.fenceKey);
    f.memory.putVersion(
      nextEpochKey,
      Buffer.from(
        JSON.stringify({
          ...f.fenceRecord,
          state: 'CANCELLED',
        }),
      ),
      'trusted-next-epoch-cancel',
    );
    await expect(f.ports.assertActive(input)).rejects.toMatchObject({
      code: 'native_execution_cancelled',
    });
    expect(f.memory.operations.map((op) => op.name)).toEqual([
      'GetObjectCommand',
      'GetObjectCommand',
    ]);
    expect(f.memory.operations.every((op) => !Object.hasOwn(op.input, 'VersionId'))).toBe(true);
    expect(f.commandRunner).not.toHaveBeenCalled();
  });
});
