// The protected service with the production execution store, engine journal,
// immutable object codecs and proof reader over the shared in-memory authority
// table. Only the pinned Bun engine process and its private workspace are
// scripted: they exist in the qualified image, not on a test host. The
// journal's DynamoDB behaviour has its own container-backed integration test.
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { expect } from 'vitest';
import { createNativeEngineStore, nativeEngineIdentity } from '../workflow-engine/store.js';
import { createNativeWorkflowEngine } from '../workflow-engine/service.js';
import { createNativeEngineProofReader } from '../workflow-engine/proof-reader.js';
import { createNativeExecutionApi } from '../execution-api.js';
import { createNativeArtifactRevisions } from '../../shared/native-artifact-revision.js';
import { nativeProjectionStatus } from '../projection-store.js';
import { createNativeEngineObjects } from '../../shared/native-workflow-objects.js';
import { decodeNativeTurnInteraction } from '../../agentcore/native/turn-interaction.js';
import {
  NATIVE_ENGINE_PROFILE,
  encodeNativeEngineFiles,
  engineDigest,
  engineFailure,
  nativeEngineArn,
  nativeEngineFileDigest,
  nativeEngineFiles,
} from '../../shared/native-workflow-protocol.js';
import { serialFixture } from './execution-serial-fixtures.js';
import { TABLE } from './fixtures.js';

const STATE_FILE = 'aidlc/spaces/default/intents/fixture/aidlc-state.md';
const json = (value) => ({
  exitCode: 0,
  stdout: Buffer.from(JSON.stringify(value)),
  stderr: Buffer.alloc(0),
});
const flag = (args, name) => args[args.indexOf(name) + 1];

export const setupNativeWorkflowEngine = async (fixtureOptions) => {
  const f = serialFixture(fixtureOptions);
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
        if (name === 'aidlc-utility.ts' && args[0] === 'intent-create') {
          engine.scope = flag(args, '--scope');
          engine.status = 'In Progress';
          emit(engine, { event: 'WORKFLOW_STARTED', stage: null });
          return json({ created: true });
        }
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
            scope: engine.scope ?? 'express',
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
  const publish = async (pendingInput, rendered) => {
    const mirrored = await send(await request('mirror'));
    expect(mirrored.result.exitCode).toBe(0);
    if (rendered) {
      ({ pendingInput } = decodeNativeTurnInteraction({
        interactionContract: 'aidlc-2.11.1',
        snapshot: { files: files() },
        rendered,
        enginePendingInput: mirrored.result.pendingInput,
        messages: [],
      }));
    }
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
    objects,
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
