import * as fs from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { createNativeExecutor } from '../../agentcore/native/executor.js';
import { createNativeExecutionPorts } from '../../agentcore/native/execution-prepare.js';
import { runNativeCommand } from '../../agentcore/native/command-runner.js';
import { createNativePublications } from '../../shared/native-publication.js';
import { createNativeInteractions } from '../../shared/native-interaction.js';
import { createNativeRecoveryCheckpoints } from '../../shared/native-recovery-checkpoint.js';
import { createNativeExecutionFence } from '../../shared/native-execution-fence.js';
import { createNativeExecutionSupervisor, readNativeRuntimeReport } from '../execution-worker.js';
import { createNativeExecutionApi } from '../execution-api.js';
import { executionIdentity } from '../execution-runtime.js';
import { executionFixture } from './execution-fixtures.js';
import { ACTOR } from './fixtures.js';

// Production control/store/runtime/capture/restore code, actual child processes
// and filesystem destruction. AWS and the model are inert external ports. This
// proves restart plumbing; pinned CLI and live model qualification are separate.
it.each([
  { loseAck: false, failRestore: false },
  { loseAck: true, failRestore: false },
  { loseAck: false, failRestore: true },
  { loseAck: false, restoreRead: 'native-status', unreadableReads: 1 },
  { loseAck: true, restoreRead: 'native-recover', unreadableReads: 3 },
])('restores the exact session after local state loss: %j', async (scenario) => {
  const { loseAck, failRestore, restoreRead, unreadableReads = 0 } = scenario;
  const f = executionFixture();
  await f.start();
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-recovery-loop-')));
  const root = join(base, 'mount');
  const homeRoot = join(base, 'homes');
  await fs.mkdir(root, { mode: 0o700 });
  const nativeSessionId = randomUUID();
  const script = join(base, 'session-harness.mjs');
  await fs.writeFile(
    script,
    `
    import * as fs from 'node:fs/promises';
    import {join,dirname} from 'node:path';
    const id=process.argv[2], resume=process.argv[3]==='resume';
    let prompt=''; for await(const b of process.stdin) prompt+=b.toString();
    const file=join(process.env.CODEX_HOME,'sessions','2026','09','30','rollout-'+id+'.jsonl');
    if(resume) {
      const prior=(await fs.readFile(file,'utf8')).trim().split('\\n').map(JSON.parse);
      if(prior[0].payload.id!==id || prior[0].payload.cwd!==process.cwd() ||
        prior.filter(x=>x.type==='test_user').length!==1) throw Error('history not restored exactly');
      if(await fs.readFile('src/game.js','utf8')!=='original game\\r\\n') throw Error('workspace changed');
    } else {
      await fs.mkdir(dirname(file),{recursive:true,mode:0o700});
      await fs.writeFile(file,JSON.stringify({type:'session_meta',payload:{id,cwd:process.cwd()}})+'\\n',{mode:0o600});
    }
    await fs.appendFile(file,JSON.stringify({type:'test_user',text:prompt})+'\\n');
    console.log(JSON.stringify({type:'thread.started',thread_id:id}));
    console.log(JSON.stringify({type:'turn.started'}));
    console.log(JSON.stringify({type:'item.completed',item:{id:'reply',type:'agent_message',
      text:resume?'Which pipe shape should we use?':'Which workflow should I compose?'}}));
    console.log(JSON.stringify({type:'turn.completed',usage:{}}));
  `,
  );
  const latest = new Map();
  const objects = new Map();
  let version = 0;
  const precondition = () =>
    Object.assign(new Error('conditional object conflict'), {
      name: 'PreconditionFailed',
      $metadata: { httpStatusCode: 412 },
    });
  const s3 = {
    send: vi.fn(async (command) => {
      const p = command.input;
      expect(p.Bucket).toBe(f.configuration.publicationBucket);
      expect(p.ExpectedBucketOwner).toBe(f.configuration.accountId);
      const current = latest.get(p.Key);
      if (command.constructor.name === 'PutObjectCommand') {
        if (p.IfNoneMatch === '*' && current) throw precondition();
        if (p.IfMatch && p.IfMatch !== current?.etag) throw precondition();
        const bytes = Buffer.from(p.Body);
        const item = {
          bytes,
          version: `immutable-${++version}`,
          etag: `"${createHash('sha256').update(bytes).digest('hex')}"`,
        };
        objects.set(`${p.Key}\0${item.version}`, item);
        latest.set(p.Key, item);
        return { VersionId: item.version, ETag: item.etag };
      }
      expect(command.constructor.name).toBe('GetObjectCommand');
      const item = p.VersionId ? objects.get(`${p.Key}\0${p.VersionId}`) : current;
      if (!item) throw Object.assign(new Error('missing object'), { name: 'NoSuchKey' });
      return {
        VersionId: item.version,
        ETag: item.etag,
        ContentLength: item.bytes.length,
        Body: Readable.from([item.bytes]),
      };
    }),
  };
  const storage = {
    s3,
    bucket: f.configuration.publicationBucket,
    accountId: f.configuration.accountId,
  };
  const publications = createNativePublications(storage);
  const interactions = createNativeInteractions(storage);
  const checkpoints = createNativeRecoveryCheckpoints(storage);
  const fence = createNativeExecutionFence(storage);
  const row = f.row();
  const env = {
    NATIVE_RUNTIME_MODE: 'isolated',
    NATIVE_EXECUTION_ENABLED: 'true',
    NATIVE_RUNTIME_PROJECT_ID: row.scope.projectId,
    NATIVE_RUNTIME_EXECUTION_ID: row.scope.executionId,
    NATIVE_RUNTIME_BINDING_ID: row.bindingId,
    NATIVE_EXECUTION_ATTEMPT_ID: row.attemptId,
    NATIVE_EXECUTION_RUNTIME_SESSION_ID: row.runtimeSessionId,
    NATIVE_EXECUTION_EPOCH: '1',
    NATIVE_EXECUTION_IMAGE_DIGEST: f.configuration.image.digest,
    NATIVE_PUBLICATION_BUCKET: storage.bucket,
    NATIVE_RUNTIME_ACCOUNT_ID: storage.accountId,
  };
  const pkg = {
    directory: join(root, 'packages', 'verified-package'),
    binaryPath: join(root, 'packages', 'verified-package', 'aidlc'),
    version: '2.9.0',
    packageId: f.configuration.packageId,
  };
  const clean = {
    exitCode: 0,
    signal: null,
    spawnError: null,
    timedOut: false,
    outputLimitExceeded: false,
    cleanupComplete: true,
    stdout: '',
    stderr: '',
  };
  let modelTurns = 0;
  let failNextRestore = failRestore;
  const invocations = [];
  const commandRunner = async (input) => {
    if (input.timeoutMs !== null) return clean;
    modelTurns++;
    const resume = input.args.includes('resume');
    if (resume) expect(input.args).toContain(nativeSessionId);
    return runNativeCommand({
      ...input,
      command: process.execPath,
      args: [script, nativeSessionId, resume ? 'resume' : 'start'],
    });
  };
  const createRuntime = () =>
    createNativeExecutor({
      env,
      root,
      homeRoot,
      ...createNativeExecutionPorts({ env, s3 }),
      inspectMount: async () => ({}),
      inspectInitialization: async () => ({ ok: true }),
      commandRunner,
      prepare: async ({ project }) => {
        await fs.mkdir(pkg.directory, { recursive: true, mode: 0o700 });
        await fs.writeFile(pkg.binaryPath, 'inert package');
        await fs.mkdir(join(project, 'src'), { mode: 0o700 });
        await fs.writeFile(join(project, 'src/game.js'), 'original game\r\n', { mode: 0o600 });
        return {
          package: pkg,
          repositoryCommit: 'c'.repeat(40),
          authEnv: { AWS_BEARER_TOKEN_BEDROCK: 'fixture-model-token' },
        };
      },
      prepareRecovery: async () => {
        if (failNextRestore) {
          failNextRestore = false;
          throw Object.assign(new Error('injected package restore failure'), {
            code: 'native_execution_package_invalid',
          });
        }
        return { package: pkg };
      },
    });
  let runtime = createRuntime();
  let lastInvocationError;
  let lastRuntimeResult;
  let beforeStop;
  let loseNextAck = loseAck;
  let remainingUnreadable = unreadableReads;
  let restoreEpisode;
  const restoreReports = [];
  const stop = vi.fn(async ({ execution, recoveryId }) => {
    expect(recoveryId).toBeTruthy();
    expect((await fence.read(executionIdentity(execution))).state).toBe('FENCED');
    beforeStop = await runtime.settle();
    await fs.rm(homeRoot, { recursive: true, force: true });
    runtime = createRuntime();
    return { confirmed: true, runtimeSessionId: execution.runtimeSessionId };
  });
  const supervisor = createNativeExecutionSupervisor({
    store: f.store,
    preparationStore: f.preparationStore,
    now: f.now,
    upgrade: async ({ execution }) => ({ ready: true, target: f.target(execution) }),
    authorize: async () => {},
    credentials: async (execution) => ({
      ok: true,
      ...executionIdentity(execution),
      model: { provider: 'bedrock', value: 'fixture-model-token' },
      git: { username: 'fixture', password: 'fixture-git-token' },
      source: { branch: 'main', commit: 'c'.repeat(40) },
    }),
    invoke: async ({ payload }) => {
      invocations.push(
        structuredClone({
          command: payload.command,
          writerGeneration: payload.writerGeneration,
          requestId: payload.requestId,
          sequence: payload.sequence,
          text: payload.text,
        }),
      );
      const method = {
        'native-start': 'start',
        'native-continue': 'continue',
        'native-status': 'status',
        'native-recover': 'recover',
      }[payload.command];
      let result;
      try {
        result = await runtime[method](payload);
        lastRuntimeResult = result;
      } catch (error) {
        lastInvocationError = { code: error.code, name: error.name };
        throw error;
      }
      if (f.row().status === 'RECOVERING') {
        restoreEpisode ??= f.row().recovery;
        expect(f.row().recovery).toEqual(restoreEpisode);
        if (payload.command === 'native-recover') restoreReports.push(result);
        if (payload.command === restoreRead && remainingUnreadable > 0) {
          remainingUnreadable--;
          // The actual restore ran. Only its response was lost in transport.
          return readNativeRuntimeReport({
            statusCode: 200,
            contentType: 'application/json',
            response: Readable.from(['{"partial":']),
          });
        }
      }
      if (payload.command === 'native-continue' && loseNextAck) {
        loseNextAck = false;
        throw Object.assign(new Error('lost acknowledgement'), { name: 'TimeoutError' });
      }
      return result;
    },
    stop,
    publications,
    interactions,
    checkpoints,
    fence,
    project: async () => {},
  });
  const api = createNativeExecutionApi({
    enabled: true,
    store: f.store,
    publications,
    interactions,
    configure: async () => f.configuration,
    enqueue: async () => {},
    authorizeSource: async () => {},
  });
  const recheck = async () => {};
  const step = async () => {
    const result = await supervisor(f.identity);
    await runtime.settle();
    return result;
  };
  try {
    for (let i = 0; i < 10 && f.row().status !== 'AWAITING_USER'; i++) await step();
    expect(f.row().status).toBe('AWAITING_USER');
    expect(modelTurns).toBe(1);
    await step(); // Complete the projection before accepting a reply.
    const first = f.row();
    expect(first.recoveryCheckpoint.sequence).toBe(1);
    const content = await api.interaction(f.prepared, recheck);
    const request = {
      requestId: randomUUID(),
      interactionId: content.id,
      contentSha256: content.contentSha256,
      text: '  $aidlc compose Keep this exact task.\r\n',
    };
    // Destroy the local HOME and all executor memory while preserving EFS.
    await fs.rm(homeRoot, { recursive: true, force: true });
    runtime = createRuntime();
    expect((await runtime.status(executionIdentity(first))).recovered).toBe(true);
    const accepted = await api.respond(f.prepared, ACTOR, request, recheck);
    await step();
    expect(f.row().status).toBe('RECOVERING');
    expect((await api.interaction(f.prepared, recheck)).response.text).toBe(request.text);
    expect((await api.publication(f.prepared, recheck)).id).toBe(first.publication.id);
    for (
      let i = 0;
      i < 12 && !['AWAITING_USER', 'RECOVERY_REQUIRED'].includes(f.row().status);
      i++
    ) {
      if (unreadableReads && f.row().status === 'RECOVERING') {
        const before = f.row();
        await api.recover(
          f.prepared,
          { requestId: randomUUID(), recoveryId: before.recovery.id },
          recheck,
        );
        expect(f.row()).toEqual(before);
      }
      await step();
    }
    if (failRestore) {
      expect(f.row().status).toBe('RECOVERY_REQUIRED');
      expect(f.row().recovery).toMatchObject({ reason: 'RESTORE_FAILED', canRecover: true });
      expect(modelTurns).toBe(1);
      const recoveryRequest = { requestId: randomUUID(), recoveryId: f.row().recovery.id };
      restoreEpisode = undefined;
      const resumed = await api.recover(f.prepared, recoveryRequest, recheck);
      expect(resumed.execution.status).toBe('RECOVERING');
      expect(await api.recover(f.prepared, recoveryRequest, recheck)).toEqual(resumed);
      for (let i = 0; i < 12 && f.row().status !== 'AWAITING_USER'; i++) await step();
    }
    expect(
      f.row().status,
      JSON.stringify({
        recovery: f.row().recovery,
        lastInvocationError,
        invocations,
        lastRuntimeResult,
        beforeStop,
        report: await runtime.settle(),
      }),
    ).toBe('AWAITING_USER');
    const finalGeneration = failRestore ? 3 : 2;
    expect(f.row().writerGeneration).toBe(finalGeneration);
    expect(stop).toHaveBeenCalledTimes(failRestore ? 3 : 1);
    expect(modelTurns).toBe(2);
    expect(remainingUnreadable).toBe(0);
    if (unreadableReads) {
      expect(restoreReports.length).toBeGreaterThan(1);
      expect(restoreReports.slice(1).every((report) => report.duplicate === true)).toBe(true);
      const recovered = f.row();
      await api.recover(
        f.prepared,
        { requestId: randomUUID(), recoveryId: restoreEpisode.id },
        recheck,
      );
      expect(f.row()).toEqual(recovered);
      await step(); // A duplicate work pointer cannot deliver the answer again.
      expect(modelTurns).toBe(2);
    }
    expect(f.row().attemptId).toBe(first.attemptId);
    expect(f.row().runtimeSessionId).toBe(first.runtimeSessionId);
    expect(f.row().epoch).toBe(first.epoch);
    expect(f.row().publication.nativeSessionId).toBe(nativeSessionId);
    expect(f.row().recoveryCheckpoint.sequence).toBe(2);
    const delivered = invocations.filter((v) => v.command === 'native-continue');
    expect(delivered).toEqual([
      {
        command: 'native-continue',
        writerGeneration: finalGeneration,
        requestId: accepted.response.id,
        sequence: 2,
        text: request.text,
      },
    ]);
    expect((await api.interaction(f.prepared, recheck)).messages).toEqual([
      { type: 'text', text: 'Which pipe shape should we use?' },
    ]);
    expect((await api.respond(f.prepared, ACTOR, request, recheck)).response.id).toBe(
      accepted.response.id,
    );
    const privateManifest = await checkpoints.read(
      executionIdentity(f.row()),
      f.row().recoveryCheckpoint,
      { verifyFiles: true },
    );
    expect(privateManifest.nativeSessionId).toBe(nativeSessionId);
    expect(privateManifest.writerGeneration).toBe(finalGeneration);
    expect(privateManifest.files.some((v) => v.scope === 'home')).toBe(true);
    expect(
      (await api.publication(f.prepared, recheck)).files.every(
        (file) => !file.path.includes('.codex') && !file.path.includes('.native-control'),
      ),
    ).toBe(true);
  } finally {
    await runtime.settle();
    await fs.rm(base, { recursive: true, force: true });
  }
});
