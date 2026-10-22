import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeRuntimeServer, NATIVE_RUNTIME_MAX_BODY } from '../native/runtime-server.js';
import { createNativeExecutor } from '../native/executor.js';
import { createNativeExecutionPorts } from '../native/execution-prepare.js';
import { runNativeCommand } from '../native/command-runner.js';
import { createNativePublications } from '../../shared/native-publication.js';
import { createNativeInteractions } from '../../shared/native-interaction.js';
import { nativeExecutionFenceKey } from '../../shared/native-execution-fence.js';
import { Readable } from 'node:stream';
import { createNativeWorkspaceCheck, workspaceCheckContent } from '../native/workspace-check.js';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const identity = {
  projectId: 'project-one',
  executionId: 'execution-one',
  bindingId: '10000000-0000-4000-8000-000000000001',
  nonce: 'a'.repeat(64),
};
const env = {
  NATIVE_RUNTIME_MODE: 'isolated',
  NATIVE_RUNTIME_PROJECT_ID: identity.projectId,
  NATIVE_RUNTIME_EXECUTION_ID: identity.executionId,
  NATIVE_RUNTIME_BINDING_ID: identity.bindingId,
  NATIVE_RUNTIME_CHECK_NONCE: identity.nonce,
};
const payload = { command: 'native-workspace-check', ...identity };
const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

// Real file descriptors, hardlinks, rename and bytes on a local temporary
// filesystem. Only the deployment's NFS/UID and Linux fd-path mapping are
// substituted; these tests do not claim to qualify real EFS.
const fixture = async () => {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-runtime-check-')));
  await fs.chmod(dir, 0o700);
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const descriptors = new Map();
  const map = (path) => {
    if (path.startsWith('/mnt/native')) return dir + path.slice('/mnt/native'.length);
    const match = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/.exec(path);
    if (match) return descriptors.get(Number(match[1])) + (match[2] ?? '');
    throw new Error('unexpected test path');
  };
  const io = {
    lstat: async (path) => Object.assign(await fs.lstat(map(path)), { uid: 1000, gid: 1000 }),
    mkdir: (path, opts) => fs.mkdir(map(path), opts),
    realpath: async (path) => (await fs.realpath(map(path))).replace(dir, '/mnt/native'),
    open: async (path, flags, mode) => {
      const file = await fs.open(map(path), flags, mode);
      descriptors.set(file.fd, map(path));
      return file;
    },
    link: (a, b) => fs.link(map(a), map(b)),
    rename: (a, b) => fs.rename(map(a), map(b)),
    unlink: (path) => fs.unlink(map(path)),
  };
  const inspectMount = vi.fn(async () => ({ filesystemType: 'nfs4', mountPath: '/mnt/native' }));
  return { dir, io, inspectMount, check: createNativeWorkspaceCheck({ env, io, inspectMount }) };
};
const start = async (options) => {
  const server = createNativeRuntimeServer({ env, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return server.address().port;
};
const request = (port, path, body, method = body === undefined ? 'GET' : 'POST') =>
  new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }),
      );
    });
    req.on('error', reject);
    req.end(
      body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    );
  });

describe('native isolated workspace diagnostic', () => {
  it('performs real hardlink/rename/readback and removes only its diagnostic files', async () => {
    const f = await fixture();
    await fs.writeFile(join(f.dir, 'do-not-read'), 'unrelated project content');
    const result = await f.check(payload);
    expect(result).toMatchObject({
      ok: true,
      ...identity,
      evidence: {
        hardlinkSameInode: true,
        linkCount: 2,
        atomicRename: true,
        cleanupComplete: true,
        sha256: createHash('sha256').update(workspaceCheckContent(identity)).digest('hex'),
      },
    });
    expect(await fs.readdir(join(f.dir, '.control'))).toEqual([]);
    expect(await fs.readFile(join(f.dir, 'do-not-read'), 'utf8')).toBe('unrelated project content');
    expect(f.inspectMount).toHaveBeenCalledWith({ workspaceDir: '/mnt/native' });
  });
  it.each([
    { ...payload, projectId: 'other' },
    { ...payload, executionId: 'other' },
    { ...payload, nonce: 'b'.repeat(64) },
    { ...payload, path: '/mnt/other' },
    { ...payload, command: 'run-stage' },
  ])('refuses wrong scope or arbitrary arguments before filesystem access', async (input) => {
    const f = await fixture();
    await expect(f.check(input)).rejects.toThrow('native_workspace_scope_mismatch');
    expect(f.inspectMount).not.toHaveBeenCalled();
    expect(await fs.readdir(f.dir)).toEqual([]);
  });
  it('refuses a missing NFS mount before creating .control', async () => {
    const f = await fixture();
    f.inspectMount.mockRejectedValue(new Error('not NFS'));
    await expect(f.check(payload)).rejects.toThrow('not NFS');
    expect(await fs.readdir(f.dir)).toEqual([]);
  });
  it('refuses a symlinked control directory without following it', async () => {
    const f = await fixture();
    const outside = join(f.dir, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, join(f.dir, '.control'));
    await expect(f.check(payload)).rejects.toThrow('native_control_directory_invalid');
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it('preserves preexisting residue instead of overwriting another file', async () => {
    const f = await fixture();
    await fs.mkdir(join(f.dir, '.control'), { mode: 0o700 });
    await fs.writeFile(join(f.dir, '.control/workspace-check.done'), 'untouched');
    await expect(f.check(payload)).rejects.toThrow('native_workspace_check_residue');
    expect(await fs.readFile(join(f.dir, '.control/workspace-check.done'), 'utf8')).toBe(
      'untouched',
    );
  });
});

describe('native-only HTTP on real loopback sockets', () => {
  it('loads the preparation-only runtime server without execution or SDK imports', async () => {
    const entry = fileURLToPath(new URL('../native/runtime-server.js', import.meta.url));
    const code = `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, next) {
        if (!specifier.startsWith('node:') &&
          !['/runtime-server.js', '/workspace-check.js', '/efs-workspace.js', '/resource-telemetry.js', '/flight-recorder.js'].some(name => specifier.endsWith(name)))
          throw new Error('execution import attempted');
        return next(specifier, context);
      }});
      const {createNativeRuntimeServer} = await import(${JSON.stringify(entry)});
      const server = createNativeRuntimeServer({env:process.env});
      server.close();
      process.stdout.write('preparation-only');
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', code],
      {
        env: { PATH: process.env.PATH, ...env },
        timeout: 5000,
      },
    );
    expect(stdout).toBe('preparation-only');
  });
  it.each(['isloated', 'platform', ' '])(
    'refuses nonempty invalid mode %j before platform imports',
    async (mode) => {
      const entry = fileURLToPath(new URL('../http-server.js', import.meta.url));
      const code = `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, next) {
        if (!specifier.startsWith('node:') && !specifier.endsWith('/http-server.js')) {
          throw new Error('platform import attempted');
        }
        return next(specifier, context);
      }});
      try { await import(${JSON.stringify(entry)}); process.exitCode = 1; }
      catch(error) { process.stdout.write(error.message); }
    `;
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['--input-type=module', '-e', code],
        {
          env: { PATH: process.env.PATH, ...env, NATIVE_RUNTIME_MODE: mode },
          timeout: 5000,
        },
      );
      expect(stdout).toBe('native_runtime_mode_invalid');
    },
  );
  it('loads the isolated HTTP entrypoint without any platform or SDK import', async () => {
    const entry = fileURLToPath(new URL('../http-server.js', import.meta.url));
    const code = `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, next) {
        if (!specifier.startsWith('node:') && !specifier.endsWith('/http-server.js')) {
          throw new Error('platform import attempted');
        }
        return next(specifier, context);
      }});
      await import(${JSON.stringify(entry)});
      process.stdout.write('isolated-import-ok');
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', code],
      {
        env: { PATH: process.env.PATH, ...env },
        timeout: 5000,
      },
    );
    expect(stdout).toBe('isolated-import-ok');
  });
  it('serves health and a bound diagnostic, rejecting platform commands and routes', async () => {
    const f = await fixture();
    const port = await start({ checkWorkspace: f.check });
    expect(await request(port, '/ping')).toEqual({ status: 200, body: { status: 'Healthy' } });
    expect((await request(port, '/invocations', payload)).body.ok).toBe(true);
    expect(
      (await request(port, '/invocations', { ...payload, command: 'native-interaction-probe' }))
        .status,
    ).toBe(400);
    expect((await request(port, '/invocations', { command: 'init-ws' })).status).toBe(400);
    expect((await request(port, '/exec', payload)).status).toBe(404);
    expect((await request(port, '/invocations', '{invalid')).status).toBe(400);
    expect((await request(port, '/invocations', 'x'.repeat(4097))).status).toBe(400);
  });
  it('reports busy, rejects overlapping checks, and sanitizes failures', async () => {
    const gate = Promise.withResolvers();
    const started = Promise.withResolvers();
    const port = await start({
      checkWorkspace: async () => {
        started.resolve();
        await gate.promise;
        throw new Error('secret AWS details');
      },
    });
    const first = request(port, '/invocations', payload);
    await started.promise;
    expect((await request(port, '/ping')).body.status).toBe('HealthyBusy');
    expect((await request(port, '/invocations', payload)).status).toBe(409);
    gate.resolve();
    expect(await first).toEqual({
      status: 500,
      body: { ok: false, code: 'native_workspace_check_failed' },
    });
    expect((await request(port, '/ping')).body.status).toBe('Healthy');
  });
});

const executionIdentity = {
  projectId: identity.projectId,
  executionId: identity.executionId,
  bindingId: identity.bindingId,
  attemptId: '20000000-0000-4000-8000-000000000001',
  epoch: 1,
  runtimeSessionId: '30000000-0000-4000-8000-000000000001',
};
const executionEnv = {
  ...env,
  NATIVE_EXECUTION_ENABLED: 'true',
  NATIVE_EXECUTION_ATTEMPT_ID: executionIdentity.attemptId,
  NATIVE_EXECUTION_EPOCH: '1',
  NATIVE_EXECUTION_RUNTIME_SESSION_ID: executionIdentity.runtimeSessionId,
};
const startPayload = () => ({
  command: 'native-start',
  schemaVersion: 1,
  ...executionIdentity,
  configuration: {
    harness: 'codex',
    model: 'configured-model',
    prompt: 'Fix the pipe visualization',
    packageVersion: '2.9.0',
    repository: {
      provider: 'github',
      repository: 'owner/flappy-bird',
      branch: 'main',
      commit: 'a'.repeat(40),
    },
  },
  package: { candidate: { authored: true }, archiveReceipt: { authored: true } },
  credentials: {
    model: { provider: 'bedrock', value: 'secret-native-model-value' },
    git: { username: 'secret-native-git-user', password: 'secret-native-git-value' },
  },
});
const executionFixture = async () => {
  const temp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-http-execution-')));
  const root = join(temp, 'mount');
  await fs.mkdir(root, { mode: 0o700 });
  cleanup.push(() => fs.rm(temp, { recursive: true, force: true }));
  const started = Promise.withResolvers();
  const prepare = vi.fn(async ({ signal }) => {
    started.resolve();
    await new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', resolve, { once: true });
    });
    signal.throwIfAborted();
  });
  const executor = createNativeExecutor({
    env: executionEnv,
    root,
    homeRoot: join(temp, 'homes'),
    inspectMount: async () => ({}),
    prepare,
    publish: vi.fn(async () => {
      throw new Error('must not publish');
    }),
    publishInteraction: vi.fn(async () => {
      throw new Error('must not publish');
    }),
    commandRunner: vi.fn(async () => {
      throw new Error('must not run model');
    }),
  });
  cleanup.push(async () => {
    if (executor.isBusy()) await executor.cancel(executionIdentity);
    await executor.settle();
  });
  const checkWorkspace = vi.fn(async () => ({ ok: true }));
  const createExecutor = vi.fn(async () => executor);
  const port = await start({ env: executionEnv, createExecutor, checkWorkspace });
  return { port, executor, started, prepare, createExecutor, checkWorkspace };
};

describe('native execution HTTP lifecycle on real loopback sockets', () => {
  it('uses wire v2 only for explicitly pinned workspace commands and routes resume separately', async () => {
    const executor = Object.fromEntries(
      ['start', 'continue', 'recover', 'resume', 'status', 'cancel', 'settle'].map((method) => [
        method,
        vi.fn(async () => ({ accepted: true, method })),
      ]),
    );
    executor.isBusy = () => false;
    const createExecutor = vi.fn(async () => executor);
    const port = await start({ env: executionEnv, createExecutor, checkWorkspace: vi.fn() });
    const payload = {
      ...startPayload(),
      configuration: { ...startPayload().configuration, recoveryMode: 'efs-workspace-v1' },
    };
    expect((await request(port, '/invocations', payload)).status).toBe(400);
    expect(createExecutor).not.toHaveBeenCalled();
    expect(
      (await request(port, '/invocations', { ...payload, schemaVersion: 2 })).body.method,
    ).toBe('start');
    expect(
      (
        await request(port, '/invocations', {
          ...payload,
          schemaVersion: 2,
          command: 'native-resume',
        })
      ).body.method,
    ).toBe('resume');
    expect(executor.recover).not.toHaveBeenCalled();
    expect(
      (await request(port, '/invocations', { ...startPayload(), schemaVersion: 2 })).status,
    ).toBe(400);
    expect((await request(port, '/invocations', startPayload())).body.method).toBe('start');
  });
  it.each([
    'WAITING_FOR_INPUT',
    'STOPPED',
    'NO_SESSION',
    'CANCELLED_BEFORE_PREPARE',
    'CANCELLED_AFTER_PREPARE',
  ])(
    'composes HTTP, real executor, immutable upload and supervisor receipt verification for %s',
    async (outcome) => {
      const expectedOutcome = outcome === 'NO_SESSION' ? 'STOPPED' : outcome;
      const expectedSession = outcome === 'NO_SESSION' ? null : 'composed-native-session';
      const temp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-composed-http-')));
      const root = join(temp, 'mount');
      await fs.mkdir(root, { mode: 0o700 });
      cleanup.push(() => fs.rm(temp, { recursive: true, force: true }));
      const scope = { ...executionIdentity, executionId: '40000000-0000-4000-8000-000000000001' };
      const scopedEnv = {
        ...executionEnv,
        NATIVE_RUNTIME_EXECUTION_ID: scope.executionId,
        NATIVE_PUBLICATION_BUCKET: 'native-composed-publications',
        NATIVE_RUNTIME_ACCOUNT_ID: '123456789012',
        NATIVE_EXECUTION_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
      };
      const objects = new Map();
      const operations = [];
      const fenceKey = nativeExecutionFenceKey(scope);
      const { epoch: _epoch, ...fenceIdentity } = scope;
      let fenceState = outcome === 'CANCELLED_BEFORE_PREPARE' ? 'CANCELLED' : 'ACTIVE';
      let sequence = 0;
      const s3 = {
        send: async (command) => {
          const input = command.input;
          const kind = command.constructor.name;
          operations.push({ kind, key: input.Key, versionId: input.VersionId });
          expect(input.Bucket).toBe(scopedEnv.NATIVE_PUBLICATION_BUCKET);
          expect(input.ExpectedBucketOwner).toBe(scopedEnv.NATIVE_RUNTIME_ACCOUNT_ID);
          if (kind === 'PutObjectCommand') {
            const versionId = `immutable-version-${++sequence}`;
            expect(Buffer.isBuffer(input.Body)).toBe(true);
            expect(input.ChecksumSHA256).toBe(
              createHash('sha256').update(input.Body).digest('base64'),
            );
            objects.set(`${input.Key}:${versionId}`, Buffer.from(input.Body));
            return { VersionId: versionId };
          }
          if (kind === 'GetObjectCommand') {
            if (input.Key === fenceKey) {
              expect(input).not.toHaveProperty('VersionId');
              const bytes = Buffer.from(
                JSON.stringify({ schemaVersion: 1, ...fenceIdentity, state: fenceState }),
              );
              return {
                VersionId: `trusted-${fenceState}`,
                ContentLength: bytes.length,
                Body: Readable.from([bytes]),
              };
            }
            const bytes = objects.get(`${input.Key}:${input.VersionId}`);
            if (!bytes) throw new Error('test object/version unavailable');
            return {
              VersionId: input.VersionId,
              ContentLength: bytes.length,
              Body: Readable.from([bytes]),
            };
          }
          throw new Error('unexpected SDK operation');
        },
      };
      const nativeIntent = 'aidlc/spaces/default/intents/real-request';
      const questionPath = `${nativeIntent}/ideation/intent-capture/intent-capture-questions.md`;
      const questionBytes =
        '# Intent Capture Questions\r\n\r\n## Q1. Which pipe appearance do you want?\r\n\r\n[Answer]:\r\n';
      const files = {
        'src/game.js': 'original code\n',
        'aidlc/active-space': 'default\n',
        'aidlc/spaces/default/intents/active-intent': 'real-request\n',
        [`${nativeIntent}/aidlc-state.md`]:
          '- [-] intent-capture — EXECUTE\n- **Current Stage**: intent-capture\n- **Status**: Running\n',
        [`${nativeIntent}/.aidlc-engine/active-directive.json`]: JSON.stringify({
          version: outcome === 'STOPPED' ? 999 : 2,
          kind: 'run-stage',
          stage: 'intent-capture',
          cursor_harness: 'codex',
          active_attempt: { status: 'settled' },
        }),
        [questionPath]: questionBytes,
      };
      const script = join(temp, 'inert-process.mjs');
      await fs.writeFile(
        script,
        `
        import {mkdir,writeFile} from 'node:fs/promises';
        import {dirname,join} from 'node:path';
        for await (const chunk of process.stdin) {}
        if (${JSON.stringify(outcome)} !== 'NO_SESSION') console.log(JSON.stringify({type:'thread.started',thread_id:'composed-native-session'}));
        console.log(JSON.stringify({type:'turn.started'}));
        for (const [path, content] of Object.entries(${JSON.stringify(files)})) {
          await mkdir(dirname(path),{recursive:true,mode:0o700}); await writeFile(path,content);
        }
        if (${JSON.stringify(outcome)} !== 'NO_SESSION') {
          const rollout = join(process.env.CODEX_HOME,'sessions','2026','09','30','rollout-composed-native-session.jsonl');
          await mkdir(dirname(rollout), {recursive:true,mode:0o700});
          await writeFile(rollout,JSON.stringify({
            type:'session_meta',payload:{id:'composed-native-session',cwd:process.cwd()}
          })+'\\n', {mode:0o600});
        }
        console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'Which option do you prefer?'}}));
        console.log(JSON.stringify({type:'turn.completed',usage:{}}));
      `,
      );
      const ports = createNativeExecutionPorts({ env: scopedEnv, s3 });
      const runner = vi.fn(async (input) =>
        input.timeoutMs === null
          ? runNativeCommand({ ...input, command: process.execPath, args: [script] })
          : {
              exitCode: 0,
              signal: null,
              spawnError: null,
              timedOut: false,
              outputLimitExceeded: false,
              cleanupComplete: true,
              stdout: '',
              stderr: '',
            },
      );
      const executor = createNativeExecutor({
        env: scopedEnv,
        ...ports,
        root,
        homeRoot: join(temp, 'homes'),
        inspectMount: async () => ({}),
        inspectInitialization: async () => ({ ok: true }),
        commandRunner: runner,
        prepare: async ({ signal }) => {
          await ports.assertActive({ identity: scope, signal });
          if (outcome === 'CANCELLED_AFTER_PREPARE') fenceState = 'CANCELLED';
          const directory = join(root, 'packages');
          await fs.mkdir(directory, { mode: 0o700 });
          await fs.writeFile(join(directory, 'aidlc'), 'inert package bytes');
          return {
            package: {
              directory,
              binaryPath: join(directory, 'aidlc'),
              version: '2.9.0',
              packageId: `sha256:${'a'.repeat(64)}`,
            },
            repositoryCommit: 'a'.repeat(40),
            authEnv: { AWS_BEARER_TOKEN_BEDROCK: 'inert-fixture-token' },
          };
        },
      });
      cleanup.push(async () => {
        if (executor.isBusy()) await executor.cancel(scope);
        await executor.settle();
      });
      const port = await start({
        env: scopedEnv,
        createExecutor: async () => executor,
        checkWorkspace: vi.fn(),
      });
      const ack = await request(port, '/invocations', { ...startPayload(), ...scope });
      expect(ack).toMatchObject({ status: 200, body: { accepted: true, ...scope } });
      expect(ack.body).not.toHaveProperty('receipt');
      await executor.settle();
      // Exactly the worker payload: no schemaVersion on status/cancel.
      const status = await request(port, '/invocations', { command: 'native-status', ...scope });
      if (outcome.startsWith('CANCELLED_')) {
        expect(status).toMatchObject({
          status: 200,
          body: {
            ...scope,
            status: 'cancelled',
            code: 'native_execution_cancelled',
          },
        });
        expect(status.body).not.toHaveProperty('receipt');
        expect(runner.mock.calls.filter(([input]) => input.timeoutMs === null)).toHaveLength(0);
        expect(
          operations.every((op) => op.kind === 'GetObjectCommand' && op.key === fenceKey),
        ).toBe(true);
        expect(operations).toHaveLength(outcome === 'CANCELLED_BEFORE_PREPARE' ? 1 : 2);
        return;
      }
      if (outcome === 'NO_SESSION') {
        expect(status).toMatchObject({
          status: 200,
          body: { status: 'failed', code: 'native_execution_output_incomplete' },
        });
        expect(operations.some((op) => op.kind === 'PutObjectCommand')).toBe(false);
        return;
      }
      expect(status.body.code).toBeUndefined();
      expect(status).toMatchObject({
        status: 200,
        body: {
          ...scope,
          status: 'publication_ready',
          outcome: expectedOutcome,
          nativeSessionId: expectedSession,
          receipt: { outcome: expectedOutcome, nativeSessionId: expectedSession, sequence: 1 },
        },
      });
      expect(status.body).not.toHaveProperty('committed');
      const publications = createNativePublications({
        s3,
        bucket: scopedEnv.NATIVE_PUBLICATION_BUCKET,
        accountId: scopedEnv.NATIVE_RUNTIME_ACCOUNT_ID,
      });
      const manifest = await publications.read(scope, status.body.receipt, { verifyFiles: true });
      expect(manifest.outcome).toBe(expectedOutcome);
      expect(manifest.repository).toEqual({ branch: 'main', commit: 'a'.repeat(40) });
      expect(manifest.scope).toEqual({
        projectId: scope.projectId,
        executionId: scope.executionId,
        attemptId: scope.attemptId,
        epoch: 1,
      });
      const questionFile = manifest.files.find((file) => file.path === questionPath);
      expect(questionFile.sha256).toBe(createHash('sha256').update(questionBytes).digest('hex'));
      const content = await publications.file(scope, manifest, questionFile.id);
      expect(content.bytes).toEqual(Buffer.from(questionBytes));
      const interactions = createNativeInteractions({
        s3,
        bucket: scopedEnv.NATIVE_PUBLICATION_BUCKET,
        accountId: scopedEnv.NATIVE_RUNTIME_ACCOUNT_ID,
      });
      const message = await interactions.read(scope, status.body.interaction);
      expect(message).toMatchObject({
        kind: 'assistant_turn',
        sequence: 1,
        publicationId: status.body.receipt.id,
        messages: [{ type: 'text', text: 'Which option do you prefer?' }],
      });
      if (outcome === 'WAITING_FOR_INPUT') {
        const continuation = {
          ...startPayload(),
          ...scope,
          command: 'native-continue',
          sequence: 2,
          requestId: '50000000-0000-4000-8000-000000000001',
          priorInteractionId: status.body.interaction.id,
          priorPublicationId: status.body.receipt.id,
          text: 'Use the colorful design.',
          credentials: { model: startPayload().credentials.model },
        };
        const accepted = await request(port, '/invocations', continuation);
        expect(accepted).toMatchObject({ status: 200, body: { accepted: true, sequence: 2 } });
        expect((await request(port, '/invocations', continuation)).body).toMatchObject({
          duplicate: true,
          sequence: 2,
        });
        await executor.settle();
        const next = await request(port, '/invocations', { command: 'native-status', ...scope });
        expect(next).toMatchObject({
          status: 200,
          body: {
            status: 'publication_ready',
            sequence: 2,
            nativeSessionId: expectedSession,
            interaction: { sequence: 2 },
            receipt: { sequence: 2 },
          },
        });
        const secondMessage = await interactions.read(scope, next.body.interaction);
        expect(secondMessage.publicationId).toBe(next.body.receipt.id);
        expect(next.body.receipt.id).not.toBe(status.body.receipt.id);
        expect(await publications.read(scope, status.body.receipt, { verifyFiles: true })).toEqual(
          manifest,
        );
        expect(await interactions.read(scope, status.body.interaction)).toEqual(message);
        expect(runner.mock.calls.filter(([input]) => input.timeoutMs === null)).toHaveLength(2);
        const conflict = await request(port, '/invocations', {
          ...continuation,
          text: 'different answer',
        });
        expect(conflict).toEqual({
          status: 409,
          body: { ok: false, code: 'native_execution_reply_conflict' },
        });
      }
      if (outcome === 'STOPPED') {
        // Missing session capture remains null through the real port and shared
        // writer/reader; it cannot be relabelled as a waiting question.
        const stoppedInput = {
          identity: scope,
          packageId: manifest.packageId,
          nativeSessionId: null,
          outcome: 'STOPPED',
          repository: manifest.repository,
          files: [
            { path: 'src/game.js', role: 'code', content: Buffer.from(files['src/game.js']) },
          ],
          questionPath: null,
          signal: new AbortController().signal,
        };
        const uploaded = await ports.publish(stoppedInput);
        const stopped = await publications.read(scope, uploaded.receipt, { verifyFiles: true });
        expect(stopped.nativeSessionId).toBeNull();
        expect(stopped.outcome).toBe('STOPPED');
        const count = operations.length;
        await expect(
          ports.publish({
            ...stoppedInput,
            outcome: 'WAITING_FOR_INPUT',
            questionPath: 'question.md',
            files: [{ path: 'question.md', role: 'question', content: Buffer.from(questionBytes) }],
          }),
        ).rejects.toMatchObject({ code: 'NATIVE_PUBLICATION_INVALID' });
        expect(operations).toHaveLength(count);
      }
      expect((await request(port, '/ping')).body.status).toBe('Healthy');
      expect(runner.mock.calls.filter(([input]) => input.timeoutMs === null)).toHaveLength(
        outcome === 'WAITING_FOR_INPUT' ? 2 : 1,
      );
      expect(
        operations
          .filter((op) => op.kind === 'GetObjectCommand' && op.key !== fenceKey)
          .every((op) => op.versionId),
      ).toBe(true);
    },
  );
  it('ACKs asynchronous Start, serves status and duplicate Start while busy, cancels, and never logs credentials', async () => {
    const logging = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    try {
      const f = await executionFixture();
      expect(f.createExecutor).not.toHaveBeenCalled();
      const result = await request(f.port, '/invocations', startPayload());
      expect(result).toMatchObject({
        status: 200,
        body: { accepted: true, status: 'preparing', ...executionIdentity },
      });
      await f.started.promise;
      expect((await request(f.port, '/ping')).body.status).toBe('HealthyBusy');
      expect(
        await request(f.port, '/invocations', { command: 'native-status', ...executionIdentity }),
      ).toMatchObject({ status: 200, body: { status: 'preparing' } });
      expect(await request(f.port, '/invocations', startPayload())).toMatchObject({
        status: 200,
        body: { duplicate: true, accepted: true },
      });
      expect(f.prepare).toHaveBeenCalledTimes(1);
      expect(f.createExecutor).toHaveBeenCalledTimes(1);
      expect((await request(f.port, '/invocations', payload)).status).toBe(409);
      expect(f.checkWorkspace).not.toHaveBeenCalled();
      expect(
        await request(f.port, '/invocations', { command: 'native-cancel', ...executionIdentity }),
      ).toMatchObject({ status: 200, body: { status: 'cancelling' } });
      await f.executor.settle();
      const final = await request(f.port, '/invocations', {
        command: 'native-status',
        ...executionIdentity,
      });
      expect(final).toMatchObject({ status: 200, body: { status: 'cancelled' } });
      expect((await request(f.port, '/ping')).body.status).toBe('Healthy');
      expect(JSON.stringify([result, final, ...logging.map((spy) => spy.mock.calls)])).not.toMatch(
        /secret-native-(?:model|git)/,
      );
    } finally {
      for (const spy of logging) spy.mockRestore();
    }
  });

  it.each(['attemptId', 'epoch', 'runtimeSessionId', 'bindingId', 'projectId', 'executionId'])(
    'rejects an unpinned %s for start/status/cancel before constructing execution',
    async (field) => {
      const f = await executionFixture();
      for (const command of ['native-start', 'native-status', 'native-cancel']) {
        const body =
          command === 'native-start' ? startPayload() : { command, ...executionIdentity };
        body[field] = field === 'epoch' ? 2 : 'wrong';
        expect(await request(f.port, '/invocations', body)).toEqual({
          status: 400,
          body: { ok: false, code: 'native_execution_scope_mismatch' },
        });
      }
      expect(f.createExecutor).not.toHaveBeenCalled();
    },
  );

  it('never constructs execution ports when disabled and preserves workspace checks', async () => {
    const createExecutor = vi.fn(async () => {
      throw new Error('must not construct');
    });
    const checkWorkspace = vi.fn(async () => ({ ok: true }));
    const port = await start({ createExecutor, checkWorkspace });
    expect((await request(port, '/invocations', startPayload())).status).toBe(403);
    expect(
      (await request(port, '/invocations', { command: 'native-status', ...executionIdentity }))
        .status,
    ).toBe(403);
    expect((await request(port, '/invocations', payload)).body.ok).toBe(true);
    expect(createExecutor).not.toHaveBeenCalled();
    expect(checkWorkspace).toHaveBeenCalledOnce();
  });

  it('prevents Start from racing a diagnostic and a diagnostic from racing Start initialization', async () => {
    const diagnostic = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const createExecutor = vi.fn();
    const port = await start({
      env: executionEnv,
      createExecutor,
      checkWorkspace: async () => {
        entered.resolve();
        await diagnostic.promise;
        return { ok: true };
      },
    });
    const check = request(port, '/invocations', payload);
    await entered.promise;
    expect((await request(port, '/invocations', startPayload())).status).toBe(409);
    expect(createExecutor).not.toHaveBeenCalled();
    diagnostic.resolve();
    await check;

    const loaded = Promise.withResolvers();
    const loading = Promise.withResolvers();
    const second = await start({
      env: executionEnv,
      createExecutor: async () => {
        loading.resolve();
        return loaded.promise;
      },
      checkWorkspace: vi.fn(),
    });
    const begin = request(second, '/invocations', startPayload());
    await loading.promise;
    expect((await request(second, '/ping')).body.status).toBe('HealthyBusy');
    expect((await request(second, '/invocations', payload)).status).toBe(409);
    loaded.reject(new Error('secret-native-model-value'));
    expect(await begin).toEqual({
      status: 500,
      body: { ok: false, code: 'native_execution_failed' },
    });
  });

  it('bounds request bytes at 256 KiB and accepts a complete start payload larger than 4 KiB', async () => {
    const f = await executionFixture();
    const body = startPayload();
    body.configuration.prompt = 'a'.repeat(8192);
    expect((await request(f.port, '/invocations', body)).status).toBe(200);
    const oversized = JSON.stringify({ ...body, extra: 'x'.repeat(NATIVE_RUNTIME_MAX_BODY) });
    expect((await request(f.port, '/invocations', oversized)).status).toBe(400);
    for (const invalid of ['null', '[]', '"text"', '{invalid'])
      expect((await request(f.port, '/invocations', invalid)).status).toBe(400);
    expect(f.createExecutor).toHaveBeenCalledOnce();
  });

  it('rejects extra status/cancel fields and missing execution pins', async () => {
    const f = await executionFixture();
    expect(
      (
        await request(f.port, '/invocations', {
          command: 'native-status',
          ...executionIdentity,
          credentials: startPayload().credentials,
        })
      ).status,
    ).toBe(400);
    expect(() =>
      createNativeRuntimeServer({
        env: { ...env, NATIVE_EXECUTION_ENABLED: 'true' },
        checkWorkspace: vi.fn(),
      }),
    ).toThrow('native_execution_options_invalid');
    expect(f.createExecutor).not.toHaveBeenCalled();
  });
});
