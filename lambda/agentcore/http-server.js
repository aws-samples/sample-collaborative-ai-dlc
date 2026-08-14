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
import { createProcessStore } from '../shared/v2-process-store.js';

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

// Only commands that can spawn an agent CLI need hierarchical credential
// resolution. Engine-only commands must remain available during an SSM outage.
const AGENT_AUTH_COMMANDS = new Set([
  'run-stage',
  'run-stage-start',
  'derive-artifacts',
  'resolve-conflict',
  'discussion-assist-start',
  'compose-plan-start',
  'quorum-edit-plan-start',
  'quorum-edit-apply-start',
  'repair-structure',
  'capabilities',
]);

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
  const handler = {
    'init-ws': handlers.initWs,
    'run-stage': handlers.runStage,
    'run-stage-start': handlers.runStageStart,
    'promote-units': handlers.promoteUnits,
    'derive-artifacts': handlers.deriveArtifacts,
    'record-pr': handlers.recordPr,
    'record-unit-pr': handlers.recordUnitPr,
    'init-lane': handlers.initLane,
    'merge-lane': handlers.mergeLane,
    'reconcile-lane': handlers.reconcileLane,
    'refresh-intent': handlers.refreshIntent,
    'resolve-conflict': handlers.resolveConflict,
    'discussion-assist-start': handlers.discussionAssistStart,
    'compose-plan-start': handlers.composePlanStart,
    'quorum-edit-plan-start': handlers.quorumEditPlanStart,
    'quorum-edit-apply-start': handlers.quorumEditApplyStart,
    'repair-structure': handlers.repairStructure,
    inspect: handlers.inspect,
    capabilities: handlers.capabilities,
    'verify-mcp': handlers.verifyMcp,
  }[command];
  if (!handler) return { statusCode: 400, body: { error: `unknown command "${command}"` } };

  busy?.enter();
  try {
    const context =
      prepareInvocation && AGENT_AUTH_COMMANDS.has(command) ? await prepareInvocation(payload) : {};
    const result = await handler(payload, context);
    // Command-level failures are part of the application protocol. Keep them on
    // HTTP 200 so Bedrock AgentCore returns the JSON body to the orchestrator
    // instead of turning the response into an SDK transport exception.
    return { statusCode: 200, body: { ...result, command, at: now() } };
  } catch (e) {
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

// Container entry: wire the real commands + clients, then listen on 8080.
const main = async () => {
  const {
    ddb,
    openGraph,
    broadcastToIntent,
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
  const { recordPr } = await import('./commands/record-pr.js');
  const { recordUnitPr } = await import('./commands/record-unit-pr.js');
  const { initLane, mergeLane, reconcileLane, refreshIntentWorkspace } =
    await import('./commands/lane.js');
  const { resolveConflict } = await import('./commands/resolve-conflict.js');
  const { inspect } = await import('./commands/inspect.js');
  const { capabilities } = await import('./commands/capabilities.js');
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
  const store = createProcessStore({ ddb, tableName: process.env.V2_PROCESS_TABLE });
  const installedClis = await discoverInstalledClis();
  const invocationContext = async (payload) => {
    const auth = await resolveInvocationAgentAuth({
      payload,
      store,
      env: process.env,
    });
    return {
      ...auth,
      availableClis: authenticatedClisForEnv({ installed: installedClis, env: auth.env }),
    };
  };

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
    })(p);
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
