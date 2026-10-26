import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { createNativeExecutor } from '../../agentcore/native/executor.js';
import { createNativeRuntimeServer } from '../../agentcore/native/runtime-server.js';
import { createNativeExecutionPorts } from '../../agentcore/native/execution-prepare.js';
import { runNativeCommand } from '../../agentcore/native/command-runner.js';
import { captureNativeSessionRecovery } from '../../agentcore/native/session-recovery-files.js';
import { createNativePublications } from '../../shared/native-publication.js';
import { createNativeInteractions } from '../../shared/native-interaction.js';
import { createNativeExecutionFence } from '../../shared/native-execution-fence.js';
import { NATIVE_WORKSPACE_RECOVERY } from '../../shared/native-recovery-mode.js';
import {
  createNativeExecutionSupervisor,
  invokeNativeExecutionRuntime,
} from '../execution-worker.js';
import { createNativeExecutionApi } from '../execution-api.js';
import { executionIdentity } from '../execution-runtime.js';
import { executionFixture } from './execution-fixtures.js';
import { memoryNativeObjects } from './memory-objects.js';
import { ACTOR } from './fixtures.js';

// Production authority, fence, executor, public snapshot/upload and interaction
// path. The subprocess is explicitly inert; installed AI-DLC gate recovery is
// proved by native-workspace-protocol-qualification.mjs, not fabricated here.
it.each([
  'undelivered',
  'delivered',
  'uncertain',
  'wrong-workspace',
  'wrong-config',
  'unconfirmed-stop',
  'resume-owner-loss',
  'resume-running-owner-loss',
])('confirmed workspace resume preserves work and never replays %s input', async (scenario) => {
  const interruptRunningResume = scenario === 'resume-running-owner-loss';
  const f = executionFixture({ harness: 'claude', recoveryMode: NATIVE_WORKSPACE_RECOVERY });
  await f.start();
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-workspace-journey-')));
  const root = join(base, 'mount');
  const project = join(root, 'project');
  const homes = join(base, 'homes');
  await fs.mkdir(root, { mode: 0o700 });
  const script = join(base, 'inert-turn.mjs');
  await fs.writeFile(
    script,
    `
      import * as fs from 'node:fs/promises'; import {join,dirname} from 'node:path';
      const id=process.argv[2]; let prompt=''; for await(const b of process.stdin) prompt+=b;
      const session=join(process.env.HOME,'.claude/projects/fixture',id+'.jsonl');
      await fs.mkdir(dirname(session),{recursive:true,mode:0o700});
      await fs.appendFile(session,JSON.stringify({type:'user',sessionId:id,cwd:process.cwd()})+'\\n',{mode:0o600});
      await fs.appendFile('effects.jsonl',JSON.stringify({id,prompt})+'\\n',{mode:0o600});
      if(process.argv[3]==='interrupt') await fs.writeFile('unfinished-resume.md','Interrupted resume work must survive.\\n');
      console.log(JSON.stringify({type:'system',subtype:'init',session_id:id}));
      if(process.argv[3]==='interrupt') await new Promise(()=>setInterval(()=>{},1000));
      console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:id,
        result:'Which current option?',stop_reason:'end_turn',terminal_reason:'completed'}));
    `,
  );
  const memory = memoryNativeObjects({
    bucket: f.configuration.publicationBucket,
    accountId: f.configuration.accountId,
  });
  const storage = {
    s3: memory.s3,
    bucket: f.configuration.publicationBucket,
    accountId: f.configuration.accountId,
  };
  const fence = createNativeExecutionFence(storage);
  const publications = createNativePublications(storage);
  const interactions = createNativeInteractions(storage);
  const firstIdentity = executionIdentity(f.row());
  const env = {
    NATIVE_RUNTIME_MODE: 'isolated',
    NATIVE_EXECUTION_ENABLED: 'true',
    NATIVE_RUNTIME_PROJECT_ID: f.identity.projectId,
    NATIVE_RUNTIME_EXECUTION_ID: f.identity.executionId,
    NATIVE_RUNTIME_BINDING_ID: f.row().bindingId,
    NATIVE_EXECUTION_ATTEMPT_ID: f.row().attemptId,
    NATIVE_EXECUTION_RUNTIME_SESSION_ID: f.row().runtimeSessionId,
    NATIVE_EXECUTION_EPOCH: '1',
    NATIVE_EXECUTION_IMAGE_DIGEST: f.configuration.image.digest,
    NATIVE_PUBLICATION_BUCKET: storage.bucket,
    NATIVE_RUNTIME_ACCOUNT_ID: storage.accountId,
  };
  const forbiddenPrivate = vi.fn(() => {
    throw Error('Private recovery must not run');
  });
  let pkg;
  let lastHome;
  let modelTurns = 0;
  let nativeSession;
  let setup = 0;
  let signalInterrupted;
  const interrupted = new Promise((resolve) => {
    signalInterrupted = resolve;
  });
  const resumedCommandController = new AbortController();
  const create = () =>
    createNativeExecutor({
      env,
      root,
      homeRoot: homes,
      ...createNativeExecutionPorts({ env, s3: memory.s3 }),
      inspectMount: async () => ({}),
      inspectInitialization: async () => ({ ok: true }),
      captureRecovery: forbiddenPrivate,
      publishRecovery: forbiddenPrivate,
      loadRecovery: forbiddenPrivate,
      restoreRecovery: forbiddenPrivate,
      prepareRecovery: async () => ({ package: pkg }),
      prepare: async () => {
        const directory = join(root, 'packages/fixture');
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.writeFile(join(directory, 'aidlc'), 'inert package');
        pkg = {
          directory,
          binaryPath: join(directory, 'aidlc'),
          version: '2.9.0',
          packageId: f.configuration.packageId,
        };
        await fs.mkdir(join(project, '.claude'), { mode: 0o700 });
        await fs.writeFile(
          join(project, '.claude/settings.json'),
          JSON.stringify({
            hooks: {
              SessionEnd: [
                { hooks: [{ type: 'command', command: 'aidlc engine hook session-end' }] },
              ],
            },
          }),
          { mode: 0o600 },
        );
        await fs.mkdir(join(project, 'node_modules/pkg'), { recursive: true, mode: 0o700 });
        await fs.writeFile(join(project, 'node_modules/pkg/index.js'), 'module.exports = 42;\n', {
          mode: 0o600,
        });
        await fs.link(
          join(project, 'node_modules/pkg/index.js'),
          join(project, 'node_modules/pkg/alias.js'),
        );
        await fs.writeFile(join(project, 'package-lock.json'), '{"lockfileVersion":3}\n', {
          mode: 0o600,
        });
        return {
          package: pkg,
          repositoryCommit: 'c'.repeat(40),
          authEnv: { AWS_BEARER_TOKEN_BEDROCK: 'fixture-token' },
        };
      },
      commandRunner: async (input) => {
        if (input.timeoutMs !== null) {
          setup++;
          return {
            exitCode: 0,
            signal: null,
            spawnError: null,
            timedOut: false,
            outputLimitExceeded: false,
            cleanupComplete: true,
            stdout: '',
            stderr: '',
          };
        }
        lastHome = input.env.HOME;
        if (!input.args.includes('--resume')) nativeSession = randomUUID();
        modelTurns++;
        const interrupt = interruptRunningResume && modelTurns === 2;
        const result = await runNativeCommand({
          ...input,
          command: process.execPath,
          args: [script, nativeSession, interrupt ? 'interrupt' : 'complete'],
          ...(interrupt
            ? {
                signal: AbortSignal.any([input.signal, resumedCommandController.signal]),
                onStdoutChunk: async (chunk) => {
                  await input.onStdoutChunk?.(chunk);
                  signalInterrupted();
                },
              }
            : {}),
        });
        if (modelTurns === 2 && ['delivered', 'uncertain'].includes(scenario)) {
          signalInterrupted();
          await new Promise((resolve) =>
            input.signal.addEventListener('abort', resolve, { once: true }),
          );
        }
        return result;
      },
    });
  let runtime = create();
  let server;
  let servedRuntime;
  const invokeHttp = async ({ execution, payload }) => {
    if (servedRuntime !== runtime) {
      if (server) await new Promise((resolve) => server.close(resolve));
      server = createNativeRuntimeServer({
        env,
        checkWorkspace: async () => ({}),
        createExecutor: () => runtime,
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      servedRuntime = runtime;
    }
    return invokeNativeExecutionRuntime({
      execution,
      payload,
      runtime: {
        async send(command) {
          const response = await fetch(`http://127.0.0.1:${server.address().port}/invocations`, {
            method: 'POST',
            body: command.input.payload,
          });
          return {
            statusCode: response.status,
            contentType: response.headers.get('content-type'),
            response: Readable.fromWeb(response.body),
          };
        },
      },
    });
  };
  let loseResumeAck = !interruptRunningResume;
  let loseAnswerAck = scenario === 'uncertain';
  const invocations = [];
  let lastRuntimeError;
  const supervisor = createNativeExecutionSupervisor({
    store: f.store,
    preparationStore: f.preparationStore,
    now: f.now,
    upgrade: async ({ execution }) => ({ ready: true, target: f.target(execution) }),
    authorize: async () => {},
    credentials: async (row) => ({
      ok: true,
      ...executionIdentity(row),
      model: { provider: 'bedrock', value: 'fixture-token' },
      git: { username: 'fixture', password: 'fixture-git' },
      source: { branch: 'main', commit: 'c'.repeat(40) },
    }),
    invoke: async ({ execution, payload }) => {
      invocations.push(payload);
      const report = await (
        scenario === 'resume-owner-loss' || interruptRunningResume
          ? invokeHttp({ execution, payload })
          : runtime[
              {
                'native-start': 'start',
                'native-continue': 'continue',
                'native-status': 'status',
                'native-resume': 'resume',
              }[payload.command]
            ](payload)
      ).catch((error) => {
        lastRuntimeError = error.code;
        throw error;
      });
      if (payload.command === 'native-continue' && loseAnswerAck) {
        loseAnswerAck = false;
        throw Object.assign(new Error('lost acknowledgement'), { code: 'ECONNRESET' });
      }
      if (payload.command === 'native-resume' && loseResumeAck) {
        loseResumeAck = false;
        if (scenario === 'resume-owner-loss') {
          // The CLI really ran, but this publication was never admitted.
          // Lose both the acknowledgement and the in-memory runtime owner.
          await runtime.settle();
          await fs.rm(homes, { recursive: true });
          runtime = create();
        }
        throw Object.assign(new Error('lost acknowledgement'), { code: 'ECONNRESET' });
      }
      return report;
    },
    stop: async ({ execution }) => {
      expect((await fence.read(executionIdentity(execution))).state).not.toBe('ACTIVE');
      if (runtime.isBusy())
        await runtime.cancel({ ...firstIdentity, writerGeneration: execution.writerGeneration });
      await runtime.settle();
      return {
        confirmed: scenario !== 'unconfirmed-stop',
        runtimeSessionId: execution.runtimeSessionId,
      };
    },
    publications,
    interactions,
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
  const settle = async (expected) => {
    for (let i = 0; i < 16; i++) {
      await supervisor(f.identity);
      await runtime.settle();
      if (f.row().status === expected) return;
    }
    throw Error(`Unexpected authority ${f.row().status}, runtime ${lastRuntimeError}`);
  };
  try {
    await settle('AWAITING_USER');
    const first = structuredClone(f.row().publication);
    const oldSession = first.nativeSessionId;
    expect(f.row().recoveryCheckpoint).toBeUndefined();
    // Direct old exporter reproduction on exactly the surviving tree: the
    // internal dependency alias is rejected despite a successful public turn.
    await expect(
      captureNativeSessionRecovery({
        project,
        home: lastHome,
        harness: 'claude',
        nativeSessionId: oldSession,
        filesystemPolicy: 'node-dependencies-v1',
      }),
    ).rejects.toMatchObject({ code: 'native_recovery_external_hardlink' });
    const firstRow = structuredClone(f.row());
    const question = await api.interaction(f.prepared, recheck);
    const reply = {
      requestId: randomUUID(),
      interactionId: question.id,
      contentSha256: question.contentSha256,
      text: 'protected-fixture-answer',
    };
    const accepted = await api.respond(f.prepared, ACTOR, reply, recheck);
    if (['delivered', 'uncertain'].includes(scenario)) {
      await supervisor(f.identity);
      await interrupted;
      await runtime.cancel(firstIdentity);
      await runtime.settle();
    }
    const priorModelTurns = modelTurns;
    await fs.writeFile(join(project, 'unfinished.md'), 'Unpublished work must survive.\n');
    await fs.rm(homes, { recursive: true });
    runtime = create();
    if (scenario === 'unconfirmed-stop') {
      await expect(supervisor(f.identity)).rejects.toMatchObject({
        code: 'NATIVE_EXECUTION_STOP_UNCONFIRMED',
      });
      expect(f.row().status).not.toBe('RECOVERING');
      expect(f.row().recovery?.canRecover).not.toBe(true);
      expect(f.row().stopConfirmation).toBeUndefined();
      expect(modelTurns).toBe(priorModelTurns);
      expect((await fence.read(firstIdentity)).state).toBe('FENCED');
      return;
    }
    await settle('RECOVERY_REQUIRED');
    expect(f.row().stopConfirmation.writerGeneration).toBe(1);
    expect(f.row().recovery.canRecover).toBe(true);
    expect(f.row().publication).toEqual(first);
    const request = { requestId: randomUUID(), recoveryId: f.row().recovery.id };
    await expect(api.recover(f.prepared, request, recheck)).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_INVALID',
    });
    if (scenario === 'wrong-workspace') {
      await fs.rename(project, join(root, 'wrong-project'));
      await fs.mkdir(project, { mode: 0o700 });
    }
    if (scenario === 'wrong-config') {
      const path = join(root, '.native-control/workspace.json');
      const binding = JSON.parse(await fs.readFile(path, 'utf8'));
      binding.configurationSha256 = 'f'.repeat(64);
      await fs.writeFile(path, JSON.stringify(binding));
    }
    await Promise.all(
      [ACTOR, 'another-member'].map(() =>
        api.recover(
          f.prepared,
          { ...request, requestId: randomUUID(), confirmWorkspaceResume: true },
          recheck,
        ),
      ),
    );
    expect(f.row().status).toBe('RECOVERING');
    expect(f.row().response).toBeUndefined();
    expect(await f.store.response(f.row(), reply.interactionId)).toMatchObject({
      commandId: accepted.response.id,
      text: reply.text,
      requestId: reply.requestId,
    });
    if (['wrong-workspace', 'wrong-config'].includes(scenario)) {
      await settle('RECOVERY_REQUIRED');
      expect(f.row().recovery.reason).toBe('WORKSPACE_UNAVAILABLE');
      expect(f.row().recovery.canRecover).toBe(false);
      expect(modelTurns).toBe(priorModelTurns);
      return;
    }
    if (interruptRunningResume) {
      // Admit the native-resume acknowledgement before losing its runtime.
      // No normal Start/Continue dispatch remains on this authority row.
      await supervisor(f.identity);
      await supervisor(f.identity);
      await interrupted;
      const running = f.row();
      expect(running).toMatchObject({
        status: 'RUNNING',
        writerGeneration: 2,
        publication: first,
        workspaceResume: { id: request.recoveryId, sequence: 2, writerGeneration: 2 },
      });
      expect(running.dispatch).toBeUndefined();
      expect(running.response).toBeUndefined();
      // Stop the actual inert child, then discard the runtime and CLI home.
      // This injects process loss without submitting a platform cancellation.
      resumedCommandController.abort();
      await runtime.settle();
      await fs.rm(homes, { recursive: true });
      runtime = create();
      const cold = await invokeHttp({
        execution: running,
        payload: {
          command: 'native-status',
          ...executionIdentity(running),
          writerGeneration: 2,
        },
      });
      expect(cold).toMatchObject({
        status: 'stopped_needs_review',
        code: 'native_execution_existing_owner',
        writerGeneration: 2,
      });
      expect(cold.sequence).toBeUndefined();
      expect(await supervisor(f.identity)).toEqual({
        pending: false,
        status: 'RECOVERY_REQUIRED',
        reason: 'DELIVERY_UNCERTAIN',
      });
      expect(f.row()).toMatchObject({
        status: 'RECOVERY_REQUIRED',
        recovery: { reason: 'DELIVERY_UNCERTAIN', canRecover: true },
        publication: first,
      });
    }
    const coldResume = scenario === 'resume-owner-loss' || interruptRunningResume;
    if (coldResume) {
      await settle('RECOVERY_REQUIRED');
      expect(f.row().recovery.reason).toBe(
        interruptRunningResume ? 'DELIVERY_UNCERTAIN' : 'RESTORE_FAILED',
      );
      expect(f.row().recovery.canRecover).toBe(true);
      expect(f.row().stopConfirmation.writerGeneration).toBe(2);
      expect(f.row().publication).toEqual(first);
      expect(modelTurns).toBe(priorModelTurns + 1);
      // Neither a cold reissue nor the previous confirmation may launch work.
      const pendingRecovery = f.row();
      const previousConfirmation = api.recover(
        f.prepared,
        { ...request, confirmWorkspaceResume: true },
        recheck,
      );
      if (interruptRunningResume) {
        // The acknowledged episode deduplicates to the current blocked row.
        await expect(previousConfirmation).resolves.toMatchObject({
          execution: { status: 'RECOVERY_REQUIRED', recovery: pendingRecovery.recovery },
        });
      } else {
        await expect(previousConfirmation).rejects.toMatchObject({
          code: 'NATIVE_EXECUTION_CONFLICT',
        });
      }
      expect(f.row()).toEqual(pendingRecovery);
      expect(modelTurns).toBe(priorModelTurns + 1);
      await api.recover(
        f.prepared,
        {
          requestId: randomUUID(),
          recoveryId: f.row().recovery.id,
          confirmWorkspaceResume: true,
        },
        recheck,
      );
    }
    await settle('AWAITING_USER');
    const generation = coldResume ? 3 : 2;
    const expectedTurns = priorModelTurns + (coldResume ? 2 : 1);
    expect(f.row().writerGeneration).toBe(generation);
    expect(f.row().publication.sequence).toBe(2);
    expect(f.row().publication.nativeSessionId).not.toBe(oldSession);
    expect(modelTurns).toBe(expectedTurns);
    expect(setup).toBe(3, 'Existing project and machine are not reinitialized');
    expect(await fs.readFile(join(project, 'unfinished.md'), 'utf8')).toBe(
      'Unpublished work must survive.\n',
    );
    if (interruptRunningResume)
      expect(await fs.readFile(join(project, 'unfinished-resume.md'), 'utf8')).toBe(
        'Interrupted resume work must survive.\n',
      );
    const [original, alias] = await Promise.all(
      ['index.js', 'alias.js'].map((file) => fs.stat(join(project, 'node_modules/pkg', file))),
    );
    expect(original.ino).toBe(alias.ino);
    expect(original.nlink).toBe(2);
    const history = await f.store.historicalAnswer(f.row(), {
      identity: firstIdentity,
      runtimeSessionId: firstIdentity.runtimeSessionId,
      receipt: first,
      interaction: firstRow.interaction,
      interactionContentSha256: firstRow.interactionContentSha256,
    });
    expect(history.response.text).toBe(reply.text);
    expect(history.retained.delivery).toBe(coldResume ? 'undelivered' : scenario);
    expect(history.publication).toBeNull(); // Fresh resume did not consume the old answer.
    const resumes = invocations.filter((input) => input.command === 'native-resume');
    expect(resumes.length).toBeGreaterThanOrEqual(2); // Lost ACK or another confirmed episode.
    expect(new Set(resumes.map((input) => input.recoveryId)).size).toBe(coldResume ? 2 : 1);
    expect(
      resumes.every((input) => !input.text && !input.checkpoint && !input.nativeSessionId),
    ).toBe(true);
    const effects = (await fs.readFile(join(project, 'effects.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    expect(effects.filter((event) => event.prompt === reply.text)).toHaveLength(
      scenario === 'undelivered' || coldResume ? 0 : 1,
    );
    expect(effects.at(-1).prompt).toContain('/aidlc --resume');
    expect(effects.at(-1).prompt).not.toContain(reply.text);
    await api.respond(f.prepared, ACTOR, reply, recheck);
    await supervisor(f.identity);
    expect(modelTurns).toBe(expectedTurns);
    expect(forbiddenPrivate).not.toHaveBeenCalled();
    expect(memory.writes.some((key) => key.startsWith('native-recovery/'))).toBe(false);
    await api.cancel(f.prepared, recheck);
    await supervisor(f.identity);
    expect(f.row().status).toBe('CANCELLED');
    expect(f.row().publication.sequence).toBe(2);
    expect(f.row().stopConfirmation.writerGeneration).toBe(generation);
  } finally {
    if (runtime.isBusy())
      await runtime.cancel({ ...firstIdentity, writerGeneration: f.row().writerGeneration });
    await runtime.settle();
    if (server) await new Promise((resolve) => server.close(resolve));
    await fs.rm(base, { recursive: true, force: true });
  }
});
