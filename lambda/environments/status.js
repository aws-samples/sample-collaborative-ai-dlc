import { createHash, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import {
  ECRClient,
  DescribeImagesCommand,
  DescribeImageScanFindingsCommand,
} from '@aws-sdk/client-ecr';
import {
  BedrockAgentCoreControlClient,
  CreateAgentRuntimeCommand,
  CreateAgentRuntimeEndpointCommand,
  GetAgentRuntimeCommand,
  GetAgentRuntimeEndpointCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  RETRYABLE_ECR_ERRORS,
  createBuildLifecycleHandler,
  streamToString,
  summarizeScanFindings,
} from './build-lifecycle.js';
import { createEnvironmentStore } from './store.js';
import { evaluateScanFindings } from './fixed-tool-recipe.js';
import { runtimeBackendFor } from './runtime-backends/index.js';
import { createSessionCleanupStore } from '../shared/session-cleanup-store.js';
import { SessionReleaseHandoffError, retryQueuedReleases } from '../shared/runtime-session.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ecr = new ECRClient({});
const control = new BedrockAgentCoreControlClient({});
const runtime = new BedrockAgentCoreClient({});
const defaultStore = createEnvironmentStore({ ddb });
const defaultCleanupStore = createSessionCleanupStore({ ddb });

const logger = new Logger({ persistentKeys: { component: 'environments' } });

const parseJsonEnv = (name, fallback) => {
  try {
    return JSON.parse(process.env[name] || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
};

const runtimeNameFor = (environmentId, revisionId) => {
  const readable = String(environmentId)
    .replace(/[^A-Za-z0-9_]/g, '_')
    .slice(0, 20);
  const identity = createHash('sha256')
    .update(`${environmentId}\0${revisionId}`)
    .digest('hex')
    .slice(0, 16);
  return `managed_${readable}_${identity}`;
};

const endpointNameFor = (revisionId) =>
  `revision_${revisionId}`
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/^[^A-Za-z]+/, 'rev_')
    .slice(0, 48);

const clientTokenFor = (...parts) => createHash('sha256').update(parts.join('\0')).digest('hex');

const RETRYABLE_CONTROL_ERRORS = new Set([
  'ConflictException',
  'InternalServerException',
  'ResourceNotFoundException',
  'ServiceException',
  'ThrottlingException',
  'TooManyRequestsException',
]);

const isConditionalFailure = (error) => error?.name === 'ConditionalCheckFailedException';

const securityFindingsAcceptedAt = (revision) =>
  revision.securityFindingsAcceptedAt ?? revision.highFindingsAcknowledgedAt ?? null;

const updateEnvironmentForRevision = async (store, environmentId, revisionId, patch) => {
  try {
    return await store.updateEnvironment(environmentId, patch, {
      ifCurrentRevisionId: revisionId,
      unlessRetired: true,
    });
  } catch (error) {
    if (isConditionalFailure(error)) return null;
    throw error;
  }
};

const invokeValidationCommand = async ({ runtimeClient, revision, payload, sessionId }) => {
  const response = await runtimeClient.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: revision.runtimeArn,
      qualifier: revision.runtimeEndpoint,
      runtimeSessionId: sessionId,
      contentType: 'application/json',
      accept: 'application/json',
      payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
  const text = await streamToString(response.response);
  return text ? JSON.parse(text) : {};
};

const failRevision = async (store, environmentId, revision, reason, detail = null) => {
  let failed;
  try {
    failed = await store.updateRevision(
      environmentId,
      revision.revisionId,
      {
        status: 'FAILED',
        validationSessionId: null,
        validationAttempts: null,
        failure: {
          reason,
          detail,
          failedAt: new Date().toISOString(),
        },
      },
      { fromStatus: revision.status },
    );
  } catch (error) {
    // Another writer moved the revision since this caller read it — e.g. an
    // overlapping status poll (validation on Instances outlasts the 1-minute
    // schedule) that already validated it and marked it READY. Its outcome
    // wins; this failure observation is stale.
    if (!isConditionalFailure(error)) throw error;
    return (await store.getRevision(environmentId, revision.revisionId)) ?? revision;
  }
  await updateEnvironmentForRevision(store, environmentId, revision.revisionId, {
    status: 'FAILED',
  });
  return failed;
};

const createRuntimeForRevision = async ({
  store,
  environment,
  revision,
  controlClient = control,
}) => {
  let created;
  let capacityProviderArn = null;
  try {
    const resourceTags = {
      ...parseJsonEnv('MANAGED_RUNTIME_TAGS', {}),
      ManagedEnvironment: environment.environmentId,
      ManagedEnvironmentRevision: revision.revisionId,
    };
    const environmentVariables = {
      ...parseJsonEnv('MANAGED_RUNTIME_ENVIRONMENT', {}),
      RUNTIME_COMPATIBILITY_VERSION: revision.runtimeCompatibilityVersion,
    };
    // The backend owns everything compute-specific about the runtime: network
    // vs capacity provider, session storage vs persistent volume, and any
    // dependency that must exist first (a capacity provider still CREATING
    // reports pending and the poller re-enters on the next tick).
    const backend = runtimeBackendFor(environment);
    const prepared = await backend.prepareRuntime({ controlClient });
    if (prepared.pending) return { environment, revision, pending: true };
    capacityProviderArn = prepared.capacityProviderArn ?? null;
    const computeParams = prepared.runtimeParams;
    created = await controlClient.send(
      new CreateAgentRuntimeCommand({
        agentRuntimeName: runtimeNameFor(environment.environmentId, revision.revisionId),
        agentRuntimeArtifact: {
          containerConfiguration: {
            containerUri: `${revision.imageUri}@${revision.imageDigest}`,
          },
        },
        roleArn: process.env.MANAGED_RUNTIME_ROLE_ARN,
        protocolConfiguration: { serverProtocol: 'HTTP' },
        lifecycleConfiguration: {
          idleRuntimeSessionTimeout: 900,
          maxLifetime: 28800,
        },
        ...computeParams,
        environmentVariables,
        tags: resourceTags,
        clientToken: clientTokenFor('runtime', environment.environmentId, revision.revisionId),
      }),
    );
  } catch (error) {
    if (RETRYABLE_CONTROL_ERRORS.has(error?.name)) {
      return { environment, revision, pending: true };
    }
    return {
      environment,
      revision: await failRevision(
        store,
        environment.environmentId,
        revision,
        'runtime_creation_failed',
        error.message,
      ),
    };
  }
  if (!created?.agentRuntimeArn || !created.agentRuntimeId || !created.agentRuntimeVersion) {
    return {
      environment,
      revision: await failRevision(
        store,
        environment.environmentId,
        revision,
        'runtime_creation_failed',
        'AgentCore did not return a complete runtime identity',
      ),
    };
  }
  let verifying;
  try {
    verifying = await store.updateRevision(
      environment.environmentId,
      revision.revisionId,
      {
        status: 'VERIFYING',
        runtimeArn: created.agentRuntimeArn,
        runtimeId: created.agentRuntimeId,
        runtimeVersion: created.agentRuntimeVersion,
        runtimeEndpoint: endpointNameFor(revision.revisionId),
        runtimeEndpointArn: null,
        capacityProviderArn,
        failure: null,
      },
      { fromStatus: revision.status },
    );
  } catch (error) {
    if (isConditionalFailure(error)) {
      const latest = await store.getRevision(environment.environmentId, revision.revisionId);
      return { environment, revision: latest ?? revision, ignored: true };
    }
    throw error;
  }
  await updateEnvironmentForRevision(store, environment.environmentId, revision.revisionId, {
    status: 'VERIFYING',
  });
  return { environment, revision: verifying };
};

export const continueRevisionValidation = async ({
  store = defaultStore,
  environment,
  revision,
  controlClient = control,
}) =>
  createRuntimeForRevision({
    store,
    environment,
    revision,
    controlClient,
  });

const inspectImage = async ({
  store,
  environment,
  revision,
  ecrClient = ecr,
  controlClient = control,
}) => {
  const legacySecurityFailure =
    revision.status === 'FAILED' &&
    revision.failure?.reason === 'critical_vulnerability_findings' &&
    Boolean(revision.imageDigest);
  if (!['BUILDING', 'SCANNING'].includes(revision.status) && !legacySecurityFailure) {
    return { environment, revision, ignored: true };
  }
  try {
    const repositoryName = process.env.ENVIRONMENT_ECR_REPOSITORY_NAME;
    const described = await ecrClient.send(
      new DescribeImagesCommand({
        repositoryName,
        imageIds: [{ imageTag: revision.revisionId }],
      }),
    );
    const image = described.imageDetails?.[0];
    if (!image?.imageDigest) return { environment, revision, pending: true };
    const maxImageBytes = Number(process.env.MAX_ENVIRONMENT_IMAGE_MB || 2048) * 1024 * 1024;
    if (Number(image.imageSizeInBytes ?? 0) > maxImageBytes) {
      return {
        environment,
        revision: await failRevision(
          store,
          environment.environmentId,
          revision,
          'image_size_exceeded',
          `Image is ${image.imageSizeInBytes} bytes; maximum is ${maxImageBytes}`,
        ),
      };
    }
    const imageUri = process.env.ENVIRONMENT_ECR_REPOSITORY_URI;
    let scanning = revision;
    if (revision.status === 'BUILDING') {
      scanning = await store.updateRevision(
        environment.environmentId,
        revision.revisionId,
        {
          status: 'SCANNING',
          imageUri,
          imageDigest: image.imageDigest,
          imageSizeBytes: image.imageSizeInBytes ?? null,
          failure: null,
        },
        { fromStatus: 'BUILDING' },
      );
    }
    const scan = await ecrClient.send(
      new DescribeImageScanFindingsCommand({
        repositoryName,
        imageId: { imageDigest: image.imageDigest },
      }),
    );
    const scanStatus = scan.imageScanStatus?.status;
    if (scanStatus === 'IN_PROGRESS' || scanStatus === 'PENDING') {
      return { environment, revision: scanning };
    }
    if (scanStatus !== 'COMPLETE' && scanStatus !== 'ACTIVE') {
      return {
        environment,
        revision: await failRevision(
          store,
          environment.environmentId,
          scanning,
          'image_scan_failed',
          scan.imageScanStatus?.description ?? scanStatus ?? 'unknown scan state',
        ),
      };
    }
    const severityCounts = scan.imageScanFindings?.findingSeverityCounts ?? {};
    const verdict = evaluateScanFindings(
      severityCounts,
      Boolean(securityFindingsAcceptedAt(scanning)),
    );
    const scanFindings = {
      status: scanStatus,
      severityCounts,
      findings: summarizeScanFindings(scan),
      findingsTruncated: Boolean(scan.nextToken),
      evaluatedAt: new Date().toISOString(),
      imageDigest: image.imageDigest,
    };
    if (!verdict.allowed) {
      const gated = await store.updateRevision(
        environment.environmentId,
        scanning.revisionId,
        {
          status: verdict.status,
          scanFindings,
          failure: null,
        },
        { fromStatus: scanning.status },
      );
      await updateEnvironmentForRevision(store, environment.environmentId, scanning.revisionId, {
        status: verdict.status,
      });
      return { environment, revision: gated };
    }
    const readyForRuntime = await store.updateRevision(
      environment.environmentId,
      scanning.revisionId,
      { scanFindings },
      { fromStatus: scanning.status },
    );
    return createRuntimeForRevision({
      store,
      environment,
      revision: readyForRuntime,
      controlClient,
    });
  } catch (error) {
    if (RETRYABLE_ECR_ERRORS.has(error?.name)) {
      return { environment, revision, pending: true };
    }
    if (isConditionalFailure(error)) {
      const latest = await store.getRevision(environment.environmentId, revision.revisionId);
      return { environment, revision: latest ?? revision, ignored: true };
    }
    return {
      environment,
      revision: await failRevision(
        store,
        environment.environmentId,
        revision,
        'image_inspection_failed',
        error.message,
      ),
    };
  }
};

// A poll holds a revision's verification lease for at most this long. It is
// above the status Lambda's 300 s timeout, so a live holder never loses the
// lease mid-poll and a crashed one blocks the revision for one extra minute.
const VERIFICATION_LEASE_MS = 6 * 60 * 1000;

// Validation-session identity, minted under the verification lease. Backends
// that reuse one session across polls (Instances: the first invoke provisions
// an EC2 instance) persist it on the revision so the next poll reattaches
// instead of restarting the cold start; the lease guarantees no other poll
// mints a competing id. Per-poll backends (microVMs) use a fresh one.
const validationSessionFor = async ({ store, backend, environment, revision }) => {
  if (backend.validation.reuseSession && revision.validationSessionId) {
    return { session: revision.validationSessionId, revision };
  }
  const session = `managed-environment-${revision.revisionId}-${randomUUID()}`.padEnd(33, '0');
  if (!backend.validation.reuseSession) return { session, revision };
  const updated = await store.updateRevision(
    environment.environmentId,
    revision.revisionId,
    { validationSessionId: session, validationAttempts: 0 },
    { fromStatus: 'VERIFYING' },
  );
  return { session, revision: updated };
};

// The two validation commands. Returns the outcome instead of throwing, so
// the caller decides retain vs release before anything else happens.
const attemptValidation = async ({ runtimeClient, revision, session }) => {
  try {
    const capabilities = await invokeValidationCommand({
      runtimeClient,
      revision,
      sessionId: session,
      payload: { command: 'capabilities' },
    });
    if (capabilities.ok !== true || !Array.isArray(capabilities.clis)) {
      throw new Error('capability validation failed');
    }
    const nonce = `check-${revision.revisionId}`;
    const deterministic = await invokeValidationCommand({
      runtimeClient,
      revision,
      sessionId: session,
      payload: { command: 'managed-runtime-check', nonce },
    });
    if (
      deterministic.ok !== true ||
      deterministic.nonce !== nonce ||
      deterministic.compatibilityVersion !== revision.runtimeCompatibilityVersion ||
      deterministic.nonRoot !== true
    ) {
      throw new Error('deterministic runtime validation failed');
    }
    return { capabilities, deterministic };
  } catch (error) {
    return { error };
  }
};

const isRetryableValidationError = (backend, error) =>
  RETRYABLE_CONTROL_ERRORS.has(error?.name) || backend.validation.isTransientInvokeError(error);

const verifyRuntime = async (args) => {
  const { store, environment, revision } = args;
  const owner = randomUUID();
  const leased = await store.acquireVerificationLease(
    environment.environmentId,
    revision.revisionId,
    { owner, ttlMs: VERIFICATION_LEASE_MS },
  );
  // Another poll is verifying this revision (or it already left VERIFYING).
  if (!leased) return { environment, revision, pending: true, leaseHeld: false };
  try {
    return await verifyLeasedRuntime({ ...args, revision: leased });
  } finally {
    await store
      .releaseVerificationLease(environment.environmentId, revision.revisionId, owner)
      .catch((error) =>
        logger.warn('verification lease release failed — it expires on its own', {
          environmentId: environment.environmentId,
          revisionId: revision.revisionId,
          error: error?.message ?? String(error),
        }),
      );
  }
};

// Finalizing a validation is a three-step transition, each step recoverable
// from the revision row alone (the poll can die or a write can fail between
// any two):
//
//   1. RECORD   Still VERIFYING, the decided outcome (READY verification or
//               failure) is written together with moving the session id from
//               `validationSessionId` (reusable) to
//               `finalizingValidationSessionId` (retired, never reused).
//   2. RELEASE  The retired session is deleted or durably queued. Only now is
//               the release irreversible — no verifier can pick that id up
//               again, so a concurrent queue cleanup cannot pull a session out
//               from under one.
//   3. APPLY    The terminal READY/FAILED write clears both fields.
//
// A poll that finds a recorded outcome resumes at step 2. Step 2 is
// idempotent (an already-deleted session is "absent"), so repeating it after a
// lost step-3 write is safe; until step 3 lands the revision row remains the
// session's cleanup owner.
const recordFinalization = async ({ store, environment, revision, session, outcome }) =>
  store.updateRevision(
    environment.environmentId,
    revision.revisionId,
    {
      validationSessionId: null,
      validationAttempts: null,
      finalizingValidationSessionId: session ?? null,
      pendingFinalization: outcome,
    },
    { fromStatus: 'VERIFYING' },
  );

const applyFinalization = async ({ store, environment, revision, outcome }) => {
  const cleared = {
    validationSessionId: null,
    validationAttempts: null,
    finalizingValidationSessionId: null,
    pendingFinalization: null,
  };
  if (outcome.status === 'READY') {
    const ready = await store.updateRevision(
      environment.environmentId,
      revision.revisionId,
      { ...cleared, status: 'READY', verification: outcome.verification, failure: null },
      { fromStatus: 'VERIFYING' },
    );
    await updateEnvironmentForRevision(store, environment.environmentId, revision.revisionId, {
      status: 'READY',
    });
    return ready;
  }
  const failed = await store.updateRevision(
    environment.environmentId,
    revision.revisionId,
    { ...cleared, status: 'FAILED', failure: outcome.failure },
    { fromStatus: 'VERIFYING' },
  );
  await updateEnvironmentForRevision(store, environment.environmentId, revision.revisionId, {
    status: 'FAILED',
  });
  return failed;
};

const failureOutcome = (detail) => ({
  status: 'FAILED',
  failure: {
    reason: 'runtime_validation_failed',
    detail,
    failedAt: new Date().toISOString(),
  },
});

const verifyLeasedRuntime = async ({
  store,
  environment,
  revision,
  controlClient = control,
  runtimeClient = runtime,
  cleanupStore = defaultCleanupStore,
}) => {
  const backend = runtimeBackendFor(environment);
  const ids = { environmentId: environment.environmentId, revisionId: revision.revisionId };

  // Session ownership for this poll. A session the revision already records
  // (retained by an earlier poll, possibly after a failed release) is adopted
  // HERE, before anything can fail, so every exit below accounts for it.
  //   persisted  the id is on the revision row; returning `pending` leaves it
  //              owned by the row.
  //   ephemeral  a per-poll id (microVMs) that only this poll knows; it must
  //              be stopped before any exit.
  let held = revision.validationSessionId
    ? { id: revision.validationSessionId, persisted: true }
    : null;

  const release = async (sessionId) => {
    try {
      await backend.releaseValidationSession({
        runtimeClient,
        revision,
        sessionId,
        cleanupStore,
        environmentId: environment.environmentId,
      });
      return true;
    } catch (error) {
      if (!(error instanceof SessionReleaseHandoffError)) throw error;
      logger.error(
        'Validation session release could not be handed off — keeping ownership',
        error,
        {
          ...ids,
          sessionId,
        },
      );
      return false;
    }
  };

  // Steps 2 + 3 of the finalization (see recordFinalization).
  const completeFinalization = async (recorded) => {
    const sessionId = recorded.finalizingValidationSessionId;
    if (sessionId && !(await release(sessionId))) {
      return { environment, revision: recorded, pending: true };
    }
    try {
      return {
        environment,
        revision: await applyFinalization({
          store,
          environment,
          revision: recorded,
          outcome: recorded.pendingFinalization,
        }),
      };
    } catch (error) {
      if (isConditionalFailure(error)) {
        const latest = await store.getRevision(environment.environmentId, revision.revisionId);
        return { environment, revision: latest ?? recorded, ignored: true };
      }
      // The outcome and retired id stay recorded; the next poll re-applies.
      logger.warn('Validation finalization write failed — resuming on the next poll', {
        ...ids,
        error: error?.message ?? String(error),
      });
      return { environment, revision: recorded, pending: true };
    }
  };

  // Every terminal outcome goes through here.
  const finalize = async (outcome) => {
    if (held && !held.persisted) {
      // Ephemeral (microVMs): nothing reuses the id, a stop is the release.
      if (!(await release(held.id))) return { environment, revision, pending: true };
      held = null;
    }
    let recorded;
    try {
      recorded = await recordFinalization({
        store,
        environment,
        revision,
        session: held?.id,
        outcome,
      });
    } catch (error) {
      if (isConditionalFailure(error)) {
        const latest = await store.getRevision(environment.environmentId, revision.revisionId);
        return { environment, revision: latest ?? revision, ignored: true };
      }
      // Nothing was released: the session (if any) is still owned by the
      // row, either as validationSessionId or — if the write actually landed
      // — as finalizingValidationSessionId. Both are picked up next poll.
      logger.warn('Validation outcome could not be recorded — retrying on the next poll', {
        ...ids,
        error: error?.message ?? String(error),
      });
      return { environment, revision, pending: true };
    }
    held = null;
    return completeFinalization(recorded);
  };

  // Pending return. A persisted session stays owned by the row; an ephemeral
  // one is stopped first.
  const pending = async (current = revision) => {
    if (held && !held.persisted) {
      if (!(await release(held.id))) return { environment, revision: current, pending: true };
      held = null;
    }
    return { environment, revision: current, pending: true };
  };

  // A previous poll decided the outcome but did not finish: resume.
  if (revision.pendingFinalization) return completeFinalization(revision);

  try {
    if (!revision.runtimeArn || !revision.runtimeId || !revision.runtimeVersion) {
      throw new Error('runtime identity is incomplete');
    }
    if (!revision.runtimeEndpointArn) {
      let runtimeState;
      try {
        runtimeState = await controlClient.send(
          new GetAgentRuntimeCommand({
            agentRuntimeId: revision.runtimeId,
            agentRuntimeVersion: revision.runtimeVersion,
          }),
        );
      } catch (error) {
        if (RETRYABLE_CONTROL_ERRORS.has(error?.name)) return pending();
        throw error;
      }
      if (runtimeState.status === 'CREATING' || runtimeState.status === 'UPDATING') {
        return pending();
      }
      if (runtimeState.status !== 'READY') {
        throw new Error(runtimeState.failureReason || `runtime is ${runtimeState.status}`);
      }
      let endpoint;
      try {
        const resourceTags = {
          ...parseJsonEnv('MANAGED_RUNTIME_TAGS', {}),
          ManagedEnvironment: environment.environmentId,
          ManagedEnvironmentRevision: revision.revisionId,
        };
        endpoint = await controlClient.send(
          new CreateAgentRuntimeEndpointCommand({
            agentRuntimeId: revision.runtimeId,
            name: revision.runtimeEndpoint,
            agentRuntimeVersion: revision.runtimeVersion,
            tags: resourceTags,
            clientToken: clientTokenFor('endpoint', environment.environmentId, revision.revisionId),
          }),
        );
      } catch (error) {
        if (RETRYABLE_CONTROL_ERRORS.has(error?.name)) return pending();
        throw error;
      }
      if (!endpoint?.agentRuntimeEndpointArn) return pending();
      const endpointRevision = await store.updateRevision(
        environment.environmentId,
        revision.revisionId,
        {
          runtimeEndpoint: endpoint.endpointName ?? revision.runtimeEndpoint,
          runtimeEndpointArn: endpoint.agentRuntimeEndpointArn,
        },
        { fromStatus: 'VERIFYING' },
      );
      return pending(endpointRevision);
    }
    const endpoint = await controlClient.send(
      new GetAgentRuntimeEndpointCommand({
        agentRuntimeId: revision.runtimeId,
        endpointName: revision.runtimeEndpoint,
      }),
    );
    if (endpoint.status === 'CREATING' || endpoint.status === 'UPDATING') {
      // Nothing minted yet; an adopted session stays owned by the row.
      return { environment, revision };
    }
    if (endpoint.status !== 'READY') {
      throw new Error(endpoint.failureReason || `endpoint is ${endpoint.status}`);
    }
    if (!held) {
      const minted = await validationSessionFor({ store, backend, environment, revision });
      revision = minted.revision;
      held = { id: minted.session, persisted: backend.validation.reuseSession };
    }
    let outcome = await attemptValidation({ runtimeClient, revision, session: held.id });

    // A reusable session that hit a transient error (the instance is still
    // booting) is RETAINED for the next poll, within the backend's budget.
    if (
      outcome.error &&
      backend.validation.reuseSession &&
      isRetryableValidationError(backend, outcome.error)
    ) {
      const attempts = Number(revision.validationAttempts ?? 0) + 1;
      if (attempts <= backend.validation.maxAttempts) {
        try {
          await store.updateRevision(
            environment.environmentId,
            revision.revisionId,
            { validationAttempts: attempts },
            { fromStatus: 'VERIFYING' },
          );
        } catch (error) {
          if (!isConditionalFailure(error)) {
            // The id is on the row; only the counter was not bumped.
            logger.warn('Validation attempt counter not updated', {
              ...ids,
              error: error?.message ?? String(error),
            });
          }
        }
        return pending();
      }
      outcome = {
        error: new Error(
          `runtime validation did not complete within ${backend.validation.maxAttempts} polls: ${outcome.error?.message ?? outcome.error}`,
          { cause: outcome.error },
        ),
      };
    }

    if (outcome.error) {
      // microVMs: stop this poll's session; a fresh one next poll.
      if (isRetryableValidationError(backend, outcome.error)) return pending();
      return finalize(failureOutcome(outcome.error.message));
    }
    const { capabilities, deterministic } = outcome;
    const elevatedFindings =
      Number(revision.scanFindings?.severityCounts?.CRITICAL ?? 0) +
        Number(revision.scanFindings?.severityCounts?.HIGH ?? 0) >
      0;
    return finalize({
      status: 'READY',
      verification: {
        status: 'PASSED',
        completedAt: new Date().toISOString(),
        imageBuild: 'PASSED',
        baseDigest: 'PASSED',
        architecture: backend.architecture,
        nonRoot: deterministic.nonRoot === true,
        workspaceWritable: deterministic.workspaceWritable === true,
        protectedRuntime: deterministic.protectedRuntime === true,
        sbom: 'PASSED',
        securityScan:
          elevatedFindings && securityFindingsAcceptedAt(revision) ? 'ACCEPTED' : 'PASSED',
        containerStartup: 'PASSED',
        containerShutdown: 'PASSED',
        toolBuilds: 'PASSED',
        endpoint: 'PASSED',
        capabilities: capabilities.clis,
        ...(capabilities.agentAuthProtocol
          ? {
              agentAuthProtocol: capabilities.agentAuthProtocol,
              agentAuthModes: capabilities.agentAuthModes ?? [],
            }
          : {}),
        deterministicCommand: 'PASSED',
      },
    });
  } catch (error) {
    if (RETRYABLE_CONTROL_ERRORS.has(error?.name)) return pending();
    if (isConditionalFailure(error)) {
      // Another writer moved the revision out of VERIFYING. A persisted
      // session stays recorded on the row (the writer that moved it owns the
      // row); an ephemeral one is stopped.
      await pending();
      const latest = await store.getRevision(environment.environmentId, revision.revisionId);
      return { environment, revision: latest ?? revision, ignored: true };
    }
    // Pre-invoke and unexpected failures end the validation through the same
    // recoverable finalization as a failed invoke: the adopted session is
    // retired and released, never silently dropped.
    return finalize(failureOutcome(error.message));
  }
};

const handleBuildEvent = async ({ store, event, ecrClient, controlClient }) => {
  const buildId = event.detail?.['build-id'];
  if (!buildId) return { ignored: true };
  const lookup = await store.getLookup('BUILD', buildId);
  if (!lookup) return { ignored: true };
  const environment = await store.getEnvironment(lookup.environmentId);
  const revision = await store.getRevision(lookup.environmentId, lookup.revisionId);
  if (!environment || !revision) return { ignored: true };
  const status = event.detail?.['build-status'];
  if (status === 'SUCCEEDED') {
    if (!['BUILDING', 'SCANNING'].includes(revision.status)) {
      return { environment, revision, ignored: true };
    }
    return inspectImage({
      store,
      environment,
      revision,
      ecrClient,
      controlClient,
    });
  }
  if (['FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT'].includes(status)) {
    if (!['QUEUED', 'BUILDING'].includes(revision.status)) {
      return { environment, revision, ignored: true };
    }
    return {
      environment,
      revision: await failRevision(
        store,
        environment.environmentId,
        revision,
        'image_build_failed',
        status,
      ),
    };
  }
  return { environment, revision };
};

const handleScanEvent = async ({ store, event, ecrClient, controlClient }) => {
  const imageDigest = event.detail?.['image-digest'];
  if (!imageDigest) return { ignored: true };
  const lookup = await store.getLookup('IMAGE', imageDigest);
  if (!lookup) return { ignored: true };
  const environment = await store.getEnvironment(lookup.environmentId);
  const revision = await store.getRevision(lookup.environmentId, lookup.revisionId);
  if (!environment || !revision || revision.status !== 'SCANNING') return { ignored: true };
  return inspectImage({
    store,
    environment,
    revision,
    ecrClient,
    controlClient,
  });
};

const pollManagedEnvironmentStatus = async ({
  store,
  ecrClient,
  controlClient,
  runtimeClient,
  cleanupStore = defaultCleanupStore,
}) => {
  const results = [];
  // Each item is isolated: the poll is the ONLY driver of every transition
  // (BUILDING/SCANNING inspection, acknowledged security findings → runtime
  // creation, VERIFYING validation, session cleanup), so one revision whose
  // handling throws unexpectedly must not abort the passes behind it — that
  // starves every other revision on every subsequent poll and presents as
  // "accepted the findings and nothing happens".
  const guarded = async (pass, revision, fn) => {
    try {
      results.push(await fn());
    } catch (error) {
      logger.error('Managed environment poll item failed', error, {
        pass,
        environmentId: revision.environmentId,
        revisionId: revision.revisionId,
      });
      results.push({
        environmentId: revision.environmentId,
        revisionId: revision.revisionId,
        pass,
        error: error?.message ?? String(error),
      });
    }
  };
  for (const status of ['BUILDING', 'SCANNING']) {
    const revisions = await store.listRevisionsByStatus(status);
    for (const revision of revisions) {
      const environment = await store.getEnvironment(revision.environmentId);
      if (!environment) continue;
      await guarded('inspect', revision, () =>
        inspectImage({
          store,
          environment,
          revision,
          ecrClient,
          controlClient,
        }),
      );
    }
  }
  const legacySecurityFailures = await store.listRevisionsByStatus('FAILED');
  for (const revision of legacySecurityFailures.filter(
    (candidate) =>
      candidate.failure?.reason === 'critical_vulnerability_findings' &&
      Boolean(candidate.imageDigest),
  )) {
    const environment = await store.getEnvironment(revision.environmentId);
    if (!environment) continue;
    await guarded('legacy-security', revision, () =>
      inspectImage({
        store,
        environment,
        revision,
        ecrClient,
        controlClient,
      }),
    );
  }
  const acknowledged = await store.listRevisionsByStatus('SECURITY_REVIEW');
  for (const revision of acknowledged.filter((candidate) =>
    securityFindingsAcceptedAt(candidate),
  )) {
    const environment = await store.getEnvironment(revision.environmentId);
    if (!environment) continue;
    await guarded('acknowledged', revision, () =>
      createRuntimeForRevision({
        store,
        environment,
        revision,
        controlClient,
      }),
    );
  }
  const verifying = await store.listRevisionsByStatus('VERIFYING');
  for (const revision of verifying) {
    const environment = await store.getEnvironment(revision.environmentId);
    if (!environment) continue;
    await guarded('verify', revision, () =>
      verifyRuntime({
        store,
        environment,
        revision,
        controlClient,
        runtimeClient,
        cleanupStore,
      }),
    );
  }
  // Releases that failed earlier (validation sessions, deleted intents) are
  // queued on the shared cleanup store; the poller is the retry driver.
  const sessionCleanups = await retryQueuedReleases({ client: runtimeClient, cleanupStore });
  return { checked: results.length, results, sessionCleanups };
};

export const createStatusHandler = ({
  store = defaultStore,
  ecrClient = ecr,
  controlClient = control,
  runtimeClient = runtime,
  cleanupStore = defaultCleanupStore,
} = {}) =>
  createBuildLifecycleHandler({
    label: 'Managed environment',
    poll: () =>
      pollManagedEnvironmentStatus({
        store,
        ecrClient,
        controlClient,
        runtimeClient,
        cleanupStore,
      }),
    handleBuildEvent: (event) =>
      handleBuildEvent({
        store,
        event,
        ecrClient,
        controlClient,
      }),
    handleScanEvent: (event) =>
      handleScanEvent({
        store,
        event,
        ecrClient,
        controlClient,
      }),
  });

export const handler = createStatusHandler();

export {
  inspectImage,
  verifyRuntime,
  createRuntimeForRevision,
  pollManagedEnvironmentStatus,
  runtimeNameFor,
  endpointNameFor,
};
