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
//   { "command": "record-learning", projectId, intentId, executionId,
//     stageInstanceId?, stageId?, learnings, recordedBy?, recordedByName? }
//     → the learnings ritual: write a human-authored learning offered at an
//       approval gate into the project rule stack. Never fails the run.
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

import { Logger } from '@aws-lambda-powertools/logger';
import http from 'node:http';
import { installProcessGroupShutdown } from './cli/spawn.js';
import { createExecutionStore, EXECUTION_DATA_GRANT_ENV } from './execution-store.js';
import { commandDefinition, executionDataId } from './command-registry.js';

const logger = new Logger({ persistentKeys: { component: 'agentcore' } });

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

export const createRecordLearningHandler =
  ({ recordLearning, openGraph, broadcast }) =>
  (payload, context) =>
    recordLearning(payload, { store: context.store, openGraph, broadcast });

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
  if (!command) {
    logger.warn('dispatch rejected: missing command');
    return { statusCode: 400, body: { error: 'missing "command"' } };
  }
  const definition = commandDefinition(command);
  const handler = definition ? handlers[definition.handler] : null;
  if (!handler) {
    logger.warn('dispatch rejected: unknown command', { command });
    return { statusCode: 400, body: { error: `unknown command "${command}"` } };
  }

  busy?.enter();
  try {
    const context = prepareInvocation ? await prepareInvocation(payload, definition.agentAuth) : {};
    const handlerPayload = { ...payload };
    delete handlerPayload.agentCredentialGrant;
    delete handlerPayload.executionDataGrant;
    const result = await handler(handlerPayload, context);
    // Command-level failures are part of the application protocol. Keep them on
    // HTTP 200 so Bedrock AgentCore returns the JSON body to the orchestrator
    // instead of turning the response into an SDK transport exception. Log them
    // so a swallowed failure (e.g. a checkpoint that silently didn't apply) is
    // diagnosable from the container logs.
    if (result?.ok === false) {
      logger.warn('command returned failure', {
        command,
        reason: result.reason,
        detail: result.detail,
        error: result.error,
      });
    }
    return { statusCode: 200, body: { ...result, command, at: now() } };
  } catch (e) {
    logger.error('command threw', e, { command });
    return { statusCode: 500, body: { error: e.message, command } };
  } finally {
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

export const createInvocationContext =
  ({ installedClis, resolveInvocationAgentAuth, authenticatedClisForEnv }) =>
  async (payload, authMode) => {
    const env = { ...process.env };
    delete env[EXECUTION_DATA_GRANT_ENV];
    let store = null;
    const executionId = executionDataId(payload);
    if (commandDefinition(payload.command)?.executionData && !executionId) {
      throw new Error('executionId or intentId is required for execution data');
    }
    if (executionId) {
      store = await createExecutionStore({ executionId, grant: payload.executionDataGrant, env });
      // Child CLIs and the MCP server renew their own credentials with this grant.
      env[EXECUTION_DATA_GRANT_ENV] = payload.executionDataGrant;
    }
    if (!authMode) return { store, env };
    const auth = await resolveInvocationAgentAuth({
      payload,
      authMode,
      store,
      env,
    });
    return {
      ...auth,
      store,
      availableClis: authenticatedClisForEnv({ installed: installedClis, env: auth.env }),
    };
  };

// Container entry: wire the real commands + clients, then listen on 8080.
const main = async () => {
  const { s3, openGraph, broadcastToIntent, sendStageCallbackSuccess, sendStageCallbackHeartbeat } =
    await import('./clients.js');
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
  const { recordLearning } = await import('./commands/record-learning.js');
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
  const { authenticatedClisForEnv, resolveInvocationAgentAuth } =
    await import('./auth-resolver.js');

  const workspaceDir = process.env.V2_WORKSPACE_DIR || '/mnt/workspace';
  const mcpEntry = process.env.V2_MCP_ENTRY || new URL('./mcp/index.js', import.meta.url).pathname;
  const installedClis = await discoverInstalledClis();
  const invocationContext = createInvocationContext({
    installedClis,
    resolveInvocationAgentAuth,
    authenticatedClisForEnv,
  });

  // Publish a process-state payload on the intent's realtime channel. The
  // payload carries its own intentId (the command stamps it), so fan-out is keyed
  // off the payload rather than a closed-over id.
  const broadcast = (payload) => broadcastToIntent(payload?.intentId, payload);

  const handlers = {
    initWs: (p, context) =>
      initWs(p, { store: context.store, openGraph, checkoutRepos, workspaceDir, broadcast }),
    runStage: (p, context) =>
      runStage(
        { ...p, workspaceDir },
        {
          store: context.store,
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
          broadcast,
          env: context.env,
        },
      ),
    inspect: (p) => inspect(p, { openGraph }),
    capabilities: (p, context) =>
      capabilities(p, {
        env: context.env,
        discoverInstalledClis: async () => installedClis,
      }),
    managedRuntimeCheck: (p) => managedRuntimeCheck(p, { workspaceDir }),
    verifyMcp: (p) => verifyMcp(p),
    // WP3: freeze the approved unit DAG into UNITPLAN/UNIT rows + the graph
    // mirror. Dispatched by the orchestrator after the producing stage
    // succeeds (docs/v2-parallel.md).
    promoteUnits: (p, context) => promoteUnits(p, { store: context.store, openGraph, broadcast }),
    deriveArtifacts: (p, context) =>
      deriveArtifacts(p, {
        store: context.store,
        openGraph,
        broadcast,
        availableClis: context.availableClis,
        env: context.env,
      }),
    createWorkflowCheckpoint: (p, context) =>
      createWorkflowCheckpoint(p, {
        store: context.store,
        openGraph,
        s3,
        bucket: process.env.ARTIFACTS_BUCKET,
      }),
    // Fan-in PR record: write the opened PR(s) into the graph (the orchestrator
    // has no Neptune access, so it forwards the structured PR data here).
    recordPr: (p, context) => recordPr(p, { store: context.store, openGraph, broadcast }),
    // Learnings ritual: the human's gate answer becomes a durable
    // project learning here, because the orchestrator has no Neptune access.
    recordLearning: createRecordLearningHandler({ recordLearning, openGraph, broadcast }),
    recordUnitPr: (p, context) => recordUnitPr(p, { store: context.store, openGraph, broadcast }),
    // WP5 unit lanes: engine-owned lane git (docs/v2-parallel.md A3). init-lane
    // runs in the lane's own session; merge-lane in the intent session.
    initLane: (p, context) => initLane({ ...p, workspaceDir }, { store: context.store, broadcast }),
    mergeLane: (p, context) =>
      mergeLane({ ...p, workspaceDir }, { store: context.store, broadcast }),
    reconcileLane: (p, context) =>
      reconcileLane({ ...p, workspaceDir }, { store: context.store, broadcast }),
    refreshIntent: (p) => refreshIntentWorkspace({ ...p, workspaceDir }, {}),
    // WP6: the scoped conflict-resolution stage (lane session). The engine
    // merges/verifies/concludes; the agent CLI only edits conflicted files.
    resolveConflict: (p, context) =>
      resolveConflict(
        { ...p, workspaceDir },
        {
          store: context.store,
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
    })(p);
  const discussionJobs = new Map();
  handlers.discussionAssistStart = (p, context) =>
    createDiscussionAssistStart({
      openGraph,
      store: context.store,
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
      store: context.store,
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
      store: context.store,
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
      store: context.store,
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
      store: context.store,
      broadcast,
      availableClis: context.availableClis,
      deriveArtifacts: (q) => handlers.deriveArtifacts(q, context),
      env: context.env,
    });

  // Shutdown policy, installed once for the whole container rather than lazily by
  // the first persona session: a stop reaps the persona-session process groups
  // (their children are not group leaders and would otherwise be orphaned) and
  // then lets the signal take its default course. A container that never runs a
  // persona stage therefore keeps exactly the disposition it had before persona
  // sessions existed.
  installProcessGroupShutdown();

  const server = createServer({
    handlers,
    busy,
    prepareInvocation: invocationContext,
  });
  server.listen(8080, '0.0.0.0', () => logger.info('listening on 0.0.0.0:8080'));
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    logger.error('fatal', e);
    process.exit(1);
  });
}
