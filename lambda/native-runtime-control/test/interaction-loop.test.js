import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { expect, it, vi } from 'vitest';
import { createNativeExecutor } from '../../agentcore/native/executor.js';
import { runNativeCommand } from '../../agentcore/native/command-runner.js';
import { createNativePublications } from '../../shared/native-publication.js';
import { createNativeInteractions } from '../../shared/native-interaction.js';
import { createNativeExecutionSupervisor } from '../execution-worker.js';
import { createNativeExecutionApi } from '../execution-api.js';
import { executionIdentity } from '../execution-runtime.js';
import { executionFixture } from './execution-fixtures.js';
import { ACTOR } from './fixtures.js';

// This composes the production runtime, supervisor, store, API and immutable
// storage validators. Only external AWS/model/initialization ports are fakes.
// The inert harness is a real subprocess with a large tool event before its
// ordered composer messages. It performs no network or model invocation.
it.each([false, true])('native interaction cycle (structured: %s)', async (structured) => {
  const f = executionFixture();
  const temp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-interaction-loop-')));
  const root = join(temp, 'mount');
  const homeRoot = join(temp, 'homes');
  await fs.mkdir(root, { mode: 0o700 });
  const script = join(temp, 'inert-harness.mjs');
  await fs.writeFile(
    script,
    `
    import * as fs from 'node:fs/promises';
    let input = '';
    for await (const part of process.stdin) input += part.toString();
    const turn = Number(process.argv[2]);
    if (${structured}) {
      // Deterministic engine stand-in: consume the delivered choice, revise,
      // and only mark the stage applied on the subsequent approval turn.
      if (turn === 2 && input !== 'Request Changes\\n\\nAdd an accessibility check.') throw Error('Wrong revision answer');
      if (turn === 3 && input !== 'Approve') throw Error('Wrong approval answer');
      const dir = 'aidlc/spaces/default/intents/pipes';
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile('aidlc/active-space', 'default\\n');
      await fs.writeFile('aidlc/spaces/default/intents/active-intent', 'pipes\\n');
      await fs.writeFile(dir + '/aidlc-state.md',
        '- **Current Stage**: requirements-analysis\\n- [' + (turn === 3 ? 'x' : '?') + '] requirements-analysis — EXECUTE\\n');
      await fs.writeFile(dir + '/plan.md', turn === 1 ? 'Original plan\\n' : 'Revised plan: accessibility check\\n');
      if (turn < 3) await fs.writeFile('.native-control/pending-question.json', JSON.stringify({
        version: 1,
        questions: [{
          prompt: 'How should the requirements proceed?',
          options: [{ label: 'Approve' }, { label: 'Request Changes' }],
        }],
      }));
    }
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'composer-session' }));
    console.log(JSON.stringify({ type: 'turn.started' }));
    console.log(JSON.stringify({
      type: 'item.completed',
      item: { type: 'command_execution', aggregated_output: 'unretained tool output'.repeat(20000) },
    }));
    const texts = ${structured} && turn === 3 ? ['Approval applied by the deterministic fixture.'] : turn === 1
      ? ['| Stage | Purpose |\\n|---|---|\\n| Design | Improve the pipes |',
         'Would you like to approve or edit this workflow?']
      : ['Which pipe appearance should the design use?'];
    if (${structured} && turn < 3) texts.push('Approve / Request Changes');
    for (const [index, text] of texts.entries()) console.log(JSON.stringify({
      type: 'item.completed', item: { id: 'message-' + index, type: 'agent_message', text },
    }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
  `,
  );
  const objects = new Map();
  let version = 0;
  const s3 = {
    send: vi.fn(async (command) => {
      const p = command.input;
      expect(p.Bucket).toBe(f.configuration.publicationBucket);
      expect(p.ExpectedBucketOwner).toBe(f.configuration.accountId);
      if (command instanceof PutObjectCommand) {
        const VersionId = `version-${++version}`;
        objects.set(`${p.Key}\0${VersionId}`, Buffer.from(p.Body));
        return { VersionId };
      }
      expect(command).toBeInstanceOf(GetObjectCommand);
      const bytes = objects.get(`${p.Key}\0${p.VersionId}`);
      if (!bytes) throw new Error('Missing immutable object version');
      return {
        VersionId: p.VersionId,
        ContentLength: bytes.length,
        Body: Readable.from([bytes]),
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
  const cleanCommand = {
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
  const commandRunner = vi.fn(async (input) => {
    if (input.timeoutMs !== null) return cleanCommand;
    modelTurns++;
    return runNativeCommand({
      ...input,
      command: process.execPath,
      args: [script, String(modelTurns)],
      stdoutBytes: 2048,
    });
  });
  const prepare = vi.fn(async ({ project }) => {
    const directory = join(root, 'packages');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(join(directory, 'aidlc'), 'inert-package');
    await fs.writeFile(join(project, 'index.html'), '<h1>Original code</h1>\r\n');
    return {
      package: {
        directory,
        binaryPath: join(directory, 'aidlc'),
        version: '2.9.0',
        packageId: f.configuration.packageId,
      },
      repositoryCommit: 'c'.repeat(40),
      authEnv: { AWS_BEARER_TOKEN_BEDROCK: 'fixture-model-credential' },
    };
  });
  const runtime = createNativeExecutor({
    env: {
      NATIVE_RUNTIME_MODE: 'isolated',
      NATIVE_RUNTIME_PROJECT_ID: f.identity.projectId,
      NATIVE_RUNTIME_EXECUTION_ID: f.identity.executionId,
      NATIVE_RUNTIME_BINDING_ID: f.prepared.bindingId,
    },
    root,
    homeRoot,
    prepare,
    commandRunner,
    inspectMount: async () => ({}),
    inspectInitialization: async () => ({ ok: true }),
    prepareContinuation: async () => ({
      authEnv: { AWS_BEARER_TOKEN_BEDROCK: 'fixture-model-credential' },
      forbiddenBytes: ['fixture-model-credential'],
    }),
    publish: async ({ signal: _signal, ...input }) => ({
      uploaded: true,
      receipt: await publications.write(input),
    }),
    publishInteraction: ({ signal: _signal, ...input }) => interactions.write(input),
  });
  const credentials = vi.fn(async (row) => ({
    ok: true,
    ...executionIdentity(row),
    model: { provider: 'bedrock', value: 'fixture-model-credential' },
    git: { username: 'fixture', password: 'fixture-git-credential' },
    source: { branch: 'main', commit: 'c'.repeat(40) },
  }));
  let loseContinuationAck = false;
  const invoke = vi.fn(async ({ payload }) => {
    const method = {
      'native-start': 'start',
      'native-status': 'status',
      'native-continue': 'continue',
    }[payload.command];
    const result = await runtime[method](payload);
    if (payload.command === 'native-continue' && loseContinuationAck) {
      loseContinuationAck = false;
      throw new Error('Acknowledgement lost after runtime acceptance');
    }
    return result;
  });
  const project = vi.fn(async () => {});
  const supervisor = createNativeExecutionSupervisor({
    store: f.store,
    preparationStore: f.preparationStore,
    now: f.now,
    upgrade: async ({ execution }) => ({ ready: true, target: f.target(execution) }),
    authorize: async () => {},
    credentials,
    invoke,
    publications,
    interactions,
    project,
    stop: async () => {},
    fence: {
      ensureActive: async () => ({ state: 'ACTIVE' }),
      cancel: async () => ({ state: 'CANCELLED' }),
    },
  });
  const recheck = vi.fn(async () => {});
  const api = createNativeExecutionApi({
    enabled: true,
    store: f.store,
    configure: async () => f.configuration,
    publications,
    interactions,
    enqueue: async () => {},
    authorizeSource: async () => {},
  });
  try {
    await f.start();
    for (let i = 0; i < 4; i++) await supervisor(f.identity);
    expect(f.row().status).toBe('RUNNING');
    await runtime.settle();
    expect((await runtime.status(executionIdentity(f.row()))).status).toBe('publication_ready');
    await supervisor(f.identity);
    expect(f.row().status).toBe('AWAITING_USER');
    await supervisor(f.identity);
    const firstRow = f.row();
    const first = await api.interaction(f.prepared, recheck);
    expect(first.messages).toEqual([
      { type: 'text', text: '| Stage | Purpose |\n|---|---|\n| Design | Improve the pipes |' },
      { type: 'text', text: 'Would you like to approve or edit this workflow?' },
      ...(structured ? [{ type: 'text', text: 'Approve / Request Changes' }] : []),
    ]);
    expect(firstRow.publication.question).toBeNull();
    expect(firstRow.publication.outcome).toBe('STOPPED');
    expect(firstRow.interaction.publicationId).toBe(firstRow.publication.id);
    expect((await api.publication(f.prepared, recheck)).files.map((file) => file.path)).toContain(
      'index.html',
    );
    const reply = {
      requestId: randomUUID(),
      interactionId: first.id,
      contentSha256: first.contentSha256,
      text: structured
        ? 'Request Changes\n\nAdd an accessibility check.'
        : 'Please edit the workflow to include an accessibility check.\r\n',
      ...(structured
        ? {
            selection: {
              answers: [{ selectedOptions: [1], freeText: 'Add an accessibility check.' }],
            },
          }
        : {}),
    };
    if (structured)
      expect(first.pendingInput).toMatchObject({
        kind: 'approval',
        stage: 'requirements-analysis',
      });
    const accepted = await api.respond(f.prepared, ACTOR, reply, recheck);
    expect(accepted.response.text).toBe(reply.text);
    expect(accepted.response.actorId).toBe(ACTOR);
    expect(accepted.response.deliveryStatus).toBe('pending');
    expect(modelTurns).toBe(1); // Acceptance itself did not run/apply the choice.
    const duplicate = await api.respond(f.prepared, ACTOR, reply, recheck);
    expect(duplicate.response.id).toBe(accepted.response.id);
    await expect(
      api.respond(
        f.prepared,
        ACTOR,
        {
          ...reply,
          requestId: randomUUID(),
          text: 'Competing reply',
        },
        recheck,
      ),
    ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_CONFLICT' });

    loseContinuationAck = true;
    await expect(supervisor(f.identity)).rejects.toBeTruthy();
    // Simulate queue delivery after the lost acknowledgement and lease expiry.
    f.tick();
    await supervisor(f.identity);
    await runtime.settle();
    await supervisor(f.identity);
    await supervisor(f.identity);
    const secondRow = f.row();
    expect(secondRow.status).toBe('AWAITING_USER');
    expect(secondRow.publication.sequence).toBe(2);
    expect(secondRow.epoch).toBe(firstRow.epoch);
    expect(secondRow.attemptId).toBe(firstRow.attemptId);
    expect(secondRow.runtimeSessionId).toBe(firstRow.runtimeSessionId);
    expect(secondRow.publication.nativeSessionId).toBe('composer-session');
    expect(secondRow.publication.id).not.toBe(firstRow.publication.id);
    expect(modelTurns).toBe(2);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect((await api.interaction(f.prepared, recheck)).messages).toEqual([
      { type: 'text', text: 'Which pipe appearance should the design use?' },
      ...(structured ? [{ type: 'text', text: 'Approve / Request Changes' }] : []),
    ]);
    const calls = commandRunner.mock.calls.filter(([call]) => call.timeoutMs === null);
    expect(calls[0][0].stdin).toContain(f.prepared.request.prompt);
    expect(calls[1][0].stdin).toBe(reply.text);
    expect(calls[1][0].args.slice(0, 3)).toEqual(['exec', 'resume', 'composer-session']);
    expect(
      await interactions.read(executionIdentity(firstRow), firstRow.interaction),
    ).toMatchObject({
      sequence: 1,
      messages: first.messages,
    });
    expect(JSON.stringify([...objects.values()].map((b) => b.toString()))).not.toContain(
      'fixture-model-credential',
    );
    // A retry remains associated with its original interaction after turn two.
    expect((await api.respond(f.prepared, ACTOR, reply, recheck)).response.id).toBe(
      accepted.response.id,
    );
    expect(modelTurns).toBe(2);
    if (structured) {
      const second = await api.interaction(f.prepared, recheck);
      expect(second.pendingInput.kind).toBe('approval');
      expect(second.contentSha256).not.toBe(first.contentSha256);
      const approval = {
        requestId: randomUUID(),
        interactionId: second.id,
        contentSha256: second.contentSha256,
        text: 'Approve',
        selection: { answers: [{ selectedOptions: [0] }] },
      };
      await expect(
        api.respond(
          f.prepared,
          'second-member',
          {
            ...approval,
            contentSha256: first.contentSha256,
          },
          recheck,
        ),
      ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_CONFLICT' });
      const competingApproval = { ...approval, requestId: randomUUID() };
      const outcomes = await Promise.allSettled([
        api.respond(f.prepared, 'second-member', approval, recheck),
        api.respond(f.prepared, ACTOR, competingApproval, recheck),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.find((outcome) => outcome.status === 'rejected').reason.code).toBe(
        'NATIVE_EXECUTION_CONFLICT',
      );
      const winner = outcomes.find((outcome) => outcome.status === 'fulfilled').value.response;
      expect(winner.deliveryStatus).toBe('pending');
      expect(modelTurns).toBe(2);
      await supervisor(f.identity);
      await runtime.settle();
      await supervisor(f.identity);
      await supervisor(f.identity);
      expect(modelTurns).toBe(3);
      const applied = await api.interaction(f.prepared, recheck);
      expect(applied.pendingInput).toBeNull();
      const publication = await api.publication(f.prepared, recheck);
      const stateFile = publication.files.find((file) => file.path.endsWith('/aidlc-state.md'));
      expect((await api.file(f.prepared, stateFile.id, recheck)).content).toContain(
        '[x] requirements-analysis',
      );
      expect((await f.store.response(f.row(), first.id)).text).toBe(reply.text);
      expect((await f.store.response(f.row(), second.id)).text).toBe('Approve');
      const winningRequest = winner.actorId === 'second-member' ? approval : competingApproval;
      expect(
        (await api.respond(f.prepared, winner.actorId, winningRequest, recheck)).response.id,
      ).toBe(winner.id);
      expect(modelTurns).toBe(3);
    }
  } finally {
    if (runtime.isBusy()) await runtime.cancel(executionIdentity(f.row()));
    await runtime.settle();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
