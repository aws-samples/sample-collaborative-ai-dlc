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
import executionPlanPkg from '../shared/v2-execution-plan.js';
import pricingPkg from '../shared/model-pricing.js';
import metricClassificationPkg from '../shared/metric-classification.js';
import { fetchKnowledgeGraph } from './knowledge-graph.js';

const { createProcessStore } = pkg;
const { parseCliModels, mergeCliModels } = cliModelsPkg;
const { loadWorkflowScopes, loadExecutionPlan } = workflowPlanPkg;
const { stageInstanceId: planStageInstanceId } = executionPlanPkg;
const { makePriceResolver, costForMetrics } = pricingPkg;
const { aggregateMetrics, rollupAggregates } = metricClassificationPkg;

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const __ = gremlin.process.statics;
const { cardinality, P } = gremlin.process;

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

// Model pricing (READ path). Prices live in SSM (`${prefix}/model-pricing`, a
// family→{input,output} JSON that the agents lambda refreshes from the AWS Price
// List API — this lambda never calls Pricing, so it needs no extra SDK client).
// We cache the built resolver for the container's life. The static fallback baked
// into model-pricing.js means cost is always computable even before the first
// refresh has populated SSM. Best-effort: any failure degrades to the seed and
// never breaks the intent GET.
const MODEL_PRICING_SSM_PREFIX = () => process.env.AGENT_SETTINGS_SSM_PREFIX || '';
const PRICING_TTL_MS = 6 * 60 * 60 * 1000; // re-read SSM at most every 6h
let cachedPricing = null; // { resolver, at }

const loadPricingTable = async () => {
  const prefix = MODEL_PRICING_SSM_PREFIX();
  if (!prefix) return {};
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: `${prefix}/model-pricing` }));
    const parsed = JSON.parse(res.Parameter?.Value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // not yet populated / unreadable → static fallback prices this run
  }
};

const getPriceResolver = async () => {
  if (cachedPricing && Date.now() - cachedPricing.at < PRICING_TTL_MS) {
    return cachedPricing.resolver;
  }
  const table = await loadPricingTable().catch(() => ({}));
  const resolver = makePriceResolver(table);
  cachedPricing = { resolver, at: Date.now() };
  return resolver;
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

const getResponder = (event) => {
  const claims = event?.requestContext?.authorizer?.claims || {};
  return {
    sub: claims.sub || '',
    displayName: claims['custom:display_name'] || claims.email || claims.sub || '',
  };
};

const answerText = (answer) => {
  if (answer == null) return 'answered';
  if (typeof answer === 'string') return answer;
  if (Array.isArray(answer?.answers)) {
    const parts = answer.answers
      .map(
        (a) => a.freeText || (Array.isArray(a.selectedOptions) ? a.selectedOptions.join(', ') : ''),
      )
      .filter(Boolean);
    return parts.join('; ') || 'answered';
  }
  return 'answered';
};

const questionText = (questionsJson) => {
  try {
    const parsed = JSON.parse(questionsJson ?? '[]');
    const first = Array.isArray(parsed) ? parsed[0]?.text : null;
    return first ? String(first) : 'question';
  } catch {
    return 'question';
  }
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
    // Concurrency cap for parallel unit lanes (docs/v2-parallel.md WP5);
    // 0 = unbounded. `|| 0` is safe: 0 IS the default.
    maxParallelUnits: Number(getVal(v, 'max_parallel_units') || 0),
    // PR strategy at fan-in (docs/v2-parallel.md WP6; only intent-pr enabled).
    prStrategy: getVal(v, 'pr_strategy') || 'intent-pr',
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
    // Rewind lineage (docs/v2-steering.md): set when a rewind superseded this
    // artifact and the re-run has not yet rehabilitated it. UI dims it.
    supersededAt: getVal(vm, 'superseded_at') ?? null,
    supersededBy: getVal(vm, 'superseded_by') ?? null,
    content: getVal(vm, 'content') ?? null,
  }));
};

const fetchInfluencedArtifacts = async (g, questionId) => {
  const rows = await g
    .V()
    .has('Question', 'id', questionId)
    .out('INFLUENCES')
    .hasLabel('Artifact')
    .project('id', 'title')
    .by('id')
    .by(__.coalesce(__.values('title'), __.constant('')))
    .toList();
  return rows.map((r) => ({ id: r.get('id'), title: r.get('title') || r.get('id') }));
};

const syncAnsweredQuestionVertex = async ({ g, intentId, gate, answer, responder, answeredAt }) => {
  const exists = await g.V().has('Question', 'id', gate.humanTaskId).hasNext();
  if (!exists) return;
  await g
    .V()
    .has('Question', 'id', gate.humanTaskId)
    .property(cardinality.single, 'intent_id', intentId)
    .property(cardinality.single, 'stage_instance_id', gate.stageInstanceId ?? '')
    .property(cardinality.single, 'structured_answer', JSON.stringify(answer ?? null))
    .property(cardinality.single, 'answered_by', responder.sub)
    .property(cardinality.single, 'answered_by_name', responder.displayName)
    .property(cardinality.single, 'answered_at', answeredAt)
    .next();
};

const linkQuestionToStageArtifacts = async (g, intentId, gate) => {
  if (!gate.stageInstanceId) return;
  const artifactIds = await g
    .V()
    .has('Intent', 'id', intentId)
    .out('CONTAINS')
    .hasLabel('Artifact')
    .has('created_by_stage_instance_id', gate.stageInstanceId)
    .values('id')
    .toList();
  for (const artifactId of artifactIds) {
    const exists = await g
      .V()
      .has('Question', 'id', gate.humanTaskId)
      .outE('INFLUENCES')
      .where(__.inV().has('Artifact', 'id', artifactId))
      .hasNext();
    if (!exists) {
      await g
        .V()
        .has('Question', 'id', gate.humanTaskId)
        .addE('INFLUENCES')
        .to(__.V().has('Artifact', 'id', artifactId))
        .next();
    }
  }
};

// Mirror a steering (course-correction) row as a Steering vertex hanging off the
// Intent anchor, so the knowledge graph shows WHY the run changed direction. A
// revision additionally gets a REVISES edge to the Question it corrects.
// Best-effort by design: the STEER row is the source of truth; a DRAFT-era
// intent (no Neptune anchor yet) simply skips the mirror.
const mirrorSteeringVertex = async ({ g, intentId, steer }) => {
  const anchored = await g.V().has('Intent', 'id', intentId).hasNext();
  if (!anchored) return;
  const exists = await g.V().has('Steering', 'id', steer.steerId).hasNext();
  if (!exists) {
    await g
      .addV('Steering')
      .property('id', steer.steerId)
      .property('intent_id', intentId)
      .property('kind', steer.kind)
      .property('message', steer.message ?? '')
      .property('target_gate_id', steer.targetGateId ?? '')
      .property('target_stage_id', steer.targetStageId ?? '')
      .property('created_by', steer.createdBy ?? '')
      .property('created_by_name', steer.createdByName ?? '')
      .property('created_at', steer.createdAt)
      .next();
    await g
      .V()
      .has('Intent', 'id', intentId)
      .addE('CONTAINS')
      .to(__.V().has('Steering', 'id', steer.steerId))
      .next();
  }
  if (steer.kind === 'revision' && steer.targetGateId) {
    const question = await g.V().has('Question', 'id', steer.targetGateId).hasNext();
    if (question) {
      const linked = await g
        .V()
        .has('Steering', 'id', steer.steerId)
        .outE('REVISES')
        .where(__.inV().has('Question', 'id', steer.targetGateId))
        .hasNext();
      if (!linked) {
        await g
          .V()
          .has('Steering', 'id', steer.steerId)
          .addE('REVISES')
          .to(__.V().has('Question', 'id', steer.targetGateId))
          .next();
      }
    }
  }
};

// Rewind graph cleanup: mark every artifact produced by the reset stages as
// superseded (kept for lineage, dimmed in the UI). The marker is the dedicated
// `superseded_at`/`superseded_by` prop pair — NOT the free-form `status` prop
// agents may set. The re-run's create/update_artifact clears the marker; a
// replacement artifact links DERIVED_FROM instead. Returns the superseded
// artifact ids (for the audit event).
const supersedeArtifactsForStages = async (g, intentId, stageInstanceIds, steerId) => {
  if (!stageInstanceIds.length) return [];
  const ts = new Date().toISOString();
  const ids = await g
    .V()
    .has('Intent', 'id', intentId)
    .out('CONTAINS')
    .hasLabel('Artifact')
    .has('created_by_stage_instance_id', P.within(...stageInstanceIds))
    .values('id')
    .toList();
  for (const id of ids) {
    await g
      .V()
      .has('Artifact', 'id', id)
      .property(cardinality.single, 'superseded_at', ts)
      .property(cardinality.single, 'superseded_by', steerId)
      .next();
  }
  return ids;
};

const buildGateAnswerEvents = async (g, gates) => {
  const answered = gates.filter((gate) => gate.kind === 'question' && gate.answeredAt);
  const events = [];
  for (const gate of answered) {
    const artifacts = await fetchInfluencedArtifacts(g, gate.humanTaskId).catch(() => []);
    const who = gate.answeredByName || gate.answeredBy || 'Someone';
    const q = questionText(gate.questions);
    const a = answerText(gate.answer);
    events.push({
      eventId: `human-answer-${gate.humanTaskId}`,
      type: 'v2.question.answered',
      stageInstanceId: gate.stageInstanceId ?? null,
      actor: gate.answeredByName || gate.answeredBy || null,
      summary: `${who} answered "${q}" with "${a}"`,
      timestamp: gate.answeredAt,
      humanTaskId: gate.humanTaskId,
      questions: gate.questions ?? null,
      answer: gate.answer ?? null,
      answeredBy: gate.answeredBy ?? null,
      answeredByName: gate.answeredByName ?? null,
      artifacts,
    });
  }
  return events;
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
  rewindFromStageId: meta.rewindFromStageId ?? null,
  agentCli: meta.agentCli ?? null,
  cliModels: meta.cliModels ?? null,
  parkReleaseSeconds: meta.parkReleaseSeconds ?? null,
  maxParallelUnits: meta.maxParallelUnits ?? null,
  constructionAutonomyMode: meta.constructionAutonomyMode ?? null,
  prStrategy: meta.prStrategy ?? null,
  source: meta.source ?? null,
  planWarnings: meta.planWarnings ?? null,
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
      const responder = getResponder(event);
      const answered = await store.answerHumanTask({
        executionId: intentId,
        humanTaskId,
        status: data.status || 'answered',
        answer: data.answer ?? null,
        answeredBy: responder.sub,
        answeredByName: responder.displayName,
      });
      if (!answered) {
        return response(409, { error: 'Gate already answered or not pending' });
      }
      // Optional course correction riding on the answer (docs/v2-steering.md):
      // record it BEFORE resuming the callback so the resume run-stage — which
      // reads pending steering at entry — is guaranteed to inject it into the
      // parked conversation alongside the answer.
      let steer = null;
      const steeringMessage = typeof data.steering === 'string' ? data.steering.trim() : '';
      if (steeringMessage) {
        steer = await store.createSteering({
          executionId: intentId,
          kind: 'gate-steer',
          message: steeringMessage,
          targetGateId: humanTaskId,
          createdBy: responder.sub,
          createdByName: responder.displayName,
        });
        await store
          .appendEvent({
            executionId: intentId,
            type: 'v2.steering.recorded',
            stageInstanceId: gate.stageInstanceId ?? null,
            actor: responder.displayName || responder.sub,
            summary: `${responder.displayName || 'Someone'} added a course correction with their answer`,
          })
          .catch((err) => console.error('Steering event append failed:', err.message));
        await mirrorSteeringVertex({ g, intentId, steer }).catch((err) =>
          console.error('Steering graph mirror failed:', err.message),
        );
      }
      await syncAnsweredQuestionVertex({
        g,
        intentId,
        gate,
        answer: answered.answer,
        responder,
        answeredAt: answered.answeredAt,
      }).catch((err) => console.error('Question graph sync failed:', err.message));
      await linkQuestionToStageArtifacts(g, intentId, gate).catch((err) =>
        console.error('Question artifact link sync failed:', err.message),
      );
      // Resume the suspended orchestrator ONLY if this gate is the one the
      // durable run actually parked on (it carries the callbackId). Answering an
      // older sibling gate just records the durable Q&A — the run is parked on a
      // different callback. SendDurableExecutionCallbackSuccess resumes the
      // EXISTING execution; a fresh Invoke would start a new one.
      if (gate.callbackId) {
        await resumeDurableCallback(gate.callbackId, answered.answer);
      }
      return response(200, {
        ...mapHumanTask(answered),
        steering: steer ? mapSteering(steer) : null,
      });
    }

    // POST /projects/{projectId}/intents/{intentId}/gates/{humanTaskId}/revise
    // Correct an already-given answer (docs/v2-steering.md). The original answer
    // is immutable — the correction is a STEER row delivered at the next
    // deterministic injection point (gate resume or fresh stage start).
    if (intentId && humanTaskId && httpMethod === 'POST' && path?.endsWith('/revise')) {
      const data = body ? JSON.parse(body) : {};
      const message = typeof data.message === 'string' ? data.message.trim() : '';
      if (!message) return response(400, { error: 'message is required' });
      const gate = await store.getHumanTask(intentId, humanTaskId);
      if (!gate) return response(404, { error: 'Gate not found' });
      const meta = await store.getExecution(intentId);
      if (!meta || meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      if (gate.status === 'pending') {
        return response(409, { error: 'Gate is still pending — answer it instead of revising' });
      }
      if (['SUCCEEDED', 'CANCELLED'].includes(meta.status)) {
        return response(409, { error: `Intent is ${meta.status}; nothing left to steer` });
      }
      const responder = getResponder(event);
      const steer = await store.createSteering({
        executionId: intentId,
        kind: 'revision',
        message,
        targetGateId: humanTaskId,
        createdBy: responder.sub,
        createdByName: responder.displayName,
      });
      await store.markGateRevised({ executionId: intentId, humanTaskId, steerId: steer.steerId });
      await store
        .appendEvent({
          executionId: intentId,
          type: 'v2.gate.revised',
          stageInstanceId: gate.stageInstanceId ?? null,
          actor: responder.displayName || responder.sub,
          summary: `${responder.displayName || 'Someone'} revised their answer to "${questionText(gate.questions)}"`,
        })
        .catch((err) => console.error('Revise event append failed:', err.message));
      await mirrorSteeringVertex({ g, intentId, steer }).catch((err) =>
        console.error('Steering graph mirror failed:', err.message),
      );
      // Tell the caller when the correction will reach the agent: a WAITING run
      // delivers on the pending gate's resume; otherwise at the next stage start.
      const delivery = meta.status === 'WAITING' ? 'next-resume' : 'next-stage-start';
      return response(201, { ...mapSteering(steer), delivery });
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

    // POST /projects/{projectId}/intents/{intentId}/cancel
    // Retire a run that is parked (WAITING), stranded (CREATED) or FAILED. A
    // RUNNING stage cannot be cancelled mid-turn (steering is deterministic —
    // docs/v2-steering.md); wait for it to park or finish. Supersedes every
    // pending gate, wakes the suspended orchestrator with a cancel sentinel
    // (it sees the superseded gate and exits without touching META), then
    // flips META → CANCELLED.
    if (intentId && httpMethod === 'POST' && path?.endsWith('/cancel')) {
      const meta = await store.getExecution(intentId);
      if (!meta || meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      const CANCELLABLE = new Set(['WAITING', 'CREATED', 'FAILED']);
      if (!CANCELLABLE.has(meta.status)) {
        return response(409, { error: `Intent is ${meta.status}, cannot cancel` });
      }
      const responder = getResponder(event);
      await retireParkedRun(intentId, `cancelled by ${responder.displayName || responder.sub}`);
      const updated = await store.updateExecution({
        executionId: intentId,
        projectId,
        status: 'CANCELLED',
        fromStatus: meta.status,
        startedAt: meta.startedAt,
        pendingHumanTaskId: null,
        completedAt: new Date().toISOString(),
      });
      await store
        .appendEvent({
          executionId: intentId,
          type: 'v2.execution.cancelled',
          actor: responder.displayName || responder.sub,
          summary: `Run cancelled by ${responder.displayName || 'a project member'}`,
        })
        .catch((err) => console.error('Cancel event append failed:', err.message));
      return response(200, mapIntent(updated));
    }

    // POST /projects/{projectId}/intents/{intentId}/rewind
    // Restart the run from an earlier stage with corrective guidance
    // (docs/v2-steering.md). Rejected while RUNNING (409) — steering is only
    // applied at deterministic points, so wait for the stage to park or finish.
    // Resets the target stage + everything after it in run order (attempt+1),
    // supersedes the artifacts those stages produced (kept for lineage), records
    // the guidance as a rewind STEER row (injected into the restarted stage's
    // prompt), and relaunches the orchestrator at that stage.
    if (intentId && httpMethod === 'POST' && path?.endsWith('/rewind')) {
      const data = body ? JSON.parse(body) : {};
      const fromStageId = typeof data.fromStageId === 'string' ? data.fromStageId : '';
      const guidance = typeof data.guidance === 'string' ? data.guidance.trim() : '';
      if (!fromStageId) return response(400, { error: 'fromStageId is required' });
      if (!guidance) {
        return response(400, {
          error: 'guidance is required — tell the agent what went wrong and what to do instead',
        });
      }
      const meta = await store.getExecution(intentId);
      if (!meta || meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      const REWINDABLE = new Set(['SUCCEEDED', 'FAILED', 'WAITING', 'CANCELLED']);
      if (!REWINDABLE.has(meta.status)) {
        return response(409, {
          error: `Intent is ${meta.status}, cannot rewind — wait for the stage to park or finish`,
        });
      }
      // Resolve the pinned plan to find the rewind point + the downstream set.
      const planResult = await loadExecutionPlan({
        ddb,
        tableName: BLOCKS_TABLE(),
        workflowId: meta.workflowId,
        workflowVersion: meta.workflowVersion,
        scope: meta.scope,
      });
      if (!planResult.valid || !planResult.plan) {
        return response(409, {
          error: 'Execution plan cannot be resolved',
          errors: planResult.errors,
        });
      }
      const stages = planResult.plan.stages;
      const idx = stages.findIndex((s) => s.stageId === fromStageId);
      if (idx < 0) {
        return response(400, {
          error: `Unknown stage "${fromStageId}"`,
          stages: stages.map((s) => s.stageId),
        });
      }
      const resetStages = stages.slice(idx);
      // Per-unit instance expansion (docs/v2-parallel.md WP4): a `forEach:
      // unit-of-work` stage has one STAGE row (and one artifact provenance id)
      // PER UNIT — a rewind must reset every lane's instance, and the touched
      // lanes themselves, or the relaunch would see stale terminal rows.
      const sectionStages = resetStages.filter((s) => s.parallelSection != null);
      const unitPlan = sectionStages.length
        ? await store.getUnitPlan(intentId).catch(() => null)
        : null;
      const unitSlugs = (unitPlan?.units ?? []).map((u) => u.slug);
      const planNamespace =
        planResult.plan.namespace ?? `${meta.workflowId}@${meta.workflowVersion}`;
      const resetInstances = resetStages.flatMap((stage) =>
        stage.parallelSection != null
          ? unitSlugs.map((unitSlug) => ({
              stage,
              unitSlug,
              stageInstanceId: planStageInstanceId(planNamespace, stage.stageId, unitSlug),
            }))
          : [{ stage, unitSlug: null, stageInstanceId: stage.stageInstanceId }],
      );
      const responder = getResponder(event);
      // Retire a parked run first so the woken orchestrator exits quietly (its
      // gate is superseded) instead of racing the relaunch.
      await retireParkedRun(intentId, `rewound to ${fromStageId}`);
      // Record the guidance BEFORE resetting/relaunching: the restarted stage
      // reads pending steering at entry, so the correction can never be missed.
      const steer = await store.createSteering({
        executionId: intentId,
        kind: 'rewind',
        message: guidance,
        targetStageId: fromStageId,
        createdBy: responder.sub,
        createdByName: responder.displayName,
      });
      for (const { stage, unitSlug, stageInstanceId } of resetInstances) {
        const reset = await store.resetStageRow({
          executionId: intentId,
          stageInstanceId,
        });
        if (reset) {
          await store
            .appendEvent({
              executionId: intentId,
              type: 'v2.stage.reset',
              stageInstanceId,
              unitSlug,
              actor: responder.displayName || responder.sub,
              summary: `Stage ${stage.stageId}${unitSlug ? ` [unit ${unitSlug}]` : ''} reset for rewind (attempt ${reset.attempt + 1})`,
            })
            .catch(() => {});
        }
      }
      // Reset the touched lanes so the relaunch re-walks them (state PENDING,
      // stale verdict fields cleared). Unconditional — a rewind overrides any
      // lane state; the UNIT rows are the lane-level view, never audit (the
      // per-instance STAGE rows + EVENT feed keep the history).
      if (sectionStages.length && unitSlugs.length) {
        for (const slug of unitSlugs) {
          await store
            .updateUnitState({
              executionId: intentId,
              slug,
              state: 'PENDING',
              fields: { failureReason: null, blockedOn: null },
            })
            .catch((err) => console.error(`Unit lane reset failed (${slug}):`, err.message));
        }
      }
      const supersededArtifacts = await supersedeArtifactsForStages(
        g,
        intentId,
        resetInstances.map((i) => i.stageInstanceId),
        steer.steerId,
      ).catch((err) => {
        console.error('Artifact supersede failed:', err.message);
        return [];
      });
      await mirrorSteeringVertex({ g, intentId, steer }).catch((err) =>
        console.error('Steering graph mirror failed:', err.message),
      );
      await store
        .appendEvent({
          executionId: intentId,
          type: 'v2.execution.rewound',
          actor: responder.displayName || responder.sub,
          summary: `${responder.displayName || 'Someone'} rewound the run to ${fromStageId} (${resetInstances.length} stage instance(s) reset, ${supersededArtifacts.length} artifact(s) superseded)`,
        })
        .catch((err) => console.error('Rewind event append failed:', err.message));
      // Relaunch at the rewind point. Same CAS + rollback discipline as /start.
      const priorStatus = meta.status;
      const updated = await store.updateExecution({
        executionId: intentId,
        projectId,
        status: 'CREATED',
        fromStatus: priorStatus,
        startedAt: meta.startedAt,
        pendingHumanTaskId: null,
        failureReason: null,
        completedAt: null,
        rewindFromStageId: fromStageId,
      });
      try {
        await invokeOrchestrator({
          action: 'start',
          intentId,
          executionId: intentId,
          startAtStageId: fromStageId,
        });
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
      return response(202, { intent: mapIntent(updated), steering: mapSteering(steer) });
    }

    if (intentId && httpMethod === 'GET') {
      // GET /projects/{projectId}/intents/{intentId}/graph — the intent's
      // Neptune knowledge subgraph (artifacts + typed relations + questions +
      // discussions + the project knowledge corpus) for the KnowledgeGraph
      // view. Same membership check as the detail DTO.
      if (path?.endsWith('/graph')) {
        const meta = await store.getExecution(intentId);
        if (!meta || meta.projectId !== projectId) {
          return response(404, { error: 'Intent not found' });
        }
        return response(200, await fetchKnowledgeGraph(g, { projectId, intentId }));
      }

      // GET /projects/{projectId}/intents/{intentId}/outputs — the agent
      // transcript, fetched lazily per activity pane instead of riding the
      // detail DTO (a long run's transcript is megabytes; the DTO is polled).
      // Query params:
      //   stageInstanceId — that stage's chunks; the literal "intent" selects
      //     the stage-less workspace/init bucket; absent = ALL chunks.
      //   afterSeq — only chunks with seq > afterSeq (incremental catch-up
      //     after a websocket-live pane is seeded).
      if (path?.endsWith('/outputs')) {
        const meta = await store.getExecution(intentId);
        if (!meta || meta.projectId !== projectId) {
          return response(404, { error: 'Intent not found' });
        }
        const qs = event.queryStringParameters ?? {};
        const rawStage = qs.stageInstanceId ?? undefined;
        const afterSeq = qs.afterSeq != null && qs.afterSeq !== '' ? Number(qs.afterSeq) : null;
        if (afterSeq != null && !Number.isFinite(afterSeq)) {
          return response(400, { error: 'afterSeq must be a number' });
        }
        const rows = await store.getOutputs(intentId, {
          // "intent" is the UI's bucket key for stage-less (init-ws) output.
          ...(rawStage !== undefined
            ? { stageInstanceId: rawStage === 'intent' ? null : rawStage, filterByStage: true }
            : {}),
          afterSeq,
        });
        return response(200, {
          outputs: rows.map((o) => ({
            seq: o.seq,
            stageInstanceId: o.stageInstanceId ?? null,
            unitSlug: o.unitSlug ?? null,
            kind: o.kind,
            content: o.content,
            timestamp: o.timestamp,
          })),
        });
      }

      // GET single — assembled detail DTO. Outputs are deliberately EXCLUDED
      // (see /outputs above): they dominate the partition's size and the UI
      // fetches them lazily per pane. `outputs: []` keeps the DTO shape stable.
      const records = await store.getExecutionRecords(intentId, { includeOutputs: false });
      if (!records.meta || records.meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      const artifacts = await fetchArtifacts(g, intentId);
      const gates = records.humanTasks.map(mapHumanTask);
      const answerEvents = await buildGateAnswerEvents(g, gates);
      const priceFor = await getPriceResolver();
      return response(200, {
        intent: mapIntent(records.meta),
        stages: records.stages.map(mapStage),
        // Activity feed: lifecycle events (workspace init, failures, completion)
        // newest-last in emit order, so the UI can show what's happening — init-ws
        // is otherwise invisible (it creates no stage row).
        events: [
          ...(records.events ?? []).map((e) => ({
            eventId: e.eventId,
            type: e.eventType,
            stageInstanceId: e.stageInstanceId ?? null,
            unitSlug: e.unitSlug ?? null,
            actor: e.actor ?? null,
            summary: e.summary ?? null,
            timestamp: e.timestamp,
          })),
          ...answerEvents,
        ].toSorted((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))),
        gates,
        steering: (records.steering ?? []).map(mapSteering),
        metrics: mapMetricsWithCost(records.metrics, records.stages, priceFor),
        outputs: [],
        sensorRuns: records.sensorRuns.map((s) => ({
          sensorRunId: s.sensorRunId,
          stageInstanceId: s.stageInstanceId ?? null,
          unitSlug: s.unitSlug ?? null,
          sensorId: s.sensorId,
          result: s.result,
          severity: s.severity,
          held: s.held,
          // The sensor's structured verdict (missing artifacts, unreferenced
          // upstreams, violations …). Surfaced so the UI can explain WHY a
          // non-PASS verdict fired — an advisory INCONCLUSIVE still matters even
          // though it did not hold the stage.
          detail: s.detail ?? null,
          timestamp: s.timestamp,
        })),
        artifacts,
        // Unit lanes (docs/v2-parallel.md WP4): the promoted UNITPLAN snapshot
        // + the live UNIT lane rows, so the UI can render the lane board and
        // attribute per-unit stage instances. Both null/empty pre-promotion.
        unitPlan: mapUnitPlan(records.unitPlan),
        units: (records.units ?? []).map(mapUnit),
      });
    }

    // GET /projects/{projectId}/metrics — usage + cost rolled up across every
    // intent in the project. Reads each execution's METRIC#/STAGE# rows (bounded,
    // fanned out concurrently), aggregates per intent, then rolls up: token
    // counts + cost summed, gauges (context %) peaked. `anyUnpriced` flags that a
    // model (newer / Kiro) couldn't be priced so the UI can caveat the total.
    if (httpMethod === 'GET' && !intentId && path?.endsWith('/intents/metrics')) {
      const metas = await store.listProjectExecutions({ projectId });
      const priceFor = await getPriceResolver();
      const perIntent = await Promise.all(
        metas.map(async (meta) => {
          const records = await store.getExecutionRecords(meta.executionId ?? meta.intentId, {
            includeOutputs: false,
          });
          const summary = summarizeExecutionMetrics(records.metrics, records.stages, priceFor);
          return {
            intentId: meta.intentId ?? meta.executionId,
            title: meta.title ?? null,
            status: meta.status ?? null,
            metrics: summary.metrics,
            cost: summary.cost,
          };
        }),
      );
      const withUsage = perIntent.filter(
        (p) => Object.keys(p.metrics).length > 0 || p.cost.hasCostedSamples,
      );
      const projectMetrics = rollupAggregates(withUsage.map((p) => p.metrics));
      const totalCost = withUsage.reduce((s, p) => s + p.cost.totalCost, 0);
      const anyUnpriced = withUsage.some((p) => p.cost.hasCostedSamples && !p.cost.priced);
      // Kiro credit-priced dollars are estimates (overage rate) — flag them so
      // the UI can caveat the project total instead of presenting it as billing.
      const anyEstimated = withUsage.some((p) => p.cost.estimated);
      return response(200, {
        perIntent: withUsage,
        project: {
          metrics: projectMetrics,
          cost: { totalCost, currency: 'USD', anyUnpriced, anyEstimated },
        },
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
      // Resolve the full execution plan NOW, before any row is written. The
      // plan is a pure function of (workflow@pinnedVersion, scope), so a pass
      // here holds for the whole intent lifetime — this turns a structurally
      // broken scope into a synchronous 400 instead of a post-init-ws
      // `plan_invalid` failure (after a git clone + Neptune anchor were burnt).
      // Non-fatal `warnings` (scope-shortcut degradations: inputs whose
      // producer is out of scope, sections downgraded to once-per-workflow)
      // are persisted on the intent so the UI can surface the degraded run.
      const planCheck = await loadExecutionPlan({
        ddb,
        tableName: BLOCKS_TABLE(),
        workflowId,
        workflowVersion,
        scope,
      });
      if (!planCheck.valid) {
        return response(400, {
          error: `Scope "${scope}" is not runnable for workflow "${workflowId}"`,
          errors: planCheck.errors ?? [],
        });
      }
      const planWarnings = planCheck.warnings?.length ? planCheck.warnings : null;
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
        maxParallelUnits: cfg.maxParallelUnits,
        prStrategy: cfg.prStrategy,
        source,
        planWarnings,
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

// Retire a parked run for cancel/rewind: supersede every still-pending gate
// (CAS — answered gates stay as the Q&A record), then wake any suspended
// callback with a cancel sentinel. The woken orchestrator re-reads its gate,
// sees `superseded`, and exits WITHOUT touching META (docs/v2-steering.md), so
// the retire can never race the relaunch. Best-effort per gate: a gate answered
// concurrently is simply left alone.
const retireParkedRun = async (executionId, reason) => {
  const records = await store.getExecutionRecords(executionId, { includeOutputs: false });
  const pending = (records.humanTasks ?? []).filter((h) => h.status === 'pending');
  for (const gate of pending) {
    const superseded = await store
      .supersedeHumanTask({
        executionId,
        humanTaskId: gate.humanTaskId,
        supersededBy: reason,
      })
      .catch((err) => {
        console.error('Gate supersede failed:', err.message);
        return null;
      });
    if (superseded && gate.callbackId) {
      await lambdaClient
        .send(
          new SendDurableExecutionCallbackSuccessCommand({
            CallbackId: gate.callbackId,
            Result: Buffer.from(JSON.stringify({ cancelled: true, reason })),
          }),
        )
        .catch((err) => console.error('Cancel callback send failed:', err.message));
    }
  }
};

const mapStage = (s) => ({
  stageInstanceId: s.stageInstanceId,
  stageId: s.stageId ?? null,
  unitSlug: s.unitSlug ?? null,
  phase: s.phase ?? null,
  state: s.state,
  attempt: s.attempt ?? 0,
  cli: s.cli ?? null,
  resolvedModel: s.resolvedModel ?? null,
  runtimeError: s.runtimeError ?? null,
  startedAt: s.startedAt ?? null,
  completedAt: s.completedAt ?? null,
  updatedAt: s.updatedAt ?? null,
});

// Unit lanes (docs/v2-parallel.md WP4): the promoted scheduling snapshot and
// the per-lane rows, in wire shape. Null/[] before promotion.
const mapUnitPlan = (p) =>
  p
    ? {
        units: p.units ?? [],
        batches: p.batches ?? [],
        unitCount: p.unitCount ?? (p.units ?? []).length,
        skipMatrix: p.skipMatrix ?? {},
        walkingSkeleton: p.walkingSkeleton ?? null,
        autonomyMode: p.autonomyMode ?? null,
        promotedAt: p.promotedAt ?? null,
      }
    : null;

const mapUnit = (u) => ({
  slug: u.slug,
  dependsOn: u.dependsOn ?? [],
  state: u.state,
  batchIndex: u.batchIndex ?? 0,
  branch: u.branch ?? null,
  startedAt: u.startedAt ?? null,
  mergedAt: u.mergedAt ?? null,
  failureReason: u.failureReason ?? null,
  blockedOn: u.blockedOn ?? null,
  updatedAt: u.updatedAt ?? null,
});

// Map metric rows to the DTO shape, attaching the model in effect and its cost.
// The model comes from the metric row's own stamp (trusted, set by the bridge),
// falling back to the resolvedModel joined from its stage row. Cost is computed
// server-side so intent + project views agree; an unpriced model (newer / Kiro)
// yields `cost.priced: false` rather than a misleading $0. A Kiro `credits`
// sample carries its own stamped $/credit rate and prices as an ESTIMATE
// (`cost.estimated: true`).
const mapMetricsWithCost = (metrics = [], stages = [], priceFor) => {
  const modelByStage = new Map(stages.map((s) => [s.stageInstanceId, s.resolvedModel ?? null]));
  return metrics.map((m) => {
    const model = m.resolvedModel ?? modelByStage.get(m.stageInstanceId) ?? null;
    return {
      metricId: m.metricId,
      stageInstanceId: m.stageInstanceId ?? null,
      metrics: m.metrics ?? {},
      timestamp: m.timestamp,
      model,
      cost: costForMetrics(m.metrics ?? {}, model, priceFor, m.creditRate ?? null),
    };
  });
};

// Fold one execution's metric samples into an aggregated bag (tokens summed,
// gauges peaked) + a total cost. Used per-intent for the project rollup.
// `priced` is true only if every sample that carried spend (tokens or credits)
// was priceable — EXCEPT that an unpriced Kiro token sample counts as covered
// when the same stage also has a credit-priced sample (the credits ARE that
// stage's spend; its token counts are usage detail). `estimated` marks that
// credit-priced (Kiro overage-rate) dollars contributed to the total.
const summarizeExecutionMetrics = (metrics = [], stages = [], priceFor) => {
  const mapped = mapMetricsWithCost(metrics, stages, priceFor);
  const aggregated = aggregateMetrics(
    mapped.map((m) => ({ metrics: m.metrics, timestamp: m.timestamp })),
  );
  // Only samples with spend contribute to the priced/unpriced verdict; a pure
  // context-window sample has no cost and shouldn't mark the intent unpriced.
  const costed = mapped.filter(
    (m) =>
      (m.metrics?.tokensInput ?? 0) + (m.metrics?.tokensOutput ?? 0) > 0 ||
      (m.metrics?.credits ?? 0) > 0,
  );
  const creditPricedStages = new Set(
    costed.filter((m) => m.cost?.priced && m.cost?.estimated).map((m) => m.stageInstanceId),
  );
  const totalCost = costed.reduce((s, m) => s + (m.cost?.totalCost ?? 0), 0);
  const priced =
    costed.length > 0 &&
    costed.every((m) => m.cost?.priced || creditPricedStages.has(m.stageInstanceId));
  const estimated = costed.some((m) => m.cost?.estimated);
  return {
    metrics: aggregated,
    cost: { totalCost, currency: 'USD', priced, estimated, hasCostedSamples: costed.length > 0 },
  };
};

const mapHumanTask = (h) => ({
  humanTaskId: h.humanTaskId,
  stageInstanceId: h.stageInstanceId ?? null,
  unitSlug: h.unitSlug ?? null,
  kind: h.kind,
  status: h.status,
  prompt: h.prompt ?? null,
  options: h.options ?? null,
  questions: h.questions ?? null,
  answer: h.answer ?? null,
  answeredBy: h.answeredBy ?? null,
  answeredByName: h.answeredByName ?? null,
  answeredAt: h.answeredAt ?? null,
  createdAt: h.createdAt ?? null,
  // Steering (docs/v2-steering.md): a revised answer keeps its original payload
  // and points at the correction; a superseded gate was retired by cancel/rewind.
  revisedAt: h.revisedAt ?? null,
  revisionSteerId: h.revisionSteerId ?? null,
  supersededAt: h.supersededAt ?? null,
  supersededBy: h.supersededBy ?? null,
});

// Map a STEER row to the wire shape (docs/v2-steering.md).
const mapSteering = (s) => ({
  steerId: s.steerId,
  kind: s.kind,
  status: s.status,
  message: s.message ?? null,
  targetGateId: s.targetGateId ?? null,
  targetStageId: s.targetStageId ?? null,
  createdBy: s.createdBy ?? null,
  createdByName: s.createdByName ?? null,
  createdAt: s.createdAt ?? null,
  consumedAt: s.consumedAt ?? null,
  consumedByStageInstanceId: s.consumedByStageInstanceId ?? null,
});
