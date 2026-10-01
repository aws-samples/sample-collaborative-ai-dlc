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
import { retryQueuedReleases } from '../shared/runtime-session.js';

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

// Validation-session identity. Backends that reuse one session across polls
// (Instances: the first invoke provisions an EC2 instance) persist it on the
// revision so the next poll reattaches instead of restarting the cold start;
// per-poll backends (microVMs) mint a fresh one every time.
const acquireValidationSession = async ({ store, backend, environment, revision }) => {
  const reuse = backend.validation.reuseSession;
  let session = reuse ? revision.validationSessionId : null;
  if (session) return { session, revision };
  session = `managed-environment-${revision.revisionId}-${randomUUID()}`.padEnd(33, '0');
  if (!reuse) return { session, revision };
  const updated = await store.updateRevision(
    environment.environmentId,
    revision.revisionId,
    { validationSessionId: session, validationAttempts: 0 },
    { fromStatus: 'VERIFYING' },
  );
  return { session, revision: updated };
};

// Runs the two validation commands on the session and applies the backend's
// session policy on the way out: a transient invoke error on a reusable
// session keeps it alive for the next poll (bounded by maxAttempts); every
// other outcome — success, hard failure, exhausted budget — releases it. The
// poller itself never decides what a transient error is or what "release"
// means for the compute type.
const runValidationCommands = async ({
  store,
  backend,
  environment,
  revision,
  runtimeClient,
  cleanupStore,
  session,
}) => {
  let retain = false;
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
    const transient =
      backend.validation.reuseSession &&
      (backend.validation.isTransientInvokeError(error) ||
        RETRYABLE_CONTROL_ERRORS.has(error?.name));
    if (!transient) throw error;
    const attempts = Number(revision.validationAttempts ?? 0) + 1;
    if (attempts > backend.validation.maxAttempts) {
      throw new Error(
        `runtime validation did not complete within ${backend.validation.maxAttempts} polls: ${error?.message ?? error}`,
        { cause: error },
      );
    }
    retain = true;
    await store.updateRevision(
      environment.environmentId,
      revision.revisionId,
      { validationAttempts: attempts },
      { fromStatus: 'VERIFYING' },
    );
    throw error;
  } finally {
    if (!retain) {
      await backend.releaseValidationSession({
        runtimeClient,
        revision,
        sessionId: session,
        cleanupStore,
        environmentId: environment.environmentId,
      });
    }
  }
};

const verifyRuntime = async ({
  store,
  environment,
  revision,
  controlClient = control,
  runtimeClient = runtime,
  cleanupStore = defaultCleanupStore,
}) => {
  const backend = runtimeBackendFor(environment);
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
        if (RETRYABLE_CONTROL_ERRORS.has(error?.name)) {
          return { environment, revision, pending: true };
        }
        throw error;
      }
      if (runtimeState.status === 'CREATING' || runtimeState.status === 'UPDATING') {
        return { environment, revision, pending: true };
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
        if (RETRYABLE_CONTROL_ERRORS.has(error?.name)) {
          return { environment, revision, pending: true };
        }
        throw error;
      }
      if (!endpoint?.agentRuntimeEndpointArn) {
        return { environment, revision, pending: true };
      }
      const endpointRevision = await store.updateRevision(
        environment.environmentId,
        revision.revisionId,
        {
          runtimeEndpoint: endpoint.endpointName ?? revision.runtimeEndpoint,
          runtimeEndpointArn: endpoint.agentRuntimeEndpointArn,
        },
        { fromStatus: 'VERIFYING' },
      );
      return { environment, revision: endpointRevision, pending: true };
    }
    const endpoint = await controlClient.send(
      new GetAgentRuntimeEndpointCommand({
        agentRuntimeId: revision.runtimeId,
        endpointName: revision.runtimeEndpoint,
      }),
    );
    if (endpoint.status === 'CREATING' || endpoint.status === 'UPDATING') {
      return { environment, revision };
    }
    if (endpoint.status !== 'READY') {
      throw new Error(endpoint.failureReason || `endpoint is ${endpoint.status}`);
    }
    const { session, revision: sessionRevision } = await acquireValidationSession({
      store,
      backend,
      environment,
      revision,
    });
    revision = sessionRevision;
    const { capabilities, deterministic } = await runValidationCommands({
      store,
      backend,
      environment,
      revision,
      runtimeClient,
      cleanupStore,
      session,
    });
    const completedAt = new Date().toISOString();
    const elevatedFindings =
      Number(revision.scanFindings?.severityCounts?.CRITICAL ?? 0) +
        Number(revision.scanFindings?.severityCounts?.HIGH ?? 0) >
      0;
    const ready = await store.updateRevision(
      environment.environmentId,
      revision.revisionId,
      {
        status: 'READY',
        validationSessionId: null,
        validationAttempts: null,
        verification: {
          status: 'PASSED',
          completedAt,
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
          deterministicCommand: 'PASSED',
        },
        failure: null,
      },
      { fromStatus: 'VERIFYING' },
    );
    await updateEnvironmentForRevision(store, environment.environmentId, revision.revisionId, {
      status: 'READY',
    });
    return { environment, revision: ready };
  } catch (error) {
    if (
      RETRYABLE_CONTROL_ERRORS.has(error?.name) ||
      backend.validation.isTransientInvokeError(error)
    ) {
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
        'runtime_validation_failed',
        error.message,
      ),
    };
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
