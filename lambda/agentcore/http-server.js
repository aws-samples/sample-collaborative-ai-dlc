// AgentCore Runtime HTTP server — the container contract.
//
// Bedrock AgentCore Runtime requires a container that listens on 0.0.0.0:8080
// (ARM64) and serves:
//   GET  /ping         → 200 { status: "Healthy" | "HealthyBusy", time_of_last_update }
//                        HealthyBusy keeps the runtime SESSION alive while a stage
//                        runs (a stage can take many minutes).
//   POST /invocations  → run a command; JSON in, JSON out.
//
// The SAME session id routes to the SAME microVM, so the git checkout from
// init-ws persists across run-stage invocations — that's how we keep filesystem
// state between stages without our own pool/lease machinery.
//
// Invocation payloads:
//   { "command": "init-ws",  ...initWs args }
//   { "command": "run-stage", ...runStage args }
//   { "command": "run-stage-start", ...runStage args, stageCallbackId }
//     → accepts in ms, runs the stage as a background job, completes the
//       orchestrator's durable callback on exit (docs/v2-parallel.md WP1).
//       The busy tracker is held for the job's lifetime so /ping reports
//       HealthyBusy and AgentCore keeps the session alive while it runs.
//   { "command": "promote-units", projectId, intentId, executionId, stageInstanceId? }
//     → WP3: re-parse the approved unit-of-work-dependency artifact into the
//       UNITPLAN/UNIT scheduling rows + the Neptune traceability mirror.
//   { "command": "derive-artifacts", projectId, intentId, executionId, stageInstanceId?,
//     artifactTypes?, enrichment?, requestedCli?, cliModels? }
//     → rebuild the fine-grained graph projection from canonical artifact markdown.
//       `enrichment` ('off'|'llm') is the Admin toggle snapshotted on the execution;
//       'llm' adds bounded summary metadata via a one-shot agent-CLI call.
//   { "command": "create-workflow-checkpoint", projectId, intentId, executionId,
//     sourceStageInstanceId? }
//     → freeze the latest completed workflow boundary for native export.
//   { "command": "init-lane",  ...initLane args }   → WP5: prepare a unit
//       lane's session workspace (clone + unit branch off intent HEAD + push).
//   { "command": "merge-lane", ...mergeLane args }  → WP5: serialized --no-ff
//       merge of a finished lane's branch into the intent branch (runs in the
//       INTENT session; the orchestrator holds the merge lock).
//   { "command": "reconcile-lane", ...reconcileLane args } → merge the latest
//       intent head into a unit branch before making its draft PR ready.
//   { "command": "refresh-intent", ...refreshIntentWorkspace args } → reset the
//       intent session checkout to the remote after provider-side integration.
//   { "command": "resolve-conflict", ...resolveConflict args } → WP6: the
//       scoped conflict-resolution stage (lane session; engine merges +
//       verifies + concludes, the agent only edits the conflicted files).
//   { "command": "record-unit-pr", unitPrs:[...] } → best-effort Neptune
//       projection for unit review PRs; DDB remains scheduling truth.
//   { "command": "discussion-assist-start", ...discussion args }
//     → accepts in ms, runs Quorum's one-shot discussion answer in a background
//       job, then updates the pending DiscussionMessage and broadcasts it.
//   { "command": "quorum-edit-plan-start", ...quorum edit args, callbackId }
//     → accepts in ms; a background job analyzes the downstream impact of a
//       requested document edit, produces a structured update plan, and
//       completes the orchestrator's durable callback with it.
//   { "command": "quorum-edit-apply-start", ...quorum edit args, callbackId }
//     → accepts in ms; a background job applies the APPROVED plan (bounded
//       one-shot rewrites + drift bookkeeping + re-derive) and completes the
//       orchestrator's durable callback with the outcome.
//   { "command": "repair-structure", projectId, intentId, executionId,
//     artifactTypes?, requestedCli?, cliModels? }
//     → ops remediation: reconstruct LOST machine-parsed structured blocks
//       from each damaged artifact's own prose (validated through the real
//       extractor before any write), then re-derive the projection.
//
// The dispatcher is pure (handlers injected) so it is unit-tested without a
// socket; createServer wires the real commands + clients.

import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createProcessStore } from '../shared/v2-process-store.js';
import {
  AGENT_CREDENTIAL_ENV_NAMES,
  AWS_REFRESH_CREDENTIAL_ENV_NAMES,
  AWS_TEMPORARY_CREDENTIAL_ENV_NAMES,
  CREDENTIAL_VALUE_KINDS,
} from '../shared/agent-credentials.js';
import { commandDefinition } from './command-registry.js';

const APPLICATION_FAILURE_REASONS = new Set([
  'credential_binding_mismatch',
  'credential_grant_mismatch',
  'credential_grant_required',
  'credential_resolution_failed',
]);
const LOWER_SNAKE_CASE_REASON = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

// Only explicitly recognized application failures cross the AgentCore HTTP
// boundary as values. A shape check in addition to the finite allowlist keeps a
// future SDK/OS code from becoming part of the public protocol by accident.
export const applicationFailureBody = (error) => {
  const reason = error?.code;
  if (
    typeof reason !== 'string' ||
    !LOWER_SNAKE_CASE_REASON.test(reason) ||
    !APPLICATION_FAILURE_REASONS.has(reason)
  ) {
    return null;
  }
  return { ok: false, reason };
};

const CONTAINER_CREDENTIALS_HOST = '127.0.0.1';
const CONTAINER_CREDENTIALS_PATH_PREFIX = '/v1/credentials/';
const REFRESH_BEDROCK_ROLE_CREDENTIALS = 'refresh-bedrock-role-credentials';
const CONTAINER_CREDENTIAL_FIELDS = Object.freeze([
  'AccessKeyId',
  'SecretAccessKey',
  'SessionToken',
  'Token',
  'Expiration',
]);

const scrubCredentialRecord = (value) => {
  if (!value || typeof value !== 'object') return;
  for (const field of CONTAINER_CREDENTIAL_FIELDS) {
    try {
      delete value[field];
    } catch {
      // A provider may return a frozen object. Dropping every mutable reference
      // remains best-effort; frozen values leave scope immediately after send.
    }
  }
};

const scrubInvocationEnv = (value) => {
  if (!value || typeof value !== 'object') return;
  for (const name of [...AGENT_CREDENTIAL_ENV_NAMES, ...AWS_REFRESH_CREDENTIAL_ENV_NAMES]) {
    delete value[name];
  }
};

const sameSecret = (actual, expected) => {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
};

const containerCredentialBody = (credentials) => {
  const body = {
    AccessKeyId: credentials?.AccessKeyId,
    SecretAccessKey: credentials?.SecretAccessKey,
    Token: credentials?.SessionToken,
    Expiration: credentials?.Expiration,
  };
  if (Object.values(body).some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new Error('Credential broker returned incomplete Bedrock role credentials');
  }
  return body;
};

const sendContainerCredentialResponse = (res, statusCode, body, extraHeaders = {}) => {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    Pragma: 'no-cache',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
};

// AWS SDKs and agent CLIs poll this provider through
// AWS_CONTAINER_CREDENTIALS_FULL_URI. It is a separate server from AgentCore's
// 0.0.0.0:8080 runtime contract so the credential route is reachable only from
// this microVM. Every stage invocation receives a distinct unguessable path and
// authorization token; neither the refresh grant nor the token is logged.
//
// The provider never caches STS credentials. Every accepted GET redeems the
// invocation's bounded refresh grant through the credential broker, which
// revalidates the active execution, stage attempt, binding and session ceiling.
export const createContainerCredentialsProvider = ({
  broker,
  port = 0,
  randomBytesFn = randomBytes,
} = {}) => {
  if (typeof broker !== 'function') throw new TypeError('credential broker is required');

  const invocations = new Map();
  const opaqueValue = (size) => randomBytesFn(size).toString('base64url');

  const server = http.createServer(async (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url || '/', `http://${CONTAINER_CREDENTIALS_HOST}`).pathname;
    } catch {
      return sendContainerCredentialResponse(res, 404, { error: 'not found' });
    }
    if (!pathname.startsWith(CONTAINER_CREDENTIALS_PATH_PREFIX)) {
      return sendContainerCredentialResponse(res, 404, { error: 'not found' });
    }
    const invocationId = pathname.slice(CONTAINER_CREDENTIALS_PATH_PREFIX.length);
    const invocation =
      invocationId && !invocationId.includes('/') ? invocations.get(invocationId) : null;
    if (!invocation) return sendContainerCredentialResponse(res, 404, { error: 'not found' });
    if (req.method !== 'GET') {
      return sendContainerCredentialResponse(
        res,
        405,
        { error: 'method not allowed' },
        { Allow: 'GET' },
      );
    }
    if (!sameSecret(req.headers.authorization, invocation.authorizationToken)) {
      return sendContainerCredentialResponse(res, 401, { error: 'unauthorized' });
    }

    let result = null;
    let body = null;
    try {
      result = await broker({
        action: REFRESH_BEDROCK_ROLE_CREDENTIALS,
        grant: invocation.refreshGrant,
      });
      // Revocation can race an already-started broker call. Never release the
      // freshly minted credentials unless this exact invocation registration is
      // still live after the broker returns.
      if (!invocation.active || invocations.get(invocationId) !== invocation) {
        return sendContainerCredentialResponse(res, 404, { error: 'not found' });
      }
      body = containerCredentialBody(result?.credentials);
      return sendContainerCredentialResponse(res, 200, body);
    } catch {
      // Broker, AWS SDK and provider messages may contain sensitive context.
      // The local caller needs only a retryable, sanitized failure.
      return sendContainerCredentialResponse(res, 503, { error: 'credential refresh unavailable' });
    } finally {
      // The provider never caches STS material. Remove mutable references as
      // soon as the response has been serialized into the loopback socket.
      scrubCredentialRecord(result?.credentials);
      scrubCredentialRecord(body);
    }
  });

  const address = () => {
    const value = server.address();
    return typeof value === 'object' && value ? value : null;
  };

  return {
    async listen() {
      if (!server.listening) {
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            server.off('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            server.off('error', onError);
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, CONTAINER_CREDENTIALS_HOST);
        });
      }
      return address();
    },
    registerInvocation(refreshGrant) {
      if (!server.listening) throw new Error('container credentials provider is not listening');
      if (typeof refreshGrant !== 'string' || refreshGrant.length === 0) {
        throw new TypeError('Bedrock role refresh grant is required');
      }
      let invocationId;
      do invocationId = opaqueValue(18);
      while (invocations.has(invocationId));
      const authorizationToken = opaqueValue(32);
      const providerAddress = address();
      const invocation = { refreshGrant, authorizationToken, active: true, registration: null };
      const registration = {
        url: `http://${CONTAINER_CREDENTIALS_HOST}:${providerAddress.port}${CONTAINER_CREDENTIALS_PATH_PREFIX}${invocationId}`,
        authorizationToken,
        revoke() {
          if (!invocation.active) return;
          invocation.active = false;
          invocations.delete(invocationId);
          invocation.refreshGrant = null;
          invocation.authorizationToken = null;
          registration.url = null;
          registration.authorizationToken = null;
        },
      };
      invocation.registration = registration;
      invocations.set(invocationId, invocation);
      return registration;
    },
    async close() {
      for (const invocation of invocations.values()) {
        invocation.active = false;
        invocation.refreshGrant = null;
        invocation.authorizationToken = null;
        if (invocation.registration) {
          invocation.registration.url = null;
          invocation.registration.authorizationToken = null;
          invocation.registration = null;
        }
      }
      invocations.clear();
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    get address() {
      return address();
    },
  };
};

// Bind one role-mode stage invocation to one loopback endpoint registration.
// The initial broker resolution is authoritative for credential kind: a bearer
// binding never receives refresh authority, even if the orchestrator supplied a
// refresh grant during a rolling mode change.
export const createInvocationContext = ({
  store,
  installedClis,
  containerCredentials,
  resolveAuth,
  authenticatedClis,
  env = process.env,
}) => {
  if (typeof resolveAuth !== 'function') throw new TypeError('auth resolver is required');
  if (typeof authenticatedClis !== 'function') {
    throw new TypeError('authenticated CLI resolver is required');
  }
  return async (payload, authMode) => {
    const auth = await resolveAuth({ payload, authMode, store, env });
    let invocationEnv = auth.env;
    let containerCredentialRegistration = null;
    if (
      payload?.command === 'run-stage-start' &&
      auth.credentialKinds?.bedrock === CREDENTIAL_VALUE_KINDS.ROLE &&
      auth.resolvedProviders?.includes('bedrock')
    ) {
      if (!payload.bedrockRoleRefreshGrant) {
        throw Object.assign(new Error('Bedrock role refresh grant is required'), {
          code: 'credential_grant_required',
        });
      }
      containerCredentialRegistration = containerCredentials.registerInvocation(
        payload.bedrockRoleRefreshGrant,
      );
      invocationEnv = {
        ...auth.env,
        AWS_CONTAINER_CREDENTIALS_FULL_URI: containerCredentialRegistration.url,
        AWS_CONTAINER_AUTHORIZATION_TOKEN: containerCredentialRegistration.authorizationToken,
      };
      for (const name of AWS_TEMPORARY_CREDENTIAL_ENV_NAMES) delete invocationEnv[name];
    }
    const context = {
      ...auth,
      env: invocationEnv,
      // The initial STS session is discarded when the loopback provider is
      // installed. Its expiry must not classify a later, unrelated CLI failure
      // after one or more successful refreshes.
      credentialExpiresAt: containerCredentialRegistration ? null : auth.credentialExpiresAt,
      // A Bedrock role binding sets no bearer token, so availability must
      // follow the providers the broker resolved rather than secret env names.
      availableClis: authenticatedClis({
        installed: installedClis,
        resolvedProviders: auth.resolvedProviders,
      }),
    };
    if (containerCredentialRegistration) {
      let cleaned = false;
      let cleanupDeferred = false;
      Object.defineProperties(context, {
        cleanup: {
          enumerable: false,
          value() {
            if (cleaned) return;
            cleaned = true;
            containerCredentialRegistration.revoke();
            scrubInvocationEnv(auth.env);
            scrubInvocationEnv(invocationEnv);
            containerCredentialRegistration = null;
          },
        },
        deferCleanup: {
          enumerable: false,
          value() {
            if (!cleaned) cleanupDeferred = true;
          },
        },
        cleanupDeferred: {
          enumerable: false,
          get() {
            return cleanupDeferred;
          },
        },
      });
    }
    return context;
  };
};

// Track whether a stage is currently running so /ping can report HealthyBusy.
export const createBusyTracker = () => {
  let busy = 0;
  return {
    enter() {
      busy += 1;
    },
    leave() {
      busy = Math.max(0, busy - 1);
    },
    get status() {
      return busy > 0 ? 'HealthyBusy' : 'Healthy';
    },
  };
};

// Dispatch one parsed invocation to the right command handler. PURE of HTTP —
// returns { statusCode, body }. `handlers` = { initWs, runStage }; `busy` is the
// tracker so a long run-stage flips /ping to HealthyBusy.
export const dispatchInvocation = async ({
  payload,
  handlers,
  busy,
  prepareInvocation = null,
  now = () => new Date().toISOString(),
}) => {
  const command = payload?.command;
  if (!command) return { statusCode: 400, body: { error: 'missing "command"' } };
  const definition = commandDefinition(command);
  const handler = definition ? handlers[definition.handler] : null;
  if (!handler) return { statusCode: 400, body: { error: `unknown command "${command}"` } };

  let context = {};
  busy?.enter();
  try {
    context =
      prepareInvocation && definition.agentAuth
        ? await prepareInvocation(payload, definition.agentAuth)
        : {};
    const handlerPayload = { ...payload };
    delete handlerPayload.agentCredentialGrant;
    delete handlerPayload.bedrockRoleRefreshGrant;
    const result = await handler(handlerPayload, context);
    // Command-level failures are part of the application protocol. Keep them on
    // HTTP 200 so Bedrock AgentCore returns the JSON body to the orchestrator
    // instead of turning the response into an SDK transport exception.
    return { statusCode: 200, body: { ...result, command, at: now() } };
  } catch (error) {
    // Typed invocation-preparation failures are application outcomes. Returning
    // them on HTTP 200 lets AgentCore preserve the JSON body for the
    // orchestrator. Unexpected runtime, SDK, and OS failures remain transport
    // failures, and their messages are never exposed to the caller.
    const applicationFailure = applicationFailureBody(error);
    if (applicationFailure) {
      return {
        statusCode: 200,
        body: { ...applicationFailure, command, at: now() },
      };
    }
    return {
      statusCode: 500,
      body: { error: 'Internal server error', command },
    };
  } finally {
    if (!context?.cleanupDeferred) context?.cleanup?.();
    busy?.leave();
  }
};

const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });

// Build the HTTP server. `handlers` = { initWs, runStage } already bound to their
// deps; `busy` defaults to a fresh tracker.
export const createServer = ({
  handlers,
  busy = createBusyTracker(),
  prepareInvocation = null,
  now = () => new Date().toISOString(),
}) => {
  return http.createServer(async (req, res) => {
    const send = (statusCode, body) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/ping') {
      return send(200, {
        status: busy.status,
        time_of_last_update: Math.floor(Date.parse(now()) / 1000),
      });
    }
    if (req.method === 'POST' && req.url === '/invocations') {
      let payload;
      try {
        payload = await readJsonBody(req);
      } catch (e) {
        return send(400, { error: e.message });
      }
      const { statusCode, body } = await dispatchInvocation({
        payload,
        handlers,
        busy,
        prepareInvocation,
        now,
      });
      return send(statusCode, body);
    }
    return send(404, { error: 'not found' });
  });
};

// Container entry: wire the real commands + clients, then listen on 8080.
const main = async () => {
  const {
    ddb,
    s3,
    openGraph,
    broadcastToIntent,
    invokeCredentialBroker,
    sendStageCallbackSuccess,
    sendStageCallbackHeartbeat,
  } = await import('./clients.js');
  const { initWs } = await import('./commands/init-ws.js');
  const { runStage } = await import('./commands/run-stage.js');
  const { createRunStageStart } = await import('./commands/run-stage-start.js');
  const { createDiscussionAssistStart } = await import('./commands/discussion-assist-start.js');
  const { createComposePlanStart } = await import('./commands/compose-plan-start.js');
  const { createQuorumEditPlanStart } = await import('./commands/quorum-edit-plan-start.js');
  const { createQuorumEditApplyStart } = await import('./commands/quorum-edit-apply-start.js');
  const { repairStructure } = await import('./commands/repair-structure.js');
  const { promoteUnits } = await import('./commands/promote-units.js');
  const { deriveArtifacts } = await import('./commands/derive-artifacts.js');
  const { createWorkflowCheckpoint } = await import('./commands/create-workflow-checkpoint.js');
  const { recordPr } = await import('./commands/record-pr.js');
  const { recordUnitPr } = await import('./commands/record-unit-pr.js');
  const { initLane, mergeLane, reconcileLane, refreshIntentWorkspace } =
    await import('./commands/lane.js');
  const { resolveConflict } = await import('./commands/resolve-conflict.js');
  const { inspect } = await import('./commands/inspect.js');
  const { capabilities } = await import('./commands/capabilities.js');
  const { managedRuntimeCheck } = await import('./commands/managed-runtime-check.js');
  const { verifyMcp } = await import('./commands/verify-mcp.js');
  const { loadLibrary, loadBlockBody, loadBlockScript, loadConductor } =
    await import('./block-loader.js');
  const { materializeStage, renderRulesDoc } = await import('./stage-materializer.js');
  const { checkoutRepos } = await import('./workspace.js');
  const { discoverInstalledClis } = await import('./cli/discover.js');
  const { authenticatedClisForProviders, resolveInvocationAgentAuth } =
    await import('./auth-resolver.js');

  const workspaceDir = process.env.V2_WORKSPACE_DIR || '/mnt/workspace';
  const mcpEntry = process.env.V2_MCP_ENTRY || new URL('./mcp/index.js', import.meta.url).pathname;
  const store = createProcessStore({ ddb, tableName: process.env.V2_PROCESS_TABLE });
  const installedClis = await discoverInstalledClis();
  const containerCredentials = createContainerCredentialsProvider({
    broker: invokeCredentialBroker,
  });
  const containerCredentialsAddress = await containerCredentials.listen();
  console.error(
    `[agentcore] container credentials listening on ${CONTAINER_CREDENTIALS_HOST}:${containerCredentialsAddress.port}`,
  );
  const invocationContext = createInvocationContext({
    store,
    installedClis,
    containerCredentials,
    resolveAuth: resolveInvocationAgentAuth,
    authenticatedClis: authenticatedClisForProviders,
    env: process.env,
  });

  // Publish a process-state payload on the intent's realtime channel. The
  // payload carries its own intentId (the command stamps it), so fan-out is keyed
  // off the payload rather than a closed-over id.
  const broadcast = (payload) => broadcastToIntent(payload?.intentId, payload);

  const handlers = {
    initWs: (p) => initWs(p, { store, openGraph, checkoutRepos, workspaceDir, broadcast }),
    runStage: (p, context) =>
      runStage(
        { ...p, workspaceDir },
        {
          store,
          loadLibrary,
          loadBlockBody,
          loadBlockScript,
          loadConductor,
          materializeStage,
          renderRulesDoc,
          mcpEntry,
          openGraph,
          availableClis: context.availableClis,
          credentialBindings: context.credentialBindings,
          missingCredentialBindings: context.missingCredentialBindings,
          // The deadline on this invocation's temporary credentials, so a stage
          // failure after it passed is attributed to expiry deterministically
          // rather than by matching a CLI's stderr wording (req-expiry-tripwire).
          credentialExpiresAt: context.credentialExpiresAt,
          broadcast,
          env: context.env,
        },
      ),
    inspect: (p) => inspect(p, { openGraph }),
    capabilities: (p, context) =>
      capabilities(p, {
        env: context.env,
        // Availability is a question about the RESOLVED binding, not about a
        // secret env var: a Bedrock role binding sets no bearer token.
        resolvedProviders: context.resolvedProviders,
        discoverInstalledClis: async () => installedClis,
      }),
    managedRuntimeCheck: (p) => managedRuntimeCheck(p, { workspaceDir }),
    verifyMcp: (p) => verifyMcp(p),
    // WP3: freeze the approved unit DAG into UNITPLAN/UNIT rows + the graph
    // mirror. Dispatched by the orchestrator after the producing stage
    // succeeds (docs/v2-parallel.md).
    promoteUnits: (p) => promoteUnits(p, { store, openGraph, broadcast }),
    deriveArtifacts: (p, context) =>
      deriveArtifacts(p, {
        store,
        openGraph,
        broadcast,
        availableClis: context.availableClis,
        env: context.env,
      }),
    createWorkflowCheckpoint: (p) =>
      createWorkflowCheckpoint(p, {
        store,
        openGraph,
        s3,
        bucket: process.env.ARTIFACTS_BUCKET,
      }),
    // Fan-in PR record: write the opened PR(s) into the graph (the orchestrator
    // has no Neptune access, so it forwards the structured PR data here).
    recordPr: (p) => recordPr(p, { store, openGraph, broadcast }),
    recordUnitPr: (p) => recordUnitPr(p, { store, openGraph, broadcast }),
    // WP5 unit lanes: engine-owned lane git (docs/v2-parallel.md A3). init-lane
    // runs in the lane's own session; merge-lane in the intent session.
    initLane: (p) => initLane({ ...p, workspaceDir }, { store, broadcast }),
    mergeLane: (p) => mergeLane({ ...p, workspaceDir }, { store, broadcast }),
    reconcileLane: (p) => reconcileLane({ ...p, workspaceDir }, { store, broadcast }),
    refreshIntent: (p) => refreshIntentWorkspace({ ...p, workspaceDir }, {}),
    // WP6: the scoped conflict-resolution stage (lane session). The engine
    // merges/verifies/concludes; the agent CLI only edits conflicted files.
    resolveConflict: (p, context) =>
      resolveConflict(
        { ...p, workspaceDir },
        {
          store,
          availableClis: context.availableClis,
          mcpEntry,
          broadcast,
          env: context.env,
        },
      ),
  };
  // Async stage invocation (WP1): shares the sync handler's whole deps bag; the
  // background job holds the SAME busy tracker the server uses for /ping, so
  // the session stays HealthyBusy for the job's lifetime.
  const busy = createBusyTracker();
  const stageJobs = new Map();
  handlers.runStageStart = (p, context) =>
    createRunStageStart({
      runStage: (q) => handlers.runStage(q, context),
      sendCallbackSuccess: sendStageCallbackSuccess,
      sendCallbackHeartbeat: sendStageCallbackHeartbeat,
      busy,
      activeJobs: stageJobs,
    })(p, context);
  const discussionJobs = new Map();
  handlers.discussionAssistStart = (p, context) =>
    createDiscussionAssistStart({
      openGraph,
      store,
      broadcast,
      availableClis: context.availableClis,
      env: context.env,
      mcpEntry,
      busy,
      activeJobs: discussionJobs,
    })(p);
  // Composer proposals (Adaptive Workflows): grounded scope/grid proposals for
  // a DRAFT intent (front/report) or a parked run (inflight). Proposal-only —
  // applying it is the intents lambda's job, never this container's.
  const composeJobs = new Map();
  handlers.composePlanStart = (p, context) =>
    createComposePlanStart({
      openGraph,
      store,
      broadcast,
      availableClis: context.availableClis,
      env: context.env,
      busy,
      activeJobs: composeJobs,
    })(p);
  // Quorum-supported artifact edits: plan (impact analysis) + apply (approved
  // rewrites). Same accept-then-background contract as run-stage-start; the
  // apply job re-derives through the SAME deriveArtifacts handler stages use.
  const quorumPlanJobs = new Map();
  handlers.quorumEditPlanStart = (p, context) =>
    createQuorumEditPlanStart({
      openGraph,
      store,
      broadcast,
      availableClis: context.availableClis,
      env: context.env,
      sendCallbackSuccess: sendStageCallbackSuccess,
      sendCallbackHeartbeat: sendStageCallbackHeartbeat,
      busy,
      activeJobs: quorumPlanJobs,
    })(p);
  const quorumApplyJobs = new Map();
  handlers.quorumEditApplyStart = (p, context) =>
    createQuorumEditApplyStart({
      openGraph,
      store,
      broadcast,
      availableClis: context.availableClis,
      env: context.env,
      deriveArtifacts: (q) => handlers.deriveArtifacts(q, context),
      sendCallbackSuccess: sendStageCallbackSuccess,
      sendCallbackHeartbeat: sendStageCallbackHeartbeat,
      busy,
      activeJobs: quorumApplyJobs,
    })(p);
  // Ops remediation: reconstruct lost structured blocks (see command header).
  handlers.repairStructure = (p, context) =>
    repairStructure(p, {
      openGraph,
      store,
      broadcast,
      availableClis: context.availableClis,
      deriveArtifacts: (q) => handlers.deriveArtifacts(q, context),
      env: context.env,
    });

  const server = createServer({
    handlers,
    busy,
    prepareInvocation: invocationContext,
  });
  server.listen(8080, '0.0.0.0', () => console.error('[agentcore] listening on 0.0.0.0:8080'));
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('[agentcore] fatal:', e);
    process.exit(1);
  });
}
