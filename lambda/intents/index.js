import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  LambdaClient,
  GetDurableExecutionCommand,
  InvokeCommand,
  ListDurableExecutionsByFunctionCommand,
  SendDurableExecutionCallbackSuccessCommand,
  StopDurableExecutionCommand,
} from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { requirePlatformAdmin } from '../shared/authz.js';
import { createProcessStore } from '../shared/v2-process-store.js';
import { deleteIntentCascade, IntentRunningError } from '../shared/intent-deletion.js';
import { buildResponse } from '../shared/response.js';
import { fetchMembershipRole, projectTrackersFoldStep, mapBinding } from '../shared/trackers.js';
import { signRealtimeToken } from '../shared/realtime-token.js';
import { parseCliModels, mergeCliModels } from '../shared/cli-models.js';
import { parseTierModels, mergeTierModels } from '../shared/tier-models.js';
import {
  loadWorkflowScopes,
  loadExecutionPlan,
  listMergedBlocks,
} from '../shared/v2-workflow-plan.js';
import { stageInstanceId as planStageInstanceId } from '../shared/v2-execution-plan.js';
import { effectiveStageSkipping, normalizeSkipStageIds } from '../shared/stage-skip.js';
import { effectivePrStrategy, normalizePlatformPrStrategy } from '../shared/pr-strategy.js';
import { getGitConnection } from '../shared/git-connection-store.js';
import { ensureFreshGitToken, resolveGitHubTokenForMode } from '../shared/git-token.js';
import { getProvider } from '../shared/git-providers.js';
import { normalizeComposedGrid, pruneSkipsForGrid } from '../shared/composed-grid.js';
import { matchScopeByKeywords } from '../shared/compose-match.js';
import { makePriceResolver, costForMetrics } from '../shared/model-pricing.js';
import { aggregateMetrics, rollupAggregates } from '../shared/metric-classification.js';
import { broadcastToIntentChannel } from '../shared/ws-fanout.js';
import {
  applyArtifactEdit,
  verifyArtifact,
  markArtifactsStale,
  fetchDownstreamClosure,
} from '../shared/artifact-edit.js';
import {
  archiveArtifactsForStages,
  artifactAliases,
  artifactLogicalKeyFromRow,
  legacyVersionId,
  readIntentArtifactEntries,
  selectCanonicalArtifact,
} from '../shared/artifact-versioning.js';
import { fetchKnowledgeGraph } from './knowledge-graph.js';
import { buildIntentAudit } from './audit.js';
import { buildArtifactImpact, editBlockReason, activeQuorumEdit } from './impact.js';

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const __ = gremlin.process.statics;
const { cardinality } = gremlin.process;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});
const s3 = new S3Client({});
const lambdaClient = new LambdaClient({});
const agentcore = new BedrockAgentCoreClient({});
const store = createProcessStore({ ddb });

const BLOCKS_TABLE = () => process.env.BLOCKS_TABLE;
const ORCHESTRATOR_FN = () => process.env.V2_ORCHESTRATOR_FUNCTION;
const DURABLE_EXECUTION_TIMEOUT_SECONDS = () =>
  Number(process.env.DURABLE_EXECUTION_TIMEOUT_SECONDS || 31622400);
// The AgentCore stage-executor runtime — used for the manual derive backfill
// (POST .../derive). Same ARN + session-id convention as the orchestrator.
const AGENTCORE_RUNTIME_ARN = () => process.env.AGENTCORE_RUNTIME_ARN || '';
// Compose report uploads land here (presigned PUT) and are read back at
// compose dispatch. Key shape: compose-reports/<intentId>/<uuid>.json.
const ARTIFACTS_BUCKET = () => process.env.ARTIFACTS_BUCKET || '';
const mapWithConcurrency = async (items, limit, worker) => {
  const results = Array.from({ length: items.length });
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
};
const composeReportPrefix = (intentId) => `compose-reports/${intentId}/`;
const runtimeSessionIdFor = (intentId) => `aidlc-intent-${intentId}`.padEnd(33, '0');
// Composer one-shots run in a THROWAWAY session keyed by the compose id —
// stateless, so a fresh microVM (on the CURRENT image) per request is exactly
// right; see the compose dispatch below for the field incident this avoids.
const composeSessionIdFor = (composeId) => `aidlc-compose-${composeId}`.padEnd(33, '0');
// Unit-lane session ids — must mirror v2-orchestrator/section.js laneSessionIdFor.
const laneSessionIdFor = (intentId, sectionIndex, slug) =>
  `aidlc-intent-${intentId}-s${sectionIndex}-${slug}`.padEnd(33, '0');
const toRepoSlug = (repo) =>
  String(typeof repo === 'string' ? repo : (repo?.url ?? ''))
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '');

const resolveReviewToken = async (meta) => {
  const provider = meta.gitProvider || 'github';
  if (provider === 'github') {
    const { token } = await resolveGitHubTokenForMode(
      { ssm, secrets, ddb },
      {
        userId: meta.startedBy,
        repositories: (meta.repos ?? []).map(toRepoSlug).filter(Boolean),
        permissions: {
          contents: 'read',
          pull_requests: 'write',
          issues: 'write',
        },
      },
    );
    return token || null;
  }
  const connection = await getGitConnection(ddb, meta.startedBy, provider);
  if (!connection?.parameterName) return null;
  return ensureFreshGitToken({
    ssm,
    secrets,
    ddb,
    item: connection,
    gitProvider: provider,
  });
};

const isSelectableReviewComment = (comment) => {
  const author = String(comment?.user?.login ?? '').toLowerCase();
  return (
    comment &&
    !comment.bot &&
    !comment.system &&
    !author.includes('ai-dlc') &&
    typeof comment.body === 'string' &&
    comment.body.trim().length > 0
  );
};

const reviewCommentKey = (comment) =>
  `${comment.repository}\u0000${comment.id}\u0000${comment.version}`;

const feedbackBatchId = (comments) =>
  createHash('sha256')
    .update(comments.map(reviewCommentKey).toSorted().join('\n'))
    .digest('hex')
    .slice(0, 24);

// Best-effort: stop the intent's live AgentCore session(s) so a relaunch
// (rewind) starts a FRESH microVM instead of re-attaching a live one. Field
// incident: an image redeploy does NOT kill/migrate a live session — the
// rewound run kept executing on the pre-fix image ("zombie session") until it
// idled out. The persistent /mnt/workspace mount survives the stop and is
// re-attached by session id, so no checkout/conversation state is lost.
// Never throws: an already-stopped/never-started session must not block the
// caller (same tolerance as the orchestrator's stopRuntimeSession).
const stopRuntimeSessions = async (intentId, { sectionIndexes = [], unitSlugs = [] } = {}) => {
  if (!AGENTCORE_RUNTIME_ARN()) return;
  const ids = [runtimeSessionIdFor(intentId)];
  for (const idx of sectionIndexes) {
    for (const slug of unitSlugs) ids.push(laneSessionIdFor(intentId, idx, slug));
  }
  await mapWithConcurrency(ids, 8, async (id) => {
    try {
      await agentcore.send(
        new StopRuntimeSessionCommand({
          agentRuntimeArn: AGENTCORE_RUNTIME_ARN(),
          runtimeSessionId: id,
        }),
      );
    } catch (err) {
      console.log(`stop-runtime-session best-effort miss (${id}): ${err?.message ?? err}`);
    }
  });
};
// SSM path of the Admin GLOBAL per-CLI model defaults (written by the agents
// lambda's PUT /agents/settings). Merged UNDER the project selection at create so
// the model precedence is project > global(admin) > agentBlock > env, matching
// what the project-settings UI advertises. Empty prefix disables the merge.
const AGENT_SETTINGS_SSM_PREFIX = () => process.env.AGENT_SETTINGS_SSM_PREFIX || '';
const DEFAULT_WORKFLOW_ID = 'aidlc-v2';
// Branch a started intent runs on: aidlc/<title-slug> — derived from the human
// title (falling back to the prompt) so the branch is recognizable in git and
// PR UIs instead of an opaque UUID. Only single hyphens are emitted: `--` is
// reserved as the unit-lane separator (v2-orchestrator/section.js appends
// `--s<k>-unit-<slug>`, and the git providers list `<branch>--task-*` refs).
const slugForBranch = (text) =>
  String(text || '')
    .slice(0, 200) // slug is cut to 60 anyway; don't regex a whole prompt
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics: "café" -> "cafe"
    .replace(/[^a-z0-9]+/g, '-') // any other run becomes a single hyphen
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');

// `taken` = branch names already claimed by the project's other intents. On a
// slug collision a short id suffix keeps the branch unique; a title that
// yields no slug (e.g. all emoji) falls back to the short id alone.
const branchForIntent = ({ title, prompt, intentId, taken = new Set() }) => {
  const shortId = String(intentId).replace(/-/g, '').slice(0, 8);
  const slug = slugForBranch(title) || slugForBranch(prompt) || shortId;
  const candidate = `aidlc/${slug}`;
  return taken.has(candidate) ? `${candidate}-${shortId}` : candidate;
};

// Per-repo base-branch override, e.g. { "acme/api": "develop" }. A project can
// hold multiple repos (primary + secondaries), and each may want to branch off
// a DIFFERENT ref (a hotfix repo tracking `release`, a docs repo tracking
// `main`, …) — so this is a map, not a single string. Any repo omitted from
// the map falls back to the legacy single `baseBranch` (if the caller sent
// one), then to that repo's own actual default branch (resolved lazily by the
// checkout/PR steps — never hardcoded here). Returns `{ value: null }` when
// there is nothing to override; `{ error }` on a malformed or out-of-scope
// input so the caller gets a 400 instead of a silently-ignored typo.
const validateBaseBranches = (input, repos) => {
  if (input === undefined || input === null) return { value: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'baseBranches must be an object of { repoUrl: branchName }' };
  }
  const repoSet = new Set(repos ?? []);
  const out = {};
  for (const [repoUrl, branchName] of Object.entries(input)) {
    if (!repoSet.has(repoUrl)) {
      return { error: `baseBranches references a repo not on this project: ${repoUrl}` };
    }
    if (typeof branchName !== 'string' || !branchName.trim()) {
      return { error: `baseBranches.${repoUrl} must be a non-empty branch name` };
    }
    out[repoUrl] = branchName.trim();
  }
  return { value: Object.keys(out).length ? out : null };
};

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

const safeJsonParse = (value, fallback = null) => {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
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

// Read the Admin GLOBAL tier-model config from SSM (written by the agents
// lambda): per-agent-tier model rows + the fallback/quorum rows. Same
// best-effort contract as the flat map above.
const fetchGlobalTierModels = async () => {
  const prefix = AGENT_SETTINGS_SSM_PREFIX();
  if (!prefix) return {};
  try {
    const res = await ssm.send(
      new GetParameterCommand({ Name: `${prefix}/tier-models`, WithDecryption: true }),
    );
    return parseTierModels(res.Parameter?.Value || '{}');
  } catch {
    return {};
  }
};

// Read the Admin global custom MCP servers (raw JSON string) from SSM (written
// by the agents lambda). Merged UNDER the project's custom MCP servers at
// intent create (project wins by name). Best-effort: any failure yields '{}'.
const fetchGlobalCustomMcpServers = async () => {
  const prefix = AGENT_SETTINGS_SSM_PREFIX();
  if (!prefix) return '{}';
  try {
    const res = await ssm.send(
      new GetParameterCommand({ Name: `${prefix}/custom-mcp-servers`, WithDecryption: true }),
    );
    return res.Parameter?.Value || '{}';
  } catch {
    return '{}';
  }
};

// Read the Admin derive-time graph enrichment mode ('off'|'llm') from SSM
// (written by the agents lambda). Snapshotted onto the execution META row at
// intent create so a toggle flip needs no redeploy and never changes a run
// mid-flight. Best-effort: any failure or unknown value yields 'off'.
const fetchDeriveEnrichment = async () => {
  const prefix = AGENT_SETTINGS_SSM_PREFIX();
  if (!prefix) return 'off';
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: `${prefix}/derive-enrichment` }));
    return res.Parameter?.Value === 'llm' ? 'llm' : 'off';
  } catch {
    return 'off';
  }
};

// Read the Admin platform stage-skipping toggle ('enabled'|'disabled') from
// SSM (written by the agents lambda). The project vertex may override it
// ('stage_skipping': default|enabled|disabled); the EFFECTIVE value (see
// shared/stage-skip.js) is snapshotted onto the execution META row at create.
// Fail-safe: any failure or unknown value yields 'disabled'.
const fetchPlatformStageSkipping = async () => {
  const prefix = AGENT_SETTINGS_SSM_PREFIX();
  if (!prefix) return 'disabled';
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: `${prefix}/stage-skipping` }));
    return res.Parameter?.Value === 'enabled' ? 'enabled' : 'disabled';
  } catch {
    return 'disabled';
  }
};

// Read the platform PR strategy. Fail-safe to intent-pr: an unavailable or
// malformed setting must never expose the more complex integration workflow.
const fetchPlatformPrStrategy = async () => {
  const prefix = AGENT_SETTINGS_SSM_PREFIX();
  if (!prefix) return 'intent-pr';
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: `${prefix}/pr-strategy` }));
    return normalizePlatformPrStrategy(res.Parameter?.Value);
  } catch {
    return 'intent-pr';
  }
};

// Read the Admin compose-LLM-bypass toggle. When 'enabled' (the default), a
// CLEAN deterministic keyword match answers a front compose without any LLM
// call; 'disabled' forces every compose through the composer agent. Fail-open
// to 'enabled' — the bypass is the cheap, deterministic path.
const fetchComposeLlmBypass = async () => {
  const prefix = AGENT_SETTINGS_SSM_PREFIX();
  if (!prefix) return 'enabled';
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: `${prefix}/compose-llm-bypass` }));
    return res.Parameter?.Value === 'disabled' ? 'disabled' : 'enabled';
  } catch {
    return 'enabled';
  }
};

// Map a COMPOSE# row (composer session) to the wire shape.
const mapCompose = (c) => ({
  composeId: c.composeId,
  mode: c.mode,
  state: c.state,
  source: c.source ?? null,
  requestedBy: c.requestedBy ?? null,
  requestedByName: c.requestedByName ?? null,
  instructions: c.instructions ?? null,
  reportKey: c.reportKey ?? null,
  proposal: c.proposal ?? null,
  validation: c.validation ?? null,
  failureReason: c.failureReason ?? null,
  createdAt: c.createdAt ?? null,
  updatedAt: c.updatedAt ?? null,
  completedAt: c.completedAt ?? null,
});

// Parse a raw JSON string into a name-keyed server OBJECT (refs-only). Non-object
// / unparseable input → {}. Used to snapshot each MCP tier separately.
const parseServerMap = (raw) => {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
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
  // Tier-model config, merged the same way (project row/CLI wins, global fills
  // the gaps) and snapshotted alongside: maps each agent's tier to a model per
  // CLI plus the fallback and Quorum rows. See shared/tier-models.js.
  const globalTierModels = await fetchGlobalTierModels();
  const tierModels = mergeTierModels(getVal(v, 'tier_models'), globalTierModels);
  // Custom MCP servers: keep the Admin GLOBAL set and the PROJECT set as TWO
  // SEPARATE name-keyed maps (do NOT pre-merge). Each holds only `${VAR}`
  // references (no secret values). Carrying the tiers apart lets the runtime
  // resolve each tier's secrets against its own SSM prefix (tenant isolation) and
  // merge only AFTER resolution (project wins by name). Custom rules are
  // project-scope only (metadata carries the s3Key the runtime fetches).
  const globalCustomMcp = await fetchGlobalCustomMcpServers();
  const mcpServersByTier = {
    global: parseServerMap(globalCustomMcp),
    project: parseServerMap(getVal(v, 'custom_mcp_servers')),
  };
  const hasMcpServers =
    Object.keys(mcpServersByTier.global).length > 0 ||
    Object.keys(mcpServersByTier.project).length > 0;
  let customRules = [];
  try {
    const parsed = JSON.parse(getVal(v, 'custom_rules') || '[]');
    if (Array.isArray(parsed)) customRules = parsed;
  } catch {
    customRules = [];
  }
  return {
    workflowId: getVal(v, 'workflow_id') || DEFAULT_WORKFLOW_ID,
    workflowVersion: rawVersion ? Number(rawVersion) : null,
    parkReleaseSeconds: Number(getVal(v, 'park_release_seconds') || 300),
    // Concurrency cap for parallel unit lanes (docs/v2-parallel.md WP5);
    // 0 = unbounded. `|| 0` is safe: 0 IS the default.
    maxParallelUnits: Number(getVal(v, 'max_parallel_units') || 0),
    // Project override. Missing is a legacy project and remains intent-pr;
    // new projects persist `default` explicitly.
    prStrategy: getVal(v, 'pr_strategy') || 'intent-pr',
    // Per-project stage-skipping override ('default'|'enabled'|'disabled');
    // 'default' inherits the platform SSM setting (shared/stage-skip.js).
    stageSkipping: getVal(v, 'stage_skipping') || 'default',
    // The project's selected agent CLI (defaults to kiro on the project vertex);
    // snapshotted onto the intent so the run honours the explicit choice.
    agentCli: getVal(v, 'agent_cli') || null,
    cliModels: Object.keys(cliModels).length ? cliModels : null,
    tierModels: Object.keys(tierModels).length ? tierModels : null,
    mcpServersByTier: hasMcpServers ? mcpServersByTier : null,
    customRules: customRules.length ? customRules : null,
    repos: ordered,
    trackers,
    gitProvider: getVal(v, 'git_provider') || 'github',
    // null = each repo's actual default branch (resolved lazily downstream by
    // the checkout and PR/MR steps via the provider's getDefaultBranch — see
    // git-providers/{github,gitlab}.js). Do NOT hardcode 'main': a repo whose
    // default is `master`/`develop`/… must clone/PR against its own HEAD.
    baseBranch: null,
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
  const rows = await readIntentArtifactEntries(g, intentId);
  const groups = new Map();
  for (const row of rows) {
    const key = artifactLogicalKeyFromRow(row, intentId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()]
    .map((group) => ({ group, head: selectCanonicalArtifact(group) }))
    .filter(({ head }) => head && !head.superseded_at)
    .map(({ group, head }) => mapArtifactHead(head, group.length - 1));
};

const mapArtifactHead = (row, legacyVersionCount = 0) => ({
  id: row.id,
  artifactType: row.artifact_type ?? null,
  title: row.title ?? null,
  createdByExecutionId: row.created_by_execution_id ?? null,
  createdByStageInstanceId: row.created_by_stage_instance_id ?? null,
  sectionIndex:
    row.section_index === undefined || row.section_index === '' ? null : Number(row.section_index),
  unitSlug: row.unit_slug || null,
  stageAttempt: Number(row.stage_attempt) || 0,
  generation: Math.max(1, Number(row.generation) || 1),
  versionCount: Math.max(0, Number(row.version_count) || 0) + legacyVersionCount,
  aliases: artifactAliases(row),
  createdAt: row.created_at ?? null,
  staleSince: row.stale_since ?? null,
  staleReason: row.stale_reason ?? null,
  editedBy: row.edited_by ?? null,
  editedByName: row.edited_by_name ?? null,
  editedAt: row.edited_at ?? null,
  editOrigin: row.edit_origin ?? null,
  verifiedBy: row.verified_by ?? null,
  verifiedByName: row.verified_by_name ?? null,
  verifiedAt: row.verified_at ?? null,
  summaryGist: row.summary_gist ?? null,
  summaryClaims: safeJsonParse(row.summary_claims, []),
  enrichmentModel: row.enrichment_model ?? null,
  content: row.content ?? null,
});

// The fan-in PR record(s), anchored Intent --HAS_PR--> PullRequest.
const fetchPullRequests = async (g, intentId) => {
  const rows = await g
    .V()
    .has('Intent', 'id', intentId)
    .out('HAS_PR')
    .hasLabel('PullRequest')
    .valueMap(true)
    .toList();
  return rows.map((vm) => ({
    id: getVal(vm, 'id'),
    repository: getVal(vm, 'repository') ?? null,
    prUrl: getVal(vm, 'pr_url') ?? null,
    prNumber: getVal(vm, 'pr_number') ?? null,
    branch: getVal(vm, 'branch') ?? null,
    baseBranch: getVal(vm, 'base_branch') ?? null,
    createdAt: getVal(vm, 'created_at') ?? null,
  }));
};

// One artifact by id, scoped to the intent (agent-chosen artifact ids are only
// unique within an intent — a bare id match could bind to a foreign intent's
// same-id vertex). Compact shape for the edit routes.
const fetchArtifactRow = async (g, intentId, artifactId) => {
  const rows = await readIntentArtifactEntries(g, intentId);
  const logicalKeys = new Set(
    rows
      .filter((row) => row.id === artifactId || artifactAliases(row).includes(artifactId))
      .map((row) => artifactLogicalKeyFromRow(row, intentId)),
  );
  const row = selectCanonicalArtifact(
    rows.filter((candidate) => logicalKeys.has(artifactLogicalKeyFromRow(candidate, intentId))),
  );
  if (!row) return null;
  return {
    id: row.id,
    vertexId: row.vertexId,
    artifactType: row.artifact_type ?? null,
    title: row.title ?? null,
    supersededAt: row.superseded_at ?? null,
  };
};

const versionSummary = (row, { versionId = row.id, legacy = false } = {}) => ({
  versionId,
  artifactId: row.artifact_id ?? row.id,
  generation: Math.max(1, Number(row.generation) || 1),
  artifactType: row.artifact_type ?? null,
  title: row.title ?? null,
  stageInstanceId: row.created_by_stage_instance_id ?? null,
  stageAttempt: Number(row.stage_attempt) || 0,
  sectionIndex:
    row.section_index === undefined || row.section_index === '' ? null : Number(row.section_index),
  unitSlug: row.unit_slug || null,
  archivedAt: row.archived_at ?? row.updated_at ?? row.created_at ?? null,
  restartId: row.restart_id ?? null,
  restartReason: row.restart_reason ?? (legacy ? 'Legacy artifact record' : null),
  actor: row.archived_by ?? null,
  createdAt: row.created_at ?? null,
  editedAt: row.edited_at ?? null,
  editedByName: row.edited_by_name ?? null,
  contentLength: Number(row.content_length) || Buffer.byteLength(String(row.content ?? ''), 'utf8'),
  contentType: row.content_type ?? 'text/markdown',
  contentHash: row.content_hash ?? null,
  legacy,
});

const fetchArtifactHistory = async (g, intentId, artifactId) => {
  const rows = await readIntentArtifactEntries(g, intentId);
  const groups = new Map();
  for (const row of rows) {
    const key = artifactLogicalKeyFromRow(row, intentId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const candidates = [...groups.values()]
    .filter((group) =>
      group.some((row) => row.id === artifactId || artifactAliases(row).includes(artifactId)),
    )
    .map((group) => ({ group, head: selectCanonicalArtifact(group) }));
  const selected = selectCanonicalArtifact(candidates.map(({ head }) => head).filter(Boolean));
  const entry = candidates.find(({ head }) => head?.vertexId === selected?.vertexId);
  if (!entry?.head) return null;

  const versionRows = (
    await g.V(entry.head.vertexId).out('HAS_VERSION').valueMap(true).toList()
  ).map((row) => {
    const flat = {};
    for (const [key, value] of row.entries()) {
      if (typeof key === 'string') flat[key] = Array.isArray(value) ? value[0] : value;
    }
    return flat;
  });
  const legacyRows = entry.group.filter((row) => row.vertexId !== entry.head.vertexId);
  const versions = [
    ...versionRows.map((row) => ({
      summary: versionSummary(row),
      row,
    })),
    ...legacyRows.map((row) => {
      const versionId = legacyVersionId(row);
      return {
        summary: versionSummary(row, { versionId, legacy: true }),
        row: { ...row, id: versionId, artifact_id: entry.head.id },
      };
    }),
  ].toSorted((a, b) => {
    const byGeneration = b.summary.generation - a.summary.generation;
    return byGeneration || String(b.summary.archivedAt).localeCompare(String(a.summary.archivedAt));
  });
  return { head: entry.head, versions };
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
      // Scope the artifact end by intent_id: agent-chosen artifact ids are only
      // unique within an intent, so a bare id match could bind to a foreign
      // intent's same-id vertex.
      .where(__.inV().has('Artifact', 'id', artifactId).has('intent_id', intentId))
      .hasNext();
    if (!exists) {
      await g
        .V()
        .has('Question', 'id', gate.humanTaskId)
        .addE('INFLUENCES')
        .to(__.V().has('Artifact', 'id', artifactId).has('intent_id', intentId))
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
  baseBranches: meta.baseBranches ?? null,
  repos: meta.repos ?? null,
  gitProvider: meta.gitProvider ?? null,
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
  tierModels: meta.tierModels ?? null,
  parkReleaseSeconds: meta.parkReleaseSeconds ?? null,
  maxParallelUnits: meta.maxParallelUnits ?? null,
  constructionAutonomyMode: meta.constructionAutonomyMode ?? null,
  prStrategy: meta.prStrategy ?? null,
  stageSkipping: meta.stageSkipping ?? null,
  skipStageIds: meta.skipStageIds ?? null,
  composedGrid: meta.composedGrid ?? null,
  source: meta.source ?? null,
  planWarnings: meta.planWarnings ?? null,
  createdAt: meta.startedAt ?? null,
  updatedAt: meta.updatedAt ?? null,
  completedAt: meta.completedAt ?? null,
});

// Map a QEDIT# row (Quorum-supported artifact edit session) to the wire shape.
const mapQuorumEdit = (q) => ({
  editId: q.editId,
  artifactId: q.artifactId,
  artifactType: q.artifactType ?? null,
  artifactTitle: q.artifactTitle ?? null,
  changeDescription: q.changeDescription ?? null,
  state: q.state,
  plan: q.plan ?? null,
  requestedBy: q.requestedBy ?? null,
  requestedByName: q.requestedByName ?? null,
  decidedBy: q.decidedBy ?? null,
  decidedByName: q.decidedByName ?? null,
  decidedAt: q.decidedAt ?? null,
  approvedArtifactIds: q.approvedArtifactIds ?? null,
  updatedArtifactIds: q.updatedArtifactIds ?? null,
  verifiedArtifactIds: q.verifiedArtifactIds ?? null,
  failedArtifactIds: q.failedArtifactIds ?? null,
  failureReason: q.failureReason ?? null,
  createdAt: q.createdAt ?? null,
  updatedAt: q.updatedAt ?? null,
  completedAt: q.completedAt ?? null,
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
  if (
    event?.action === 'repair-durable-executions' ||
    (event?.source === 'aws.events' && event?.['detail-type'] === 'Scheduled Event')
  ) {
    return runDurableExecutionWatchdog(event);
  }
  if (event.httpMethod === 'OPTIONS') return response(200, {});

  const { httpMethod, pathParameters, path, body } = event;
  const projectId = pathParameters?.projectId;
  const intentId = pathParameters?.intentId;
  const humanTaskId = pathParameters?.humanTaskId;
  const unitSlug = pathParameters?.unitSlug;
  const rawSectionIndex = pathParameters?.sectionIndex;
  // Post-hoc artifact editing routes.
  const artifactId = pathParameters?.artifactId;
  const versionId = pathParameters?.versionId;
  const editId = pathParameters?.editId;
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

    // Authenticated unit-review selection. Provider comments are data only:
    // no webhook/comment can launch an agent. GET refreshes selectable
    // comments; POST persists a replay-safe batch that the durable lane claims.
    if (intentId && unitSlug && rawSectionIndex !== undefined && path?.endsWith('/feedback')) {
      const sectionIndex = Number(rawSectionIndex);
      if (!Number.isInteger(sectionIndex) || sectionIndex < 0) {
        return response(400, { error: 'sectionIndex must be a non-negative integer' });
      }
      const meta = await store.getExecution(intentId);
      if (!meta || meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      if (meta.prStrategy !== 'pr-per-unit') {
        return response(409, { error: 'This intent does not use PR per unit' });
      }
      const unit = await store.getUnit(intentId, sectionIndex, unitSlug);
      const activeUnitStates = new Set([
        'PR_DRAFT',
        'RECONCILING',
        'PR_READY',
        'ADDRESSING_FEEDBACK',
      ]);
      if (!unit || !activeUnitStates.has(unit.state)) {
        return response(409, { error: 'The unit lane is not in active review' });
      }
      const prs = (await store.listUnitPrs(intentId, { sectionIndex, slug: unitSlug })).filter(
        (pr) => pr.state !== 'UNCHANGED' && pr.number != null,
      );
      if (prs.length === 0) {
        return response(409, { error: 'The unit lane has no review pull requests' });
      }
      let token;
      try {
        token = await resolveReviewToken(meta);
      } catch (error) {
        console.error('Review credential resolution failed:', error.message);
        return response(502, { error: 'Could not refresh source-control credentials' });
      }
      if (!token) {
        return response(409, {
          error: `No ${meta.gitProvider || 'github'} credential is available`,
        });
      }
      const provider = getProvider(meta.gitProvider || 'github');
      const fetched = [];
      for (const pr of prs) {
        const comments = await provider.listPRComments({ token }, pr.repository, pr.number);
        const selectable = comments.filter(isSelectableReviewComment).map((comment) => ({
          ...comment,
          id: String(comment.id),
          repository: pr.repository,
          prNumber: pr.number,
        }));
        fetched.push(...selectable);
        await store
          .updateUnitPr({
            executionId: intentId,
            sectionIndex,
            slug: unitSlug,
            repository: pr.repository,
            fields: { commentCount: selectable.length },
          })
          .catch(() => {});
      }
      const comments = fetched.toSorted((a, b) =>
        String(a.createdAt).localeCompare(String(b.createdAt)),
      );
      if (httpMethod === 'GET') {
        const history = await store.listFeedbackBatches(intentId, {
          sectionIndex,
          slug: unitSlug,
        });
        const handled = new Set(
          history.flatMap((batch) => (batch.comments ?? []).map(reviewCommentKey)),
        );
        return response(200, {
          comments: comments.map((comment) => ({
            ...comment,
            previouslySelected: handled.has(reviewCommentKey(comment)),
          })),
        });
      }
      if (httpMethod === 'POST') {
        const data = body ? JSON.parse(body) : {};
        const selections = Array.isArray(data.comments) ? data.comments : [];
        if (selections.length < 1 || selections.length > 20) {
          return response(400, { error: 'Select between 1 and 20 comments' });
        }
        const requested = new Map(
          selections.map((selection) => [
            `${selection.repository}\u0000${String(selection.commentId)}`,
            selection,
          ]),
        );
        if (requested.size !== selections.length) {
          return response(400, { error: 'Duplicate comment selections are not allowed' });
        }
        const selected = comments.filter((comment) =>
          requested.has(`${comment.repository}\u0000${String(comment.id)}`),
        );
        if (selected.length !== requested.size) {
          return response(400, {
            error: 'One or more selected comments no longer exist or cannot be addressed',
          });
        }
        const bytes = Buffer.byteLength(JSON.stringify(selected), 'utf8');
        if (bytes > 32 * 1024) {
          return response(413, { error: 'Selected feedback exceeds 32 KiB' });
        }
        const history = await store.listFeedbackBatches(intentId, {
          sectionIndex,
          slug: unitSlug,
        });
        const prior = new Set(
          history.flatMap((batch) => (batch.comments ?? []).map(reviewCommentKey)),
        );
        const repeated = selected.filter((comment) => prior.has(reviewCommentKey(comment)));
        if (repeated.length > 0) {
          return response(409, {
            error: 'Selected feedback has already been queued or handled',
            commentIds: repeated.map((comment) => comment.id),
          });
        }
        const responder = getResponder(event);
        const batchId = feedbackBatchId(selected);
        const created = await store.createFeedbackBatch({
          executionId: intentId,
          sectionIndex,
          slug: unitSlug,
          batchId,
          comments: selected,
          requestedBy: responder.sub,
          requestedByName: responder.displayName,
        });
        if (created.conflict) {
          return response(409, {
            error: 'Selected feedback has already been queued or handled',
          });
        }
        if (created.created) {
          const summary = `${responder.displayName || 'A project member'} queued ${selected.length} review comment(s) for unit ${unitSlug}`;
          await store
            .appendEvent({
              executionId: intentId,
              type: 'v2.feedback.queued',
              unitSlug,
              sectionIndex,
              actor: responder.displayName || responder.sub,
              summary,
            })
            .catch(() => {});
          await broadcastToIntentChannel(intentId, {
            action: 'agent.feedback',
            intentId,
            projectId,
            unitSlug,
            sectionIndex,
            state: 'QUEUED',
            summary,
          }).catch(() => {});
        }
        return response(created.created ? 202 : 200, mapFeedbackBatch(created.item));
      }
      return response(405, { error: 'Method not allowed' });
    }

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

    // ── Post-hoc artifact (document) editing ─────────────────────────────────
    // Documents in Neptune stay editable after the stages that produced /
    // consumed them ran. Every mutation records drift bookkeeping
    // (shared/artifact-edit.js) and broadcasts a payload-blind reload hint on
    // the intent channel (handlers refetch the detail DTO).

    // Read-only artifact history. Archived versions are never returned by the
    // normal intent DTO and never receive collaborative document ids.
    if (intentId && artifactId && httpMethod === 'GET' && path?.endsWith('/versions')) {
      const meta = await store.getExecution(intentId);
      if (!meta || meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      const history = await fetchArtifactHistory(g, intentId, artifactId);
      if (!history) return response(404, { error: 'Artifact not found' });
      const current = mapArtifactHead(history.head);
      return response(200, {
        artifactId: history.head.id,
        current: history.head.superseded_at
          ? null
          : {
              versionId: 'current',
              artifactId: history.head.id,
              generation: current.generation,
              artifactType: current.artifactType,
              title: current.title,
              stageInstanceId: current.createdByStageInstanceId,
              stageAttempt: current.stageAttempt,
              sectionIndex: current.sectionIndex,
              unitSlug: current.unitSlug,
              archivedAt: null,
              restartId: null,
              restartReason: null,
              actor: null,
              createdAt: current.createdAt,
              editedAt: current.editedAt,
              editedByName: current.editedByName,
              contentLength: Buffer.byteLength(String(current.content ?? ''), 'utf8'),
              contentType: 'text/markdown',
              contentHash: createHash('sha256')
                .update(String(current.content ?? ''))
                .digest('hex'),
              legacy: false,
              current: true,
            },
        versions: history.versions.map(({ summary }) => ({ ...summary, current: false })),
      });
    }

    if (
      intentId &&
      artifactId &&
      versionId &&
      httpMethod === 'GET' &&
      path?.includes('/versions/')
    ) {
      const meta = await store.getExecution(intentId);
      if (!meta || meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      const history = await fetchArtifactHistory(g, intentId, artifactId);
      const archived = history?.versions.find(({ summary }) => summary.versionId === versionId);
      if (!archived) return response(404, { error: 'Artifact version not found' });
      return response(200, {
        ...archived.summary,
        current: false,
        content: archived.row.content ?? null,
        relationships: safeJsonParse(archived.row.relationships, []),
        editedBy: archived.row.edited_by ?? null,
        editOrigin: archived.row.edit_origin ?? null,
        verifiedBy: archived.row.verified_by ?? null,
        verifiedByName: archived.row.verified_by_name ?? null,
        verifiedAt: archived.row.verified_at ?? null,
      });
    }

    // GET .../artifacts/{artifactId}/impact — the pre-edit drift warning data:
    // consuming stages (declared + actual reads), the transitive downstream
    // closure, and whether editing is currently blocked.
    if (intentId && artifactId && httpMethod === 'GET' && path?.endsWith('/impact')) {
      const records = await store.getExecutionRecords(intentId, { includeOutputs: false });
      if (!records.meta || records.meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      const artifact = await fetchArtifactRow(g, intentId, artifactId);
      if (!artifact) return response(404, { error: 'Artifact not found' });
      // Declared-consumes evidence needs the resolved plan; degrade to graph +
      // read evidence when it cannot be resolved (never block the warning).
      let plan = null;
      try {
        const planResult = await loadExecutionPlan({
          ddb,
          tableName: BLOCKS_TABLE(),
          workflowId: records.meta.workflowId,
          workflowVersion: records.meta.workflowVersion,
          scope: records.meta.scope,
          ...(Array.isArray(records.meta.skipStageIds) && records.meta.skipStageIds.length
            ? { skipStageIds: records.meta.skipStageIds }
            : {}),
          ...(records.meta.composedGrid ? { composedGrid: records.meta.composedGrid } : {}),
        });
        plan = planResult.valid ? planResult.plan : null;
      } catch {
        plan = null;
      }
      return response(200, await buildArtifactImpact({ g, intentId, artifact, plan, records }));
    }

    // PUT .../artifacts/{artifactId}/content — the human "simple edit". Writes
    // the new content + server-stamped edit provenance, marks the transitive
    // downstream closure stale (drift), re-derives the graph projection for
    // the edited document, and broadcasts a reload hint. Refused while an
    // execution is active or a Quorum edit is in flight (racing the agent's
    // own update_artifact — or a parked conversation resuming over stale
    // in-memory context — is never safe).
    if (intentId && artifactId && httpMethod === 'PUT' && path?.endsWith('/content')) {
      const data = body ? JSON.parse(body) : {};
      if (typeof data.content !== 'string' || !data.content.trim()) {
        return response(400, { error: 'content is required' });
      }
      const records = await store.getExecutionRecords(intentId, { includeOutputs: false });
      if (!records.meta || records.meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      const blockReason = editBlockReason({
        meta: records.meta,
        quorumEdits: records.quorumEdits ?? [],
      });
      if (blockReason) {
        return response(409, {
          error:
            blockReason === 'execution_active'
              ? `Intent is ${records.meta.status} — wait for the stage to park or finish before editing artifacts`
              : 'A Quorum edit is in progress for this intent — wait for it to finish',
          code: blockReason,
        });
      }
      const artifact = await fetchArtifactRow(g, intentId, artifactId);
      if (!artifact) return response(404, { error: 'Artifact not found' });
      if (artifact.supersededAt) {
        return response(409, { error: 'Artifact is superseded — edit its replacement instead' });
      }
      const canonicalArtifactId = artifact.id;
      const responder = getResponder(event);
      // Closure BEFORE the write (root is excluded by construction either way).
      const downstream = await fetchDownstreamClosure({
        g,
        intentId,
        artifactId: canonicalArtifactId,
      }).catch((err) => {
        console.error('Downstream closure failed:', err.message);
        return [];
      });
      const edit = await applyArtifactEdit({
        g,
        intentId,
        artifactId: canonicalArtifactId,
        content: data.content,
        editedBy: responder.sub,
        editedByName: responder.displayName,
        origin: 'human',
        editRef: `human:${responder.sub}`,
      });
      const staleMarked = await markArtifactsStale({
        g,
        intentId,
        artifactIds: downstream.map((d) => d.id),
        reason: `edit:${canonicalArtifactId}:${edit.editedAt}`,
      }).catch((err) => {
        console.error('Stale marking failed:', err.message);
        return [];
      });
      // Mid-run edit (the run is parked WAITING on a gate): the parked CLI
      // conversation still holds the OLD document content. Record a steering
      // row so the next deterministic injection point (this gate's resume or
      // the next fresh stage start — docs/v2-steering.md) tells the agent to
      // re-read the edited document instead of trusting stale context.
      let steer = null;
      if (records.meta.status === 'WAITING') {
        steer = await store
          .createSteering({
            executionId: intentId,
            kind: 'artifact-edit',
            message: `The document "${artifact.title || canonicalArtifactId}" (artifact id: ${canonicalArtifactId}) was edited while this run was parked. Re-read it with get_artifact before continuing — its CURRENT content overrides anything you read earlier in this conversation.`,
            createdBy: responder.sub,
            createdByName: responder.displayName,
          })
          .catch((err) => {
            console.error('Artifact-edit steering record failed:', err.message);
            return null;
          });
        if (steer) {
          await mirrorSteeringVertex({ g, intentId, steer }).catch((err) =>
            console.error('Steering graph mirror failed:', err.message),
          );
        }
      }
      const summary = `${responder.displayName || 'Someone'} edited "${artifact.title || canonicalArtifactId}"${
        staleMarked.length
          ? ` — ${staleMarked.length} downstream artifact(s) marked possibly stale`
          : ''
      }`;
      await store
        .appendEvent({
          executionId: intentId,
          type: 'v2.artifact.edited',
          actor: responder.displayName || responder.sub,
          summary,
        })
        .catch((err) => console.error('Edit event append failed:', err.message));
      await broadcastToIntentChannel(intentId, {
        action: 'agent.note',
        intentId,
        projectId,
        noteType: 'v2.artifact.edited',
        summary,
      });
      // Re-derive the fine-grained projection for the edited document so
      // sections/items/citations stay truthful. Best-effort — the canonical
      // content is already saved; a failed derive is picked up by the next
      // stage-exit derive or the admin backfill.
      let derived = false;
      if (AGENTCORE_RUNTIME_ARN() && artifact.artifactType) {
        try {
          const res = await agentcore.send(
            new InvokeAgentRuntimeCommand({
              agentRuntimeArn: AGENTCORE_RUNTIME_ARN(),
              runtimeSessionId: runtimeSessionIdFor(intentId),
              contentType: 'application/json',
              accept: 'application/json',
              payload: Buffer.from(
                JSON.stringify({
                  command: 'derive-artifacts',
                  projectId,
                  intentId,
                  executionId: intentId,
                  artifactTypes: [artifact.artifactType],
                  enrichment: records.meta.deriveEnrichment === 'llm' ? 'llm' : 'off',
                  ...(records.meta.agentCli ? { requestedCli: records.meta.agentCli } : {}),
                  ...(records.meta.cliModels ? { cliModels: records.meta.cliModels } : {}),
                  ...(records.meta.tierModels ? { tierModels: records.meta.tierModels } : {}),
                }),
              ),
            }),
          );
          const text = res.response ? await res.response.transformToString() : '';
          derived = text ? JSON.parse(text).ok !== false : false;
        } catch (err) {
          console.error('[artifact-edit] derive dispatch failed:', err.message);
        }
      }
      return response(200, {
        artifactId: canonicalArtifactId,
        editedAt: edit.editedAt,
        staleMarked,
        derived,
        // Set when the run was parked: the correction the resumed agent will
        // receive at the next deterministic injection point.
        steering: steer ? mapSteering(steer) : null,
      });
    }

    // POST .../artifacts/{artifactId}/verify — clear the drift marker: a human
    // reviewed the artifact against the upstream edit and judged it still
    // valid. Metadata-only, so it is allowed regardless of run state.
    if (intentId && artifactId && httpMethod === 'POST' && path?.endsWith('/verify')) {
      const data = body ? JSON.parse(body) : {};
      const meta = await store.getExecution(intentId);
      if (!meta || meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      const artifact = await fetchArtifactRow(g, intentId, artifactId);
      if (!artifact) return response(404, { error: 'Artifact not found' });
      const responder = getResponder(event);
      const result = await verifyArtifact({
        g,
        intentId,
        artifactId: artifact.id,
        verifiedBy: responder.sub,
        verifiedByName: responder.displayName,
        note: typeof data.note === 'string' ? data.note : '',
      });
      const summary = `${responder.displayName || 'Someone'} verified "${artifact.title || artifact.id}" against the upstream edit`;
      await store
        .appendEvent({
          executionId: intentId,
          type: 'v2.artifact.verified',
          actor: responder.displayName || responder.sub,
          summary,
        })
        .catch((err) => console.error('Verify event append failed:', err.message));
      await broadcastToIntentChannel(intentId, {
        action: 'agent.note',
        intentId,
        projectId,
        noteType: 'v2.artifact.verified',
        summary,
      });
      return response(200, { artifactId: artifact.id, verifiedAt: result.verifiedAt });
    }

    // POST .../artifacts/{artifactId}/quorum-edit — start a Quorum-supported
    // edit: the user describes the change; Quorum analyzes the downstream
    // impact, proposes a per-artifact update plan (human-approved), then
    // applies it. Driven by a durable orchestrator flow; this endpoint only
    // records the request and hands off.
    if (intentId && artifactId && httpMethod === 'POST' && path?.endsWith('/quorum-edit')) {
      const data = body ? JSON.parse(body) : {};
      const changeDescription =
        typeof data.changeDescription === 'string' ? data.changeDescription.trim() : '';
      if (!changeDescription) {
        return response(400, { error: 'changeDescription is required' });
      }
      const records = await store.getExecutionRecords(intentId, { includeOutputs: false });
      if (!records.meta || records.meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      const blockReason = editBlockReason({
        meta: records.meta,
        quorumEdits: records.quorumEdits ?? [],
      });
      if (blockReason) {
        return response(409, {
          error:
            blockReason === 'execution_active'
              ? `Intent is ${records.meta.status} — wait for the stage to park or finish before editing artifacts`
              : 'A Quorum edit is already in progress for this intent',
          code: blockReason,
        });
      }
      const artifact = await fetchArtifactRow(g, intentId, artifactId);
      if (!artifact) return response(404, { error: 'Artifact not found' });
      if (artifact.supersededAt) {
        return response(409, { error: 'Artifact is superseded — edit its replacement instead' });
      }
      if (!ORCHESTRATOR_FN()) {
        return response(500, { error: 'V2_ORCHESTRATOR_FUNCTION not configured' });
      }
      const responder = getResponder(event);
      const newEditId = `qe-${randomUUID()}`;
      const row = await store.createQuorumEdit({
        executionId: intentId,
        editId: newEditId,
        artifactId: artifact.id,
        artifactType: artifact.artifactType,
        artifactTitle: artifact.title,
        changeDescription,
        requestedBy: responder.sub,
        requestedByName: responder.displayName,
      });
      const summary = `${responder.displayName || 'Someone'} asked Quorum to edit "${artifact.title || artifact.id}"`;
      await store
        .appendEvent({
          executionId: intentId,
          type: 'v2.quorum_edit.requested',
          actor: responder.displayName || responder.sub,
          summary,
        })
        .catch((err) => console.error('Quorum edit event append failed:', err.message));
      await broadcastToIntentChannel(intentId, {
        action: 'agent.note',
        intentId,
        projectId,
        noteType: 'v2.quorum_edit.updated',
        summary,
      });
      try {
        await invokeOrchestrator({
          action: 'quorum-edit',
          intentId,
          executionId: intentId,
          editId: newEditId,
        });
      } catch (err) {
        // The hand-off never reached a live orchestrator — fail the session so
        // it doesn't strand in PLANNING (which would block future edits).
        await store
          .updateQuorumEdit({
            executionId: intentId,
            editId: newEditId,
            state: 'FAILED',
            fields: { failureReason: 'orchestrator_dispatch_failed', completedAt: true },
          })
          .catch(() => {});
        throw err;
      }
      return response(202, mapQuorumEdit(row));
    }

    // POST .../quorum-edits/{editId}/decision — approve or reject Quorum's
    // update plan. Approve optionally narrows the plan to a subset of
    // artifacts. CAS on AWAITING_APPROVAL (a double decision loses), then the
    // suspended durable callback is completed — the same resume-by-callback
    // pattern as gate answers.
    if (intentId && editId && httpMethod === 'POST' && path?.endsWith('/decision')) {
      const data = body ? JSON.parse(body) : {};
      const decision =
        data.decision === 'approve' ? 'approve' : data.decision === 'reject' ? 'reject' : null;
      if (!decision) {
        return response(400, { error: 'decision must be "approve" or "reject"' });
      }
      const meta = await store.getExecution(intentId);
      if (!meta || meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      const edit = await store.getQuorumEdit(intentId, editId);
      if (!edit) return response(404, { error: 'Quorum edit not found' });
      if (edit.state !== 'AWAITING_APPROVAL' || !edit.callbackId) {
        return response(409, { error: `Quorum edit is ${edit.state}, not awaiting approval` });
      }
      const responder = getResponder(event);
      // Only plan items can be approved — a fabricated id is dropped, never
      // forwarded to the apply step.
      const planIds = (edit.plan?.items ?? []).map((i) => i.artifactId);
      const planIdSet = new Set(planIds);
      const approvedArtifactIds =
        decision === 'approve'
          ? Array.isArray(data.approvedArtifactIds)
            ? data.approvedArtifactIds.filter((id) => planIdSet.has(id))
            : planIds
          : [];
      const updated = await store.updateQuorumEdit({
        executionId: intentId,
        editId,
        state: decision === 'approve' ? 'APPLYING' : 'REJECTED',
        fromStates: ['AWAITING_APPROVAL'],
        fields: {
          decidedBy: responder.sub,
          decidedByName: responder.displayName,
          decidedAt: true,
          approvedArtifactIds,
          ...(decision === 'reject' ? { completedAt: true } : {}),
        },
      });
      if (!updated) {
        return response(409, { error: 'Quorum edit was already decided' });
      }
      // Wake the suspended orchestrator with the decision.
      await resumeDurableCallback(edit.callbackId, {
        decision,
        approvedArtifactIds,
        decidedBy: responder.sub,
        decidedByName: responder.displayName,
      });
      const summary = `${responder.displayName || 'Someone'} ${decision === 'approve' ? `approved Quorum's update plan (${approvedArtifactIds.length} artifact(s))` : "rejected Quorum's update plan"}`;
      await store
        .appendEvent({
          executionId: intentId,
          type: 'v2.quorum_edit.decided',
          actor: responder.displayName || responder.sub,
          summary,
        })
        .catch((err) => console.error('Quorum decision event append failed:', err.message));
      await broadcastToIntentChannel(intentId, {
        action: 'agent.note',
        intentId,
        projectId,
        noteType: 'v2.quorum_edit.updated',
        summary,
      });
      return response(200, mapQuorumEdit(updated));
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
      // A live Quorum edit is mutating this intent's artifacts; answering the
      // gate would resume the parked stage RIGHT INTO those writes. The run is
      // already parked — waiting for the edit to finish costs nothing (mirror
      // of the /start guard).
      const answerBlockingEdit = activeQuorumEdit(
        await store.listQuorumEdits(intentId).catch(() => []),
      );
      if (answerBlockingEdit) {
        return response(409, {
          error:
            'A Quorum artifact edit is in progress — wait for it to finish (or reject its plan) before answering, so the resumed stage sees the final documents',
          code: 'quorum_edit_active',
        });
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
        try {
          await resumeDurableCallback(gate.callbackId, answered.answer);
        } catch (err) {
          if (isCallbackTimeoutError(err)) {
            await repairExpiredDurableExecution({
              executionId: intentId,
              projectId,
              meta,
              actor: responder.displayName || responder.sub,
              summary: `${responder.displayName || 'Someone'} answered after the durable execution expired; the run was marked failed and can be restarted`,
            }).catch((repairErr) =>
              console.error('Durable callback expiry repair failed:', repairErr.message),
            );
            return response(409, {
              error: 'Durable execution expired before this answer could resume the run',
              code: 'durable_execution_expired',
            });
          }
          await store
            .appendEvent({
              executionId: intentId,
              type: 'v2.gate.resume_failed',
              stageInstanceId: gate.stageInstanceId ?? null,
              actor: responder.displayName || responder.sub,
              summary: `Gate answer was recorded, but the durable callback could not be completed: ${err?.message ?? 'unknown error'}`,
            })
            .catch((eventErr) =>
              console.error('Gate resume failure event append failed:', eventErr.message),
            );
          return response(503, {
            error:
              'Gate answer was recorded, but the durable callback could not be completed. Retry after refreshing the intent.',
            code: 'durable_callback_resume_failed',
            retryable: true,
          });
        }
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
    // Optional body { skipStageIds } (DRAFT only): replace the intent's skip
    // overlay at the moment of launch — the DRAFT screen is where the user
    // reviews the run before starting, so it is the natural last chance to
    // (de)select CONDITIONAL stages. Same validation as create: only accepted
    // when the run's snapshotted stageSkipping is 'enabled', and the plan must
    // resolve with the overlay applied. FAILED/CREATED restarts never touch
    // the overlay (the prior run's plan holds).
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
      // A live Quorum artifact edit is mutating this intent's artifacts —
      // starting a run underneath it would race the apply step.
      const liveQuorumEdit = activeQuorumEdit(
        await store.listQuorumEdits(intentId).catch(() => []),
      );
      if (liveQuorumEdit) {
        return response(409, {
          error: 'A Quorum artifact edit is in progress — wait for it to finish before starting',
          code: 'quorum_edit_active',
        });
      }
      if (!meta.prompt) {
        return response(400, { error: 'Intent has no prompt; define it before starting' });
      }
      // Skip-overlay / composed-grid override at launch (DRAFT only — a restart
      // re-enters the prior run's pinned plan). `skipStageIds: []` explicitly
      // clears skips picked at create; `composedGrid: null` reverts to the
      // named-scope projection; an absent field leaves the create-time
      // snapshot. Both overrides are validated TOGETHER against the pinned
      // plan below — a grid and an overlay that are individually fine can
      // still starve each other's stages.
      const startData = body ? JSON.parse(body) : {};
      let skipOverride; // undefined = untouched
      let gridOverride; // undefined = untouched
      if (startData.composedGrid !== undefined) {
        if (meta.status !== 'DRAFT') {
          return response(409, {
            error: 'composedGrid can only be changed before the first start (DRAFT)',
          });
        }
        const { value, error: gridError } = normalizeComposedGrid(startData.composedGrid);
        if (gridError) {
          return response(400, { error: gridError });
        }
        gridOverride = value; // null clears, object replaces
      }
      if (startData.skipStageIds !== undefined) {
        if (meta.status !== 'DRAFT') {
          return response(409, {
            error: 'skipStageIds can only be changed before the first start (DRAFT)',
          });
        }
        if (!Array.isArray(startData.skipStageIds)) {
          return response(400, { error: 'skipStageIds must be an array of stage ids' });
        }
        const normalized = normalizeSkipStageIds(startData.skipStageIds);
        if (normalized && meta.stageSkipping !== 'enabled') {
          return response(400, {
            error: 'Stage skipping is disabled for this intent — skipStageIds is not accepted',
          });
        }
        skipOverride = normalized; // null clears, array replaces
      }
      if (skipOverride !== undefined || gridOverride !== undefined) {
        const effectiveGrid = gridOverride !== undefined ? gridOverride : meta.composedGrid;
        // The grid absorbs redundant overlay skips (composed-grid.js) — the
        // pruned overlay is what launches, so the pinned combination always
        // resolves for the orchestrator and the container alike.
        const effectiveSkips = pruneSkipsForGrid(
          skipOverride !== undefined ? skipOverride : meta.skipStageIds,
          effectiveGrid,
        );
        if (effectiveGrid) skipOverride = effectiveSkips;
        const planCheck = await loadExecutionPlan({
          ddb,
          tableName: BLOCKS_TABLE(),
          workflowId: meta.workflowId,
          workflowVersion: meta.workflowVersion,
          scope: meta.scope,
          ...(effectiveSkips?.length ? { skipStageIds: effectiveSkips } : {}),
          ...(effectiveGrid ? { composedGrid: effectiveGrid } : {}),
        });
        if (!planCheck.valid) {
          return response(400, {
            error:
              gridOverride !== undefined
                ? `The composed stage grid is not runnable for workflow "${meta.workflowId}"`
                : `The requested stage skips are not runnable for workflow "${meta.workflowId}"`,
            errors: planCheck.errors ?? [],
          });
        }
      }
      // Flip <current> → CREATED (CAS on the observed status) so a double-start
      // can't launch two runs, then hand off to the orchestrator (init-ws + run the
      // plan). If the hand-off throws, roll back to the prior status — otherwise the
      // intent strands in CREATED (the orchestrator never ran) and never retries.
      const priorStatus = meta.status;
      const durableExecutionName = durableExecutionNameForIntent(intentId);
      const updated = await store.updateExecution({
        executionId: intentId,
        projectId,
        status: 'CREATED',
        fromStatus: priorStatus,
        startedAt: meta.startedAt,
        durableExecutionName,
        durableExecutionArn: null,
        orchestratorStartedAt: null,
        orchestratorExpiresAt: null,
        // Clear any stale failure from a prior attempt as we re-enter the pipeline.
        failureReason: null,
        // Launch-time skip override (validated above; undefined = untouched).
        ...(skipOverride !== undefined ? { skipStageIds: skipOverride } : {}),
        ...(gridOverride !== undefined ? { composedGrid: gridOverride } : {}),
      });
      try {
        const invoked = await invokeOrchestrator(
          { action: 'start', intentId, executionId: intentId },
          { durableExecutionName },
        );
        if (invoked?.durableExecutionArn) {
          await store
            .updateExecution({
              executionId: intentId,
              durableExecutionArn: invoked.durableExecutionArn,
            })
            .catch((err) => console.error('Durable execution ARN stamp failed:', err.message));
        }
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
      // The run is over — free the warm microVM now instead of waiting for the
      // idle reap (the persistent mount survives for a later rewind relaunch).
      await stopRuntimeSessions(intentId);
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

    // DELETE /projects/{projectId}/intents/{intentId}
    // Permanently remove an intent: the Neptune subgraph (anchor + everything
    // it CONTAINS + discussion threads), the entire EXEC#<id> DynamoDB
    // partition, and the intent-scoped realtime Yjs documents. Owner/admin
    // only (destructive, matches repo removal). A RUNNING intent is refused —
    // its durable orchestrator + AgentCore session are live and would write
    // into the deleted partition; any other non-terminal status is first
    // retired exactly like cancel (supersede pending gates, wake the parked
    // orchestrator with a cancel sentinel) so nothing resumes afterwards.
    // Deletion order is deliberate: Yjs docs → Neptune → DynamoDB (META last),
    // so a partial failure leaves the intent listed and the delete retryable.
    // ── Composer (Adaptive Workflows) ────────────────────────────────────────
    // "LLM proposes, engine disposes": a compose request only ever produces a
    // COMPOSE row carrying a proposal + the plan resolver's authoritative
    // verdict. Applying a proposal is a SEPARATE human action (the DRAFT PATCH
    // above / the recompose path), which validates again.

    // POST .../compose-report-upload — presigned PUT for an external analysis
    // report (report-mode compose input). DRAFT only; the key is namespaced
    // under this intent so a report can never be smuggled across intents.
    if (intentId && httpMethod === 'POST' && path?.endsWith('/compose-report-upload')) {
      const meta = await store.getExecution(intentId);
      if (!meta || meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      if (meta.status !== 'DRAFT') {
        return response(409, { error: `Intent is ${meta.status}, compose applies to DRAFT only` });
      }
      if (!ARTIFACTS_BUCKET()) {
        return response(503, { error: 'Report uploads are not configured' });
      }
      const key = `${composeReportPrefix(intentId)}${randomUUID()}.json`;
      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: ARTIFACTS_BUCKET(),
          Key: key,
          ContentType: 'application/json',
        }),
        { expiresIn: 300 },
      );
      return response(200, { uploadUrl, key, expiresIn: 300 });
    }

    // POST .../compose — start a composer session for this intent.
    // Body: { instructions?, reportKey?, repoSignals?, mode? }. Modes:
    //   front  (default) — DRAFT only, composed from the draft text;
    //   report           — DRAFT only, derived when a reportKey rides along;
    //   inflight         — a parked (WAITING) or FAILED run: propose
    //                      EXECUTE/SKIP flips for pending stages, with the
    //                      run's frozen progress enforced by the compose job.
    //                      The proposal applies via POST .../recompose.
    // Deterministic-first: when the Admin bypass is enabled and exactly one
    // stock scope's keywords match the draft text, a front compose completes
    // WITHOUT any LLM call.
    if (intentId && httpMethod === 'POST' && path?.endsWith('/compose')) {
      const meta = await store.getExecution(intentId);
      if (!meta || meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      const data = body ? JSON.parse(body) : {};
      const reportKey =
        typeof data.reportKey === 'string' && data.reportKey ? data.reportKey : null;
      const mode = data.mode === 'inflight' ? 'inflight' : reportKey ? 'report' : 'front';
      if (mode === 'inflight') {
        if (!['WAITING', 'FAILED'].includes(meta.status)) {
          return response(409, {
            error: `Intent is ${meta.status} — in-flight compose needs a parked or failed run`,
          });
        }
        if (meta.constructionAutonomyMode === 'autonomous') {
          return response(409, {
            error:
              'Construction is running autonomously — recompose is disabled until the swarm finishes or autonomy drops back to gated',
            code: 'autonomous_construction',
          });
        }
      } else if (meta.status !== 'DRAFT') {
        return response(409, { error: `Intent is ${meta.status}, compose applies to DRAFT only` });
      }
      if (!meta.prompt && !meta.title) {
        return response(400, { error: 'Give the intent a prompt (or title) before composing' });
      }
      const instructions =
        typeof data.instructions === 'string' && data.instructions.trim()
          ? data.instructions.trim().slice(0, 4000)
          : null;
      if (reportKey && !reportKey.startsWith(composeReportPrefix(intentId))) {
        return response(400, { error: 'reportKey does not belong to this intent' });
      }
      // Advisory workspace signals, gathered client-side through the existing
      // authenticated git-provider routes (branch lists, trees). Bounded and
      // shape-checked only — runtime workspace-detection stays authoritative.
      const repoSignals =
        data.repoSignals && typeof data.repoSignals === 'object' && !Array.isArray(data.repoSignals)
          ? JSON.parse(JSON.stringify(data.repoSignals).slice(0, 8192))
          : null;
      const responder = getResponder(event);
      const composeId = randomUUID();
      const intentText = [meta.title, meta.prompt].filter(Boolean).join('\n\n');

      // Deterministic pre-pass: a CLEAN single-scope keyword match (front mode,
      // no steering instructions) resolves without the LLM — unless the Admin
      // switch forces every compose through the composer agent.
      if (mode === 'front' && !instructions && (await fetchComposeLlmBypass()) === 'enabled') {
        const scopeBlocks = await listMergedBlocks(ddb, BLOCKS_TABLE(), 'SCOPE').catch(() => []);
        const match = matchScopeByKeywords({ text: intentText, scopes: scopeBlocks });
        if (match) {
          const planCheck = await loadExecutionPlan({
            ddb,
            tableName: BLOCKS_TABLE(),
            workflowId: meta.workflowId,
            workflowVersion: meta.workflowVersion,
            scope: match.scopeId,
          });
          if (planCheck.valid) {
            const row = await store.createCompose({
              executionId: intentId,
              composeId,
              mode,
              state: 'PENDING',
              source: 'match',
              requestedBy: responder.sub,
              requestedByName: responder.displayName,
              instructions,
            });
            const completed = await store.updateCompose({
              executionId: intentId,
              composeId,
              state: 'COMPLETED',
              fromStates: ['PENDING'],
              fields: {
                proposal: {
                  mode: 'matched',
                  scope: match.scopeId,
                  grid: null,
                  rationale: [`keyword match: ${match.matched.join(', ')}`],
                  confidence: 1,
                },
                validation: {
                  valid: true,
                  errors: [],
                  warnings: planCheck.warnings ?? [],
                  summary: planCheck.plan?.summary ?? null,
                },
              },
            });
            await store
              .appendEvent({
                executionId: intentId,
                type: 'v2.compose.completed',
                actor: 'composer',
                summary: `Deterministic keyword match proposed scope "${match.scopeId}"`,
              })
              .catch(() => {});
            await broadcastToIntentChannel(intentId, {
              action: 'compose.updated',
              intentId,
              projectId,
              compose: mapCompose(completed ?? row),
            });
            return response(201, mapCompose(completed ?? row));
          }
          // A matched-but-unrunnable scope falls through to the composer.
        }
      }

      if (!AGENTCORE_RUNTIME_ARN()) {
        return response(503, { error: 'Composer runtime is not configured' });
      }
      // Report excerpt: read + bound the uploaded report server-side so the
      // container payload stays small and the container needs no S3 grant.
      let reportExcerpt = null;
      if (reportKey) {
        try {
          const obj = await s3.send(
            new GetObjectCommand({ Bucket: ARTIFACTS_BUCKET(), Key: reportKey }),
          );
          const text = await obj.Body.transformToString();
          reportExcerpt = text.slice(0, 24 * 1024);
        } catch {
          return response(400, { error: 'Report not found — upload it first' });
        }
      }
      // In-flight context: the run's frozen progress, computed from its own
      // stage rows. `frozenGrid` pins what already happened (the compose job
      // rejects any proposal flipping it); `progressContext` grounds the
      // composer in the live state instead of letting it guess.
      let frozenGrid = null;
      let progressContext = null;
      if (mode === 'inflight') {
        const records = await store.getExecutionRecords(intentId, { includeOutputs: false });
        const byStage = new Map();
        for (const stageRow of records.stages ?? []) {
          if (!stageRow.stageId) continue;
          if (!byStage.has(stageRow.stageId)) byStage.set(stageRow.stageId, new Set());
          byStage.get(stageRow.stageId).add(stageRow.state);
        }
        frozenGrid = {};
        const lines = [];
        for (const [stageId, states] of byStage) {
          const ran = ['SUCCEEDED', 'RUNNING', 'WAITING_FOR_HUMAN', 'FAILED'].some((s) =>
            states.has(s),
          );
          frozenGrid[stageId] = ran ? 'EXECUTE' : 'SKIP';
          lines.push(`- ${stageId}: ${[...states].join('/')}`);
        }
        progressContext = lines.length ? lines.join('\n') : '(no stage has run yet)';
      }
      const row = await store.createCompose({
        executionId: intentId,
        composeId,
        mode,
        state: 'PENDING',
        source: 'llm',
        requestedBy: responder.sub,
        requestedByName: responder.displayName,
        instructions,
        reportKey,
      });
      try {
        const res = await agentcore.send(
          new InvokeAgentRuntimeCommand({
            agentRuntimeArn: AGENTCORE_RUNTIME_ARN(),
            // A FRESH throwaway session per compose, never the intent's own
            // session. Compose is stateless (no workspace/conversation to
            // preserve), and dispatching it to `aidlc-intent-<id>` had two
            // failure modes: an EXISTING intent microVM kept serving the
            // image it was booted with (zombie-session field incident — a
            // redeploy never reached composes for drafts that had composed
            // once), and it spawned the intent's long-lived session early,
            // pinning the future RUN to compose-time code.
            runtimeSessionId: composeSessionIdFor(composeId),
            contentType: 'application/json',
            accept: 'application/json',
            payload: Buffer.from(
              JSON.stringify({
                command: 'compose-plan-start',
                projectId,
                intentId,
                executionId: intentId,
                composeId,
                mode,
                workflowId: meta.workflowId,
                workflowVersion: meta.workflowVersion,
                prompt: intentText,
                ...(instructions ? { instructions } : {}),
                ...(repoSignals ? { repoSignals } : {}),
                ...(reportExcerpt ? { reportExcerpt } : {}),
                ...(frozenGrid && Object.keys(frozenGrid).length ? { frozenGrid } : {}),
                ...(progressContext ? { progressContext } : {}),
              }),
            ),
          }),
        );
        const text = res.response ? await res.response.transformToString() : '';
        const accepted = text ? JSON.parse(text) : {};
        if (accepted.ok === false) {
          throw new Error(accepted.reason ?? 'compose dispatch refused');
        }
      } catch (err) {
        // The accept failed — terminalize the row so the UI never spins on a
        // compose no container is running.
        await store
          .updateCompose({
            executionId: intentId,
            composeId,
            state: 'FAILED',
            fromStates: ['PENDING'],
            fields: { failureReason: `dispatch failed: ${err.message}` },
          })
          .catch(() => {});
        return response(503, { error: `Compose dispatch failed: ${err.message}` });
      }
      return response(202, mapCompose(row));
    }

    // GET .../composes — the intent's composer sessions (the compose page
    // seeds from this, then follows compose.updated broadcasts).
    if (intentId && httpMethod === 'GET' && path?.endsWith('/composes')) {
      const meta = await store.getExecution(intentId);
      if (!meta || meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      const rows = await store.listComposes(intentId);
      return response(200, { composes: rows.map(mapCompose) });
    }

    // PATCH /projects/{projectId}/intents/{intentId} — DRAFT-only header edit.
    // The collaborative draft page auto-saves the shared prompt/title and the
    // scope / composed-grid / skip selections here (the Yjs doc is transport;
    // this row is durability — Yjs docs evaporate ~60s after the last client).
    // Everything is re-validated exactly like create; a non-DRAFT intent is
    // immutable through this route (its plan is pinned by the running/finished
    // execution).
    if (intentId && httpMethod === 'PATCH') {
      const meta = await store.getExecution(intentId);
      if (!meta || meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      if (meta.status !== 'DRAFT') {
        return response(409, {
          error: `Intent is ${meta.status}, only DRAFT intents are editable`,
        });
      }
      const data = body ? JSON.parse(body) : {};
      const patch = {};
      if (data.title !== undefined) {
        if (data.title !== null && typeof data.title !== 'string') {
          return response(400, { error: 'title must be a string or null' });
        }
        patch.title = data.title === null ? null : data.title.trim() || null;
      }
      if (data.prompt !== undefined) {
        if (data.prompt !== null && typeof data.prompt !== 'string') {
          return response(400, { error: 'prompt must be a string or null' });
        }
        patch.prompt = data.prompt === null ? null : data.prompt.trim() || null;
      }
      if (data.composedGrid !== undefined) {
        const { value, error: gridError } = normalizeComposedGrid(data.composedGrid);
        if (gridError) return response(400, { error: gridError });
        patch.composedGrid = value; // null clears
      }
      if (data.skipStageIds !== undefined) {
        if (data.skipStageIds !== null && !Array.isArray(data.skipStageIds)) {
          return response(400, { error: 'skipStageIds must be an array of stage ids or null' });
        }
        const normalized = normalizeSkipStageIds(data.skipStageIds ?? []);
        if (normalized && meta.stageSkipping !== 'enabled') {
          return response(400, {
            error: 'Stage skipping is disabled for this intent — skipStageIds is not accepted',
          });
        }
        patch.skipStageIds = normalized; // null clears
      }
      if (data.scope !== undefined) {
        if (typeof data.scope !== 'string' || !data.scope) {
          return response(400, { error: 'scope must be a non-empty string' });
        }
        patch.scope = data.scope;
      }
      if (Object.keys(patch).length === 0) {
        return response(400, { error: 'Nothing to update' });
      }
      // Plan re-validation when the projection inputs change. The effective
      // combination (patched value where supplied, current META otherwise) must
      // resolve — mirrors create so a broken draft can never reach Start.
      if (
        patch.scope !== undefined ||
        patch.composedGrid !== undefined ||
        patch.skipStageIds !== undefined
      ) {
        const effScope = patch.scope ?? meta.scope;
        const effGrid =
          patch.composedGrid !== undefined ? patch.composedGrid : (meta.composedGrid ?? null);
        // The grid absorbs redundant overlay skips (composed-grid.js): a
        // shared-draft flow can legitimately pair "deselect X" with a grid
        // that later flips X to SKIP — persist the pruned overlay so the
        // pinned combination always resolves.
        const effSkips = pruneSkipsForGrid(
          patch.skipStageIds !== undefined ? patch.skipStageIds : (meta.skipStageIds ?? null),
          effGrid,
        );
        if (effGrid && (patch.skipStageIds !== undefined || patch.composedGrid !== undefined)) {
          patch.skipStageIds = effSkips;
        }
        if (!effGrid) {
          const scopes = await loadWorkflowScopes({
            ddb,
            tableName: BLOCKS_TABLE(),
            workflowId: meta.workflowId,
            workflowVersion: meta.workflowVersion,
          });
          if (!scopes.includes(effScope)) {
            return response(400, {
              error: `Unknown scope "${effScope}" for workflow "${meta.workflowId}"`,
              scopes,
            });
          }
        }
        const planCheck = await loadExecutionPlan({
          ddb,
          tableName: BLOCKS_TABLE(),
          workflowId: meta.workflowId,
          workflowVersion: meta.workflowVersion,
          scope: effScope,
          ...(effSkips?.length ? { skipStageIds: effSkips } : {}),
          ...(effGrid ? { composedGrid: effGrid } : {}),
        });
        if (!planCheck.valid) {
          return response(400, {
            error: `The requested draft changes are not runnable for workflow "${meta.workflowId}"`,
            errors: planCheck.errors ?? [],
          });
        }
        patch.planWarnings = planCheck.warnings?.length ? planCheck.warnings : null;
      }
      let updated;
      try {
        updated = await store.updateExecution({
          executionId: intentId,
          // CAS on DRAFT so a concurrent Start can never race a header edit
          // into a launched run.
          fromStatus: 'DRAFT',
          ...patch,
        });
      } catch (err) {
        if (err?.name === 'ConditionalCheckFailedException') {
          return response(409, { error: 'Intent left DRAFT while editing — reload it' });
        }
        throw err;
      }
      return response(200, mapIntent(updated));
    }

    if (intentId && httpMethod === 'DELETE') {
      const meta = await store.getExecution(intentId);
      if (!meta || meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      if (auth.role !== 'owner' && auth.role !== 'admin') {
        return response(403, { error: 'Only project owners and admins can delete intents' });
      }
      // The two-pass, intent_id-guarded cascade (Yjs → Neptune → DynamoDB) lives
      // in shared/intent-deletion so the projects lambda reuses it verbatim on a
      // project delete. force:false → a RUNNING run is refused (IntentRunningError
      // → 409) instead of deleted out from under its live orchestrator.
      const responder = getResponder(event);
      try {
        await deleteIntentCascade({
          g,
          store,
          ddb,
          agentcore,
          lambdaClient,
          intentId,
          meta,
          yjsTable: process.env.YJS_DOCUMENTS_TABLE,
          agentcoreRuntimeArn: AGENTCORE_RUNTIME_ARN(),
          actor: responder.displayName || responder.sub,
          force: false,
        });
      } catch (err) {
        if (err instanceof IntentRunningError) {
          return response(409, {
            error:
              'Intent is RUNNING, cannot delete — wait for it to park or finish, or cancel it first',
          });
        }
        throw err;
      }

      console.log(
        `Intent ${intentId} deleted by ${responder.sub} (project ${projectId}, was ${meta.status})`,
      );
      return response(204, {});
    }

    // POST /projects/{projectId}/intents/{intentId}/derive
    // Manual graph-projection backfill (platform admin): re-run the
    // derive-artifacts command over ALL of the intent's current artifacts —
    // e.g. to project intents that predate the derivation feature, or to apply
    // enrichment after flipping the Admin toggle. Idempotent (the command
    // upserts by deterministic ids and supersedes stale rows) and safe to run
    // repeatedly; refused while RUNNING to keep out of a live stage's way.
    if (intentId && httpMethod === 'POST' && path?.endsWith('/derive')) {
      const denied = requirePlatformAdmin(event);
      if (denied) return response(denied.statusCode, { error: denied.error, code: denied.code });
      if (!AGENTCORE_RUNTIME_ARN()) {
        return response(500, { error: 'AGENTCORE_RUNTIME_ARN not configured' });
      }
      const meta = await store.getExecution(intentId);
      if (!meta || meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      if (meta.status === 'RUNNING') {
        return response(409, { error: 'Intent is RUNNING — the run derives after each stage' });
      }
      const payload = {
        command: 'derive-artifacts',
        projectId,
        intentId,
        executionId: intentId,
        // No stageInstanceId / artifactTypes: the whole intent is the target.
        enrichment: meta.deriveEnrichment === 'llm' ? 'llm' : 'off',
        ...(meta.agentCli ? { requestedCli: meta.agentCli } : {}),
        ...(meta.cliModels ? { cliModels: meta.cliModels } : {}),
        ...(meta.tierModels ? { tierModels: meta.tierModels } : {}),
      };
      try {
        const res = await agentcore.send(
          new InvokeAgentRuntimeCommand({
            agentRuntimeArn: AGENTCORE_RUNTIME_ARN(),
            runtimeSessionId: runtimeSessionIdFor(intentId),
            contentType: 'application/json',
            accept: 'application/json',
            payload: Buffer.from(JSON.stringify(payload)),
          }),
        );
        const text = res.response ? await res.response.transformToString() : '';
        const out = text ? JSON.parse(text) : {};
        if (out.ok === false) {
          return response(422, {
            error: out.reason ?? 'derive_failed',
            detail: out.detail ?? null,
          });
        }
        return response(200, {
          ok: true,
          artifacts: out.artifacts ?? [],
          sections: out.sections ?? 0,
          items: out.items ?? 0,
          citations: out.citations ?? 0,
          enrichment: out.enrichment ?? 'off',
          enriched: out.enriched ?? 0,
        });
      } catch (err) {
        console.error('[derive] runtime invoke failed:', err.message);
        return response(502, { error: 'Failed to invoke the derive runtime' });
      }
    }

    // POST /projects/{projectId}/intents/{intentId}/repair
    // Recover a parallel section whose stage callbacks became orphaned. This is
    // intentionally narrower than rewind: merged units remain merged, pending
    // dependents remain pending, and every active lane in the affected section
    // is replayed from the section start so a sibling that consumed the wrong
    // gate answer cannot be integrated.
    if (intentId && httpMethod === 'POST' && path?.endsWith('/repair')) {
      if (auth.role !== 'owner' && auth.role !== 'admin') {
        return response(403, { error: 'Only project owners and admins can repair intents' });
      }
      const meta = await store.getExecution(intentId);
      if (!meta || meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      if (!['RUNNING', 'WAITING', 'FAILED'].includes(meta.status)) {
        return response(409, { error: `Intent is ${meta.status}; no active run can be repaired` });
      }

      const records = await store.getExecutionRecords(intentId, { includeOutputs: false });
      const pendingByStage = new Map(
        (records.humanTasks ?? [])
          .filter((gate) => gate.status === 'pending' && gate.stageInstanceId)
          .map((gate) => [gate.stageInstanceId, gate]),
      );
      const orphaned = (records.stages ?? []).filter(
        (stage) =>
          stage.state === 'WAITING_FOR_HUMAN' &&
          stage.unitSlug &&
          !pendingByStage.has(stage.stageInstanceId),
      );
      if (orphaned.length === 0) {
        return response(409, {
          error: 'No orphaned parallel lane waits were detected',
          code: 'repair_not_needed',
        });
      }
      const sectionIndexes = [
        ...new Set(
          orphaned
            .map((stage) => stage.sectionIndex)
            .filter(
              (index) => index !== null && index !== undefined && Number.isInteger(Number(index)),
            ),
        ),
      ];
      if (sectionIndexes.length !== 1) {
        return response(409, {
          error: 'Repair currently requires all orphaned lanes to belong to one section',
          sections: sectionIndexes,
        });
      }
      const sectionIndex = Number(sectionIndexes[0]);
      const repairableStates = new Set([
        'READY',
        'RUNNING',
        'PR_DRAFT',
        'RECONCILING',
        'PR_READY',
        'ADDRESSING_FEEDBACK',
        'MERGING',
        'FAILED',
        'BLOCKED',
      ]);
      const repairUnits = (records.units ?? []).filter(
        (unit) => Number(unit.sectionIndex) === sectionIndex && repairableStates.has(unit.state),
      );
      const repairSlugs = [...new Set(repairUnits.map((unit) => unit.slug))];
      if (repairSlugs.length === 0) {
        return response(409, { error: 'No active lanes are available to repair' });
      }

      const planResult = await loadExecutionPlan({
        ddb,
        tableName: BLOCKS_TABLE(),
        workflowId: meta.workflowId,
        workflowVersion: meta.workflowVersion,
        scope: meta.scope,
        ...(Array.isArray(meta.skipStageIds) && meta.skipStageIds.length
          ? { skipStageIds: meta.skipStageIds }
          : {}),
        ...(meta.composedGrid ? { composedGrid: meta.composedGrid } : {}),
      });
      if (!planResult.valid || !planResult.plan) {
        return response(409, {
          error: 'Execution plan cannot be resolved for repair',
          errors: planResult.errors ?? [],
        });
      }
      const sectionStages = planResult.plan.stages.filter(
        (stage) => Number(stage.parallelSection) === sectionIndex,
      );
      if (sectionStages.length === 0) {
        return response(409, { error: `Parallel section ${sectionIndex} is not in the plan` });
      }
      const planNamespace =
        planResult.plan.namespace ?? `${meta.workflowId}@${meta.workflowVersion}`;
      const resetInstances = sectionStages.flatMap((stage) =>
        repairSlugs.map((slug) => ({
          stage,
          slug,
          stageInstanceId: planStageInstanceId(planNamespace, stage.stageId, slug, sectionIndex),
        })),
      );
      const responder = getResponder(event);
      const repairId = `repair-${randomUUID()}`;
      const repairReason = `Repair orphaned parallel lanes in section ${sectionIndex}`;
      let priorDurableExecutionArn = meta.durableExecutionArn ?? null;
      if (!priorDurableExecutionArn && meta.durableExecutionName && ORCHESTRATOR_FN()) {
        const listed = await lambdaClient.send(
          new ListDurableExecutionsByFunctionCommand({
            ...parseFunctionAndQualifier(ORCHESTRATOR_FN()),
            DurableExecutionName: meta.durableExecutionName,
            MaxItems: 1,
          }),
        );
        priorDurableExecutionArn = listed.DurableExecutions?.[0]?.DurableExecutionArn ?? null;
      }

      await store.updateExecution({
        executionId: intentId,
        projectId,
        status: 'FAILED',
        fromStatus: meta.status,
        startedAt: meta.startedAt,
        pendingHumanTaskId: null,
        failureReason: 'lane_repair_in_progress',
        completedAt: null,
        orchestratorRunId: `retired-${randomBytes(8).toString('hex')}`,
      });
      if (priorDurableExecutionArn) {
        try {
          await lambdaClient.send(
            new StopDurableExecutionCommand({
              DurableExecutionArn: priorDurableExecutionArn,
              Error: {
                ErrorType: 'LaneRepair',
                ErrorMessage: repairReason,
                ErrorData: JSON.stringify({ repairId, sectionIndex, repairSlugs }),
              },
            }),
          );
        } catch (error) {
          if (!['ResourceNotFoundException', 'ConflictException'].includes(error?.name)) {
            await store
              .updateExecution({
                executionId: intentId,
                projectId,
                failureReason: 'lane_repair_durable_stop_failed',
              })
              .catch(() => {});
            await store
              .appendEvent({
                executionId: intentId,
                type: 'v2.execution.repair_failed',
                actor: responder.displayName || responder.sub,
                summary: `Could not stop the prior durable execution: ${error?.message ?? 'unknown error'}`,
              })
              .catch(() => {});
            return response(502, {
              error: 'The old durable execution could not be stopped; repair did not relaunch',
              code: 'durable_stop_failed',
            });
          }
        }
      }

      const archivedArtifacts = await archiveArtifactsForStages({
        g,
        intentId,
        stageInstanceIds: resetInstances.map((instance) => instance.stageInstanceId),
        restartId: repairId,
        reason: repairReason,
        actor: responder.displayName || responder.sub,
      });
      await retireParkedRun(intentId, repairReason);
      await stopRuntimeSessions(intentId, {
        sectionIndexes: [sectionIndex],
        unitSlugs: repairSlugs,
      });

      await mapWithConcurrency(resetInstances, 12, async ({ stage, slug, stageInstanceId }) => {
        const reset = await store.resetStageRow({ executionId: intentId, stageInstanceId });
        if (!reset) return;
        await store
          .appendEvent({
            executionId: intentId,
            type: 'v2.stage.reset',
            stageInstanceId,
            unitSlug: slug,
            sectionIndex,
            actor: responder.displayName || responder.sub,
            summary: `Stage ${stage.stageId} [unit ${slug}] reset by lane repair`,
          })
          .catch(() => {});
      });
      await mapWithConcurrency(repairSlugs, 8, (slug) =>
        store.updateUnitState({
          executionId: intentId,
          sectionIndex,
          slug,
          state: 'PENDING',
          fields: {
            failureReason: null,
            blockedOn: null,
            integrationOwner: false,
            blockedReason: 'Replaying after orphaned lane recovery',
          },
        }),
      );
      const repairPrs = (records.unitPrs ?? []).filter(
        (pr) => Number(pr.sectionIndex) === sectionIndex && repairSlugs.includes(pr.unitSlug),
      );
      await mapWithConcurrency(repairPrs, 8, (pr) =>
        store.updateUnitPr({
          executionId: intentId,
          sectionIndex,
          slug: pr.unitSlug,
          repository: pr.repository,
          state: 'DRAFT',
          fields: {
            readyHeadSha: null,
            repositoryOutcome: 'replaying_after_lane_repair',
          },
        }),
      );
      await store
        .appendEvent({
          executionId: intentId,
          type: 'v2.execution.lanes_repaired',
          actor: responder.displayName || responder.sub,
          summary: `${responder.displayName || 'Someone'} repaired section ${sectionIndex}; replaying active lanes [${repairSlugs.join(', ')}] (${archivedArtifacts.length} artifact version(s) archived)`,
        })
        .catch(() => {});

      const fromStageId = sectionStages[0].stageId;
      const durableExecutionName = durableExecutionNameForIntent(intentId);
      const updated = await store.updateExecution({
        executionId: intentId,
        projectId,
        status: 'CREATED',
        fromStatus: 'FAILED',
        startedAt: meta.startedAt,
        durableExecutionName,
        durableExecutionArn: null,
        orchestratorStartedAt: null,
        orchestratorExpiresAt: null,
        pendingHumanTaskId: null,
        failureReason: null,
        completedAt: null,
        rewindFromStageId: fromStageId,
      });
      try {
        const invoked = await invokeOrchestrator(
          {
            action: 'start',
            intentId,
            executionId: intentId,
            startAtStageId: fromStageId,
          },
          { durableExecutionName },
        );
        if (invoked?.durableExecutionArn) {
          await store
            .updateExecution({
              executionId: intentId,
              durableExecutionArn: invoked.durableExecutionArn,
            })
            .catch((error) =>
              console.error('Repair durable execution ARN stamp failed:', error.message),
            );
        }
      } catch (error) {
        await store.updateExecution({
          executionId: intentId,
          projectId,
          status: 'FAILED',
          fromStatus: 'CREATED',
          startedAt: meta.startedAt,
          pendingHumanTaskId: null,
          failureReason: 'lane_repair_relaunch_failed',
          durableExecutionArn: null,
        });
        throw error;
      }
      return response(202, {
        intent: mapIntent(updated),
        repair: {
          repairId,
          sectionIndex,
          laneSlugs: repairSlugs,
          archivedArtifactCount: archivedArtifacts.length,
          fromStageId,
        },
      });
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
      const requestedFromStageId = typeof data.fromStageId === 'string' ? data.fromStageId : '';
      // Guidance is OPTIONAL: with guidance this is a steering rewind (a
      // correction the restarted stage consumes at entry); without it, a plain
      // retry — same reset + relaunch mechanics, no steering row.
      const guidance = typeof data.guidance === 'string' ? data.guidance.trim() : '';
      if (!requestedFromStageId) return response(400, { error: 'fromStageId is required' });
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
      // The intent's skip overlay rides along — EXCEPT the rewind target
      // itself: rewinding TO a stage that was deselected at create UN-skips it
      // (the shrunken overlay is persisted on META below, so every later
      // recompute agrees). Upstream calls this "Add [Skipped Stage]".
      const priorSkipIds = Array.isArray(meta.skipStageIds) ? meta.skipStageIds : [];
      const unskipping = priorSkipIds.includes(requestedFromStageId);
      const rewindSkipIds = priorSkipIds.filter((id) => id !== requestedFromStageId);
      const planResult = await loadExecutionPlan({
        ddb,
        tableName: BLOCKS_TABLE(),
        workflowId: meta.workflowId,
        workflowVersion: meta.workflowVersion,
        scope: meta.scope,
        ...(rewindSkipIds.length ? { skipStageIds: rewindSkipIds } : {}),
        ...(meta.composedGrid ? { composedGrid: meta.composedGrid } : {}),
      });
      if (!planResult.valid || !planResult.plan) {
        return response(409, {
          error: 'Execution plan cannot be resolved',
          errors: planResult.errors,
        });
      }
      const stages = planResult.plan.stages;
      let idx = stages.findIndex((s) => s.stageId === requestedFromStageId);
      if (idx < 0) {
        // The plan is scope-projected: a stage the workflow places but the
        // run's scope does not EXECUTE is not a rewind target — running it
        // would execute a stage the scope deliberately (or accidentally, see
        // zero_scope_placement) excludes. 409 with the wiring hint instead of
        // pretending the stage does not exist.
        if ((planResult.plan.outOfScopeStageIds ?? []).includes(requestedFromStageId)) {
          return response(409, {
            error: planResult.plan.composed
              ? `Stage "${requestedFromStageId}" is SKIP in this intent's composed grid — recompose it to EXECUTE before rewinding to it`
              : `Stage "${requestedFromStageId}" is not executed in scope "${meta.scope}" — wire it to EXECUTE for this scope in the workflow composer before rewinding to it`,
          });
        }
        return response(400, {
          error: `Unknown stage "${requestedFromStageId}"`,
          stages: stages.map((s) => s.stageId),
        });
      }
      const planNamespace =
        planResult.plan.namespace ?? `${meta.workflowId}@${meta.workflowVersion}`;
      let unitPlan = null;
      let fromStageId = requestedFromStageId;

      // A partial parallel section cannot be relaunched in its middle when the
      // walking skeleton is the only lane that reached the requested stage.
      // The orchestrator's rewind guard correctly requires every earlier
      // per-unit instance to be terminal, so normalize such retries to the
      // section's first stage instead of launching a run that immediately
      // fails rewind_upstream_incomplete.
      const requestedStage = stages[idx];
      if (requestedStage.parallelSection != null) {
        const firstSectionIdx = stages.findIndex(
          (stage) => stage.parallelSection === requestedStage.parallelSection,
        );
        const priorSectionStages = firstSectionIdx >= 0 ? stages.slice(firstSectionIdx, idx) : [];
        if (priorSectionStages.length > 0) {
          unitPlan = await store.getUnitPlan(intentId).catch(() => null);
          const unitSlugs = (unitPlan?.units ?? []).map((unit) => unit.slug);
          let incomplete = unitSlugs.length === 0;
          for (const stage of priorSectionStages) {
            if (incomplete) break;
            for (const laneSlug of unitSlugs) {
              const row = await store
                .getStage(
                  intentId,
                  planStageInstanceId(
                    planNamespace,
                    stage.stageId,
                    laneSlug,
                    stage.parallelSection,
                  ),
                )
                .catch(() => null);
              if (!row || (row.state !== 'SUCCEEDED' && row.state !== 'SKIPPED')) {
                incomplete = true;
                break;
              }
            }
          }
          if (incomplete && firstSectionIdx >= 0) {
            idx = firstSectionIdx;
            fromStageId = stages[firstSectionIdx].stageId;
          }
        }
      }
      const resetStages = stages.slice(idx);
      // Per-unit instance expansion (docs/v2-parallel.md WP4): a `forEach:
      // unit-of-work` stage has one STAGE row (and one artifact provenance id)
      // PER UNIT — a rewind must reset every lane's instance, and the touched
      // lanes themselves, or the relaunch would see stale terminal rows.
      const sectionStages = resetStages.filter((s) => s.parallelSection != null);
      if (sectionStages.length && !unitPlan) {
        unitPlan = await store.getUnitPlan(intentId).catch(() => null);
      }
      const unitSlugs = (unitPlan?.units ?? []).map((u) => u.slug);
      const resetInstances = resetStages.flatMap((stage) =>
        stage.parallelSection != null
          ? unitSlugs.map((laneSlug) => ({
              stage,
              unitSlug: laneSlug,
              sectionIndex: stage.parallelSection,
              stageInstanceId: planStageInstanceId(
                planNamespace,
                stage.stageId,
                laneSlug,
                stage.parallelSection,
              ),
            }))
          : [
              {
                stage,
                unitSlug: null,
                sectionIndex: null,
                stageInstanceId: stage.stageInstanceId,
              },
            ],
      );
      const responder = getResponder(event);
      const priorStatus = meta.status;
      const restartId = `restart-${randomUUID()}`;
      const restartReason = guidance
        ? `Rewind to ${fromStageId}: ${guidance}`
        : `Retry from ${fromStageId}`;

      // Artifact history is a hard precondition for a restart. Snapshot before
      // META, gates, stage rows, lanes, or sessions are touched; a Neptune
      // failure leaves the run exactly where it was and no relaunch occurs.
      const archivedArtifacts = await archiveArtifactsForStages({
        g,
        intentId,
        stageInstanceIds: resetInstances.map((instance) => instance.stageInstanceId),
        restartId,
        reason: restartReason,
        actor: responder.displayName || responder.sub,
      });

      // Make interrupted cleanup recoverable before touching gates, sessions,
      // or stage rows. A Lambda timeout used to leave META WAITING on a gate
      // already superseded by the first cleanup step, with no action capable
      // of waking it. FAILED remains rewindable, so a repeated request can
      // safely finish an interrupted reset.
      await store.updateExecution({
        executionId: intentId,
        projectId,
        status: 'FAILED',
        fromStatus: priorStatus,
        startedAt: meta.startedAt,
        pendingHumanTaskId: null,
        failureReason: 'rewind_in_progress',
        completedAt: null,
        orchestratorRunId: `retired-${randomBytes(8).toString('hex')}`,
      });
      // Retire a parked run first so the woken orchestrator exits quietly (its
      // gate is superseded) instead of racing the relaunch.
      await retireParkedRun(intentId, `rewound to ${fromStageId}`);
      // Stop the live session(s) so the relaunch gets a fresh microVM on the
      // CURRENT runtime image (zombie-session field incident) — the persistent
      // workspace mount survives and is re-attached by session id.
      await stopRuntimeSessions(intentId, {
        sectionIndexes: [...new Set(sectionStages.map((s) => s.parallelSection))],
        unitSlugs,
      });
      // Record the guidance BEFORE resetting/relaunching: the restarted stage
      // reads pending steering at entry, so the correction can never be missed.
      // A guidance-less retry records no steering row — there is nothing to
      // inject; the stage simply re-runs.
      const steer = guidance
        ? await store.createSteering({
            executionId: intentId,
            kind: 'rewind',
            message: guidance,
            targetStageId: fromStageId,
            createdBy: responder.sub,
            createdByName: responder.displayName,
          })
        : null;
      await mapWithConcurrency(
        resetInstances,
        12,
        async ({ stage, unitSlug: laneSlug, sectionIndex, stageInstanceId }) => {
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
                unitSlug: laneSlug,
                sectionIndex,
                actor: responder.displayName || responder.sub,
                summary: `Stage ${stage.stageId}${laneSlug ? ` [unit ${laneSlug}]` : ''} reset for rewind (attempt ${reset.attempt + 1})`,
              })
              .catch(() => {});
          }
        },
      );
      // Reset the touched lanes so the relaunch re-walks them (state PENDING,
      // stale verdict fields cleared). Unconditional — a rewind overrides any
      // lane state; the UNIT rows are the lane-level view, never audit (the
      // per-instance STAGE rows + EVENT feed keep the history).
      if (sectionStages.length && unitSlugs.length) {
        const sectionIndexes = [...new Set(sectionStages.map((stage) => stage.parallelSection))];
        const lanes = sectionIndexes.flatMap((sectionIndex) =>
          unitSlugs.map((slug) => ({ sectionIndex, slug })),
        );
        await mapWithConcurrency(lanes, 12, ({ sectionIndex, slug }) =>
          store
            .updateUnitState({
              executionId: intentId,
              sectionIndex,
              slug,
              state: 'PENDING',
              fields: { failureReason: null, blockedOn: null },
            })
            .catch((err) =>
              console.error(`Unit lane reset failed (s${sectionIndex}:${slug}):`, err.message),
            ),
        );
      }
      if (steer) {
        await mirrorSteeringVertex({ g, intentId, steer }).catch((err) =>
          console.error('Steering graph mirror failed:', err.message),
        );
      }
      await store
        .appendEvent({
          executionId: intentId,
          type: 'v2.execution.rewound',
          actor: responder.displayName || responder.sub,
          summary: `${responder.displayName || 'Someone'} ${steer ? 'rewound the run to' : 'retried the run from'} ${fromStageId}${fromStageId !== requestedFromStageId ? ` (requested ${requestedFromStageId}; restarted the incomplete unit section from its first stage)` : ''}${unskipping ? ' (un-skipped: it was deselected at creation)' : ''} (${resetInstances.length} stage instance(s) reset, ${archivedArtifacts.length} artifact(s) archived)`,
        })
        .catch((err) => console.error('Rewind event append failed:', err.message));
      // Relaunch at the rewind point. Same CAS + rollback discipline as /start.
      const durableExecutionName = durableExecutionNameForIntent(intentId);
      const updated = await store.updateExecution({
        executionId: intentId,
        projectId,
        status: 'CREATED',
        fromStatus: 'FAILED',
        startedAt: meta.startedAt,
        durableExecutionName,
        durableExecutionArn: null,
        orchestratorStartedAt: null,
        orchestratorExpiresAt: null,
        pendingHumanTaskId: null,
        failureReason: null,
        completedAt: null,
        rewindFromStageId: fromStageId,
        // Un-skip: the rewind target leaves the intent's skip overlay so the
        // relaunch (and every later plan recompute) actually runs it.
        ...(unskipping ? { skipStageIds: rewindSkipIds.length ? rewindSkipIds : null } : {}),
      });
      try {
        const invoked = await invokeOrchestrator(
          {
            action: 'start',
            intentId,
            executionId: intentId,
            startAtStageId: fromStageId,
          },
          { durableExecutionName },
        );
        if (invoked?.durableExecutionArn) {
          await store
            .updateExecution({
              executionId: intentId,
              durableExecutionArn: invoked.durableExecutionArn,
            })
            .catch((err) => console.error('Durable execution ARN stamp failed:', err.message));
        }
      } catch (err) {
        await store.updateExecution({
          executionId: intentId,
          projectId,
          status: 'FAILED',
          fromStatus: 'CREATED',
          startedAt: meta.startedAt,
          pendingHumanTaskId: null,
          failureReason: 'rewind_relaunch_failed',
          durableExecutionArn: null,
        });
        throw err;
      }
      return response(202, {
        intent: mapIntent(updated),
        steering: steer ? mapSteering(steer) : null,
        restart: {
          requestedFromStageId,
          fromStageId,
          sectionRestarted: fromStageId !== requestedFromStageId,
        },
      });
    }

    // POST /projects/{projectId}/intents/{intentId}/recompose
    // In-flight reshape (Adaptive Workflows): replace the run's projection
    // with a new composed EXECUTE/SKIP grid and relaunch at the first
    // not-yet-done stage — the retire-and-relaunch path (rewind mechanics)
    // that handles BOTH directions (skip and un-skip of pending stages).
    // Guardrails, mirroring upstream:
    //   - only a parked (WAITING) or FAILED run — never mid-turn;
    //   - never while construction runs autonomously (finish the swarm or
    //     drop back to gated first);
    //   - the PAST is frozen: completed/skipped stages must keep their fate
    //     in the new grid (reshaping the past is rewind's job);
    //   - unit-lane stages are frozen once the unit plan is promoted (lanes
    //     are reshaped at the fan-out approval's skip matrix);
    //   - the new grid must resolve STRICTLY (no starved required inputs).
    if (intentId && httpMethod === 'POST' && path?.endsWith('/recompose')) {
      const data = body ? JSON.parse(body) : {};
      const meta = await store.getExecution(intentId);
      if (!meta || meta.projectId !== projectId) {
        return response(404, { error: 'Intent not found' });
      }
      const RECOMPOSABLE = new Set(['WAITING', 'FAILED']);
      if (!RECOMPOSABLE.has(meta.status)) {
        return response(409, {
          error: `Intent is ${meta.status}, cannot recompose — wait for the run to park or fail`,
        });
      }
      if (meta.constructionAutonomyMode === 'autonomous') {
        return response(409, {
          error:
            'Construction is running autonomously — recompose is disabled until the swarm finishes or autonomy drops back to gated',
          code: 'autonomous_construction',
        });
      }
      const { value: newGrid, error: gridError } = normalizeComposedGrid(data.composedGrid);
      if (gridError) return response(400, { error: gridError });
      if (!newGrid) return response(400, { error: 'composedGrid is required' });
      const newScope =
        typeof data.scope === 'string' && data.scope ? data.scope : (meta.scope ?? 'composed');
      // The grid absorbs redundant overlay skips (composed-grid.js): entries
      // the new grid already excludes leave the standing overlay — persisted
      // below with the grid so every later recompute of this run resolves.
      const priorSkipIds =
        pruneSkipsForGrid(Array.isArray(meta.skipStageIds) ? meta.skipStageIds : [], newGrid) ?? [];
      // The stages the new projection would run: EXECUTE entries minus the
      // intent's standing skip overlay. Computed straight off the grid so the
      // frozen-past check below can answer BEFORE plan resolution (a frozen
      // violation is a clearer verdict than the starvation error it causes).
      const skipOverlay = new Set(priorSkipIds);
      const newStageIds = new Set(
        Object.entries(newGrid)
          .filter(([id, v]) => v === 'EXECUTE' && !skipOverlay.has(id))
          .map(([id]) => id),
      );

      // Frozen-past enforcement, from the run's own stage rows: a stage that
      // ran (or is running/parked) must stay EXECUTE; a stage the run already
      // SKIPPED must stay out of the projection. Per-unit rows collapse onto
      // their stageId — any unit having run the stage freezes it.
      const records = await store.getExecutionRecords(intentId, { includeOutputs: false });
      const rowsByStageId = new Map();
      for (const row of records.stages ?? []) {
        if (!row.stageId) continue;
        if (!rowsByStageId.has(row.stageId)) rowsByStageId.set(row.stageId, []);
        rowsByStageId.get(row.stageId).push(row);
      }
      const violations = [];
      for (const [stageId, rows] of rowsByStageId) {
        const states = new Set(rows.map((r) => r.state));
        const ran = ['SUCCEEDED', 'RUNNING', 'WAITING_FOR_HUMAN', 'FAILED'].some((s) =>
          states.has(s),
        );
        if (ran && !newStageIds.has(stageId)) {
          violations.push(`"${stageId}" already ran — it cannot flip to SKIP (rewind instead)`);
        }
        if (!ran && states.has('SKIPPED') && newStageIds.has(stageId)) {
          violations.push(`"${stageId}" was skipped earlier in this run — rewind to it to un-skip`);
        }
      }
      // Unit lanes: once the unit plan is promoted the per-unit stages are
      // scheduled state — their membership can only change via rewind.
      const unitPlan = await store.getUnitPlan(intentId).catch(() => null);
      if (unitPlan) {
        const currentPlanResult = await loadExecutionPlan({
          ddb,
          tableName: BLOCKS_TABLE(),
          workflowId: meta.workflowId,
          workflowVersion: meta.workflowVersion,
          scope: meta.scope,
          ...(priorSkipIds.length ? { skipStageIds: priorSkipIds } : {}),
          ...(meta.composedGrid ? { composedGrid: meta.composedGrid } : {}),
        });
        const currentSectionIds = new Set(
          (currentPlanResult.plan?.stages ?? [])
            .filter((s) => s.parallelSection != null)
            .map((s) => s.stageId),
        );
        for (const stageId of currentSectionIds) {
          if (!newStageIds.has(stageId)) {
            violations.push(
              `"${stageId}" fans out per unit and the unit plan is already promoted — reshape units at the fan-out approval`,
            );
          }
        }
      }
      if (violations.length > 0) {
        return response(409, {
          error: 'Recompose violates the run\u2019s frozen state',
          violations,
        });
      }

      // Strict resolution of the NEW projection (starved required inputs are
      // hard errors mid-run — a stage must never park waiting for an input
      // nothing will write).
      const planResult = await loadExecutionPlan({
        ddb,
        tableName: BLOCKS_TABLE(),
        workflowId: meta.workflowId,
        workflowVersion: meta.workflowVersion,
        scope: newScope,
        composedGrid: newGrid,
        ...(priorSkipIds.length ? { skipStageIds: priorSkipIds } : {}),
        strict: true,
      });
      if (!planResult.valid || !planResult.plan) {
        return response(400, {
          error: 'The recomposed grid is not runnable',
          errors: planResult.errors ?? [],
        });
      }
      const newPlan = planResult.plan;

      // Relaunch point: the first stage of the NEW plan that has neither
      // succeeded nor been skipped. Nothing pending = nothing to relaunch.
      const doneStates = new Set(['SUCCEEDED', 'SKIPPED']);
      const fromStage = newPlan.stages.find((s) => {
        const rows = rowsByStageId.get(s.stageId) ?? [];
        return rows.length === 0 || rows.some((r) => !doneStates.has(r.state));
      });
      if (!fromStage) {
        return response(409, {
          error: 'Nothing left to run under the recomposed grid — every remaining stage is done',
        });
      }
      const responder = getResponder(event);
      // Reset the relaunch stage's non-terminal instances (a parked/failed
      // stage re-runs from scratch, attempt+1).
      const resetIds = (rowsByStageId.get(fromStage.stageId) ?? [])
        .filter((r) => !doneStates.has(r.state))
        .map((r) => r.stageInstanceId)
        .filter(Boolean);
      const recomposeRestartId = `restart-${randomUUID()}`;
      await archiveArtifactsForStages({
        g,
        intentId,
        stageInstanceIds: resetIds,
        restartId: recomposeRestartId,
        reason: `Recompose from ${fromStage.stageId}`,
        actor: responder.displayName || responder.sub,
      });

      // Retire only after every affected artifact was durably snapshotted.
      await retireParkedRun(intentId, `recomposed from ${fromStage.stageId}`);
      await stopRuntimeSessions(intentId);
      for (const stageInstanceId of resetIds) {
        await store.resetStageRow({ executionId: intentId, stageInstanceId }).catch(() => {});
      }
      await store
        .appendEvent({
          executionId: intentId,
          type: 'v2.execution.recomposed',
          actor: responder.displayName || responder.sub,
          summary: `${responder.displayName || 'Someone'} recomposed the run (${newPlan.summary.executedStages} of ${newPlan.summary.totalStages} stages, scope label "${newScope}") — relaunching at ${fromStage.stageId}`,
        })
        .catch((err) => console.error('Recompose event append failed:', err.message));
      const priorStatus = meta.status;
      const durableExecutionName = durableExecutionNameForIntent(intentId);
      const updated = await store.updateExecution({
        executionId: intentId,
        projectId,
        status: 'CREATED',
        fromStatus: priorStatus,
        startedAt: meta.startedAt,
        durableExecutionName,
        durableExecutionArn: null,
        orchestratorStartedAt: null,
        orchestratorExpiresAt: null,
        pendingHumanTaskId: null,
        failureReason: null,
        completedAt: null,
        rewindFromStageId: fromStage.stageId,
        scope: newScope,
        composedGrid: newGrid,
        // Persist the pruned overlay (see priorSkipIds above) so META never
        // pins a skip the new grid already excludes.
        skipStageIds: priorSkipIds.length ? priorSkipIds : null,
        planWarnings: planResult.warnings?.length ? planResult.warnings : null,
      });
      try {
        const invoked = await invokeOrchestrator(
          {
            action: 'start',
            intentId,
            executionId: intentId,
            startAtStageId: fromStage.stageId,
          },
          { durableExecutionName },
        );
        if (invoked?.durableExecutionArn) {
          await store
            .updateExecution({
              executionId: intentId,
              durableExecutionArn: invoked.durableExecutionArn,
            })
            .catch((err) => console.error('Durable execution ARN stamp failed:', err.message));
        }
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

      // GET /projects/{projectId}/intents/{intentId}/audit — aggregated process
      // and graph-read evidence for improving future runs.
      if (path?.endsWith('/audit')) {
        const records = await store.getExecutionRecords(intentId, { includeOutputs: false });
        if (!records.meta || records.meta.projectId !== projectId) {
          return response(404, { error: 'Intent not found' });
        }
        return response(200, buildIntentAudit({ records }));
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
            sectionIndex: o.sectionIndex ?? null,
            kind: o.kind,
            content: o.content,
            timestamp: o.timestamp,
            ...(o.display ? { display: o.display } : {}),
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
      const pullRequests = await fetchPullRequests(g, intentId);
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
            sectionIndex: e.sectionIndex ?? null,
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
          sectionIndex: s.sectionIndex ?? null,
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
        // Fan-in PR record(s) — a run-level output, surfaced as a work product.
        pullRequests,
        // Quorum-supported artifact edit sessions (post-hoc document editing):
        // plan approval + progress render from these rows.
        quorumEdits: (records.quorumEdits ?? []).map(mapQuorumEdit),
        // Composer sessions (proposal + authoritative validation) — the
        // compose page renders these; compose.updated broadcasts keep it live.
        composes: (records.composes ?? []).map(mapCompose),
        // Unit lanes (docs/v2-parallel.md WP4): the promoted UNITPLAN snapshot
        // + the live UNIT lane rows, so the UI can render the lane board and
        // attribute per-unit stage instances. Both null/empty pre-promotion.
        unitPlan: mapUnitPlan(records.unitPlan),
        units: (records.units ?? []).map(mapUnit),
        unitPrs: (records.unitPrs ?? []).map(mapUnitPr),
        feedbackBatches: (records.feedbackBatches ?? []).map(mapFeedbackBatch),
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
      // OPTIONAL at create: the DRAFT-first flow creates the intent as soon as
      // a title/prompt exists and picks the projection on the draft page, so an
      // absent scope defaults to the workflow's conventional default ("feature"
      // when offered, else the first offered scope). With a composed grid the
      // grid IS the projection and `scope` degrades to the provenance label of
      // whatever base it was composed from (possibly a custom name) — the
      // resolver validates the grid instead.
      const { value: composedGrid, error: composedGridError } = normalizeComposedGrid(
        data.composedGrid,
      );
      if (composedGridError) {
        return response(400, { error: composedGridError });
      }
      let scope = data.scope;
      if (!composedGrid) {
        const scopes = await loadWorkflowScopes({
          ddb,
          tableName: BLOCKS_TABLE(),
          workflowId,
          workflowVersion,
        });
        if (!scope) {
          scope = scopes.includes('feature') ? 'feature' : (scopes[0] ?? null);
          if (!scope) {
            return response(400, {
              error: `Workflow "${workflowId}" offers no scopes — cannot default one`,
            });
          }
        } else if (!scopes.includes(scope)) {
          return response(400, {
            error: `Unknown scope "${scope}" for workflow "${workflowId}"`,
            scopes,
          });
        }
      } else if (!scope) {
        scope = 'composed';
      }
      // Per-intent stage deselection (shared/stage-skip.js): only accepted when
      // stage skipping is EFFECTIVELY enabled (project override over platform
      // setting), and validated structurally by the plan resolver below
      // (CONDITIONAL-only, in-scope, never initialization). The effective mode
      // is snapshotted onto META either way — it also gates the run's
      // gate-time "skip to stage X" options.
      const stageSkipping = effectiveStageSkipping(
        await fetchPlatformStageSkipping(),
        cfg.stageSkipping,
      );
      const rawSkipStageIds = normalizeSkipStageIds(data.skipStageIds);
      if (rawSkipStageIds && stageSkipping !== 'enabled') {
        return response(400, {
          error: 'Stage skipping is disabled for this project — skipStageIds is not accepted',
        });
      }
      // The grid absorbs redundant overlay skips (composed-grid.js): an
      // overlay entry the grid already excludes would otherwise fail the
      // resolver's skip_stage_not_in_scope guard on every later recompute.
      const skipStageIds = pruneSkipsForGrid(rawSkipStageIds, composedGrid);
      // Resolve the full execution plan NOW, before any row is written. The
      // plan is a pure function of (workflow@pinnedVersion, scope, skip
      // overlay), so a pass here holds for the whole intent lifetime — this
      // turns a structurally broken scope (or an illegal skip) into a
      // synchronous 400 instead of a post-init-ws `plan_invalid` failure
      // (after a git clone + Neptune anchor were burnt).
      // Non-fatal `warnings` (scope-shortcut degradations: inputs whose
      // producer is out of scope, sections downgraded to once-per-workflow)
      // are persisted on the intent so the UI can surface the degraded run.
      const planCheck = await loadExecutionPlan({
        ddb,
        tableName: BLOCKS_TABLE(),
        workflowId,
        workflowVersion,
        scope,
        ...(skipStageIds ? { skipStageIds } : {}),
        ...(composedGrid ? { composedGrid } : {}),
      });
      if (!planCheck.valid) {
        return response(400, {
          error: composedGrid
            ? `The composed stage grid is not runnable for workflow "${workflowId}"`
            : skipStageIds
              ? `Scope "${scope}" with the requested stage skips is not runnable for workflow "${workflowId}"`
              : `Scope "${scope}" is not runnable for workflow "${workflowId}"`,
          errors: planCheck.errors ?? [],
        });
      }
      const planWarnings = planCheck.warnings?.length ? planCheck.warnings : null;
      // Optional per-repo base-branch override (see validateBaseBranches) —
      // validated against THIS intent's repo set before anything is written.
      const { value: baseBranches, error: baseBranchesError } = validateBaseBranches(
        data.baseBranches,
        cfg.repos,
      );
      if (baseBranchesError) {
        return response(400, { error: baseBranchesError });
      }
      // Optional provenance — when the intent is kicked off from a tracker
      // issue, record which one. The imported text rides in `prompt`; this is
      // only the back-link. Validated against the project's actual bindings.
      const source = normalizeSource(data.source, cfg.trackers);
      // Branch: caller override wins; otherwise derive a readable slug from
      // the title/prompt, de-duplicated against the project's existing intents
      // (best-effort — the listing is capped, and a stale duplicate only means
      // two intents share a branch name candidate, not data corruption).
      let branch = data.branch || null;
      if (!branch) {
        const existing = await store.listProjectExecutions({ projectId, limit: 1000 });
        const taken = new Set(existing.map((m) => m.branch).filter(Boolean));
        branch = branchForIntent({
          title: data.title,
          prompt: data.prompt,
          intentId: newIntentId,
          taken,
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
        branch,
        baseBranch: data.baseBranch || cfg.baseBranch,
        baseBranches,
        repos: cfg.repos,
        gitProvider: cfg.gitProvider,
        agentCli: cfg.agentCli,
        cliModels: cfg.cliModels,
        tierModels: cfg.tierModels,
        mcpServersByTier: cfg.mcpServersByTier,
        customRules: cfg.customRules,
        deriveEnrichment: await fetchDeriveEnrichment(),
        parkReleaseSeconds: cfg.parkReleaseSeconds,
        maxParallelUnits: cfg.maxParallelUnits,
        prStrategy: effectivePrStrategy(await fetchPlatformPrStrategy(), cfg.prStrategy),
        stageSkipping,
        skipStageIds,
        composedGrid,
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
const invokeOrchestrator = async (payload, { durableExecutionName = null } = {}) => {
  const fn = ORCHESTRATOR_FN();
  if (!fn) {
    console.error('V2_ORCHESTRATOR_FUNCTION not configured — cannot start');
    return;
  }
  const res = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: fn,
      InvocationType: 'Event',
      ...(durableExecutionName ? { DurableExecutionName: durableExecutionName } : {}),
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
  return {
    durableExecutionArn: res?.DurableExecutionArn ?? null,
  };
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

// A UNIQUE durable execution name per launch: durable executions are
// idempotent by name, so every start/rewind/recompose relaunch needs a fresh
// one. The service caps DurableExecutionName at 64 chars — `intent-` (7) +
// intent UUID (36) + `-` + suffix must fit, so the launch suffix is a 16-char
// random hex (60 total), never a full UUID (80 total — field incident: every
// Start failed the API's length validation).
const durableExecutionNameForIntent = (intentId) =>
  `intent-${String(intentId).replace(/[^A-Za-z0-9_-]/g, '-')}-${randomBytes(8).toString('hex')}`;

const isCallbackTimeoutError = (err) =>
  err?.name === 'CallbackTimeoutException' ||
  err?.Code === 'CallbackTimeoutException' ||
  err?.code === 'CallbackTimeoutException';

const parseFunctionAndQualifier = (functionName) => {
  if (!functionName) return { FunctionName: functionName };
  const idx = functionName.lastIndexOf(':');
  if (idx <= 0) return { FunctionName: functionName };
  const qualifier = functionName.slice(idx + 1);
  if (!qualifier || qualifier.includes('/')) return { FunctionName: functionName };
  return { FunctionName: functionName.slice(0, idx), Qualifier: qualifier };
};

const lookupDurableExecutionStatus = async (meta) => {
  if (meta?.durableExecutionArn) {
    const res = await lambdaClient.send(
      new GetDurableExecutionCommand({
        DurableExecutionArn: meta.durableExecutionArn,
        IncludeExecutionData: false,
      }),
    );
    return res.Status ?? null;
  }
  if (meta?.durableExecutionName && ORCHESTRATOR_FN()) {
    const res = await lambdaClient.send(
      new ListDurableExecutionsByFunctionCommand({
        ...parseFunctionAndQualifier(ORCHESTRATOR_FN()),
        DurableExecutionName: meta.durableExecutionName,
        MaxItems: 1,
      }),
    );
    return res.DurableExecutions?.[0]?.Status ?? null;
  }
  return null;
};

const DURABLE_TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'STOPPED']);

const repairExpiredDurableExecution = async ({
  executionId,
  projectId,
  meta,
  actor = 'system',
  eventType = 'v2.execution.repaired',
  summary = 'Durable execution expired while the intent was waiting',
}) => {
  const updated = await store.updateExecution({
    executionId,
    projectId,
    status: 'FAILED',
    startedAt: meta?.startedAt,
    completedAt: new Date().toISOString(),
    failureReason: 'durable_callback_expired',
    pendingHumanTaskId: null,
    ...(meta?.orchestratorRunId ? { ifOrchestratorRunId: meta.orchestratorRunId } : {}),
  });
  await store
    .appendEvent({
      executionId,
      type: eventType,
      actor,
      summary,
    })
    .catch((err) => console.error('Durable expiry event append failed:', err.message));
  return updated;
};

const runDurableExecutionWatchdog = async ({ candidates: injectedCandidates = null } = {}) => {
  const nowIso = new Date().toISOString();
  const candidates =
    injectedCandidates ??
    (await store.listStaleActiveExecutions({
      nowIso,
      timeoutSeconds: DURABLE_EXECUTION_TIMEOUT_SECONDS(),
      limit: Number(process.env.DURABLE_WATCHDOG_LIMIT || 100),
    }));
  const out = { checked: candidates.length, repaired: 0, skipped: 0, errors: [] };
  for (const meta of candidates) {
    try {
      const durableStatus = await lookupDurableExecutionStatus(meta).catch((err) => {
        if (err?.name === 'ResourceNotFoundException') return 'TIMED_OUT';
        throw err;
      });
      if (durableStatus && !DURABLE_TERMINAL_STATUSES.has(durableStatus)) {
        out.skipped += 1;
        continue;
      }
      await repairExpiredDurableExecution({
        executionId: meta.executionId,
        projectId: meta.projectId,
        meta,
        actor: 'durable-watchdog',
        summary: `Watchdog repaired stale ${meta.status} intent after durable execution ${durableStatus ?? 'exceeded local timeout'}`,
      });
      out.repaired += 1;
    } catch (err) {
      out.errors.push({ executionId: meta.executionId, error: err?.message ?? String(err) });
    }
  }
  return out;
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
  sectionIndex: s.sectionIndex ?? null,
  phase: s.phase ?? null,
  state: s.state,
  attempt: s.attempt ?? 0,
  cli: s.cli ?? null,
  resolvedModel: s.resolvedModel ?? null,
  runtimeError: s.runtimeError ?? null,
  startedAt: s.startedAt ?? null,
  completedAt: s.completedAt ?? null,
  updatedAt: s.updatedAt ?? null,
  // Human-wait accounting: accumulated parked ms + the open park's start (null
  // unless currently WAITING_FOR_HUMAN). The UI derives agent-active duration
  // as (completedAt ?? now) − startedAt − waitMs − any open park window.
  waitMs: s.waitMs ?? 0,
  parkedAt: s.parkedAt ?? null,
  pendingHumanTaskId: s.pendingHumanTaskId ?? null,
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
  sectionIndex: u.sectionIndex ?? null,
  slug: u.slug,
  dependsOn: u.dependsOn ?? [],
  state: u.state,
  batchIndex: u.batchIndex ?? 0,
  branch: u.branch ?? null,
  startedAt: u.startedAt ?? null,
  mergedAt: u.mergedAt ?? null,
  failureReason: u.failureReason ?? null,
  blockedOn: u.blockedOn ?? null,
  integrationOwner: Boolean(u.integrationOwner),
  blockedReason: u.blockedReason ?? null,
  updatedAt: u.updatedAt ?? null,
});

const mapUnitPr = (pr) => ({
  sectionIndex: pr.sectionIndex,
  unitSlug: pr.unitSlug,
  repository: pr.repository,
  provider: pr.provider,
  providerId: pr.providerId ?? null,
  number: pr.number ?? null,
  url: pr.url ?? null,
  sourceBranch: pr.sourceBranch,
  targetBranch: pr.targetBranch,
  headSha: pr.headSha ?? null,
  readyHeadSha: pr.readyHeadSha ?? null,
  targetSha: pr.targetSha ?? null,
  state: pr.state,
  mergeable: pr.mergeable ?? null,
  commentCount: pr.commentCount ?? 0,
  repositoryOutcome: pr.repositoryOutcome ?? null,
  createdAt: pr.createdAt ?? null,
  updatedAt: pr.updatedAt ?? null,
  mergedAt: pr.mergedAt ?? null,
  closedAt: pr.closedAt ?? null,
});

const mapFeedbackBatch = (batch) => ({
  sectionIndex: batch.sectionIndex,
  unitSlug: batch.unitSlug,
  batchId: batch.batchId,
  comments: batch.comments ?? [],
  state: batch.state,
  requestedBy: batch.requestedBy,
  requestedByName: batch.requestedByName ?? null,
  stageInstanceId: batch.stageInstanceId ?? null,
  output: batch.output ?? null,
  changedFiles: batch.changedFiles ?? null,
  verification: batch.verification ?? null,
  commitSha: batch.commitSha ?? null,
  failureReason: batch.failureReason ?? null,
  createdAt: batch.createdAt ?? null,
  updatedAt: batch.updatedAt ?? null,
  completedAt: batch.completedAt ?? null,
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
  sectionIndex: h.sectionIndex ?? null,
  kind: h.kind,
  status: h.status,
  prompt: h.prompt ?? null,
  options: h.options ?? null,
  skipTargets: h.skipTargets ?? null,
  recomposeTargets: h.recomposeTargets ?? null,
  // The computed next stage a plain approve continues to (upstream 2.2.6):
  // string = stageId, null = approving completes the workflow. Omitted (not
  // null) on legacy rows / gates where it was never computed, so the UI can
  // keep its generic labels instead of falsely claiming "Complete workflow".
  ...('nextStageId' in h ? { nextStageId: h.nextStageId ?? null } : {}),
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
