import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { randomUUID } from 'node:crypto';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  LambdaClient,
  InvokeCommand,
  SendDurableExecutionCallbackSuccessCommand,
} from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import pkg from '../shared/v2-process-store.js';
import { buildResponse } from '../shared/response.js';
import { fetchMembershipRole, projectTrackersFoldStep, mapBinding } from '../shared/trackers.js';
import { signRealtimeToken } from '../shared/realtime-token.js';
import cliModelsPkg from '../shared/cli-models.js';
import workflowPlanPkg from '../shared/v2-workflow-plan.js';

const { createProcessStore } = pkg;
const { parseCliModels, mergeCliModels } = cliModelsPkg;
const { loadWorkflowScopes } = workflowPlanPkg;

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const __ = gremlin.process.statics;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const lambdaClient = new LambdaClient({});
const store = createProcessStore({ ddb });

const BLOCKS_TABLE = () => process.env.BLOCKS_TABLE;
const ORCHESTRATOR_FN = () => process.env.V2_ORCHESTRATOR_FUNCTION;
// SSM path of the Admin GLOBAL per-CLI model defaults (written by the agents
// lambda's PUT /agents/settings). Merged UNDER the project selection at create so
// the model precedence is project > global(admin) > agentBlock > env, matching
// what the project-settings UI advertises. Empty prefix disables the merge.
const AGENT_SETTINGS_SSM_PREFIX = () => process.env.AGENT_SETTINGS_SSM_PREFIX || '';
const DEFAULT_WORKFLOW_ID = 'aidlc-v2';
// Branch a started intent runs on. Mirrors v1 (aidlc/<id>) so PRs are predictable.
const branchForIntent = (intentId) => `aidlc/${intentId}`;

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const port = process.env.GREMLIN_PORT ?? '8182';
  const protocol = process.env.GREMLIN_PROTOCOL ?? 'wss';
  const credentials = await fromNodeProviderChain()();
  credentials.region = process.env.AWS_REGION ?? 'us-east-1';
  const { url, headers } = getUrlAndHeaders(host, port, credentials, '/gremlin', protocol);
  return new DriverRemoteConnection(url, { headers });
};

// Realtime scope-token secret (shared with the discussions lambda + Yjs server).
let cachedSecret;
const getSecret = async () => {
  if (process.env.REALTIME_DOC_SECRET) return process.env.REALTIME_DOC_SECRET;
  if (cachedSecret) return cachedSecret;
  const paramName = process.env.REALTIME_SECRET_PARAM;
  if (!paramName) throw new Error('REALTIME_SECRET_PARAM is not configured');
  const result = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
  cachedSecret = result.Parameter?.Value;
  if (!cachedSecret) throw new Error(`SSM parameter ${paramName} is empty`);
  return cachedSecret;
};

const getVal = (vertexMap, key) => {
  const v = vertexMap?.get?.(key) ?? vertexMap?.[key];
  return Array.isArray(v) ? v[0] : v;
};

// ── Project / repo reads (mirror lambda/projects shapes) ──

// Read the Admin GLOBAL per-CLI model defaults from SSM (written by the agents
// lambda). Best-effort: a missing prefix / param / parse error yields {} so an
// intent still starts (the agent-block override + env default still steer it).
const fetchGlobalCliModels = async () => {
  const prefix = AGENT_SETTINGS_SSM_PREFIX();
  if (!prefix) return {};
  try {
    const res = await ssm.send(
      new GetParameterCommand({ Name: `${prefix}/cli-models`, WithDecryption: true }),
    );
    return parseCliModels(res.Parameter?.Value || '{}');
  } catch {
    return {};
  }
};

// Read the v2 project's run config (workflow pin, repos, park-release). Scope is
// NOT a project property — it is chosen per-intent at create time.
// Returns null when the project doesn't exist or isn't a v2 project.
const fetchProjectConfig = async (g, projectId) => {
  const res = await g.V().has('Project', 'id', projectId).valueMap(true).next();
  if (res.done) return null;
  const v = res.value;
  if ((getVal(v, 'kind') || 'v1') !== 'v2') return null;
  const repoRows = await g
    .V()
    .has('Project', 'id', projectId)
    .out('HAS_REPO')
    .hasLabel('Repository')
    .order()
    .by(__.coalesce(__.values('added_at'), __.constant('')))
    .project('url', 'role')
    .by('url')
    .by(__.coalesce(__.values('role'), __.constant('unknown')))
    .toList();
  const repos = repoRows.map((r) => r.get('url'));
  // Primary first so init-ws clones it as the working repo.
  const primary = repoRows.find((r) => r.get('role') === 'primary')?.get('url');
  const ordered = primary ? [primary, ...repos.filter((u) => u !== primary)] : repos;
  // Tracker bindings — used to validate an optional kick-off source (the intent
  // can only cite a tracker the project is actually bound to).
  const trackerRes = await g
    .V()
    .has('Project', 'id', projectId)
    .flatMap(projectTrackersFoldStep())
    .next();
  const trackers = (trackerRes.value ?? []).map(mapBinding);
  const rawVersion = getVal(v, 'workflow_version');
  // Snapshot the EFFECTIVE per-CLI model selection onto the intent so the run is
  // reproducible: the project's choice wins per CLI, the Admin global default
  // fills the gaps (project > global). run-stage's resolver then applies
  // cliModels[cli] first, so the runtime precedence is project > global >
  // agentBlock override > env default — matching what the settings UI advertises.
  const globalCliModels = await fetchGlobalCliModels();
  const cliModels = mergeCliModels(getVal(v, 'cli_models'), globalCliModels);
  return {
    workflowId: getVal(v, 'workflow_id') || DEFAULT_WORKFLOW_ID,
    workflowVersion: rawVersion ? Number(rawVersion) : null,
    parkReleaseSeconds: Number(getVal(v, 'park_release_seconds') || 300),
    // The project's selected agent CLI (defaults to kiro on the project vertex);
    // snapshotted onto the intent so the run honours the explicit choice.
    agentCli: getVal(v, 'agent_cli') || null,
    cliModels: Object.keys(cliModels).length ? cliModels : null,
    repos: ordered,
    trackers,
    gitProvider: getVal(v, 'git_provider') || 'github',
    baseBranch: 'main',
  };
};

// Resolve a workflow's current (latest) version from the blocks table META row.
// A `default`-tenant fork shadows the SYSTEM baseline; fall back to SYSTEM.
const resolveWorkflowVersion = async (workflowId) => {
  for (const tenant of ['default', 'SYSTEM']) {
    const { Item } = await ddb.send(
      new GetCommand({
        TableName: BLOCKS_TABLE(),
        Key: { pk: `WF#${tenant}#${workflowId}`, sk: 'META' },
      }),
    );
    if (Item?.version) return Number(Item.version);
  }
  return null;
};

// Read the intent's artifact subgraph (Intent --CONTAINS--> Artifact). Returns a
// compact snapshot for the IntentView. Empty when the intent hasn't started.
const fetchArtifacts = async (g, intentId) => {
  const rows = await g
    .V()
    .has('Intent', 'id', intentId)
    .out('CONTAINS')
    .hasLabel('Artifact')
    .valueMap(true)
    .toList();
  return rows.map((vm) => ({
    id: getVal(vm, 'id'),
    artifactType: getVal(vm, 'artifact_type') ?? null,
    title: getVal(vm, 'title') ?? null,
    createdByExecutionId: getVal(vm, 'created_by_execution_id') ?? null,
    createdByStageInstanceId: getVal(vm, 'created_by_stage_instance_id') ?? null,
    createdAt: getVal(vm, 'created_at') ?? null,
    content: getVal(vm, 'content') ?? null,
  }));
};

// Normalize the optional tracker source the intent was kicked off from. Keeps
// only the provenance fields (the imported text already lives in `prompt`) and
// validates the binding against the project's actual tracker bindings so a
// client can't pin a fabricated source. Returns null when absent/invalid-shaped.
const normalizeSource = (raw, trackers) => {
  if (!raw || typeof raw !== 'object') return null;
  const bindingId = raw.bindingId;
  const resourceId = raw.resourceId;
  if (!bindingId || !resourceId) return null;
  const binding = (trackers ?? []).find((t) => t.id === bindingId);
  if (!binding) return null;
  return {
    bindingId,
    provider: binding.provider,
    instance: binding.instance ?? null,
    resourceType: raw.resourceType || 'issue',
    resourceId: String(resourceId),
    resourceUrl: raw.resourceUrl || null,
  };
};

// ── DTO assembly ──

// Map a process-store META row to the wire shape the frontend consumes.
const mapIntent = (meta) => ({
  id: meta.intentId,
  executionId: meta.executionId,
  projectId: meta.projectId,
  title: meta.title ?? null,
  prompt: meta.prompt ?? null,
  status: meta.status,
  branch: meta.branch ?? null,
  baseBranch: meta.baseBranch ?? null,
  repos: meta.repos ?? null,
  workflowId: meta.workflowId,
  workflowVersion: meta.workflowVersion ?? null,
  scope: meta.scope ?? null,
  currentPhase: meta.currentPhase ?? null,
  currentStage: meta.currentStage ?? null,
  pendingHumanTaskId: meta.pendingHumanTaskId ?? null,
  failureReason: meta.failureReason ?? null,
  agentCli: meta.agentCli ?? null,
  cliModels: meta.cliModels ?? null,
  parkReleaseSeconds: meta.parkReleaseSeconds ?? null,
  source: meta.source ?? null,
  createdAt: meta.startedAt ?? null,
  updatedAt: meta.updatedAt ?? null,
  completedAt: meta.completedAt ?? null,
});

// ── Authorization ──
const authorize = async (g, projectId, sub, response) => {
  if (!sub) return { res: response(401, { error: 'Unauthorized' }) };
  const role = await fetchMembershipRole(g, projectId, sub);
  if (!role) return { res: response(403, { error: 'Not a project member' }) };
  return { role };
};

export const handler = async (event) => {
  const response = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return response(200, {});

  const { httpMethod, pathParameters, path, body } = event;
  const projectId = pathParameters?.projectId;
  const intentId = pathParameters?.intentId;
  const humanTaskId = pathParameters?.humanTaskId;
  const sub = event.requestContext?.authorizer?.claims?.sub;

  let conn;
  try {
    conn = await getConnection();
    let g = traversal().withRemote(conn);
    if (process.env.GREMLIN_PARTITION) {
      g = g.withStrategies(
        new PartitionStrategy({
          partitionKey: '_partition',
          writePartition: process.env.GREMLIN_PARTITION,
          readPartitions: [process.env.GREMLIN_PARTITION],
        }),
      );
    }

    const auth = await authorize(g, projectId, sub, response);
    if (auth.res) return auth.res;

    // POST /projects/{projectId}/intents/{intentId}/realtime-token
    if (intentId && httpMethod === 'POST' && path?.endsWith('/realtime-token')) {
      // Confirm the intent belongs to this project before minting an intent
      // scope (the caller is already a verified member of projectId).
      const meta = await store.getExecution(intentId);
      if (!meta || meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      const scopes = [`intent:${intentId}`, `project:${projectId}`];
      const secret = await getSecret();
      const { token, exp } = signRealtimeToken({ sub, scopes }, secret);
      return response(200, { token, exp, scopes });
    }

    // POST /projects/{projectId}/intents/{intentId}/gates/{humanTaskId}/answer
    if (intentId && humanTaskId && httpMethod === 'POST' && path?.endsWith('/answer')) {
      const data = body ? JSON.parse(body) : {};
      const gate = await store.getHumanTask(intentId, humanTaskId);
      if (!gate) return response(404, { error: 'Gate not found' });
      const meta = await store.getExecution(intentId);
      if (!meta || meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      // Answer THIS specific gate (CAS on pending). D3: a stage can leave more
      // than one pending gate; answer the one addressed by the URL, never blindly
      // META.pendingHumanTaskId.
      const answered = await store.answerHumanTask({
        executionId: intentId,
        humanTaskId,
        status: data.status || 'answered',
        answer: data.answer ?? null,
        answeredBy: sub,
      });
      if (!answered) {
        return response(409, { error: 'Gate already answered or not pending' });
      }
      // Resume the suspended orchestrator ONLY if this gate is the one the
      // durable run actually parked on (it carries the callbackId). Answering an
      // older sibling gate just records the durable Q&A — the run is parked on a
      // different callback. SendDurableExecutionCallbackSuccess resumes the
      // EXISTING execution; a fresh Invoke would start a new one.
      if (gate.callbackId) {
        await resumeDurableCallback(gate.callbackId, answered.answer);
      }
      return response(200, mapHumanTask(answered));
    }

    // POST /projects/{projectId}/intents/{intentId}/start
    if (intentId && httpMethod === 'POST' && path?.endsWith('/start')) {
      const meta = await store.getExecution(intentId);
      if (!meta || meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      // Startable states: a fresh DRAFT, a FAILED run the user wants to retry, or
      // a CREATED run whose hand-off never reached a live orchestrator (stranded —
      // see the rollback below). init-ws is idempotent in the runtime, so a restart
      // re-runs cleanly. RUNNING/WAITING/SUCCEEDED are rejected (already live/done).
      const STARTABLE = new Set(['DRAFT', 'FAILED', 'CREATED']);
      if (!STARTABLE.has(meta.status)) {
        return response(409, { error: `Intent is ${meta.status}, cannot start` });
      }
      if (!meta.prompt) {
        return response(400, { error: 'Intent has no prompt; define it before starting' });
      }
      // Flip <current> → CREATED (CAS on the observed status) so a double-start
      // can't launch two runs, then hand off to the orchestrator (init-ws + run the
      // plan). If the hand-off throws, roll back to the prior status — otherwise the
      // intent strands in CREATED (the orchestrator never ran) and never retries.
      const priorStatus = meta.status;
      const updated = await store.updateExecution({
        executionId: intentId,
        projectId,
        status: 'CREATED',
        fromStatus: priorStatus,
        startedAt: meta.startedAt,
        // Clear any stale failure from a prior attempt as we re-enter the pipeline.
        failureReason: null,
      });
      try {
        await invokeOrchestrator({ action: 'start', intentId, executionId: intentId });
      } catch (err) {
        await store.updateExecution({
          executionId: intentId,
          projectId,
          status: priorStatus,
          fromStatus: 'CREATED',
          startedAt: meta.startedAt,
        });
        throw err;
      }
      return response(202, mapIntent(updated));
    }

    if (intentId && httpMethod === 'GET') {
      // GET single — assembled detail DTO.
      const records = await store.getExecutionRecords(intentId);
      if (!records.meta || records.meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      const artifacts = await fetchArtifacts(g, intentId);
      return response(200, {
        intent: mapIntent(records.meta),
        stages: records.stages.map(mapStage),
        // Activity feed: lifecycle events (workspace init, failures, completion)
        // newest-last in emit order, so the UI can show what's happening — init-ws
        // is otherwise invisible (it creates no stage row).
        events: (records.events ?? []).map((e) => ({
          eventId: e.eventId,
          type: e.eventType,
          stageInstanceId: e.stageInstanceId ?? null,
          actor: e.actor ?? null,
          summary: e.summary ?? null,
          timestamp: e.timestamp,
        })),
        gates: records.humanTasks.map(mapHumanTask),
        metrics: records.metrics.map((m) => ({
          metricId: m.metricId,
          stageInstanceId: m.stageInstanceId ?? null,
          metrics: m.metrics ?? {},
          timestamp: m.timestamp,
        })),
        outputs: records.outputs.map((o) => ({
          seq: o.seq,
          stageInstanceId: o.stageInstanceId ?? null,
          kind: o.kind,
          content: o.content,
          timestamp: o.timestamp,
        })),
        sensorRuns: records.sensorRuns.map((s) => ({
          sensorRunId: s.sensorRunId,
          stageInstanceId: s.stageInstanceId ?? null,
          sensorId: s.sensorId,
          result: s.result,
          severity: s.severity,
          held: s.held,
          timestamp: s.timestamp,
        })),
        artifacts,
      });
    }

    if (httpMethod === 'GET') {
      // GET list — META rows for the project, newest first.
      const status = event.queryStringParameters?.status || null;
      const metas = await store.listProjectExecutions({ projectId, status });
      return response(200, metas.map(mapIntent));
    }

    if (httpMethod === 'POST') {
      // Create a DRAFT intent (no Neptune anchor yet — init-ws makes it at Start).
      const data = body ? JSON.parse(body) : {};
      if (!data.title && !data.prompt) {
        return response(400, { error: 'title or prompt is required' });
      }
      const cfg = await fetchProjectConfig(g, projectId);
      if (!cfg) {
        return response(400, { error: 'Project is not a v2 project' });
      }
      const newIntentId = randomUUID();
      // Pin the workflow version now (reproducibility) — project pin wins, else
      // resolve the workflow's current latest version.
      const workflowId = cfg.workflowId;
      const workflowVersion = cfg.workflowVersion ?? (await resolveWorkflowVersion(workflowId));
      if (!workflowVersion) {
        return response(400, { error: `Workflow "${workflowId}" has no published version` });
      }
      // Scope is chosen per-intent (a project can hold features, bugfixes, …).
      // It must be one of the pinned workflow's offered scopes — a free-typed
      // scope would be rejected by buildExecutionPlan when the orchestrator runs.
      const scope = data.scope;
      if (!scope) {
        return response(400, { error: 'scope is required' });
      }
      const scopes = await loadWorkflowScopes({
        ddb,
        tableName: BLOCKS_TABLE(),
        workflowId,
        workflowVersion,
      });
      if (!scopes.includes(scope)) {
        return response(400, {
          error: `Unknown scope "${scope}" for workflow "${workflowId}"`,
          scopes,
        });
      }
      // Optional provenance — when the intent is kicked off from a tracker
      // issue, record which one. The imported text rides in `prompt`; this is
      // only the back-link. Validated against the project's actual bindings.
      const source = normalizeSource(data.source, cfg.trackers);
      const meta = await store.createExecution({
        executionId: newIntentId,
        projectId,
        intentId: newIntentId,
        status: 'DRAFT',
        workflowId,
        workflowVersion,
        scope,
        startedBy: sub,
        title: data.title || null,
        prompt: data.prompt || null,
        branch: data.branch || branchForIntent(newIntentId),
        baseBranch: data.baseBranch || cfg.baseBranch,
        repos: cfg.repos,
        agentCli: cfg.agentCli,
        cliModels: cfg.cliModels,
        parkReleaseSeconds: cfg.parkReleaseSeconds,
        source,
      });
      return response(201, mapIntent(meta));
    }

    return response(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('intents handler error:', err);
    return response(500, { error: err.message });
  } finally {
    if (conn) {
      try {
        await conn.close();
      } catch {
        /* best-effort */
      }
    }
  }
};

// Start the orchestrator durable execution. Async (Event) — the orchestrator
// runs the long stage loop; the HTTP caller returns immediately (202).
const invokeOrchestrator = async (payload) => {
  const fn = ORCHESTRATOR_FN();
  if (!fn) {
    console.error('V2_ORCHESTRATOR_FUNCTION not configured — cannot start');
    return;
  }
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: fn,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
};

// Resume the suspended durable execution by completing the callback it parked on.
// Resumes the SAME execution (unlike Invoke, which starts a new one).
const resumeDurableCallback = async (callbackId, answer) => {
  await lambdaClient.send(
    new SendDurableExecutionCallbackSuccessCommand({
      CallbackId: callbackId,
      Result: Buffer.from(JSON.stringify({ answer: answer ?? null })),
    }),
  );
};

const mapStage = (s) => ({
  stageInstanceId: s.stageInstanceId,
  stageId: s.stageId ?? null,
  phase: s.phase ?? null,
  state: s.state,
  attempt: s.attempt ?? 0,
  cli: s.cli ?? null,
  runtimeError: s.runtimeError ?? null,
  startedAt: s.startedAt ?? null,
  completedAt: s.completedAt ?? null,
  updatedAt: s.updatedAt ?? null,
});

const mapHumanTask = (h) => ({
  humanTaskId: h.humanTaskId,
  stageInstanceId: h.stageInstanceId ?? null,
  kind: h.kind,
  status: h.status,
  prompt: h.prompt ?? null,
  options: h.options ?? null,
  questions: h.questions ?? null,
  answer: h.answer ?? null,
  answeredBy: h.answeredBy ?? null,
  answeredAt: h.answeredAt ?? null,
  createdAt: h.createdAt ?? null,
});
