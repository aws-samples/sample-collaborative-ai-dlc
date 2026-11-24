// The existing native controller fixture and production runtime/storage owners,
// with installed CLI tools and a scripted loopback provider. No private exporter.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  nativeDraftInputs,
  nativeInputSnapshot,
  nativeInputStorageId,
} from '../lambda/shared/native-inputs.js';
import { attachmentCommittedKey } from '../lambda/shared/intent-attachments.js';
import { attachmentReferences } from '../lambda/agentcore/attachments.js';
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
import { TABLE } from '../lambda/native-runtime-control/test/fixtures.js';
import { createNativeArtifactRevisions } from '../lambda/shared/native-artifact-revision.js';
import { createNativeActivityStore } from '../lambda/native-runtime-control/activity-store.js';
import {
  initiator,
  qualificationMember,
  qualificationMembership,
  competeForQuestion,
} from './native-qualification-member.mjs';
import { protectedWorkspaceEngine } from './native-qualification-protected-engine.mjs';
import { localProviderInvocation } from './native-qualification-provider.mjs';

export async function workspaceQualificationDriver({
  root,
  project,
  pkg,
  provider,
  harness = 'claude',
  model = 'claude-sonnet-4-6',
  dependencyEnv = {},
  protectedWorkflow = false,
  terminalResult = false,
}) {
  const f = executionFixture({
    harness,
    model,
    packageVersion: pkg.version,
    recoveryMode: NATIVE_WORKSPACE_RECOVERY,
    ...(protectedWorkflow && !terminalResult ? { prompt: 'Create a 3D version of the game' } : {}),
  });
  Object.assign(f.prepared, { harness, createdAt: f.now(), updatedAt: f.now() });
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
  const content = [
    { filename: 'uploaded.txt', mimeType: 'text/plain', text: 'NE09 uploaded input witness.' },
    {
      filename: 'tracker-issue.md',
      mimeType: 'text/markdown',
      text: '# NE09 tracker discussion witness.',
    },
    {
      filename: 'tracker-file.csv',
      mimeType: 'text/csv',
      text: 'kind,value\nNE09,tracker attachment witness',
    },
  ];
  const attachments = [];
  for (const [index, file] of content.entries()) {
    const attachmentId = randomUUID();
    const bytes = Buffer.from(file.text);
    const key = attachmentCommittedKey(
      nativeInputStorageId(f.identity),
      attachmentId,
      '.' + file.filename.split('.').at(-1),
    );
    const stored = await storage.s3.send(
      new PutObjectCommand({
        Bucket: storage.bucket,
        Key: key,
        Body: bytes,
        ExpectedBucketOwner: storage.accountId,
      }),
    );
    attachments.push({
      attachmentId,
      filename: file.filename,
      mimeType: file.mimeType,
      size: bytes.length,
      s3Key: key,
      s3VersionId: stored.VersionId,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(index
        ? {
            source: {
              provider: 'jira-cloud',
              bindingId: 'fixture-tracker',
              resourceId: 'FIXTURE-1',
              title: 'Offline input fixture',
              bindingFingerprint: 'a'.repeat(64),
              attachmentId: index === 1 ? 'issue-text' : '123',
            },
          }
        : {}),
    });
  }
  f.prepared.inputDraft = { ...nativeDraftInputs(f.prepared), revision: 1, attachments };
  f.prepared.version += 1;
  const publications = createNativePublications(storage);
  const gitResult = terminalResult
    ? await (
        await import('./native-qualification-git-result.mjs')
      ).qualificationGitResult({
        root,
        project,
        f,
        storage,
        memory,
        publications,
        tableName: TABLE,
      })
    : null;
  const interactions = createNativeInteractions(storage);
  const fence = createNativeExecutionFence(storage);
  const membership = qualificationMembership(f.identity.projectId);
  const engine = protectedWorkflow
    ? await protectedWorkspaceEngine(f, pkg, storage, publications, interactions, membership)
    : null;
  // Keep the fixture transport's RUNTIME row coherent with its prepared read.
  for (const [key, row] of f.rows)
    if (row.sk === 'RUNTIME') f.rows.set(key, structuredClone(f.prepared));
  f.configuration.inputs = nativeInputSnapshot(f.prepared, storage.bucket);
  const api = createNativeExecutionApi({
    enabled: true,
    store: f.store,
    publications,
    interactions,
    revisions: createNativeArtifactRevisions({ ddb: f.ddb, nativeTable: TABLE, publications }),
    activity: createNativeActivityStore({ ddb: f.ddb, tableName: TABLE, now: f.now }),
    completionProof: engine?.completionProof,
    results: gitResult?.results,
    configure: async () => f.configuration,
    enqueue: async () => {},
    authorizeSource: async () => {},
  });
  const member = qualificationMember(f, api, membership, gitResult?.jobs);
  try {
    await assert.rejects(member.request('start', {}, { token: null }), {
      code: 'NATIVE_AUTHORITY_FORBIDDEN',
    });
    const start = {
      requestId: randomUUID(),
      promptRevision: 0,
      inputRevision: f.configuration.inputs.revision,
    };
    assert.equal(
      (await member.request('start', start, { token: 'offline-nonmember', status: 403 })).code,
      'NATIVE_PREPARATION_FORBIDDEN',
    );
    assert.equal(f.row(), undefined);
    await member.request('start', start);
  } catch (error) {
    member.close();
    await gitResult?.close();
    await engine?.close();
    throw error;
  }
  const inputReads = attachmentReferences(attachments).map((file, index) => ({
    path: join(project, file.path),
    expected: content[index].text.split('\n').at(-1),
  }));
  // A later object version must not replace the admitted content, including on
  // fresh CLI sessions. The production materializer receives only pinned versions.
  for (const file of attachments)
    await storage.s3.send(
      new PutObjectCommand({
        Bucket: storage.bucket,
        Key: file.s3Key,
        ExpectedBucketOwner: storage.accountId,
        Body: Buffer.from('Later unselected object version.'),
      }),
    );
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
    NATIVE_INPUT_BUCKET: storage.bucket,
    NATIVE_RUNTIME_ACCOUNT_ID: storage.accountId,
  };
  let setups = 0,
    cliTurns = 0,
    lastHome,
    latestError;
  let resumePending = false,
    loseAck = false,
    first = true;
  const resumes = [],
    accepted = [],
    sessions = new Set();
  const create = () =>
    createNativeExecutor({
      env,
      root,
      homeRoot,
      ...createNativeExecutionPorts({ env, s3: storage.s3 }),
      ...(engine ? { prepareWorkflowEngine: (input) => engine.prepare({ ...input, env }) } : {}),
      inspectMount: async () => ({}), // Local filesystem, NOT AWS EFS proof.
      prepare: async ({ signal }) => {
        const sourceBaseline =
          gitResult && (await gitResult.checkout(executionIdentity(f.row()), signal));
        await fs.mkdir(join(project, '.native-control'), { recursive: true, mode: 0o700 });
        return {
          package: { ...pkg, packageId: f.configuration.packageId },
          repositoryCommit: f.configuration.repository.commit,
          ...(sourceBaseline ? { sourceBaseline } : {}),
          authEnv: { AWS_BEARER_TOKEN_BEDROCK: 'fixture-token' },
        };
      },
      prepareRecovery: async () => ({ package: { ...pkg, packageId: f.configuration.packageId } }),
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
        return runNativeCommand(
          localProviderInvocation(
            harness,
            { ...input, env: { ...input.env, ...engine?.env } },
            provider.url,
          ),
        );
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
      source: { branch: 'main', commit: f.configuration.repository.commit },
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
  let competition;
  const begin = async (prompt, selection, compete, token) => {
    if (resumePending) {
      if (f.row().status === 'AWAITING_USER') {
        // A waiting runtime is idle, not polled as a new workflow turn. The
        // next protected answer detects the expired session and is retained
        // as definitely undelivered; confirmation must not send it.
        const question = await member.request('interaction');
        const request = {
          requestId: randomUUID(),
          interactionId: question.id,
          contentSha256: question.contentSha256,
          text: 'Review the existing gate after waiting.',
        };
        await member.request('response', request);
        accepted.push(request);
      }
      await settle('RECOVERY_REQUIRED');
      const { execution } = await member.request('');
      assert.equal(execution.recovery.canRecover, true);
      const request = { requestId: randomUUID(), recoveryId: execution.recovery.id };
      const before = f.row();
      const refused = await member.request(
        'recover',
        { ...request, confirmWorkspaceResume: false },
        { status: 400 },
      );
      assert.equal(refused.code, 'NATIVE_PREPARATION_INVALID');
      assert.deepEqual(f.row(), before);
      await member.request('recover', { ...request, confirmWorkspaceResume: true });
      loseAck = true;
      resumePending = false;
    } else if (!first) {
      const question = await member.request('interaction', undefined, { token });
      const request = {
        requestId: randomUUID(),
        interactionId: question.id,
        contentSha256: question.contentSha256,
        text: prompt,
        ...(selection ? { selection } : {}),
      };
      if (selection) {
        const before = f.row();
        const stale = await member.request(
          'response',
          { ...request, contentSha256: '0'.repeat(64) },
          { status: 409 },
        );
        assert.equal(stale.code, 'NATIVE_EXECUTION_CONFLICT');
        const invalid = await member.request(
          'response',
          { ...request, text: 'Different option' },
          { status: 400 },
        );
        assert.equal(invalid.code, 'NATIVE_EXECUTION_INVALID');
        assert.deepEqual(f.row(), before);
      }
      if (compete) competition = await competeForQuestion(f, member, question, request);
      else {
        const reply = await member.request('response', request, { token });
        const duplicate = await member.request('response', request, { token });
        assert.equal(duplicate.response.id, reply.response.id);
      }
      accepted.push(request);
    }
    first = false;
  };
  return {
    inputReads,
    get: (route, query, options) => member.request(route, undefined, { query, ...options }),
    competition: () => competition,
    exportResult: gitResult && ((revision) => gitResult.verify(member, revision)),
    revoke: membership.revoke,
    selectedCommand: engine?.selectedCommand,
    interaction: () => member.request('interaction'),
    async turn(
      prompt,
      { interrupt = false, selection, compete = false, token = initiator.token } = {},
    ) {
      const before = f.row().publication?.sequence ?? 0;
      const beforeTurns = cliTurns;
      await begin(prompt, selection, compete, token);
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
      const resume = f.row().workspaceResume;
      const last = resumes.at(-1);
      assert.deepEqual(resume, {
        id: last.recoveryId,
        sequence: last.sequence,
        writerGeneration: last.writerGeneration,
      });
      assert.equal(f.row().writerGeneration, resume.writerGeneration);
      assert.equal(f.row().lastRecoveryId, resume.id);
      await member.request('cancel', {});
      await supervisor(f.identity);
      assert.equal(f.row().status, 'CANCELLED');
      assert.equal(f.row().stopConfirmation.writerGeneration, expectedSessions);
      return {
        publications: f.row().publication.sequence,
        cliTurns,
        resume,
        sessions: sessions.size,
        setups,
        inputs: {
          files: attachments.length,
          uploaded: 1,
          trackerText: 1,
          trackerFiles: 1,
          version: f.row().configuration.inputs.revision,
          latestVersionsIgnored: true,
          contentSha256: f.row().configuration.inputs.contentSha256,
        },
      };
    },
    async close() {
      member.close();
      await gitResult?.close();
      if (runtime.isBusy())
        await runtime.cancel({
          ...executionIdentity(f.row()),
          writerGeneration: f.row().writerGeneration,
        });
      await runtime.settle();
      await engine?.close();
      await fs.rm(homeRoot, { recursive: true, force: true });
      await fs.chmod(join(project, '.aidlc/references'), 0o755).catch(() => {});
    },
  };
}
