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
import { fetchMembershipRole } from '../shared/trackers.js';
import { signRealtimeToken } from '../shared/realtime-token.js';
import cliModelsPkg from '../shared/cli-models.js';
import workflowPlanPkg from '../shared/v2-workflow-plan.js';

const { createProcessStore } = pkg;
const { parseCliModels } = cliModelsPkg;
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
  const rawVersion = getVal(v, 'workflow_version');
  // Snapshot the project's per-CLI model selection onto the intent so the run is
  // reproducible even if the project setting later changes. {} when unset.
  const cliModels = parseCliModels(getVal(v, 'cli_models'));
  return {
    workflowId: getVal(v, 'workflow_id') || DEFAULT_WORKFLOW_ID,
    workflowVersion: rawVersion ? Number(rawVersion) : null,
    parkReleaseSeconds: Number(getVal(v, 'park_release_seconds') || 300),
    cliModels: Object.keys(cliModels).length ? cliModels : null,
    repos: ordered,
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
  cliModels: meta.cliModels ?? null,
  parkReleaseSeconds: meta.parkReleaseSeconds ?? null,
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
      if (meta.status !== 'DRAFT') {
        return response(409, { error: `Intent is ${meta.status}, cannot start` });
      }
      if (!meta.prompt) {
        return response(400, { error: 'Intent has no prompt; define it before starting' });
      }
      // Flip DRAFT → CREATED (CAS) so a double-start can't launch two runs, then
      // hand off to the orchestrator (init-ws + run the plan).
      const updated = await store.updateExecution({
        executionId: intentId,
        projectId,
        status: 'CREATED',
        fromStatus: 'DRAFT',
        startedAt: meta.startedAt,
      });
      await invokeOrchestrator({ action: 'start', intentId, executionId: intentId });
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
        cliModels: cfg.cliModels,
        parkReleaseSeconds: cfg.parkReleaseSeconds,
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
