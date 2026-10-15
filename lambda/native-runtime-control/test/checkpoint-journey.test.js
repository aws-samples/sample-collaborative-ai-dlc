import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
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
import { createNativeExecutionSupervisor } from '../execution-worker.js';
import { createNativeExecutionDiagnostics } from '../execution-diagnostics.js';
import { createNativeExecutionApi, nativeExecutionView } from '../execution-api.js';
import { executionIdentity } from '../execution-runtime.js';
import { executionFixture } from './execution-fixtures.js';
import { ACTOR } from './fixtures.js';

// Real subprocesses, filesystem capture and production runtime/controller/
// authority/publication/checkpoint validators. Only AWS, package initialization
// and model output are inert ports. No CLI or provider is invoked.
it.each([
  { kind: 'complete', turns: 3 },
  { kind: 'capture', turns: 2, code: 'native_recovery_home_path_invalid' },
  { kind: 'snapshot', turns: 3, code: 'native_snapshot_link' },
  { kind: 'cancel', turns: 2 },
  { kind: 'capture', turns: 2, code: 'native_recovery_home_path_invalid', unconfirmed: true },
])('Claude checkpoint journey: %j', async (scenario) => {
  const f = executionFixture({ harness: 'claude', model: 'fixture-sonnet' });
  await f.start();
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-checkpoint-journey-')));
  const root = join(base, 'mount');
  const homeRoot = join(base, 'homes');
  await fs.mkdir(root, { mode: 0o700 });
  const nativeSessionId = randomUUID();
  const script = join(base, 'inert-claude.mjs');
  await fs.writeFile(
    script,
    `
    import * as fs from 'node:fs/promises';
    import {join,dirname} from 'node:path';
    const id=process.argv[2],turn=Number(process.argv[3]),kind=process.argv[4];
    let prompt=''; for await(const bytes of process.stdin) prompt+=bytes.toString();
    const file=join(process.env.HOME,'.claude','projects','project-key',id+'.jsonl');
    if(turn===1) {
      await fs.mkdir(dirname(file),{recursive:true,mode:0o700});
      await fs.writeFile(file,JSON.stringify({type:'user',sessionId:id,cwd:process.cwd()})+'\\n',{mode:0o600});
    } else {
      const rows=(await fs.readFile(file,'utf8')).trim().split('\\n').map(JSON.parse);
      if(rows[0].sessionId!==id || rows[0].cwd!==process.cwd() ||
         rows.filter(x=>x.type==='fixture_turn').length!==turn-1) throw Error('session history changed');
      if(prompt!=='answer-'+(turn-1)) throw Error('answer changed or replayed');
      // Layout and shape observed in pinned Claude 2.1.257 persistAgentMetadata.
      const agent=join(file.slice(0,-6),'subagents','agent-child');
      await fs.mkdir(dirname(agent),{recursive:true,mode:0o700});
      await fs.writeFile(agent+'.jsonl',JSON.stringify({type:'assistant',agentId:'child'})+'\\n',{mode:0o600});
      await fs.writeFile(agent+'.meta.json',JSON.stringify({agentType:'Explore',toolUseId:'fixture-tool'}),{mode:0o600});
    }
    await fs.appendFile(file,JSON.stringify({type:'fixture_turn',turn})+'\\n');
    await fs.writeFile('work.txt','saved turn '+turn+'\\n',{mode:0o600});
    if(kind==='capture' && turn===2)
      await fs.writeFile(join(file.slice(0,-6),'unknown.sqlite'),'unsupported session layout',{mode:0o600});
    if(kind==='snapshot' && turn===3) await fs.symlink('work.txt','unsafe-link');
    console.log(JSON.stringify({type:'system',subtype:'init',session_id:id}));
    console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:id,
      result:'Question '+turn+'?',stop_reason:'end_turn',terminal_reason:'completed'}));
  `,
  );
  const latest = new Map();
  const objects = new Map();
  const writes = [];
  let version = 0;
  const s3 = {
    send: vi.fn(async (command) => {
      const p = command.input;
      expect(p.Bucket).toBe(f.configuration.publicationBucket);
      expect(p.ExpectedBucketOwner).toBe(f.configuration.accountId);
      const current = latest.get(p.Key);
      if (command.constructor.name === 'PutObjectCommand') {
        if ((p.IfNoneMatch === '*' && current) || (p.IfMatch && p.IfMatch !== current?.etag))
          throw Object.assign(new Error('conditional conflict'), {
            name: 'PreconditionFailed',
            $metadata: { httpStatusCode: 412 },
          });
        const bytes = Buffer.from(p.Body);
        const item = {
          bytes,
          version: `immutable-${++version}`,
          etag: `"${createHash('sha256').update(bytes).digest('hex')}"`,
        };
        objects.set(`${p.Key}\0${item.version}`, item);
        latest.set(p.Key, item);
        writes.push(p.Key);
        return { VersionId: item.version, ETag: item.etag };
      }
      expect(command.constructor.name).toBe('GetObjectCommand');
      const item = p.VersionId ? objects.get(`${p.Key}\0${p.VersionId}`) : current;
      if (!item) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
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
  let turns = 0;
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
  const commands = [];
  const runtime = createNativeExecutor({
    env,
    root,
    homeRoot,
    ...createNativeExecutionPorts({ env, s3 }),
    inspectMount: async () => ({}),
    inspectInitialization: async () => ({ ok: true }),
    commandRunner: async (input) => {
      if (input.timeoutMs !== null) return clean;
      if (++turns > 1) {
        expect(input.args).toContain('--resume');
        expect(input.args).toContain(nativeSessionId);
      }
      const result = await runNativeCommand({
        ...input,
        command: process.execPath,
        args: [script, nativeSessionId, String(turns), scenario.kind],
      });
      commands.push(result);
      return result;
    },
    prepare: async ({ project }) => {
      const directory = join(root, 'packages', 'fixture');
      const binaryPath = join(directory, 'aidlc');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(binaryPath, 'inert package');
      await fs.writeFile(join(project, 'work.txt'), 'initial\n', { mode: 0o600 });
      await fs.mkdir(join(project, '.claude'), { mode: 0o700 });
      await fs.writeFile(
        join(project, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: {
            SessionEnd: [
              { hooks: [{ type: 'command', command: 'aidlc engine hook session-end' }] },
            ],
          },
        }),
        { mode: 0o600 },
      );
      return {
        package: { directory, binaryPath, version: '2.9.0', packageId: f.configuration.packageId },
        repositoryCommit: 'c'.repeat(40),
        authEnv: { AWS_BEARER_TOKEN_BEDROCK: 'fixture-model-token' },
      };
    },
  });
  const stop = vi.fn(async ({ execution }) => {
    expect((await fence.read(executionIdentity(execution))).state).toBe('CANCELLED');
    // The external stop targets the admitted session. Authority cancellation
    // increments its fence epoch; it does not give the old runtime a new epoch.
    await runtime.cancel(executionIdentity(row));
    await runtime.settle();
    return { confirmed: !scenario.unconfirmed, runtimeSessionId: execution.runtimeSessionId };
  });
  const invocations = [];
  const diagnostics = [];
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
      invocations.push(payload);
      const method = {
        'native-start': 'start',
        'native-continue': 'continue',
        'native-status': 'status',
      }[payload.command];
      return runtime[method](payload);
    },
    diagnostics: createNativeExecutionDiagnostics({
      scope: f.identity,
      logger: { info: (line) => diagnostics.push(JSON.parse(line)) },
    }),
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
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      await supervisor(f.identity);
      await runtime.settle();
      if (['AWAITING_USER', 'FAILED', 'CANCELLED'].includes(f.row().status)) {
        await supervisor(f.identity); // Finish projection; duplicate pointer is harmless.
        return;
      }
    }
    throw new Error(`Journey did not settle: ${f.row().status}`);
  };
  try {
    await settle();
    expect(f.row().status).toBe('AWAITING_USER');
    const first = f.row();
    expect(first.recoveryCheckpoint.sequence).toBe(1);
    let previous = first;
    let latestAnswer;
    let persistedFailure;
    for (let turn = 2; turn <= scenario.turns; turn++) {
      const question = await api.interaction(f.prepared, recheck);
      expect(question.messages).toEqual([{ type: 'text', text: `Question ${turn - 1}?` }]);
      latestAnswer = {
        requestId: randomUUID(),
        interactionId: question.id,
        contentSha256: question.contentSha256,
        text: `answer-${turn - 1}`,
      };
      const answer = await api.respond(f.prepared, ACTOR, latestAnswer, recheck);
      expect(answer.response.deliveryStatus).toBe('pending');
      await supervisor(f.identity);
      const completed = await runtime.settle();
      expect(commands.at(-1)).toMatchObject({ exitCode: 0, cleanupComplete: true });
      if (completed.status === 'failed') {
        persistedFailure = JSON.parse(
          await fs.readFile(join(root, '.native-control', 'first-turn', 'status.json'), 'utf8'),
        );
      }
      if (scenario.kind === 'cancel') await api.cancel(f.prepared, recheck);
      await settle();
      expect(
        invocations.filter((p) => p.command === 'native-continue' && p.sequence === turn),
      ).toHaveLength(1);
      if (scenario.code && turn === scenario.turns) {
        expect(f.row().status).toBe('FAILED');
        expect(f.row().failureCode).toBe(scenario.code);
        expect(nativeExecutionView(f.row()).failureCode).toBe(scenario.code);
        expect([...f.rows.values()].filter((record) => record.type === 'native.failed')).toEqual([
          expect.objectContaining({ summary: expect.stringContaining(scenario.code) }),
        ]);
        expect(persistedFailure).toMatchObject({
          code: scenario.code,
          sequence: turn,
          status: 'failed',
        });
        expect(diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: 'RUNTIME_TERMINAL', runtimeCode: scenario.code }),
          ]),
        );
        if (scenario.kind === 'capture') {
          expect(persistedFailure.timings.interactionUploadCompleted).toBeTypeOf('number');
          expect(persistedFailure.timings.checkpointCaptureStarted).toBeTypeOf('number');
          expect(persistedFailure.timings.checkpointCaptureCompleted).toBeUndefined();
          expect(persistedFailure.timings.checkpointUploadStarted).toBeUndefined();
          expect(writes.some((key) => key.includes('/interactions/'))).toBe(true);
        }
      } else if (scenario.kind !== 'cancel') {
        expect(f.row().status).toBe('AWAITING_USER');
        expect(f.row().recoveryCheckpoint.sequence).toBe(turn);
        expect(f.row().publication.nativeSessionId).toBe(nativeSessionId);
        previous = f.row();
      }
    }
    const final = f.row();
    expect(turns).toBe(scenario.turns);
    expect(final.attemptId).toBe(first.attemptId);
    expect(final.runtimeSessionId).toBe(first.runtimeSessionId);
    expect(final.writerGeneration).toBe(1);
    if (scenario.kind !== 'complete') {
      expect(final.status).toBe(scenario.kind === 'cancel' ? 'CANCELLED' : 'FAILED');
      expect(final.publication).toEqual(previous.publication);
      expect(final.recoveryCheckpoint).toEqual(previous.recoveryCheckpoint);
      expect(final.interaction).toEqual(previous.interaction);
      expect(final.recovery).toBeUndefined();
      expect(stop).toHaveBeenCalledTimes(1);
      if (scenario.unconfirmed) expect(final.stopConfirmation).toBeUndefined();
      else expect(final.stopConfirmation.runtimeSessionId).toBe(first.runtimeSessionId);
      await expect(
        api.recover(f.prepared, { requestId: randomUUID(), recoveryId: randomUUID() }, recheck),
      ).rejects.toMatchObject({
        code:
          scenario.kind === 'cancel' ? 'NATIVE_EXECUTION_CANCELLED' : 'NATIVE_EXECUTION_CONFLICT',
      });
    }
    // Only admitted bytes remain visible; checkpoint one remains independently readable.
    const firstCheckpoint = await checkpoints.read(
      executionIdentity(first),
      first.recoveryCheckpoint,
      { verifyFiles: true },
    );
    expect(firstCheckpoint.sequence).toBe(1);
    const visible = await api.publication(f.prepared, recheck);
    expect(visible.id).toBe(final.publication.id);
    const saved = visible.files.find((file) => file.path === 'work.txt');
    expect(await api.file(f.prepared, saved.id, recheck)).toMatchObject({
      encoding: 'utf8',
      content: `saved turn ${final.publication.sequence}\n`,
    });
    if (scenario.kind === 'cancel')
      await expect(api.respond(f.prepared, ACTOR, latestAnswer, recheck)).rejects.toMatchObject({
        code: 'NATIVE_EXECUTION_CANCELLED',
      });
    else await api.respond(f.prepared, ACTOR, latestAnswer, recheck);
    await supervisor(f.identity);
    expect(turns).toBe(scenario.turns); // Neither duplicate answer nor queue pointer replays work.
    expect(final.publication.sequence).toBe(scenario.kind === 'complete' ? 3 : scenario.turns - 1);
  } finally {
    if (runtime.isBusy()) await runtime.cancel(executionIdentity(row));
    await runtime.settle();
    await fs.rm(base, { recursive: true, force: true });
  }
});
