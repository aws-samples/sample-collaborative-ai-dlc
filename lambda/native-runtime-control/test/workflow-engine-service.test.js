// The protected service with the production execution store, engine journal,
// immutable object codecs and proof reader over the shared in-memory authority
// table. Only the pinned Bun engine process and its private workspace are
// scripted: they exist in the qualified image, not on a test host. The
// journal's DynamoDB behaviour has its own container-backed integration test.
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
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
import { proposedPlanSpec } from '../../shared/test/fixtures/native-plan-ask.js';
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
  const hooks = {};
  let version = 0;
  const s3 = {
    async send(command) {
      const input = command.input;
      const intercepted = await hooks.beforeObject?.(command);
      if (intercepted) return intercepted;
      if (command.constructor.name === 'PutObjectCommand') {
        const VersionId = `engine-${++version}`;
        stored.set(`${input.Key}\0${VersionId}`, Buffer.from(input.Body));
        await hooks.afterPut?.(input);
        return { VersionId };
      }
      expect(input.ExpectedBucketOwner).toBe(f.configuration.accountId);
      if (command.constructor.name === 'ListObjectVersionsCommand') {
        expect(input.MaxKeys).toBe(1);
        const latest = [...stored.keys()].findLast((key) => key.startsWith(`${input.Prefix}\0`));
        return {
          Versions: latest
            ? [
                {
                  Key: input.Prefix,
                  VersionId: latest.split('\0')[1],
                  Size: stored.get(latest).length,
                  IsLatest: true,
                },
              ]
            : [],
          IsTruncated: false,
        };
      }
      const bytes = stored.get(`${input.Key}\0${input.VersionId}`);
      if (!bytes) throw new Error('Unknown immutable object version');
      const checksum = Buffer.from(engineDigest(bytes), 'hex').toString('base64');
      return {
        VersionId: input.VersionId,
        ContentLength: bytes.length,
        ChecksumSHA256:
          input.ChecksumMode === 'ENABLED' ? (hooks.checksum?.(checksum) ?? checksum) : undefined,
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
      const scripted = await hooks.orchestrate?.(args);
      if (scripted) return json(scripted);
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
  const failures = [];
  const handler = createNativeWorkflowEngine({
    // The production store; a test may alter what the reply ledger returns.
    executionStore: {
      ...execution,
      response: async (...input) => {
        const value = await execution.response(...input);
        return hooks.response ? hooks.response(value) : value;
      },
    },
    preparationStore: f.preparationStore,
    journal,
    objects,
    publications: f.publications,
    interactions: f.interactions,
    authorizeAccess: async () => {
      if (!access.allowed) throw engineFailure('NATIVE_ENGINE_FORBIDDEN');
    },
    reportFailure: (error, code) => failures.push({ thrown: error?.code ?? error?.name, code }),
    loadArchive: async () => {
      await hooks.archive?.();
      return Buffer.from('pinned archive');
    },
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
    objects,
    journal,
    handler,
    calls,
    hooks,
    access,
    jobs,
    failures,
    // How often the pinned engine's member hook has recorded a person's words.
    memberMessages: () => current.state.engine.messages,
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

const stopForWorkspaceRecovery = async (t) => {
  const claimed = await t.execution.claim(t.f.bindingIdentity);
  return t.execution.recoveryRequired({
    row: claimed.row,
    reason: 'DELIVERY_UNCERTAIN',
    workflowResumeState: 'created',
    stoppedSessionId: claimed.row.runtimeSessionId,
  });
};
const confirmWorkspaceRecovery = async (t, stopped) => {
  await t.execution.recover({
    ...t.f.bindingIdentity,
    request: {
      requestId: randomUUID(),
      recoveryId: stopped.recovery.id,
      confirmWorkspaceResume: true,
    },
  });
  return t.execution.claim(t.f.bindingIdentity);
};

const journalWrite = (command, body) =>
  command.input.TransactItems?.find(
    (item) => item.Put?.Item.requestId === body.requestId && item.Put.Item.sk.includes('#OP#'),
  )?.Put.Item.status;
const conflict = (command) =>
  Object.assign(new Error('Journal contention'), {
    name: 'TransactionCanceledException',
    CancellationReasons: command.input.TransactItems.map((_, i) => ({
      Code: i === 0 ? 'TransactionConflict' : 'None',
    })),
  });
const timeout = () => Object.assign(new Error('Lost acknowledgement'), { name: 'TimeoutError' });
const journalStatus = async (t) =>
  t.handler(
    { schemaVersion: 1, identity: await t.identity(), action: 'status' },
    await t.context(),
  );
const interruptFinish = (t, body) => {
  t.f.hooks.before = (command) => {
    if (['completed', 'failed'].includes(journalWrite(command, body))) throw timeout();
  };
};
describe('protected workflow engine journal recovery', () => {
  it('retries rejected begin and finish transactions without dispatching the sensor twice', async () => {
    const t = await setup();
    await t.command([]);
    t.project.set('src/app.js', Buffer.from('export default 1'));
    t.jobs.check = vi.fn(t.jobs.check);
    const body = await t.request('execute', {
      args: ['engine', 'sensor', 'fire', '--stage', 'build'],
    });
    const attempts = { running: 0, completed: 0 };
    t.f.hooks.before = (command) => {
      const phase = journalWrite(command, body);
      if (phase && ++attempts[phase] === 1) throw conflict(command);
    };
    const first = await t.send(body);
    expect(first.result.exitCode).toBe(0);
    expect(await t.send(body)).toEqual(first);
    expect(attempts).toEqual({ running: 2, completed: 2 });
    expect(t.jobs.check).toHaveBeenCalledTimes(1);
    expect(t.calls).toHaveLength(2);
    expect(await journalStatus(t)).toEqual({ ok: true, version: 2, pending: null });

    const next = await t.request('execute', { args: body.args });
    t.f.hooks.before = (command) => {
      if (journalWrite(command, next) === 'completed') throw conflict(command);
    };
    await expect(t.send(next)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_UNAVAILABLE' });
    expect(await journalStatus(t)).toMatchObject({ version: 2, pending: next.requestId });
    t.f.hooks.before = null;
    expect((await t.send(next)).response).toMatchObject({ status: 'completed', version: 3 });
    expect(t.jobs.check).toHaveBeenCalledTimes(2);
    expect(t.calls).toHaveLength(3);
  });

  it('recognizes its own begin token and finished result after both write replies are lost', async () => {
    const t = await setup();
    const body = await t.request('execute');
    const writes = [];
    t.f.hooks.after = (command) => {
      const phase = journalWrite(command, body);
      if (phase) {
        writes.push(phase);
        throw timeout();
      }
    };
    const first = await t.send(body);
    expect(first.response).toMatchObject({ status: 'completed', version: 1 });
    expect(await t.send(body)).toEqual(first);
    expect(writes).toEqual(['running', 'completed']);
    expect(t.calls).toHaveLength(1);
  });

  it('keeps a concurrent duplicate pending before output and lets both finish from the same saved versions', async () => {
    const t = await setup();
    const body = await t.request('execute');
    const competitor = await t.request('mirror');
    t.hooks.tool = async () => {
      expect(await t.send(body)).toMatchObject({ response: { status: 'pending' } });
      await expect(t.send(competitor)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_BUSY' });
      await expect(t.send({ ...body, args: ['next'] })).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_REQUEST_CONFLICT',
      });
    };
    let recovered;
    t.hooks.afterPut = async (input) => {
      if (input.Key.endsWith('/result.json.gz')) recovered = await t.send(body);
    };
    const original = await t.send(body);
    expect(recovered).toEqual(original);
    expect(original.response).toMatchObject({ status: 'completed', version: 1 });
    expect(t.calls).toHaveLength(1);
    expect(t.memberMessages()).toBe(1);
  });

  it.each([
    ['execute', ['next'], 'completed', 0],
    ['mirror', [], 'completed', 0],
    ['finalize', [], 'completed', 0],
    ['execute', ['next', '--force'], 'failed', 1],
    ['execute', ['engine', 'state', 'get'], 'completed', 2],
  ])('recovers persisted %s %j as %s with exitCode %i', async (action, args, status, exitCode) => {
    const t = await setup();
    await t.command([]);
    let produced;
    if (action === 'finalize')
      produced = await t.f.turn(1, {
        files: [...t.project].map(([path, content]) => ({ path, content, role: 'code' })),
      });
    const body = await t.request(
      action,
      produced
        ? { publication: produced.receipt, interaction: produced.interactionReceipt }
        : { args },
    );
    interruptFinish(t, body);
    await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_UNAVAILABLE' });
    expect(await journalStatus(t)).toMatchObject({ version: 1, pending: body.requestId });
    if (produced) expect(await t.proof(produced)).toBeNull();
    const calls = t.calls.length;
    t.f.hooks.before = null;
    t.hooks.archive = vi.fn();
    t.hooks.afterPut = vi.fn();
    const recovered = await t.send(body);
    expect(recovered.response).toMatchObject({ status, version: 2 });
    expect(recovered.result).toMatchObject({ requestId: body.requestId, exitCode });
    if (produced)
      expect(await t.proof(produced)).toMatchObject({ publicationId: produced.receipt.id });
    expect(await t.send(body)).toEqual(recovered);
    expect(t.calls).toHaveLength(calls);
    expect(t.hooks.archive).not.toHaveBeenCalled();
    expect(t.hooks.afterPut).not.toHaveBeenCalled();
    expect(await journalStatus(t)).toMatchObject({ version: 2, pending: null });
  });

  it.each([false, true])(
    'retains the previous snapshot for a saved failure before workspace creation (prior workspace %s)',
    async (prior) => {
      const t = await setup();
      if (prior) await t.command([]);
      const identity = nativeEngineIdentity(await t.row());
      const previous = (await t.journal.get(identity))?.snapshot ?? null;
      t.hooks.archive = () => {
        throw engineFailure('NATIVE_ENGINE_ARCHIVE_UNAVAILABLE');
      };
      const body = await t.request('execute');
      interruptFinish(t, body);
      await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_UNAVAILABLE' });
      t.f.hooks.before = null;
      const resumed = await t.send(body);
      expect(resumed.response.status).toBe('failed');
      expect(resumed.result.failure).toBe('NATIVE_ENGINE_ARCHIVE_UNAVAILABLE');
      expect((await t.journal.get(identity)).snapshot).toEqual(previous);
      expect(t.calls).toHaveLength(Number(prior));
    },
  );

  it('requires a readable result and snapshot before clearing a pending command', async () => {
    const t = await setup();
    const body = await t.request('execute');
    t.hooks.beforeObject = (command) => {
      if (
        command.constructor.name === 'PutObjectCommand' &&
        command.input.Key.endsWith('/result.json.gz')
      )
        throw timeout();
    };
    await expect(t.send(body)).rejects.toThrow('Lost acknowledgement');
    expect((await t.send(body)).response.status).toBe('pending');
    expect(t.calls).toHaveLength(1);
    expect(await journalStatus(t)).toMatchObject({ version: 0, pending: body.requestId });
  });

  it('recovers a lost S3 result write acknowledgement only after exact version readback succeeds', async () => {
    const t = await setup();
    const body = await t.request('execute');
    t.hooks.afterPut = (input) => {
      if (input.Key.endsWith('/result.json.gz')) throw timeout();
    };
    await expect(t.send(body)).rejects.toThrow('Lost acknowledgement');
    t.hooks.beforeObject = (command) => {
      if (command.input.Key?.endsWith('/snapshot.json.gz')) throw timeout();
    };
    await expect(t.send(body)).rejects.toThrow('Lost acknowledgement');
    expect(await journalStatus(t)).toMatchObject({ version: 0, pending: body.requestId });
    t.hooks.beforeObject = null;
    expect(await t.send(body)).toMatchObject({
      response: { status: 'completed', version: 1 },
      result: { exitCode: 0 },
    });
    expect(t.calls).toHaveLength(1);
  });

  it.each([
    ['missing snapshot', 'NATIVE_ENGINE_STATE_UNAVAILABLE'],
    ['invalid checksum', 'NATIVE_ENGINE_OBJECT_INVALID'],
    ['foreign result', 'NATIVE_ENGINE_RESULT_INVALID'],
  ])('holds the pending head with %s', async (fault, code) => {
    const t = await setup();
    const body = await t.request('execute');
    interruptFinish(t, body);
    await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_UNAVAILABLE' });
    t.f.hooks.before = null;
    const identity = nativeEngineIdentity(await t.row());
    if (fault === 'foreign result') {
      await t.objects.write(
        identity,
        body.requestId,
        'result',
        {
          schemaVersion: 1,
          identity: { ...identity, sequence: identity.sequence + 1 },
          requestId: body.requestId,
          exitCode: 0,
          stdout: '',
          stderr: '',
          patches: [],
        },
        'output',
      );
    } else if (fault === 'missing snapshot') {
      t.hooks.beforeObject = ({ input }) => {
        if (input.Prefix?.endsWith('/snapshot.json.gz')) return { IsTruncated: false };
      };
    } else t.hooks.checksum = () => '';
    await expect(t.send(body)).rejects.toMatchObject({ code });
    expect(await journalStatus(t)).toMatchObject({ version: 0, pending: body.requestId });
    expect(t.calls).toHaveLength(1);
  });

  it('does not let a confirmed replacement writer finish the previous writer’s saved output', async () => {
    const t = await setup();
    const body = await t.request('execute');
    interruptFinish(t, body);
    await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_UNAVAILABLE' });
    t.f.hooks.before = null;
    const stopped = await stopForWorkspaceRecovery(t);
    const replacement = await confirmWorkspaceRecovery(t, stopped);
    await t.execution.recoveryStopped({ row: replacement.row });
    await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_FORBIDDEN' });
    await expect(t.send({ ...body, identity: await t.identity() })).rejects.toMatchObject({
      code: 'NATIVE_ENGINE_REQUEST_CONFLICT',
    });
    await expect(t.send(await t.request('execute'))).rejects.toMatchObject({
      code: 'NATIVE_ENGINE_BUSY',
    });
    expect(await journalStatus(t)).toMatchObject({ version: 0, pending: body.requestId });
    expect(t.calls).toHaveLength(1);
  });

  it.each(['token', 'requestId', 'version', 'producerSha256', 'cancel'])(
    'fences a saved result when %s changes between its recovery read and commit',
    async (field) => {
      const t = await setup();
      const body = await t.request('execute');
      interruptFinish(t, body);
      await expect(t.send(body)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_UNAVAILABLE' });
      t.f.hooks.before = async (command) => {
        if (journalWrite(command, body) !== 'completed') return;
        t.f.hooks.before = null;
        if (field === 'cancel') return t.execution.cancel(t.f.bindingIdentity);
        const head = [...t.f.rows.values()].find((item) => item.sk.endsWith('#HEAD'));
        if (field === 'token' || field === 'requestId') head.pending[field] = randomUUID();
        else head[field] = field === 'version' ? 3 : engineDigest('another producer');
      };
      await expect(t.send(body)).rejects.toMatchObject({
        code: field === 'cancel' ? 'NATIVE_ENGINE_WRITER_CHANGED' : 'NATIVE_ENGINE_HEAD_CHANGED',
      });
      const operation = [...t.f.rows.values()].find((item) => item.sk.endsWith(body.requestId));
      expect(operation.status).toBe('running');
      expect(t.calls).toHaveLength(1);
    },
  );
});
describe('protected workflow engine service', () => {
  it('resumes the open stage only for the confirmed writer and turn, without replaying its lost approval', async () => {
    const t = await setup();
    const opened = await toGate(t);
    // The member submitted an approval, but its delivery became uncertain.
    await approve(t, opened);
    const previous = await t.request('execute', { args: ['next', '--resume'] });
    const stopped = await stopForWorkspaceRecovery(t);
    await expect(t.send(previous)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_WRITER_CHANGED' });
    const replacement = await confirmWorkspaceRecovery(t, stopped);
    await expect(t.request('execute', { args: ['next', '--resume'] })).rejects.toMatchObject({
      code: 'NATIVE_ENGINE_WRITER_CHANGED',
    });
    const restoring = await t.execution.recoveryStopped({ row: replacement.row });
    await expect(t.send(previous)).rejects.toMatchObject({ code: 'NATIVE_ENGINE_FORBIDDEN' });
    const memberMessages = t.memberMessages();
    const resumed = await t.command(['engine', 'orchestrate', 'next', '--resume']);
    expect(resumed.result.exitCode).toBe(0);
    expect(JSON.parse(resumed.result.stdout)).toMatchObject({ stage: 'build', gate: true });
    expect(t.calls.at(-1)).toEqual(['aidlc-orchestrate.ts', 'next', '--resume']);

    await t.execution.release({ row: await t.execution.recovered({ row: restoring }) });
    expect((await t.command(['next', '--resume'])).result.exitCode).toBe(0);
    expect(t.calls.at(-1)).toEqual(['aidlc-orchestrate.ts', 'next', '--resume']);
    expect(t.memberMessages()).toBe(memberMessages);
    const held = await t.publish(gate());
    expect(await t.proof(held)).toMatchObject({
      humanApproval: 'incomplete',
      workflowCompletion: 'not_verified',
      engineApplication: [],
    });

    await approve(t, held);
    expect((await t.command(['next', '--resume'])).result.failure).toBe(
      'NATIVE_ENGINE_COMMAND_DENIED',
    );
    expect((await t.command(['next'])).result.exitCode).toBe(0);
    expect(await t.proof(await t.publish())).toMatchObject({ humanApproval: 'applied' });
  });
  it.each(['no snapshot', 'intake only'])(
    'cannot restart intake on recovery with %s',
    async (scenario) => {
      const t = await setup();
      if (scenario === 'intake only') {
        t.hooks.orchestrate = () => ({ kind: 'print', message: 'Choose a plan.' });
        await t.command([]);
      }
      const replacement = await confirmWorkspaceRecovery(t, await stopForWorkspaceRecovery(t));
      await t.execution.recoveryStopped({ row: replacement.row });
      const priorCalls = t.calls.length;
      expect((await t.command(['next', '--resume'])).result.failure).toBe(
        'NATIVE_ENGINE_STATE_UNAVAILABLE',
      );
      expect(t.calls).toHaveLength(priorCalls);
      expect(t.memberMessages()).toBe(scenario === 'no snapshot' ? 0 : 1);
    },
  );
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
      // The operation is answered as recorded; what raised it is reported once, beside it.
      expect(t.failures).toEqual([
        { thrown: 'NATIVE_ENGINE_COMMAND_DENIED', code: 'NATIVE_ENGINE_COMMAND_DENIED' },
      ]);

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

  // NE-24. A reply that names no question the engine recorded carries no
  // member authority. It no longer makes the engine refuse the turn.
  const NOT_APPLIED = 'NATIVE_ENGINE_REPLY_NOT_APPLIED';
  const reply = async (t, produced, text, selection) => {
    const accepted = await t.f.api.respond(
      t.f.prepared,
      'responding-member',
      {
        requestId: randomUUID(),
        interactionId: produced.interactionReceipt.id,
        contentSha256: produced.body.contentSha256,
        text,
        ...(selection ? { selection } : {}),
      },
      t.f.recheck,
    );
    const claim = await t.execution.claim(t.f.bindingIdentity);
    await t.execution.release({ row: await t.execution.dispatched({ row: claim.row }) });
    // The accepted reply as the application shows it, with the command the row names.
    return { ...accepted.response, commandId: (await t.row()).response.commandId };
  };
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

  it('applies the commands that need no member after a reply to a turn without a question, tells the agent why nothing was decided, and completes verified in the same attempt', async () => {
    const t = await setup();
    try {
      expect(JSON.parse((await t.command([])).result.stdout)).toMatchObject({ kind: 'run-stage' });
      t.project.set('src/app.js', Buffer.from('export const answer = 42;\n'));
      // The agent ends its turn with a question in prose: no question file, no form.
      const prose = await t.publish();
      expect(prose.body.pendingInput).toBeUndefined();
      await t.admit(prose);
      const attempt = (await t.row()).attemptId;
      const written = await reply(t, prose, 'Yes, go ahead and approve the build.');
      expect(written).toMatchObject({ kind: 'user_reply', deliveryStatus: 'pending' });
      const spoken = t.memberMessages();
      const before = t.calls.length;

      // Asking for the directive again, running a check and reporting the stage
      // as waiting need no member. They reach the pinned engine and succeed.
      const again = await t.command(['next']);
      expect(again.response.status).toBe('completed');
      expect(again.result.exitCode).toBe(0);
      expect(JSON.parse(again.result.stdout)).toMatchObject({ kind: 'run-stage', stage: 'build' });
      // The agent is told why no decision was taken and what to do instead.
      expect(again.result.stderr.split('\n')[0]).toBe(NOT_APPLIED);
      expect(again.result.stderr).toContain('was not applied as a workflow decision');
      expect(again.result.stderr).toContain('.native-control/pending-question.json');
      expect(again.result.stderr).toContain('run aidlc next to read the current directive again');
      // Nothing of the member's words is repeated to the agent by the engine.
      expect(again.result.stderr).not.toContain('go ahead');
      let applied;
      for (const args of [
        ['engine', 'sensor', 'fire', '--stage', 'build'],
        report('awaiting-approval'),
      ]) {
        applied = await t.command(args);
        expect(applied.response.status).toBe('completed');
        expect(applied.result.exitCode).toBe(0);
        expect(applied.result.stderr.split('\n')[0]).toBe(NOT_APPLIED);
      }
      // Once the stage waits at its gate, the engine names the approval it holds.
      expect(applied.result.stderr).toContain('The engine holds an open approval for stage build.');
      expect(t.calls.length).toBe(before + 3);
      // The reply never reached the pinned engine as a person's words.
      expect(t.memberMessages()).toBe(spoken);
      expect(t.failures).toEqual([]);

      // The revision in between is not verified, decides nothing, and says so.
      const between = await t.publish(gate());
      expect(between.finalized.result.exitCode).toBe(0);
      const unapplied = [
        {
          commandId: written.commandId,
          interactionId: prose.interactionReceipt.id,
          actorId: 'responding-member',
          sequence: 2,
          reason: 'no_recorded_question',
        },
      ];
      expect(await t.proof(between)).toMatchObject({
        workflowCompletion: 'not_verified',
        humanApproval: 'incomplete',
        engineApplication: [],
        unappliedReplies: unapplied,
      });
      // The open question was presented again as a form the engine recorded.
      // Its answer is a decision, and the run completes in the same attempt.
      await approve(t, between);
      // The member reads in that revision's completion report that the written
      // reply was not applied as a decision.
      expect(await t.view(between)).toMatchObject({
        workflowCompletion: 'not_verified',
        engineApplication: [],
        unappliedReplies: unapplied,
      });
      const done = await t.command(['next']);
      expect(JSON.parse(done.result.stdout)).toEqual({ kind: 'done' });
      // A turn that starts with an answer to a recorded question carries no notice.
      expect(done.result.stderr).toBe('');
      const evidence = await t.proof(await t.publish());
      expect(evidence).toMatchObject({
        workflowCompletion: 'complete',
        humanApproval: 'applied',
        gates: [{ stage: 'build', status: 'applied' }],
        unappliedReplies: unapplied,
      });
      expect(evidence.engineApplication).toMatchObject([
        { actorId: 'responding-member', application: 'applied', effect: 'GATE_APPROVED' },
      ]);
      expect((await t.row()).attemptId).toBe(attempt);
    } finally {
      await t.close();
    }
  });

  it('still refuses an answer, an approval and a plan selection after such a reply, with the reason, and implies none of them', async () => {
    const t = await setup();
    try {
      await toGate(t);
      const prose = await t.publish();
      await t.admit(prose);
      await reply(t, prose, 'Approve');
      const spoken = t.memberMessages();
      const before = t.calls.length;
      for (const args of [
        report('approved', '--user-input', 'Approve'),
        report('approved'),
        ['engine', 'log', 'answer', '--stage', 'build', '--details', 'Approve'],
        [
          'engine',
          'intent',
          'create',
          '--scope',
          'express',
          '--request',
          'abcd1234',
          '--label',
          'x',
        ],
      ]) {
        const refused = await t.command(args);
        expect(refused.response.status).toBe('failed');
        expect(refused.result).toMatchObject({
          exitCode: 1,
          stdout: '',
          failure: 'NATIVE_ENGINE_COMMAND_DENIED',
          patches: [],
        });
        // The refusal names its code first, then why the reply decided nothing
        // and which approval the engine holds open.
        expect(refused.result.stderr.split('\n').slice(0, 2)).toEqual([
          'NATIVE_ENGINE_COMMAND_DENIED',
          NOT_APPLIED,
        ]);
        expect(refused.result.stderr).toContain(
          'The engine holds an open approval for stage build.',
        );
      }
      // The pinned engine saw neither a command nor a person's words.
      expect(t.calls.length).toBe(before);
      expect(t.memberMessages()).toBe(spoken);
      const status = await t.handler(
        { schemaVersion: 1, identity: await t.identity(), action: 'status' },
        await t.context(),
      );
      expect(status.pending).toBeNull();
      expect(await t.proof(await t.publish())).toMatchObject({
        workflowCompletion: 'not_verified',
        humanApproval: 'incomplete',
        gates: [{ stage: 'build', status: 'not_recorded' }],
        engineApplication: [],
        unappliedReplies: [{ actorId: 'responding-member', reason: 'no_recorded_question' }],
      });
    } finally {
      await t.close();
    }
  });

  it('records such a reply when the turn runs no workflow command at all', async () => {
    const t = await setup();
    try {
      await toGate(t);
      const prose = await t.publish();
      await t.admit(prose);
      const written = await reply(t, prose, 'Show the approval as a question.');
      // The agent only presents the gate as a form and ends its turn.
      const opened = await t.publish(gate());
      expect(opened.finalized.result.exitCode).toBe(0);
      expect(await t.proof(opened)).toMatchObject({
        workflowCompletion: 'not_verified',
        engineApplication: [],
        unappliedReplies: [{ commandId: written.commandId, sequence: 2 }],
      });
      // The same reply is recorded once, however often the turn is observed.
      await approve(t, opened);
      expect(JSON.parse((await t.command(['next'])).result.stdout)).toEqual({ kind: 'done' });
      const evidence = await t.proof(await t.publish());
      expect(evidence.unappliedReplies).toHaveLength(1);
      expect(evidence.workflowCompletion).toBe('complete');
    } finally {
      await t.close();
    }
  });

  it('treats an answer to a form that was not the engine’s question the same way and hands the agent the question it holds', async () => {
    const t = await setup();
    try {
      // The pinned engine offers a plan before any workflow state exists and
      // repeats that offer whenever it is asked again.
      const offer = proposedPlanSpec.ask;
      t.hooks.orchestrate = (args) =>
        args.includes('--scope') ? null : args[0] === 'next' ? offer : null;
      expect(JSON.parse((await t.command([])).result.stdout)).toEqual(offer);
      // The agent paraphrases the offer. The engine does not record that form.
      const paraphrased = buildNativePendingInput({
        spec: {
          version: 2,
          questions: [
            {
              prompt: 'Which plan would you like?',
              options: [{ label: 'The bugfix plan' }, { label: 'Something else' }],
            },
          ],
        },
      });
      const shown = await t.publish(paraphrased);
      expect(shown.finalized.result.failure).toBe('NATIVE_ENGINE_PRESENTATION_MISMATCH');
      await t.admit(shown);
      const selection = { answers: [{ selectedOptions: [0] }] };
      const picked = await reply(t, shown, nativeAnswerText(paraphrased, selection), selection);
      const spoken = t.memberMessages();

      // The offer can be read again from the engine.
      const again = await t.command(['next']);
      expect(again.result.exitCode).toBe(0);
      expect(JSON.parse(again.result.stdout)).toEqual(offer);
      expect(again.result.stderr.split('\n')[0]).toBe(NOT_APPLIED);
      // Choosing the plan on the member's behalf stays refused, and the refusal
      // carries the question the engine holds, to be presented unchanged.
      const forged = await t.command([
        'engine',
        'orchestrate',
        'next',
        '--scope',
        'bugfix',
        '--request',
        'fixture-request',
      ]);
      expect(forged.result).toMatchObject({ exitCode: 1, failure: 'NATIVE_ENGINE_COMMAND_DENIED' });
      expect(forged.result.stderr).toContain(NOT_APPLIED);
      const lines = forged.result.stderr.split('\n');
      const held = lines.findIndex((line) => line.includes('{"version":3,"ask":<this object>}'));
      expect(JSON.parse(lines[held + 1])).toEqual(offer);
      expect(t.memberMessages()).toBe(spoken);

      // Presented unchanged, the offer is a question the engine records, and
      // the member's selection of it is applied.
      const form = buildNativePendingInput({ spec: proposedPlanSpec });
      const asked = await t.publish(form);
      expect(asked.finalized.result.exitCode).toBe(0);
      expect(await t.proof(asked)).toMatchObject({
        workflowCompletion: 'not_verified',
        engineApplication: [],
        unappliedReplies: [{ commandId: picked.commandId, reason: 'no_recorded_question' }],
      });
      await t.admit(asked);
      await reply(t, asked, nativeAnswerText(form, selection), selection);
      const chosen = await t.command(['next']);
      expect(chosen.result.exitCode).toBe(0);
      expect(chosen.result.stderr).toBe('');
      expect(t.calls.at(-1)).toEqual([
        'aidlc-orchestrate.ts',
        'next',
        '--scope',
        'bugfix',
        '--request',
        'fixture-request',
      ]);
      expect(t.memberMessages()).toBe(spoken + 1);
      expect((await t.proof(await t.publish())).engineApplication).toMatchObject([
        { application: 'applied', effect: 'PLAN_PROPOSAL_APPLIED' },
      ]);
    } finally {
      await t.close();
    }
  });

  it('keeps refusing a reply whose record does not match the turn it is delivered to', async () => {
    const t = await setup();
    try {
      await toGate(t);
      const prose = await t.publish();
      await t.admit(prose);
      await reply(t, prose, 'Approve');
      // The stored reply no longer has the words the member's digest names.
      t.hooks.response = (value) => ({ ...value, text: 'Approve everything' });
      const refused = await t.command(['next']);
      expect(refused.result).toMatchObject({
        exitCode: 1,
        failure: 'NATIVE_ENGINE_DECISION_MISMATCH',
        stderr: 'NATIVE_ENGINE_DECISION_MISMATCH\n',
      });
      // Nor is it recorded as a reply that merely decided nothing.
      expect((await t.proof(await t.publish())).unappliedReplies).toEqual([]);
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
