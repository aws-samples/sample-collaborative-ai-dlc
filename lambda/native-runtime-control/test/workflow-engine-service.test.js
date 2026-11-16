// The protected service with the production execution store, engine journal,
// immutable object codecs and proof reader over the shared in-memory authority
// table. Only the pinned Bun engine process and its private workspace are
// scripted: they exist in the qualified image, not on a test host. The
// journal's DynamoDB behaviour has its own container-backed integration test.
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createNativeEngineStore, nativeEngineIdentity } from '../workflow-engine/store.js';
import { createNativeWorkflowEngine } from '../workflow-engine/service.js';
import { createNativeEngineProofReader } from '../workflow-engine/proof-reader.js';
import { createNativeExecutionApi } from '../execution-api.js';
import { createNativeArtifactRevisions } from '../../shared/native-artifact-revision.js';
import { nativeProjectionStatus } from '../projection-store.js';
import { createNativeEngineObjects } from '../../shared/native-workflow-objects.js';
import {
  NATIVE_ENGINE_PROFILE,
  encodeNativeEngineFiles,
  engineDigest,
  engineFailure,
  nativeEngineArn,
  nativeEngineFileDigest,
  nativeEngineFiles,
} from '../../shared/native-workflow-protocol.js';
import { buildNativePendingInput, nativeAnswerText } from '../../shared/native-pending-input.js';
import { serialFixture } from './execution-serial-fixtures.js';
import { TABLE } from './fixtures.js';

const STATE_FILE = 'aidlc/spaces/default/intents/fixture/aidlc-state.md';
const json = (value) => ({
  exitCode: 0,
  stdout: Buffer.from(JSON.stringify(value)),
  stderr: Buffer.alloc(0),
});
const flag = (args, name) => args[args.indexOf(name) + 1];

const setup = async () => {
  const f = serialFixture();
  const pin = {
    profileId: NATIVE_ENGINE_PROFILE.id,
    producerSha256: f.configuration.image.digest.slice(7),
    functionArn: `arn:aws:lambda:us-east-1:${f.configuration.accountId}:function:native-workflow`,
    version: '7',
  };
  f.configuration.packageId = NATIVE_ENGINE_PROFILE.packageId;
  f.configuration.workflowEngine = pin;
  f.prepared.candidate.packagePin.packageId = NATIVE_ENGINE_PROFILE.packageId;
  await f.ready();
  const ddb = f.ddb;
  const tableName = TABLE;
  const execution = f.store;
  const journal = createNativeEngineStore({
    ddb,
    tableName,
    readExecution: execution.get,
    now: f.now,
  });
  const stored = new Map();
  let version = 0;
  const s3 = {
    async send(command) {
      const input = command.input;
      if (command.constructor.name === 'PutObjectCommand') {
        const VersionId = `engine-${++version}`;
        stored.set(`${input.Key}\0${VersionId}`, Buffer.from(input.Body));
        return { VersionId };
      }
      const bytes = stored.get(`${input.Key}\0${input.VersionId}`);
      if (!bytes) throw new Error('Unknown immutable object version');
      return {
        VersionId: input.VersionId,
        ContentLength: bytes.length,
        Body: Readable.from([bytes]),
      };
    },
  };
  const objects = createNativeEngineObjects({
    s3,
    bucket: f.configuration.publicationBucket,
    accountId: f.configuration.accountId,
  });

  // A scripted stand-in for the pinned engine: one gated stage with one check.
  const calls = [];
  const hooks = {};
  const access = { allowed: true };
  let current;
  const sha = (event) => engineDigest(JSON.stringify(event));
  const emit = (engine, event) => {
    const value = { unit: null, ...event, index: engine.audit.length };
    engine.audit.push({ ...value, sha256: sha(value) });
  };
  const stateBytes = (engine) =>
    Buffer.from(`Status: ${engine.status}\nbuild: ${engine.box}\nevents: ${engine.audit.length}\n`);
  const workspaceFactory = async ({ snapshot }) => {
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
          requirements: [],
          unownedPublic: [],
          sourceSettings: null,
          terminalResult: null,
          engine: { status: null, box: 'pending', audit: [], messages: 0 },
        };
    let authored = snapshot ? nativeEngineFiles(snapshot.project) : [];
    const publicFiles = async () =>
      nativeEngineFiles(
        encodeNativeEngineFiles([
          ...authored.filter((file) => file.path !== STATE_FILE),
          ...(state.engine.status ? [{ path: STATE_FILE, content: stateBytes(state.engine) }] : []),
        ]),
      );
    current = {
      project: '/tmp/native-workflow-engine/project',
      home: '/tmp/native-workflow-engine/home',
      engine: { installation: '/tmp/native-workflow-engine/project/.codex' },
      state,
      async initializeSettings(settings, commit) {
        state.sourceSettings = { commit, filesSha256: settings.filesSha256, files: [] };
      },
      async importAuthored(input) {
        authored = nativeEngineFiles(input);
        return nativeEngineFileDigest(authored);
      },
      publicFiles,
      async inspectCheck({ outputPath }) {
        const files = await publicFiles();
        const inspected = files.filter((file) => file.path.startsWith(`${outputPath}/`));
        return {
          checkedPath: outputPath,
          checkedSha256: nativeEngineFileDigest(inspected),
          sourceSha256: null,
          filesSha256: nativeEngineFileDigest(files),
        };
      },
      async snapshot() {
        return {
          schemaVersion: 1,
          state,
          project: encodeNativeEngineFiles(authored),
          home: [],
        };
      },
      close: async () => {},
    };
    return current;
  };
  const directive = {
    kind: 'run-stage',
    stage: 'build',
    gate: true,
    reviewer: null,
    review_class: 'none',
    sensors_applicable: ['unit-tests'],
  };
  const runnerFactory = async ({ external, inspectCheck }) => {
    const { state } = current;
    const engine = state.engine;
    const observations = [];
    const orchestrate = async (args) => {
      if (args[0] === 'next' && args[1] === '--') {
        engine.status = 'In Progress';
        engine.box = 'in-progress';
        emit(engine, { event: 'WORKFLOW_STARTED', stage: null });
        return json(directive);
      }
      if (args[0] === 'next')
        return json(engine.status === 'Completed' ? { kind: 'done' } : directive);
      const result = flag(args, '--result');
      if (result === 'awaiting-approval') {
        engine.box = 'awaiting-approval';
        return json({ recorded: true });
      }
      if (result === 'approved') {
        emit(engine, {
          event: 'GATE_APPROVED',
          stage: 'build',
          userInputSha256: engineDigest(flag(args, '--user-input')),
        });
        engine.box = 'completed';
        engine.status = 'Completed';
        emit(engine, { event: 'WORKFLOW_COMPLETED', stage: null });
        return json({ kind: 'done' });
      }
      return { exitCode: 2, stdout: Buffer.alloc(0), stderr: Buffer.from('unsupported') };
    };
    const fire = async () => {
      const receipt = {
        sensor: 'unit-tests',
        stage: 'build',
        unit: null,
        fireId: 'a1b2c3d4',
        outputPath: 'src',
      };
      const inspected = await inspectCheck(receipt);
      const value = await external({
        command: 'npm',
        args: ['test'],
        cwd: current.project,
        input: null,
        origin: 'tools/aidlc-sensor.ts',
        timeoutMs: 1000,
      });
      observations.push({
        origin: 'tools/aidlc-sensor.ts',
        command: 'npm',
        exitCode: value.exitCode,
        observation: {
          kind: 'check',
          invocation: 'protected-engine',
          ...value.observation,
          ...receipt,
          ...inspected,
        },
      });
      emit(engine, {
        event: value.exitCode === 0 ? 'SENSOR_PASSED' : 'SENSOR_FAILED',
        stage: 'build',
        sensor: 'unit-tests',
        fireId: receipt.fireId,
        outputPath: receipt.outputPath,
      });
      return json({ fired: true });
    };
    return {
      observations,
      refusals: [],
      async tool(name, args) {
        calls.push([name, ...args]);
        await hooks.tool?.(name, args);
        if (name === 'aidlc-orchestrate.ts') return orchestrate(args);
        if (name === 'aidlc-sensor.ts') return fire();
        return { exitCode: 2, stdout: Buffer.alloc(0), stderr: Buffer.from('unsupported') };
      },
      async observe() {
        if (!engine.status) return json({ status: 'not_started', effectivePlan: null, audit: [] });
        return json({
          status: 'recorded',
          workflow: {
            status: engine.status,
            currentStage: 'build',
            recordPath: 'aidlc/spaces/default/intents/fixture',
            stateSha256: engineDigest(stateBytes(engine)),
          },
          effectivePlan: {
            scope: 'express',
            name: null,
            stages: [
              {
                id: 'build',
                phase: 'construction',
                action: 'EXECUTE',
                state: engine.box,
                review: { role: null, class: 'none' },
                sensors: ['unit-tests'],
              },
            ],
            ceremony: {},
          },
          audit: engine.audit,
          reviews: [],
          protectedQuestion: null,
        });
      },
      async member(decision) {
        const messageId = `message-${++engine.messages}`;
        return json({
          status: 'recorded',
          commandId: decision.commandId,
          actorId: decision.actorId,
          messageId,
          at: '2026-11-12T00:00:00.000Z',
          application: 'pending',
        });
      },
      hook: async () => json({}),
    };
  };
  const jobs = { check: async () => ({ exitCode: 0 }) };
  const handler = createNativeWorkflowEngine({
    executionStore: execution,
    preparationStore: f.preparationStore,
    journal,
    objects,
    publications: f.publications,
    interactions: f.interactions,
    authorizeAccess: async () => {
      if (!access.allowed) throw engineFailure('NATIVE_ENGINE_FORBIDDEN');
    },
    loadArchive: async () => Buffer.from('pinned archive'),
    loadSettings: async ({ row }) => ({
      schemaVersion: 1,
      commit: row.configuration.repository.commit,
      files: [],
      filesSha256: nativeEngineFileDigest([]),
    }),
    jobsFactory: () => ({
      check: async (request) => {
        const value = await jobs.check(request);
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          observation: {
            kind: 'check',
            jobId: randomUUID(),
            buildId: 'native-workflow-job:fixture-build',
          },
          ...value,
        };
      },
      review: async () => {
        throw new Error('This plan requires no reviewer');
      },
    }),
    env: {
      NATIVE_WORKFLOW_ENGINE_ARN: pin.functionArn,
      NATIVE_WORKFLOW_ENGINE_SHA256: pin.producerSha256,
    },
    workspaceFactory,
    runnerFactory,
    gitFactory: () => ({ initialize: async () => {}, metadata: async () => null }),
  });

  const row = () => execution.get(f.identity);
  const identity = async () => {
    const { configurationSha256: _configuration, ...value } = nativeEngineIdentity(await row());
    return value;
  };
  const alias = async () =>
    nativeEngineArn({ ...f.identity, bindingId: (await row()).bindingId }, pin);
  const context = async (overrides = {}) => ({
    invokedFunctionArn: await alias(),
    functionVersion: pin.version,
    getRemainingTimeInMillis: () => 900_000,
    ...overrides,
  });
  // The coding workspace as the runtime client sees it.
  const project = new Map([['README.md', Buffer.from('A finite fixture.\n')]]);
  const files = () => [...project].map(([path, content]) => ({ path, content }));
  const request = async (action, extra = {}) => {
    const current = await identity();
    const status = await handler(
      { schemaVersion: 1, identity: current, action: 'status' },
      await context(),
    );
    const requestId = randomUUID();
    const body = {
      schemaVersion: 1,
      identity: current,
      action,
      requestId,
      expectedVersion: status.version,
    };
    if (action === 'finalize') Object.assign(body, extra);
    else {
      const encoded = encodeNativeEngineFiles(files());
      body.input = await objects.write(
        current,
        requestId,
        'files',
        { schemaVersion: 1, files: encoded, filesSha256: nativeEngineFileDigest(encoded) },
        'input',
      );
      body.args = extra.args ?? [];
    }
    return body;
  };
  const send = async (body, overrides) => {
    const response = await handler(body, await context(overrides));
    const result = response.result
      ? await objects.read(body.identity, response.result, 'output')
      : null;
    for (const patch of result?.patches ?? [])
      project.set(patch.path, Buffer.from(patch.after.content, 'base64'));
    return { response, result };
  };
  const command = async (args) => send(await request('execute', { args }));
  const publish = async (pendingInput) => {
    const mirrored = await send(await request('mirror'));
    expect(mirrored.result.exitCode).toBe(0);
    const sequence = (await row()).turnSequence;
    const produced = await f.turn(sequence, {
      files: files().map((file) => ({
        ...file,
        role: file.path.startsWith('aidlc/') ? 'artifact' : 'code',
      })),
      ...(pendingInput ? { pendingInput } : {}),
    });
    const finalized = await send(
      await request('finalize', {
        publication: produced.receipt,
        interaction: produced.interactionReceipt,
      }),
    );
    return { ...produced, finalized };
  };
  const admit = async (produced) => {
    const claim = await execution.claim(f.bindingIdentity);
    const published = await execution.publish({
      row: claim.row,
      publication: produced.receipt,
      interaction: produced.interactionReceipt,
      interactionContentSha256: produced.body.contentSha256,
    });
    return execution.release({ row: published });
  };
  const proofReader = createNativeEngineProofReader({ ddb, tableName, objects });
  // The member read path, wired as command-service.js wires it.
  const api = createNativeExecutionApi({
    enabled: true,
    store: execution,
    projectionStatus: (value) => nativeProjectionStatus(ddb, tableName, value),
    publications: f.publications,
    revisions: createNativeArtifactRevisions({
      ddb,
      nativeTable: tableName,
      publications: f.publications,
    }),
    interactions: f.interactions,
    completionProof: proofReader,
    enqueue: async () => {},
    configure: async () => f.configuration,
    authorizeSource: async () => {},
    recheck: f.recheck,
  });
  const view = (produced, evidence = true) =>
    api.revision(
      f.prepared,
      {
        publicationId: produced.receipt.id,
        publicationSequence: produced.receipt.sequence,
        ...(evidence ? { evidence: true } : {}),
      },
      f.recheck,
    );
  const proof = async (produced, turn) => {
    const current = await row();
    const manifest = await f.publications.read(
      { ...f.identity, attemptId: current.attemptId, epoch: turn?.epoch ?? current.epoch },
      produced.receipt,
    );
    return proofReader({
      row: current,
      found: {
        identity: { attemptId: current.attemptId, epoch: turn?.epoch ?? current.epoch },
        receipt: produced.receipt,
      },
      manifest,
    });
  };
  return {
    f,
    pin,
    execution,
    journal,
    handler,
    calls,
    hooks,
    access,
    jobs,
    project,
    row,
    identity,
    context,
    request,
    send,
    command,
    publish,
    admit,
    proof,
    view,
    close: async () => {},
  };
};

const gate = () =>
  buildNativePendingInput({
    gate: { stage: 'build' },
    spec: {
      version: 2,
      questions: [
        {
          prompt: 'build complete. How would you like to proceed?',
          options: [{ label: 'Approve' }, { label: 'Request Changes' }],
        },
      ],
    },
  });
const toGate = async (t) => {
  expect(JSON.parse((await t.command([])).result.stdout)).toMatchObject({ kind: 'run-stage' });
  t.project.set('src/app.js', Buffer.from('export const answer = 42;\n'));
  expect((await t.command(['engine', 'sensor', 'fire', '--stage', 'build'])).result.exitCode).toBe(
    0,
  );
  const reported = await t.command([
    'engine',
    'orchestrate',
    'report',
    '--stage',
    'build',
    '--result',
    'awaiting-approval',
  ]);
  expect(reported.result.exitCode).toBe(0);
  return t.publish(gate());
};
const approve = async (t, opened) => {
  await t.admit(opened);
  const selection = { answers: [{ selectedOptions: [0] }] };
  await t.execution.respond({
    ...t.f.bindingIdentity,
    actorId: 'responding-member',
    request: {
      requestId: randomUUID(),
      interactionId: opened.interactionReceipt.id,
      contentSha256: opened.body.contentSha256,
      text: nativeAnswerText(gate(), selection),
      selection,
    },
  });
  const claim = await t.execution.claim(t.f.bindingIdentity);
  await t.execution.release({ row: await t.execution.dispatched({ row: claim.row }) });
};

describe('protected workflow engine service', () => {
  it('reports completion only from applied gates, observed checks and the exact published files', async () => {
    const t = await setup();
    try {
      const opened = await toGate(t);
      // A stopped turn waiting at its own gate is published, never complete.
      const waiting = await t.proof(opened);
      expect(waiting).toMatchObject({
        workflowCompletion: 'not_verified',
        reason: 'required_evidence_incomplete',
        requiredChecks: 'passed',
        humanApproval: 'incomplete',
        terminalOutcome: null,
      });
      expect(waiting.checks).toMatchObject([
        { stage: 'build', sensor: 'unit-tests', status: 'passed', buildId: expect.any(String) },
      ]);
      // The coding process cannot approve its own gate or finish the workflow.
      const forged = await t.command([
        'engine',
        'orchestrate',
        'report',
        '--stage',
        'build',
        '--result',
        'approved',
      ]);
      expect(forged.result).toMatchObject({ exitCode: 1, failure: 'NATIVE_ENGINE_COMMAND_DENIED' });

      await approve(t, opened);
      // An accepted selection alone changes nothing until the engine applies it.
      expect((await t.proof(opened)).workflowCompletion).toBe('not_verified');
      const applied = await t.request('execute', { args: ['next'] });
      const before = t.calls.length;
      const first = await t.send(applied);
      expect(JSON.parse(first.result.stdout)).toEqual({ kind: 'done' });
      expect(t.calls.at(-1)).toEqual([
        'aidlc-orchestrate.ts',
        'report',
        '--stage',
        'build',
        '--result',
        'approved',
        '--user-input',
        'Approve',
      ]);
      // A lost acknowledgement is answered from the journal, not by rerunning.
      const ran = t.calls.length;
      expect(ran).toBe(before + 1);
      const replayed = await t.send(applied);
      expect(replayed.response).toEqual(first.response);
      expect(t.calls).toHaveLength(ran);
      await expect(t.send({ ...applied, args: ['engine', 'state', 'get'] })).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_REQUEST_CONFLICT',
      });

      const completed = await t.publish();
      const evidence = await t.proof(completed);
      expect(evidence).toMatchObject({
        workflowCompletion: 'complete',
        reason: 'protected_engine_completed',
        requiredChecks: 'passed',
        finalReview: 'not_required',
        humanApproval: 'applied',
        publicationId: completed.receipt.id,
        terminalOutcome: { event: 'WORKFLOW_COMPLETED', status: 'Completed' },
      });
      expect(evidence.engineApplication).toMatchObject([
        { actorId: 'responding-member', application: 'applied', effect: 'GATE_APPROVED' },
      ]);
      expect(evidence.gates).toMatchObject([{ stage: 'build', status: 'applied' }]);
      // The earlier revision keeps its own outcome.
      expect((await t.proof(opened)).workflowCompletion).toBe('not_verified');

      // Bytes changed after the terminal outcome never inherit verification.
      t.project.set('src/app.js', Buffer.from('export const answer = 43;\n'));
      const changed = await t.publish();
      expect(await t.proof(changed)).toMatchObject({
        workflowCompletion: 'not_verified',
        reason: 'result_files_changed',
      });
      expect((await t.proof(completed)).workflowCompletion).toBe('complete');

      // Members read the same outcomes through the revision API.
      await t.admit(completed);
      expect(await t.view(completed)).toMatchObject({
        workflowCompletion: 'complete',
        reason: 'protected_engine_completed',
        policy: 'pinned_workflow',
        policyStatus: 'protected_engine',
        requirementsStatus: 'captured',
        requiredChecks: 'passed',
        humanApproval: 'applied',
        effectivePlan: { scope: 'express', stages: [{ id: 'build', state: 'completed' }] },
        engineApplication: [{ application: 'applied', effect: 'GATE_APPROVED' }],
        terminalOutcome: { event: 'WORKFLOW_COMPLETED', status: 'Completed' },
        producer: { profileId: NATIVE_ENGINE_PROFILE.id, functionVersion: t.pin.version },
        filesSha256: evidence.filesSha256,
        checks: [{ sensor: 'unit-tests', status: 'passed' }],
        gates: [{ stage: 'build', status: 'applied' }],
      });
      expect((await t.view(completed, false)).verification).toMatchObject({
        workflowCompletion: 'complete',
        publicationId: completed.receipt.id,
      });
      expect(await t.view(opened)).toMatchObject({
        workflowCompletion: 'not_verified',
        policyStatus: 'protected_engine',
        humanApproval: 'incomplete',
        terminalOutcome: 'not_recorded',
      });
      // Access is still checked for every read.
      t.f.authorization.member = false;
      await expect(t.view(completed)).rejects.toMatchObject({
        code: 'NATIVE_PREPARATION_FORBIDDEN',
      });
    } finally {
      await t.close();
    }
  });

  it('applies a gate only from the answer to a recorded question, never from an approval typed as a written reply', async () => {
    const t = await setup();
    try {
      expect(JSON.parse((await t.command([])).result.stdout)).toMatchObject({ kind: 'run-stage' });
      t.project.set('src/app.js', Buffer.from('export const answer = 42;\n'));
      expect(
        (await t.command(['engine', 'sensor', 'fire', '--stage', 'build'])).result.exitCode,
      ).toBe(0);
      const report = (result, ...rest) => [
        'engine',
        'orchestrate',
        'report',
        '--stage',
        'build',
        '--result',
        result,
        ...rest,
      ];
      expect((await t.command(report('awaiting-approval'))).result.exitCode).toBe(0);
      // The agent ends its turn at the gate in prose: no question was recorded.
      const prose = await t.publish();
      expect(prose.body.pendingInput).toBeUndefined();
      expect((await t.proof(prose)).workflowCompletion).toBe('not_verified');
      await t.admit(prose);
      // The application still accepts a written reply to that turn.
      const accepted = await t.f.api.respond(
        t.f.prepared,
        'responding-member',
        {
          requestId: randomUUID(),
          interactionId: prose.interactionReceipt.id,
          contentSha256: prose.body.contentSha256,
          text: 'Approve',
        },
        t.f.recheck,
      );
      expect(accepted.response).toMatchObject({ kind: 'user_reply', text: 'Approve' });
      const deliver = async () => {
        const claim = await t.execution.claim(t.f.bindingIdentity);
        await t.execution.release({ row: await t.execution.dispatched({ row: claim.row }) });
      };
      await deliver();
      // It names no question the engine recorded, so it approves nothing.
      const typed = await t.command(report('approved', '--user-input', 'Approve'));
      expect(typed.result.exitCode).toBe(1);
      expect(typed.result.failure).toMatch(/^NATIVE_ENGINE_(DECISION_MISMATCH|COMMAND_DENIED)$/);
      expect(t.calls.some((call) => call.includes('approved'))).toBe(false);
      // The refusal is a finished operation: nothing is left pending.
      const status = await t.handler(
        { schemaVersion: 1, identity: await t.identity(), action: 'status' },
        await t.context(),
      );
      expect(status.pending).toBeNull();
      const refused = await t.publish();
      expect(await t.proof(refused)).toMatchObject({
        workflowCompletion: 'not_verified',
        humanApproval: 'incomplete',
        engineApplication: [],
      });

      // Presented again as a question, the same gate is applied from its answer.
      await t.admit(refused);
      await t.execution.respond({
        ...t.f.bindingIdentity,
        actorId: 'responding-member',
        request: {
          requestId: randomUUID(),
          interactionId: refused.interactionReceipt.id,
          contentSha256: refused.body.contentSha256,
          text: 'Show the approval as a question.',
        },
      });
      await deliver();
      const opened = await t.publish(gate());
      expect(opened.finalized.result.exitCode).toBe(0);
      await approve(t, opened);
      expect(JSON.parse((await t.command(['next'])).result.stdout)).toEqual({ kind: 'done' });
      const evidence = await t.proof(await t.publish());
      expect(evidence).toMatchObject({
        workflowCompletion: 'complete',
        humanApproval: 'applied',
        gates: [{ stage: 'build', status: 'applied' }],
      });
      // Only the answer to the recorded question is a member decision.
      expect(evidence.engineApplication).toMatchObject([
        { actorId: 'responding-member', application: 'applied', effect: 'GATE_APPROVED' },
      ]);
    } finally {
      await t.close();
    }
  });

  it('refuses callers outside the current binding, writer and membership before any journal write', async () => {
    const t = await setup();
    try {
      const body = await t.request('execute', { args: [] });
      const denied = async (work) =>
        expect(work).rejects.toMatchObject({ code: 'NATIVE_ENGINE_FORBIDDEN' });
      await denied(t.handler(body, await t.context({ invokedFunctionArn: t.pin.functionArn })));
      await denied(
        t.handler(
          body,
          await t.context({ invokedFunctionArn: `${t.pin.functionArn}:native_${'0'.repeat(32)}` }),
        ),
      );
      await denied(t.handler(body, await t.context({ functionVersion: '8' })));
      for (const key of ['writerGeneration', 'sequence', 'epoch'])
        await denied(
          t.handler(
            { ...body, identity: { ...body.identity, [key]: body.identity[key] + 1 } },
            await t.context(),
          ),
        );
      await denied(
        t.handler(
          { ...body, identity: { ...body.identity, bindingId: randomUUID() } },
          await t.context(),
        ),
      );
      t.access.allowed = false;
      await denied(t.handler(body, await t.context()));
      t.access.allowed = true;
      expect(t.calls).toHaveLength(0);
      expect(
        await t.journal.get({
          ...body.identity,
          configurationSha256: (await t.row()).configurationSha256,
        }),
      ).toBeNull();
      // Membership lost during the operation leaves it unfinished and unproven.
      t.hooks.tool = () => {
        t.access.allowed = false;
      };
      await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_FORBIDDEN' });
      t.access.allowed = true;
      t.hooks.tool = null;
      expect(
        await t.handler(
          { schemaVersion: 1, identity: body.identity, action: 'status' },
          await t.context(),
        ),
      ).toEqual({ ok: true, version: 0, pending: body.requestId });
    } finally {
      await t.close();
    }
  });

  it('never lets a stale writer or an uncertain job record a verified outcome', async () => {
    const t = await setup();
    try {
      const opened = await toGate(t);
      await approve(t, opened);
      // The previous turn's identity is no longer admitted after the reply.
      const previous = { ...(await t.identity()), sequence: 1 };
      await expect(
        t.handler({ schemaVersion: 1, identity: previous, action: 'status' }, await t.context()),
      ).rejects.toMatchObject({ code: 'NATIVE_ENGINE_FORBIDDEN' });
      // An isolated job with an unknown outcome is never retried or passed.
      t.jobs.check = async () => {
        throw engineFailure('NATIVE_ENGINE_JOB_UNCERTAIN');
      };
      const uncertain = await t.request('execute', {
        args: ['engine', 'sensor', 'fire', '--stage', 'build'],
      });
      await expect(t.send(uncertain)).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_JOB_UNCERTAIN',
      });
      expect(await t.send(uncertain)).toMatchObject({
        response: { ok: true, status: 'pending', requestId: uncertain.requestId },
      });
      await expect(t.request('execute', { args: ['next'] })).resolves.toMatchObject({
        expectedVersion: expect.any(Number),
      });
      await expect(t.send(await t.request('execute', { args: ['next'] }))).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_BUSY',
      });
      // A publication made while the journal is unfinished has no proof.
      const produced = await t.f.turn(2, {
        files: [...t.project].map(([path, content]) => ({ path, content, role: 'code' })),
      });
      await expect(
        t.send(
          await t.request('finalize', {
            publication: produced.receipt,
            interaction: produced.interactionReceipt,
          }),
        ),
      ).rejects.toMatchObject({ code: 'NATIVE_ENGINE_BUSY' });
      expect(await t.proof(produced)).toBeNull();
    } finally {
      await t.close();
    }
  });

  it('drops an operation whose execution is cancelled before its commit', async () => {
    const t = await setup();
    try {
      const opened = await toGate(t);
      await approve(t, opened);
      const turn = await t.row();
      t.hooks.tool = async () => {
        await t.execution.cancel(t.f.bindingIdentity);
      };
      const body = await t.request('execute', { args: ['next'] });
      await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_WRITER_CHANGED' });
      t.hooks.tool = null;
      // The scripted engine reached its terminal event, yet nothing was committed.
      await expect(
        t.handler(
          { schemaVersion: 1, identity: body.identity, action: 'status' },
          await t.context(),
        ),
      ).rejects.toMatchObject({ code: 'NATIVE_ENGINE_FORBIDDEN' });
      const journalRows = [...t.f.rows.values()].filter((item) => item.sk.startsWith('ENGINE#'));
      expect(journalRows.find((item) => item.requestId === body.requestId)).toMatchObject({
        status: 'running',
      });
      expect(journalRows.filter((item) => item.sk.includes('#PUBLICATION#'))).toHaveLength(1);
      // The gate publication admitted before cancellation keeps its own proof.
      expect(await t.proof(opened, turn)).toMatchObject({ workflowCompletion: 'not_verified' });
    } finally {
      await t.close();
    }
  });
});
