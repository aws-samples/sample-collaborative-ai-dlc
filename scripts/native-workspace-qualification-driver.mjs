// The existing native controller fixture and production runtime/storage owners,
// with installed CLI tools and a scripted loopback provider. No private exporter.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativeExecutor } from '../lambda/agentcore/native/executor.js';
import { createNativeExecutionPorts } from '../lambda/agentcore/native/execution-prepare.js';
import { runNativeCommand } from '../lambda/agentcore/native/command-runner.js';
import { createNativePublications } from '../lambda/shared/native-publication.js';
import { createNativeInteractions } from '../lambda/shared/native-interaction.js';
import { createNativeExecutionFence } from '../lambda/shared/native-execution-fence.js';
import { NATIVE_WORKSPACE_RECOVERY } from '../lambda/shared/native-recovery-mode.js';
import { createNativeExecutionSupervisor } from '../lambda/native-runtime-control/execution-worker.js';
import { createNativeExecutionApi } from '../lambda/native-runtime-control/execution-api.js';
import { executionIdentity } from '../lambda/native-runtime-control/execution-runtime.js';
import { executionFixture } from '../lambda/native-runtime-control/test/execution-fixtures.js';
import { memoryNativeObjects } from '../lambda/native-runtime-control/test/memory-objects.js';
import { ACTOR } from '../lambda/native-runtime-control/test/fixtures.js';
import { localProviderInvocation } from './native-qualification-provider.mjs';

export async function workspaceQualificationDriver({
  root,
  project,
  pkg,
  provider,
  harness = 'claude',
  model = 'claude-sonnet-4-6',
  dependencyEnv = {},
}) {
  const f = executionFixture({
    harness,
    model,
    recoveryMode: NATIVE_WORKSPACE_RECOVERY,
  });
  f.prepared.candidate.packagePin.version = pkg.version;
  await f.start();
  const homeRoot = `${root}-homes`;
  const memory = memoryNativeObjects({
    bucket: f.configuration.publicationBucket,
    accountId: f.configuration.accountId,
  });
  const storage = {
    s3: memory.s3,
    bucket: f.configuration.publicationBucket,
    accountId: f.configuration.accountId,
  };
  const publications = createNativePublications(storage);
  const interactions = createNativeInteractions(storage);
  const fence = createNativeExecutionFence(storage);
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
  let privateCalls = 0,
    setups = 0,
    cliTurns = 0,
    lastHome,
    latestError;
  let resumePending = false,
    loseAck = false,
    first = true;
  const resumes = [],
    accepted = [],
    sessions = new Set();
  const forbidden = () => {
    privateCalls++;
    throw Error('Private recovery called in workspace mode');
  };
  const create = () =>
    createNativeExecutor({
      env,
      root,
      homeRoot,
      ...createNativeExecutionPorts({ env, s3: storage.s3 }),
      inspectMount: async () => ({}), // Local filesystem, NOT AWS EFS proof.
      prepare: async () => {
        await fs.mkdir(join(project, '.native-control'), { recursive: true, mode: 0o700 });
        return {
          package: { ...pkg, packageId: f.configuration.packageId },
          repositoryCommit: 'c'.repeat(40),
          authEnv: { AWS_BEARER_TOKEN_BEDROCK: 'fixture-token' },
        };
      },
      prepareRecovery: async () => ({ package: { ...pkg, packageId: f.configuration.packageId } }),
      captureRecovery: forbidden,
      publishRecovery: forbidden,
      loadRecovery: forbidden,
      restoreRecovery: forbidden,
      commandRunner: async (input) => {
        input = {
          ...input,
          env: { ...input.env, ...dependencyEnv, PATH: `${pkg.tools}:${input.env.PATH}` },
        };
        if (input.timeoutMs !== null) {
          setups++;
          const result = await runNativeCommand(input);
          if (result.exitCode !== 0) {
            const space = await fs.statfs(root);
            console.log(
              JSON.stringify({
                harness,
                probe: 'workspace-setup-failure',
                setup: setups,
                exitCode: result.exitCode,
                noSpace: /ENOSPC|No space left on device/i.test(result.stderr + result.stdout),
                diskDiagnostic: /disk|space|capacity/i.test(result.stderr + result.stdout),
                installerCodes: [
                  ...new Set((result.stderr + result.stdout).match(/\b[A-Z][A-Z_]{4,63}\b/g) ?? []),
                ].slice(0, 8),
                availableBytes: space.bavail * space.bsize,
              }),
            );
          }
          return result;
        }
        cliTurns++;
        lastHome = input.env.HOME;
        return runNativeCommand(localProviderInvocation(harness, input, provider.url));
      },
    });
  let runtime = create();
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
    invoke: async ({ payload }) => {
      if (payload.command === 'native-resume') resumes.push(payload);
      const result = await runtime[
        {
          'native-start': 'start',
          'native-continue': 'continue',
          'native-status': 'status',
          'native-resume': 'resume',
        }[payload.command]
      ](payload).catch((error) => {
        latestError = error.code;
        throw error;
      });
      if (payload.command === 'native-resume' && loseAck) {
        loseAck = false;
        throw Object.assign(Error('Lost resume acknowledgement'), { code: 'ECONNRESET' });
      }
      return result;
    },
    stop: async ({ execution }) => {
      assert.notEqual((await fence.read(executionIdentity(execution))).state, 'ACTIVE');
      if (runtime.isBusy())
        await runtime.cancel({
          ...executionIdentity(execution),
          writerGeneration: execution.writerGeneration,
        });
      await runtime.settle();
      return { confirmed: true, runtimeSessionId: execution.runtimeSessionId };
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
  const settle = async (status) => {
    for (let i = 0; i < 16; i++) {
      await supervisor(f.identity);
      await runtime.settle();
      if (f.row().status === status) return;
    }
    throw Error(`Native authority ${f.row().status}, ${latestError}, ${f.row().failureCode}`);
  };
  const loseSession = async () => {
    assert.equal(runtime.isBusy(), false);
    await fs.rm(homeRoot, { recursive: true });
    await assert.rejects(fs.stat(lastHome), { code: 'ENOENT' });
    runtime = create();
    resumePending = true;
  };
  const begin = async (prompt, selection) => {
    if (resumePending) {
      if (f.row().status === 'AWAITING_USER') {
        // A waiting runtime is idle, not polled as a new workflow turn. The
        // next protected answer detects the expired session and is retained
        // as definitely undelivered; confirmation must not send it.
        const question = await api.interaction(f.prepared, recheck);
        const request = {
          requestId: randomUUID(),
          interactionId: question.id,
          contentSha256: question.contentSha256,
          text: 'Review the existing gate after waiting.',
        };
        await api.respond(f.prepared, ACTOR, request, recheck);
        accepted.push(request);
      }
      await settle('RECOVERY_REQUIRED');
      const request = { requestId: randomUUID(), recoveryId: f.row().recovery.id };
      await assert.rejects(api.recover(f.prepared, request, recheck), {
        code: 'NATIVE_EXECUTION_INVALID',
      });
      await api.recover(f.prepared, { ...request, confirmWorkspaceResume: true }, recheck);
      loseAck = true;
      resumePending = false;
    } else if (!first) {
      const question = await api.interaction(f.prepared, recheck);
      const request = {
        requestId: randomUUID(),
        interactionId: question.id,
        contentSha256: question.contentSha256,
        text: prompt,
        ...(selection ? { selection } : {}),
      };
      const reply = await api.respond(f.prepared, ACTOR, request, recheck);
      const duplicate = await api.respond(f.prepared, ACTOR, request, recheck);
      assert.equal(duplicate.response.id, reply.response.id);
      accepted.push(request);
    }
    first = false;
  };
  return {
    interaction: () => api.interaction(f.prepared, recheck),
    async turn(prompt, { interrupt = false, selection } = {}) {
      const before = f.row().publication?.sequence ?? 0;
      const beforeTurns = cliTurns;
      await begin(prompt, selection);
      if (interrupt) {
        await supervisor(f.identity);
        const marker = join(project, '.native-control/interrupt-ready');
        let ready = false;
        for (let i = 0; i < 600 && !ready; i++) {
          ready = await fs.stat(marker).then(
            () => true,
            () => false,
          );
          if (!ready) await delay(100);
        }
        assert.ok(ready, 'Installed CLI tool actually wrote unfinished work before interruption');
        await runtime.cancel({
          ...executionIdentity(f.row()),
          writerGeneration: f.row().writerGeneration,
        });
        await runtime.settle();
        assert.equal(f.row().publication.sequence, before);
        await loseSession();
        return null;
      }
      await settle('AWAITING_USER');
      assert.equal(cliTurns, beforeTurns + 1, 'Duplicate/lost ACK does not replay a CLI turn');
      assert.equal(f.row().publication.sequence, before + 1);
      assert.equal(f.row().recoveryCheckpoint, undefined);
      sessions.add(f.row().publication.nativeSessionId);
      return f.row().publication.nativeSessionId;
    },
    loseSession,
    async finish({ expectedSessions = 3 } = {}) {
      assert.equal(privateCalls, 0);
      assert.equal(
        memory.writes.some((key) => key.startsWith('native-recovery/')),
        false,
      );
      assert.equal(setups, 3, 'No project reinitialization on either fresh session');
      assert.equal(sessions.size, expectedSessions);
      assert.equal(new Set(resumes.map((input) => input.recoveryId)).size, expectedSessions - 1);
      assert.ok(
        resumes.every((input) => !input.text && !input.checkpoint && !input.nativeSessionId),
      );
      for (const request of accepted)
        assert.equal(
          (await f.store.response(f.row(), request.interactionId)).requestId,
          request.requestId,
        );
      await api.cancel(f.prepared, recheck);
      await supervisor(f.identity);
      assert.equal(f.row().status, 'CANCELLED');
      assert.equal(f.row().stopConfirmation.writerGeneration, expectedSessions);
      return {
        publications: f.row().publication.sequence,
        cliTurns,
        sessions: sessions.size,
        privateCalls,
        setups,
      };
    },
    async close() {
      if (runtime.isBusy())
        await runtime.cancel({
          ...executionIdentity(f.row()),
          writerGeneration: f.row().writerGeneration,
        });
      await runtime.settle();
      await fs.rm(homeRoot, { recursive: true, force: true });
    },
  };
}
