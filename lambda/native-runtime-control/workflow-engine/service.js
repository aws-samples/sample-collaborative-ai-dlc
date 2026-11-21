import { isDeepStrictEqual } from 'node:util';
import {
  nativeEnginePin,
  nativeEngineArn,
  nativeEngineFiles,
  nativeEngineFileDigest,
  nativeEngineAuthoredPath,
  nativeEngineObjectPrefix,
  engineFailure,
  encodeNativeEngineFiles,
} from '../../shared/native-workflow-protocol.js';
import { createNativeInspectionGit } from '../../shared/native-workflow-git.js';
import { nativeConfirmedWorkspaceResume } from '../execution-store.js';
import { nativeEngineIdentity, nativeEngineRequestSha256 } from './store.js';
import { openNativeEngineWorkspace } from './workspace.js';
import { createNativeEngineRunner } from './runner.js';
import { applyNativeEngineCommand } from './command-application.js';
import { engineGitDelta, engineGitSource, openEngineGitInput } from './git-evidence.js';
import { nativeGitDeltaSha256 } from '../../shared/native-git-change-set.js';
import { nativeEngineCompletionEvidence } from './evidence.js';
import { nativeEngineAskInput, nativeEnginePresentation } from './presentation.js';
import { bindNativeEngineReply, nativeEngineReplyNotice } from './reply-binding.js';

const same = isDeepStrictEqual;
const decode = (result) => {
  if (result.exitCode !== 0) throw engineFailure('NATIVE_ENGINE_OBSERVATION_UNAVAILABLE');
  try {
    return JSON.parse(result.stdout.toString('utf8'));
  } catch {
    throw engineFailure('NATIVE_ENGINE_OBSERVATION_UNAVAILABLE');
  }
};
const requestValue = (request) => {
  const base = ['schemaVersion', 'identity', 'action'];
  const allowed =
    request?.action === 'abandon'
      ? [...base, 'operation', 'originalRequest']
      : request?.action === 'pending'
        ? base
        : [
            'schemaVersion',
            'identity',
            'action',
            'requestId',
            'expectedVersion',
            'input',
            'args',
            'publication',
            'interaction',
          ];
  if (
    !request ||
    request.schemaVersion !== 1 ||
    Object.keys(request).some((key) => !allowed.includes(key)) ||
    !['status', 'pending', 'abandon', 'execute', 'mirror', 'finalize'].includes(request.action) ||
    !request.identity ||
    Object.keys(request.identity).toSorted().join(',') !==
      'attemptId,bindingId,epoch,executionId,projectId,sequence,writerGeneration'
  )
    throw engineFailure();
  return structuredClone(request);
};
const publicIdentity = ({ configurationSha256: _configuration, ...identity }) => identity;
const operationSignal = (context) =>
  AbortSignal.timeout(
    Math.min(840_000, Math.max(1, (context.getRemainingTimeInMillis?.() ?? 900_000) - 60_000)),
  );
const patches = (before, after, captureModes) => {
  const from = new Map(before.map((file) => [file.path, file]));
  const to = new Map(after.map((file) => [file.path, file]));
  return [...new Set([...from.keys(), ...to.keys()])].toSorted().flatMap((path) => {
    const old = from.get(path);
    const value = to.get(path);
    // Keep an existing coding mode when the engine only mirrors its policy/ledger bytes.
    // A different protected mode remains a visible proof mismatch.
    if (old?.sha256 === value?.sha256) return [];
    // Unowned caller files stay visible. The engine never deletes an extra
    // repository file merely because it is outside its authority projection.
    if (!value) return [];
    return [
      {
        path,
        beforeSha256: old?.sha256 ?? null,
        ...(captureModes && old ? { beforeMode: old.mode } : {}),
        after: encodeNativeEngineFiles([
          captureModes
            ? { ...value, mode: old?.mode ?? value.mode }
            : { path, content: value.content },
        ])[0],
      },
    ];
  });
};
// The pinned engine writes to stderr too. The notice starts on its own line.
const withNotice = (stderr, notice) =>
  notice && stderr && !stderr.endsWith('\n') ? `${stderr}\n${notice}` : stderr + notice;
// One accepted command against the protected workspace. The returned patches
// are the only bytes that flow back to the coding workspace.
const runNativeEngineCommand = async (context) => {
  const { request, identity, row, snapshot, workspace, runner, git, objects, sessionId } = context;
  const submitted = await objects.read(identity, request.input, 'input');
  const files = nativeEngineFiles(submitted.files);
  const gitInput = await openEngineGitInput(context, submitted, files);
  const inputSha256 = await workspace.importAuthored(submitted.files, runner, sessionId);
  if (!snapshot)
    await git.initialize(
      files.filter((file) => nativeEngineAuthoredPath(file.path)),
      row.configuration.repository.commit,
    );
  const result =
    request.action === 'execute'
      ? await applyNativeEngineCommand({
          ...context,
          state: workspace.state,
          inputSha256,
          gitInput,
        })
      : { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const outputFiles = await workspace.publicFiles();
  return {
    schemaVersion: 1,
    identity,
    requestId: request.requestId,
    exitCode: result.exitCode,
    stdout: result.stdout.toString('utf8'),
    stderr: withNotice(
      result.stderr.toString('utf8'),
      request.action === 'execute' ? nativeEngineReplyNotice(workspace.state, identity) : '',
    ),
    inputSha256: nativeEngineFileDigest(files),
    filesSha256: nativeEngineFileDigest(outputFiles),
    patches: patches(files, outputFiles, Boolean(gitInput)),
    ...(request.action === 'mirror'
      ? { pendingInput: nativeEngineAskInput(workspace.state.directive) }
      : {}),
  };
};

const presentedInteraction = async ({ request, identity, row, manifest, interactions }) => {
  const body = await interactions.read(
    {
      projectId: identity.projectId,
      executionId: identity.executionId,
      bindingId: row.bindingId,
      attemptId: row.attemptId,
      epoch: row.epoch,
      runtimeSessionId: row.runtimeSessionId,
    },
    request.interaction,
  );
  if (
    body.publicationId !== request.publication.id ||
    body.sequence !== identity.sequence ||
    body.packageId !== manifest.packageId ||
    body.harness !== row.configuration.harness ||
    body.nativeSessionId !== manifest.nativeSessionId
  )
    throw engineFailure('NATIVE_ENGINE_PRESENTATION_MISMATCH');
  return { ...body, id: request.interaction.id };
};

// Bind the protected observation to one admitted publication. Nothing here
// advances the workflow; an absent or changed result stays not verified.
const finalizeNativeEnginePublication = async (context) => {
  const { request, identity, row, pin, snapshot, workspace, runner, objects, publications } =
    context;
  if (!snapshot) throw engineFailure('NATIVE_ENGINE_STATE_UNAVAILABLE');
  const manifest = await publications.read(
    {
      projectId: identity.projectId,
      executionId: identity.executionId,
      attemptId: row.attemptId,
      epoch: row.epoch,
    },
    request.publication,
    { verifyFiles: true },
  );
  if (
    manifest.sequence !== identity.sequence ||
    manifest.packageId !== row.configuration.packageId ||
    manifest.repository.commit !== row.configuration.repository.commit ||
    (manifest.git &&
      (!manifest.git.deleted ||
        manifest.repository.branch !== row.configuration.repository.branch ||
        manifest.git.provider !== row.configuration.repository.provider ||
        manifest.git.repository !== row.configuration.repository.repository ||
        (workspace.state.gitSource &&
          !same(workspace.state.gitSource, engineGitSource(manifest.sourceBaseline)))))
  )
    throw engineFailure('NATIVE_ENGINE_PUBLICATION_INVALID');
  const state = workspace.state;
  const observed = decode(await runner.observe());
  const outputFiles = await workspace.publicFiles();
  // A turn may end without any workflow command. Its reply is still recorded
  // as one that decided nothing, so the evidence does not depend on a command.
  await bindNativeEngineReply({ ...context, state }, { strict: false });
  const issued = request.interaction
    ? nativeEnginePresentation(
        state,
        observed,
        await presentedInteraction({ ...context, manifest }),
      )
    : null;
  const source = manifest.git ? await publications.source(identity, manifest) : null;
  const publicationDelta =
    source?.changes && engineGitDelta(manifest.sourceBaseline, source.manifest, source.changes);
  const evidence = nativeEngineCompletionEvidence({
    publicationGitSha256: publicationDelta && nativeGitDeltaSha256(publicationDelta),
    identity,
    row,
    publication: request.publication,
    manifest,
    workspace: { state, files: outputFiles },
    observed,
  });
  const proof = {
    identity,
    producerSha256: pin.producerSha256,
    publicationId: request.publication.id,
    evidence: await objects.write(identity, request.requestId, 'evidence', evidence, 'output'),
  };
  // Failed operations retain their partial workspace. Register the question
  // only once its evidence is ready for the same journal commit.
  if (issued) state.presentations.push(issued);
  return {
    proof,
    result: {
      schemaVersion: 1,
      identity,
      requestId: request.requestId,
      exitCode: 0,
      stdout: '',
      stderr: '',
      patches: [],
      evidence: proof.evidence,
      presentedInteractionId: issued?.interactionId ?? null,
    },
  };
};

const failureCode = (error) =>
  typeof error?.code === 'string' && error.code.startsWith('NATIVE_')
    ? error.code
    : 'NATIVE_ENGINE_UNAVAILABLE';

const interruptionCode = (error, signal) => {
  if (error?.name === 'TimeoutError' || error?.code === 'NATIVE_ENGINE_TIMEOUT')
    return 'NATIVE_ENGINE_TIMEOUT';
  if (signal.aborted || error?.name === 'AbortError' || error?.code === 'NATIVE_ENGINE_CANCELLED')
    return 'NATIVE_ENGINE_CANCELLED';
  return error?.code === 'NATIVE_ENGINE_JOB_UNCERTAIN' ? error.code : null;
};
const operationResponse = (operation) => ({
  ok: true,
  status: operation.status,
  version: operation.version,
  result: operation.result,
});

const publicationFromEvidence = (operation, value, evidence) => {
  const { identity, requestId, producerSha256 } = operation;
  if (
    evidence.key !==
      `${nativeEngineObjectPrefix(identity, 'output')}${requestId}/evidence.json.gz` ||
    value?.schemaVersion !== 1 ||
    !same(value.identity, identity) ||
    value.publicationSequence !== identity.sequence ||
    value.configurationSha256 !== identity.configurationSha256 ||
    !/^[a-f0-9]{64}$/.test(value.publicationId ?? '') ||
    value.publicationManifestSha256 !== value.publicationId ||
    (operation.publicationId && operation.publicationId !== value.publicationId) ||
    value.producer?.imageSha256 !== producerSha256
  )
    throw engineFailure('NATIVE_ENGINE_PUBLICATION_INVALID');
  return { identity, producerSha256, publicationId: value.publicationId, evidence };
};

const savedOperation = async (operation, objects, saved, action) => {
  const { identity, requestId } = operation;
  const result = saved.value;
  if (
    result?.schemaVersion !== 1 ||
    result.requestId !== requestId ||
    !same(result.identity, identity) ||
    !Number.isInteger(result.exitCode) ||
    typeof result.stdout !== 'string' ||
    typeof result.stderr !== 'string' ||
    !Array.isArray(result.patches) ||
    (Object.hasOwn(result, 'failure') &&
      (typeof result.failure !== 'string' ||
        !result.failure.startsWith('NATIVE_') ||
        result.exitCode !== 1))
  )
    throw engineFailure('NATIVE_ENGINE_RESULT_INVALID');
  const snapshot = await objects.observeOperationObject(identity, requestId, 'snapshot');
  if (
    snapshot &&
    (snapshot.value?.schemaVersion !== 1 || snapshot.value.state?.schemaVersion !== 1)
  )
    throw engineFailure('NATIVE_ENGINE_STATE_INVALID');
  if (!snapshot && !result.failure) throw engineFailure('NATIVE_ENGINE_STATE_UNAVAILABLE');

  let publication = null;
  // V4/V5 rows can lack both action and publicationId. A finalize result
  // carries its original private evidence receipt, even without a presentation.
  if (
    result.evidence ||
    (!result.failure && (action === 'finalize' || 'presentedInteractionId' in result))
  ) {
    const evidence = result.evidence;
    if (
      result.failure ||
      (action && action !== 'finalize') ||
      evidence?.key !==
        `${nativeEngineObjectPrefix(identity, 'output')}${requestId}/evidence.json.gz`
    )
      throw engineFailure('NATIVE_ENGINE_PUBLICATION_INVALID');
    publication = publicationFromEvidence(
      operation,
      await objects.read(identity, evidence, 'output'),
      evidence,
    );
  } else if (
    !action &&
    !result.failure &&
    (![result.inputSha256, result.filesSha256].every((digest) =>
      /^[a-f0-9]{64}$/.test(digest ?? ''),
    ) ||
      operation.publicationId)
  ) {
    // A historical successful command has file digests or finalize evidence.
    throw engineFailure('NATIVE_ENGINE_RESULT_INVALID');
  }
  return {
    snapshot: snapshot?.receipt,
    publication,
    status: result.failure ? 'failed' : 'completed',
  };
};

const replayOperation = async ({
  operation,
  snapshot: baseSnapshot,
  request,
  objects,
  journal,
  authorize,
}) => {
  if (operation.status !== 'running') return operationResponse(operation);
  const saved = await objects.observeOperationObject(
    operation.identity,
    operation.requestId,
    'result',
  );
  if (!saved) return { ok: true, status: 'pending', requestId: operation.requestId };
  const { snapshot, publication, status } = await savedOperation(
    operation,
    objects,
    saved,
    request.action,
  );
  if (
    publication &&
    (publication.publicationId !== request.publication?.id ||
      publication.publicationId !== request.publication.manifest?.sha256)
  )
    throw engineFailure('NATIVE_ENGINE_PUBLICATION_INVALID');
  await authorize();
  return operationResponse(
    await journal.finish({
      operation,
      // Failure before opening the workspace preserves the previous head.
      snapshot: snapshot ?? baseSnapshot,
      result: saved.receipt,
      status,
      publication,
    }),
  );
};

const observeDiscard = async (operation, writer, objects, originalRequest) => {
  const { identity, requestId } = operation;
  const saved = await objects.observeOperationObject(identity, requestId, 'result');
  if (saved && identity.writerGeneration === writer.writerGeneration)
    throw engineFailure('NATIVE_ENGINE_RESULT_SAVED');
  const discarded = {};
  if (saved) {
    const { snapshot, publication } = await savedOperation(
      operation,
      objects,
      saved,
      operation.action,
    );
    discarded.result = saved.receipt;
    if (snapshot) discarded.snapshot = snapshot;
    if (publication) {
      discarded.evidence = publication.evidence;
      discarded.publicationId = publication.publicationId;
    }
  }
  // Older rows may have neither action nor publicationId. A saved successful
  // result identifies its kind. Otherwise identify the command from the
  // original request's journal digest, without executing it or listing evidence.
  if (
    (!saved || saved.value.failure) &&
    !operation.publicationId &&
    (!operation.action || operation.action === 'finalize')
  ) {
    if (!originalRequest) throw engineFailure('NATIVE_ENGINE_ORIGINAL_REQUEST_REQUIRED');
    if (nativeEngineRequestSha256(originalRequest) !== operation.requestSha256)
      throw engineFailure('NATIVE_ENGINE_REQUEST_CONFLICT');
    const publication = originalRequest.publication;
    if (
      originalRequest.action === 'finalize' &&
      publication?.sequence === identity.sequence &&
      /^[a-f0-9]{64}$/.test(publication.id ?? '') &&
      publication.id === publication.manifest?.sha256
    )
      discarded.publicationId = publication.id;
  }
  return Object.keys(discarded).length ? discarded : null;
};

export const createNativeWorkflowEngine =
  ({
    executionStore,
    preparationStore,
    journal,
    objects,
    publications,
    interactions,
    authorizeAccess,
    loadArchive,
    loadSettings,
    jobsFactory,
    env,
    reportFailure = () => {},
    workspaceFactory = openNativeEngineWorkspace,
    runnerFactory = createNativeEngineRunner,
    gitFactory = createNativeInspectionGit,
  }) =>
  async (input, context) => {
    const request = requestValue(input);
    const scope = {
      projectId: request.identity.projectId,
      executionId: request.identity.executionId,
    };
    const row = await executionStore.get(scope);
    const identity = row ? nativeEngineIdentity(row) : null;
    const pin = row && nativeEnginePin(row.configuration.workflowEngine, row.configuration);
    if (
      !identity ||
      !same(publicIdentity(identity), request.identity) ||
      context?.invokedFunctionArn !==
        nativeEngineArn({ ...scope, bindingId: row.bindingId }, pin) ||
      context.functionVersion !== pin.version ||
      env.NATIVE_WORKFLOW_ENGINE_SHA256 !== pin.producerSha256 ||
      env.NATIVE_WORKFLOW_ENGINE_ARN !== pin.functionArn
    )
      throw engineFailure('NATIVE_ENGINE_FORBIDDEN');
    const draft = await preparationStore.get(scope);
    const authorize = async () => {
      const current = await executionStore.get(scope);
      if (
        !current ||
        !same(nativeEngineIdentity(current), identity) ||
        current.cancelRequested ||
        !(
          ['DISPATCHING', 'RUNNING'].includes(current.status) ||
          nativeConfirmedWorkspaceResume(current)
        )
      )
        throw engineFailure('NATIVE_ENGINE_WRITER_CHANGED');
      await authorizeAccess({ row: current, draft });
      return current;
    };
    await authorize();
    if (request.action === 'pending') {
      return { ok: true, operation: await journal.pending(identity, pin.producerSha256) };
    }
    if (request.action === 'abandon') {
      const receipt = await journal.abandon({
        identity,
        target: request.operation,
        producerSha256: pin.producerSha256,
        beforeAbandon: async (original) => {
          const discarded = await observeDiscard(
            original,
            identity,
            objects,
            request.originalRequest,
          );
          await authorize();
          return discarded;
        },
      });
      return { ok: true, ...receipt };
    }
    if (request.action === 'status') {
      const head = await journal.get(identity);
      return {
        ok: true,
        version: head?.version ?? 0,
        pending: head?.pending?.requestId ?? null,
      };
    }
    const opened = await journal.begin({
      identity,
      action: request.action,
      requestId: request.requestId,
      expectedVersion: request.expectedVersion,
      requestSha256: nativeEngineRequestSha256(request),
      producerSha256: pin.producerSha256,
      ...(request.action === 'finalize' && request.publication?.sequence === identity.sequence
        ? { publicationId: request.publication.id }
        : {}),
    });
    const operation = opened.operation;
    if (opened.replay) return replayOperation({ ...opened, request, objects, journal, authorize });
    const authorizeOperation = async () => {
      await authorize();
      await journal.requireRunning(operation);
    };
    const signal = operationSignal(context);
    let workspace;
    let result;
    let proof = null;
    let failure = null;
    try {
      const archive = await loadArchive({ row, draft, authorize });
      const snapshot = opened.snapshot ? await objects.read(identity, opened.snapshot) : null;
      workspace = await workspaceFactory({ archive, harness: row.configuration.harness, snapshot });
      if (!workspace.state.sourceSettings) {
        await workspace.initializeSettings(
          await loadSettings({ row, authorize }),
          row.configuration.repository.commit,
        );
      }
      const git = gitFactory({ project: workspace.project, home: workspace.home, signal });
      const jobs = jobsFactory({
        row,
        operation,
        workspace,
        archive,
        authorize: authorizeOperation,
        signal,
      });
      const sessionId = row.attemptId;
      const runner = await runnerFactory({
        project: workspace.project,
        home: workspace.home,
        engine: workspace.engine,
        signal,
        sessionId,
        external: async (invocation) => (await git.metadata(invocation)) ?? jobs.check(invocation),
        inspectCheck: (sensor) => workspace.inspectCheck(sensor),
      });
      const operationContext = {
        request,
        identity,
        row,
        draft,
        pin,
        snapshot,
        workspace,
        runner,
        git,
        jobs,
        objects,
        publications,
        interactions,
        executionStore,
        sessionId,
        authorize,
      };
      if (request.action === 'finalize')
        ({ result, proof } = await finalizeNativeEnginePublication(operationContext));
      else result = await runNativeEngineCommand(operationContext);
    } catch (error) {
      const interrupted = interruptionCode(error, signal);
      if (interrupted) {
        await workspace?.close();
        throw engineFailure(interrupted);
      }
      failure = failureCode(error);
      // Persist partial protected state with its failure; never rerun this
      // operation or label an incomplete job/check as passing. The caller sees
      // only the code; the entry records which step raised what.
      reportFailure(error, failure);
      proof = null;
      result = {
        schemaVersion: 1,
        identity,
        requestId: request.requestId,
        exitCode: 1,
        stdout: '',
        // A refused command of a turn whose reply decided nothing says so too.
        stderr: withNotice(
          `${failure}\n`,
          workspace && request.action === 'execute'
            ? nativeEngineReplyNotice(workspace.state, identity)
            : '',
        ),
        patches: [],
        failure,
      };
    }
    try {
      if (signal.aborted) throw engineFailure('NATIVE_ENGINE_CANCELLED');
      await authorizeOperation();
      const snapshot = workspace
        ? await objects.write(identity, request.requestId, 'snapshot', await workspace.snapshot())
        : (opened.snapshot ?? null);
      if (signal.aborted) throw engineFailure('NATIVE_ENGINE_CANCELLED');
      const output = await objects.write(identity, request.requestId, 'result', result, 'output');
      const finished = await journal.finish({
        operation,
        snapshot,
        result: output,
        status: failure ? 'failed' : 'completed',
        publication: proof,
      });
      return operationResponse(finished);
    } finally {
      await workspace?.close();
    }
  };
