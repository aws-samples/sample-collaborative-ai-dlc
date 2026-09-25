// run-stage — execute ONE workflow stage inside the AgentCore session.
//
// The AgentCore Runtime routes the same session to the same microVM, so the git
// checkout from init-ws (and prior stages) is USUALLY already on disk. This command:
//   1. resolves the pinned plan + finds the requested stage,
//   2. self-heals the source checkout if the mount was wiped (ensureWorkspaceSource),
//   3. marks the stage RUNNING in the v2 process table (+ current phase/stage),
//   4. materializes the stage workspace (prompt + rules + mcp-config),
//   5. selects + spawns the headless CLI with our MCP server wired in,
//   6. records the terminal stage state (SUCCEEDED/FAILED/WAITING_FOR_HUMAN) and
//      an event — ALWAYS, so the control plane never sees a stuck stage.
//
// SOURCE SELF-HEAL (docs/v2-resume.md D2): the /mnt/workspace mount is wiped on any
// runtime image redeploy and after 14 idle days, so a stage running after a deploy
// could otherwise spawn against an EMPTY tree and run blind. Step 2 re-clones any
// missing repo first; a genuine re-clone failure fails the stage rather than degrading.
//
// RESUME (docs/v2-resume.md): when `resumeFrom` (an answered humanTaskId) is set,
// the command normally re-invokes the SAME parked CLI conversation (recovered from
// the stage row's persisted cli/cliSessionId) with the human's answer. If the wiped
// mount also lost that conversation, a recent gate is RECOVERED by re-running the
// stage fresh with the answer injected; a gate ≥14d old hard-fails (resume_store_expired).
// At exit it re-checks for a still-pending question gate: if one exists the stage
// PARKS (WAITING_FOR_HUMAN) rather than completing.
//
// Business artifacts are written by the agent through the MCP tools during the
// run; this command owns ONLY process state. Every effect is injected so the
// whole flow is unit-tested with the CLI + AWS mocked.

import { Logger } from '@aws-lambda-powertools/logger';
import { randomUUID } from 'node:crypto';
import {
  selectCli,
  getDriver,
  buildKiroListSessions,
  parseLatestKiroSession,
  buildKiroUsage,
  parseKiroCredits,
  parseKiroCreditRate,
} from '../cli/drivers.js';
import { runChild, captureChild } from '../cli/spawn.js';
import { isCredentialFailure } from '../cli/credential-errors.js';
import {
  materializeMcpConfig as defaultMaterializeMcpConfig,
  materializeKiroAgent as defaultMaterializeKiroAgent,
  materializeOpenCodeConfig as defaultMaterializeOpenCodeConfig,
  materializeCodexHome as defaultMaterializeCodexHome,
  resolveCodexHome,
  neutralizeTokens,
} from '../stage-materializer.js';
import { dispatchPersona, composePersonaPrompt, OFF_MOUNT_CACHE_ENV } from '../persona-dispatch.js';
import {
  MAX_PERSONA_SESSION_MS,
  STAGE_BUDGET_MS,
  contributionArtifactId,
  ensembleGapFindings,
  renderLeadTopologyBrief,
  resolveEnsembleTopology as defaultResolveEnsembleTopology,
  runEnsembleSessions,
} from '../ensemble-runner.js';
import { fetchCustomRules as defaultFetchCustomRules } from '../custom-rules.js';
import { materializeAttachments } from '../attachments.js';
import { toMcpServerMap } from '../../shared/mcp-validator.js';
import {
  computeSurvivors,
  resolveMcpSecrets as defaultResolveMcpSecrets,
} from '../mcp-secret-resolver.js';
import { mcpSecretPaths } from '../mcp-secret-paths.js';
import {
  restoreKiroStore as defaultRestoreKiroStore,
  persistKiroStore as defaultPersistKiroStore,
  resolveKiroStore,
} from '../cli/kiro-store.js';
import {
  hasOpenCodeStore as defaultHasOpenCodeStore,
  restoreOpenCodeStore as defaultRestoreOpenCodeStore,
  persistOpenCodeStore as defaultPersistOpenCodeStore,
  resolveOpenCodeStore,
  withOpenCodeStore as defaultWithOpenCodeStore,
} from '../cli/opencode-store.js';
import {
  cleanupCodexHome as defaultCleanupCodexHome,
  persistCodexRollout as defaultPersistCodexRollout,
  resolveCodexStore,
  restoreCodexRollout as defaultRestoreCodexRollout,
} from '../cli/codex-store.js';
import {
  ensureWorkspaceSource as defaultEnsureWorkspaceSource,
  redirectHeavyDirs as defaultRedirectHeavyDirs,
} from '../workspace.js';
import {
  commitAndPushAll as defaultCommitAndPushAll,
  freeDiskBytes,
  gitResultForCommitRefs as defaultGitResultForCommitRefs,
} from '../git-engine.js';
import { workspaceRelativePath } from '../repo-paths.js';
import { resolveStageModel } from '../model-resolver.js';
import { createGraphWriter, closeGraphSource } from '../mcp/graph-writer.js';
import { ingestStageCodeTraceability as defaultIngestStageCodeTraceability } from '../code-traceability.js';
import { createSensorRunner } from '../sensor-runner.js';
import {
  evaluateGatePreconditions,
  mergeFindings,
  sensorGateFindings,
} from '../../shared/gate-preconditions.js';
import { readCurrentArtifactHeadHashes as defaultReadArtifactHeadHashes } from '../../shared/artifact-versioning.js';
import { compileContextPack as defaultCompileContextPack } from '../context-compiler.js';
import { createCliOutputSink, stripTerminalControls } from '../output-normalizer.js';
import {
  buildExecutionPlan,
  ENSEMBLE_MODES,
  stageInstanceId as planStageInstanceId,
  UNIT_FOR_EACH,
} from '../../shared/v2-execution-plan.js';
import { humanTaskMatchesOwner, isHumanTaskAnswerStatus } from '../../shared/v2-process-keys.js';
import { credentialProviderForCli } from '../../shared/agent-credentials.js';
import { eventTypeOf } from '../../shared/v2-process-keys.js';
import { pruneOutputArtifactsForUnit } from '../../shared/unit-kind-pruning.js';

const logger = new Logger({ persistentKeys: { component: 'agentcore', module: 'run-stage' } });

// The typed-extraction registry gates the platform-injected graph-coverage
// sensor: only stages that produce a registered structured artifact get it.
import { REGISTRY } from '../../shared/artifact-extractors.js';
import { invokeSourceControlOperation } from '../clients.js';

export const verifyReviewTargets = async ({
  targets = [],
  projectId,
  gitProvider,
  repoProviders = null,
  operate = invokeSourceControlOperation,
}) => {
  const results = [];
  for (const target of targets) {
    const provider = target.provider || repoProviders?.[target.repoId] || gitProvider || 'github';
    let status = await operate({
      projectId,
      provider,
      repo: target.repoId,
      operation: 'pr-status',
      args: { number: target.number },
    });
    // Feedback revisions must never race a provider-side merge button while
    // the agent is about to push a new head.
    if (status?.state === 'open' && !status.draft) {
      status = await operate({
        projectId,
        provider,
        repo: target.repoId,
        operation: 'set-pr-draft',
        args: { number: target.number, draft: true },
      });
    }
    results.push({
      repoId: target.repoId,
      number: target.number,
      expectedHeadSha: target.headSha ?? null,
      expectedTargetSha: target.targetSha ?? null,
      status,
      headMoved: Boolean(target.headSha && status?.headSha !== target.headSha),
      targetMoved: Boolean(target.targetSha && status?.targetSha !== target.targetSha),
    });
  }
  return results;
};

// Package-manager caches and scratch space belong on container-local /tmp,
// NEVER on the 1 GiB session mount (AgentCore offers no larger size). The
// 2026-07 incident filled the mount with npm state until the engine commit
// ENOSPC'd and the run finished with zero durable work. The working tree (the
// durable part) stays on the mount; caches are re-creatable. Definition now
// lives in persona-dispatch.js (every dispatched persona session needs the
// same floor); re-exported here for existing importers of run-stage.js.
export { OFF_MOUNT_CACHE_ENV };

// Free-space floor for the disk preflight — below this, installs and even the
// engine commit are at ENOSPC risk on the 1 GiB mount.
export const DISK_LOW_FLOOR_BYTES = 100 * 1024 * 1024;

const CREDENTIAL_PROVIDER_LABELS = {
  bedrock: 'Bedrock',
  kiro: 'Kiro',
};

const CREDENTIAL_SOURCE_LABELS = {
  user: 'Personal',
  space: 'Space',
  platform: 'Platform',
};

const credentialBindingForCli = (bindings, cli) => {
  const provider = credentialProviderForCli(cli);
  if (!provider) return null;
  return bindings.find((binding) => binding?.provider === provider) ?? null;
};

const credentialFailureDetail = ({ binding, state }) => {
  if (!binding) return null;
  const provider = CREDENTIAL_PROVIDER_LABELS[binding.provider] ?? binding.provider;
  const source = CREDENTIAL_SOURCE_LABELS[binding.source] ?? binding.source;
  const condition = state === 'rejected' ? 'was rejected' : 'is no longer available';
  const remediation = {
    user: 'Restore or rotate it in Account Settings, then restart the run.',
    space:
      'A Space owner or admin must restore or rotate it in Space Settings, then restart the run.',
    platform: 'A platform administrator must restore or rotate it, then restart the run.',
  }[binding.source];
  const fallback = {
    user: 'Active runs do not fall back to Space or Platform credentials.',
    space: 'Active runs do not fall back to Platform credentials.',
    platform: 'No fallback credential scope is available for this run.',
  }[binding.source];
  return `The ${source} ${provider} credential pinned to this run ${condition}. ${remediation} ${fallback}`;
};

// Resolve the plan and locate the stage instance for `stageId`. The optional
// `skipStageIds` overlay (per-intent + gate-time skips, forwarded by the
// orchestrator) is applied so this resolution matches the walk's plan.
const resolveStage = ({
  workflow,
  library,
  scope,
  stageId,
  skipStageIds = [],
  composedGrid = null,
}) => {
  const { valid, errors, plan } = buildExecutionPlan({
    workflow,
    scope: scope.scope,
    library,
    ...(skipStageIds.length ? { skipStageIds } : {}),
    ...(composedGrid ? { composedGrid } : {}),
  });
  if (!valid) return { error: 'plan_invalid', detail: errors };
  const stage = plan.stages.find((s) => s.stageId === stageId);
  if (!stage)
    return {
      error: 'stage_not_in_scope',
      detail: `stage "${stageId}" not in scope "${scope.scope}"`,
    };
  return { plan, stage };
};

// Load the support-agent personas an ensemble stage mode needs (`pipeline` /
// `mob`). Resolved from the SAME library the stage came from — the release
// closure when the intent is pinned, the DDB catalog otherwise — so a pinned
// intent can never pull a reseeded persona into its prompt. Order is the
// authored `support_agents` order, which the pipeline topology depends on.
// Returns [] for every non-ensemble mode, so the legacy prompt is unchanged.
// `modes` is the set of stage modes that get the single-session ensemble PROMPT.
// The call site passes an EMPTY set when native persona sessions
// (ensemble-runner.js) own the supports instead: the lead then drafts only its
// own part, so no support persona belongs in its prompt at all.
const loadSupportAgents = async ({ stage, library, loadBlockBody, modes = ENSEMBLE_MODES }) => {
  if (!modes.includes(stage.mode)) return [];
  const refs = (stage.supportAgentRefs ?? []).filter(
    (ref) => ref && ref !== stage.agentRef && library.agentsById?.[ref],
  );
  return Promise.all(
    refs.map(async (ref) => {
      const block = library.agentsById[ref];
      return {
        ref,
        displayName: block.displayName ?? block.name ?? ref,
        persona: await loadBlockBody(block),
      };
    }),
  );
};

// Concatenate the methodology knowledge bodies for an agent. Release mode does
// NOT swallow a body failure: a missing or digest-mismatched KNOWLEDGE body is
// tampered or absent methodology, and degrading it to '' would run the agent on
// silently reduced steering — the same fail-closed rule the stage and agent
// bodies already follow. Legacy mode keeps its lenient best-effort behaviour.
const loadMethodologyKnowledge = async ({
  agentRef,
  library,
  loadBlockBody,
  methodologyRelease = null,
}) => {
  const knowledgeBlocks = Object.values(library.knowledgeById ?? {}).filter(
    (k) => k.agentRef === agentRef || k.agentRef === 'shared',
  );
  const readBody = methodologyRelease
    ? (block) => loadBlockBody(block)
    : (block) => loadBlockBody(block).catch(() => '');
  const bodies = await Promise.all(knowledgeBlocks.map(readBody));
  return bodies.filter(Boolean).join('\n\n---\n\n');
};

// Read the project's runtime-accrued steering from Neptune in ONE pass: the team
// KNOWLEDGE for this stage's agent (+ shared) and the LEARNING rules (guardrails)
// for the whole project. Both accrue across the project's intents. Best-effort:
// a graph that is unreachable or empty just yields nothing — never a stage
// failure (the methodology tier + library rules still steer the stage).
const readProjectMemory = async ({ agentRef, projectId, intentId, executionId, openGraph }) => {
  const empty = { teamKnowledge: [], learningRules: [] };
  if (!openGraph || !projectId) return empty;
  let g = null;
  try {
    g = await openGraph();
    const writer = createGraphWriter({ g, scope: { projectId, intentId, executionId } });
    const [teamKnowledge, learningRules] = await Promise.all([
      writer.getTeamKnowledge({ agentRef }).catch(() => []),
      writer.getLearningRules().catch(() => []),
    ]);
    return { teamKnowledge, learningRules };
  } catch {
    return empty;
  } finally {
    await closeGraphSource(g);
  }
};

// Merge the project's accrued learning rules into the workflow + library so the
// EXISTING rule resolver interleaves them — no new precedence logic. Each row
// becomes a RULE block (its Neptune `content` carried inline as `body`) plus a
// ruleRef at its learnings layer; compileRules then sorts it into the universal
// stack at priority 1.5 (team-learnings) / 2.5 (project-learnings). Pure: returns
// shallow-cloned workflow + library, never mutating the loaded blocks.
const mergeLearningRules = ({ workflow, library, learningRules }) => {
  if (!learningRules.length) return { workflow, library };
  const rulesById = { ...library.rulesById };
  const ruleRefs = [...(workflow.ruleRefs ?? [])];
  for (const r of learningRules) {
    // A library rule of the same id wins (an authored rule is not overridden by
    // an accrued one); skip to avoid a duplicate ruleRef.
    if (rulesById[r.id]) continue;
    rulesById[r.id] = {
      id: r.id,
      blockId: r.id,
      type: 'RULE',
      name: r.title || r.id,
      layer: r.layer,
      phase: null,
      pairing: r.pairing ?? null,
      // Inline body (Neptune content) — no S3 bodyRef; resolveRuleBody reads it.
      body: r.content ?? '',
    };
    ruleRefs.push({ layer: r.layer, ruleId: r.id });
  }
  return { workflow: { ...workflow, ruleRefs }, library: { ...library, rulesById } };
};

// Render the team-knowledge rows as a markdown sub-section, newest last.
const renderTeamKnowledge = (rows = []) =>
  rows
    .map(
      (r) =>
        `### ${r.title || r.id}${r.agent_ref ? ` (${r.agent_ref})` : ''}\n\n${r.content ?? ''}`,
    )
    .join('\n\n');

// Combine the two knowledge tiers into the single prompt section. Methodology
// (authored baseline) first, then the project's accrued team learnings under a
// labelled heading so the agent can tell durable conventions from doctrine.
const composeKnowledge = (methodology, teamRows) => {
  const parts = [];
  if (methodology) parts.push(methodology);
  if (teamRows.length) {
    parts.push(`## Team learnings (accrued in this project)\n\n${renderTeamKnowledge(teamRows)}`);
  }
  return parts.join('\n\n---\n\n');
};

// The shared inception contracts that pin cross-unit boundaries (upstream
// stage-protocol §12a names these four). On a per-unit review they are the
// ONLY sanctioned source for cross-unit verification — the reviewer checks
// contract claims against them instead of sweeping sibling units' artifacts.
const SHARED_CONTRACT_ARTIFACTS = ['components', 'component-methods', 'services', 'unit-of-work'];

// Reviewer read scope (upstream stage-protocol §12a, 2.2.16): on a per-unit
// stage the reviewer is bounded to the unit under review plus the shared
// contracts. PURE — returns the prompt block, or '' when the run has no unit
// dimension (once-per-workflow stages review the whole intent as before).
const renderReviewerReadScope = ({ unit, contracts }) => {
  if (!unit?.slug) return '';
  return [
    '## Reviewer read scope',
    '',
    `This review is bounded to the unit **${unit.slug}**${unit.kind ? ` (kind: ${unit.kind})` : ''}.`,
    'Your scope is this unit\u2019s artifacts plus the input artifacts listed above.',
    'You MUST NOT read other units\u2019 content through any tool — not by fetching',
    'their artifacts from the graph, not by opening files, and not via grep, glob,',
    'or shell patterns that span sibling unit paths (a `construction/*/` glob is a',
    'sibling read, not a search).',
    '',
    `Cross-unit contract verification runs against the shared inception contracts`,
    `(${contracts.join(', ')}) passed as inputs — not against a sweep of sibling`,
    'units\u2019 design prose. The single exception: you may spot-check an integration',
    'point the current unit\u2019s design EXPLICITLY names — and only the owning file,',
    'resolved via the shared contracts rather than by browsing or searching the',
    'sibling\u2019s directory.',
  ].join('\n');
};

// Everything the reviewer prompt says EXCEPT the persona/knowledge tail —
// that tail is generic across persona roles and lives in
// composePersonaPrompt (persona-dispatch.js). Split out from
// buildReviewerPrompt so runReviewer can hand this, alone, to dispatchPersona
// as `brief` — the blindness seam (persona-dispatch.js) — while
// buildReviewerPrompt keeps rendering the exact same full prompt below.
const buildReviewerBrief = ({ stage, unit = null, reviewerAgent, round }) => {
  const outputs = (stage.outputArtifacts ?? []).map((o) => o.artifact ?? o).filter(Boolean);
  const inputs = (stage.inputArtifacts ?? []).map((i) => i.artifact ?? i).filter(Boolean);
  // `review_artifact` (≥2.7.0) names the ONE canonical output under review. The
  // other produced artifacts stay listed as context — narrowing the verdict
  // target must not narrow what the reviewer may read to reach it.
  const reviewArtifact = outputs.includes(stage.reviewer?.artifact)
    ? stage.reviewer.artifact
    : null;
  const advisory = Boolean(stage.reviewer?.advisory);
  // The shared contracts actually resolved for this stage (never invent ids the
  // stage does not consume) — feeds the per-unit read-scope block.
  const contracts = SHARED_CONTRACT_ARTIFACTS.filter((id) => inputs.includes(id));
  const readScope = renderReviewerReadScope({
    unit,
    contracts: contracts.length ? contracts : inputs,
  });
  return [
    `# Clean-room review: ${stage.stageId}`,
    '',
    `You are ${reviewerAgent}, the independent reviewer for this stage.`,
    'Do not modify artifacts. Use only read tools to inspect the intent graph, inputs, and produced artifacts.',
    'When done, call submit_review exactly once with verdict READY or NOT-READY and concrete findings.',
    // Upstream §12a identity marker: the first finding line names the reviewer
    // verbatim so the audit trail records which reviewer ran. The runtime also
    // stamps the trusted identity server-side; this keeps the artifact-visible
    // contract aligned with upstream.
    `Pass reviewer: "${reviewerAgent}" to submit_review, and make the FIRST line of your findings the identity marker verbatim: **Reviewer:** ${reviewerAgent}`,
    '',
    `Review round: ${round}`,
    `Stage phase: ${stage.phase ?? 'unknown'}`,
    ...(unit?.slug
      ? [`Unit under review: ${unit.slug}${unit.kind ? ` (kind: ${unit.kind})` : ''}`]
      : []),
    `Expected input artifacts: ${inputs.length ? inputs.join(', ') : 'none'}`,
    ...(reviewArtifact
      ? [
          `Artifact under review: ${reviewArtifact} — your verdict judges THIS artifact.`,
          `Context artifacts (read as needed, do not judge): ${
            outputs.filter((o) => o !== reviewArtifact).join(', ') || 'none'
          }`,
        ]
      : [`Produced artifacts to review: ${outputs.length ? outputs.join(', ') : 'none'}`]),
    ...(advisory
      ? [
          '',
          'This is an ADVISORY review: a single terminal pass with no repair round.',
          'Your findings are recorded on this stage\u2019s timeline as a durable review',
          'note that the human can open when they approve the stage; they are NOT',
          'inlined into the approval prompt, and nothing is sent back to the author',
          'agent on your behalf. State them plainly and completely, and assume the',
          'reader has to seek them out.',
        ]
      : []),
    ...(readScope ? ['', readScope] : []),
  ].join('\n');
};

const buildReviewerPrompt = ({
  stage,
  unit = null,
  reviewerAgent,
  reviewerPersona,
  knowledge,
  round,
}) =>
  composePersonaPrompt({
    brief: buildReviewerBrief({ stage, unit, reviewerAgent, round }),
    persona: reviewerPersona,
    knowledge,
    role: 'reviewer',
  });

const latestReviewerVerdict = async ({ store, executionId, stageInstanceId, reviewerAgent }) => {
  if (typeof store.listSensorRuns !== 'function') return null;
  const rows = await store.listSensorRuns(executionId, { stageInstanceId }).catch(() => []);
  return [...rows]
    .toReversed()
    .find((r) => r.kind === 'reviewer' && r.sensorId === `reviewer:${reviewerAgent}`);
};

// Thin caller: builds the reviewer's brief + emits the pre-run event, hands
// the CLI-dispatch mechanics to dispatchPersona (persona-dispatch.js), then
// resolves the verdict — reviewer-specific bookkeeping that doesn't
// generalize (yet) to other persona roles, so it stays here rather than in
// the generic dispatcher.
const runReviewer = async ({
  stage,
  unit = null,
  reviewerAgent,
  reviewerBlock,
  reviewerPersona,
  knowledge,
  round,
  cli,
  cliModels,
  tierModels,
  env,
  workspaceDir,
  spawnFn,
  mcpEntry,
  materializeMcpConfig,
  materializeKiroAgent,
  materializeOpenCodeConfig,
  materializeCodexHome,
  cleanupCodexHome,
  withOpenCodeStore,
  store,
  executionId,
  projectId,
  intentId,
  stageInstanceId,
  unitSlug,
  sectionIndex,
  publish,
  ids,
}) => {
  const brief = buildReviewerBrief({ stage, unit, reviewerAgent, round });
  await store
    .appendEvent({
      executionId,
      type: 'v2.review.running',
      stageInstanceId,
      unitSlug,
      sectionIndex,
      actor: reviewerAgent,
      summary: `Reviewer ${reviewerAgent} checking ${stage.stageId}`,
    })
    .catch(() => {});
  const dispatch = await dispatchPersona({
    role: 'reviewer',
    personaScope: { agentRef: reviewerAgent },
    agentBlock: reviewerBlock,
    persona: reviewerPersona,
    knowledge,
    brief,
    cli,
    cliModels,
    tierModels,
    env,
    workspaceDir,
    spawnFn,
    mcpEntry,
    materializeMcpConfig,
    materializeKiroAgent,
    materializeOpenCodeConfig,
    materializeCodexHome,
    cleanupCodexHome,
    withOpenCodeStore,
    executionId,
    projectId,
    intentId,
    stageInstanceId,
    unitSlug,
    sectionIndex,
    ids,
  });
  // Preserve the pre-extraction contract: a dispatch failure (spawn/materialize
  // throwing) propagates out of runReviewer exactly as it did before, so the
  // existing per-round `.catch` at the call site (records `v2.review.failed`)
  // keeps working unchanged.
  if (!dispatch.ok) throw dispatch.detail;
  const verdict = await latestReviewerVerdict({
    store,
    executionId,
    stageInstanceId,
    reviewerAgent,
  });
  if (!verdict) {
    const row = await store.recordSensorRun({
      executionId,
      stageInstanceId,
      unitSlug,
      sectionIndex,
      sensorId: `reviewer:${reviewerAgent}`,
      kind: 'reviewer',
      severity: 'advisory',
      result: 'INCONCLUSIVE',
      held: false,
      detail: { verdict: 'INCONCLUSIVE', findings: 'Reviewer did not submit a verdict', round },
    });
    await publish({
      action: 'agent.note',
      noteType: 'v2.review.inconclusive',
      stageInstanceId,
      unitSlug,
      sectionIndex,
      summary: `Reviewer ${reviewerAgent} did not submit a verdict`,
      sensorRunId: row.sensorRunId,
    });
    return row;
  }
  return verdict;
};

// Condense a sensor's structured `detail` into a short human suffix for the
// activity-feed note (the full structured detail is on the SensorRun row for the
// drill-down). Handles the shapes the evaluators emit: missing artifacts
// (`artifacts[].reason`), unreferenced upstreams (`unreferenced[]`), a bare
// `reason`, or an `error`. Returns '' when there is nothing terse worth adding.
const summarizeSensorDetail = (detail) => {
  if (!detail || typeof detail !== 'object') return '';
  const missing = Array.isArray(detail.artifacts)
    ? detail.artifacts.filter((a) => a?.reason === 'not found in graph').map((a) => a.artifact)
    : [];
  if (missing.length) return ` — missing: ${missing.join(', ')}`;
  if (Array.isArray(detail.unreferenced) && detail.unreferenced.length) {
    return ` — unreferenced: ${detail.unreferenced.join(', ')}`;
  }
  if (detail.error) return ` — ${detail.error}`;
  if (detail.reason) return ` — ${detail.reason}`;
  return '';
};

// Run the stage's deterministic sensors. Records a SensorRun verdict +
// broadcasts an `agent.note` per sensor, and returns
// `{ held, verdicts }` — `held` is a human-readable reason string when a
// BLOCKING sensor held the stage (else null), `verdicts` is the raw list the
// gate plane turns into findings.
// `graph` sensors need a graph-writer; we open the same private graph the rest
// of run-stage uses (best-effort — an unreachable graph yields INCONCLUSIVE
// graph verdicts, never a crash).
const runStageSensors = async ({
  stage,
  stageInstanceId,
  unitSlug = null,
  sectionIndex = null,
  executionId,
  projectId,
  intentId,
  openGraph,
  loadBlockScript,
  workspaceDir,
  env,
  spawnFn,
  store,
  publish,
  changedFiles = null,
  planes = null,
}) => {
  let graph = null;
  let gConn = null;
  if (openGraph) {
    try {
      gConn = await openGraph();
      graph = createGraphWriter({ g: gConn, scope: { projectId, intentId, executionId } });
    } catch {
      graph = null;
    }
  }
  try {
    return await runSensorsWithGraph({
      graph,
      stage,
      stageInstanceId,
      unitSlug,
      sectionIndex,
      executionId,
      loadBlockScript,
      workspaceDir,
      env,
      spawnFn,
      store,
      publish,
      changedFiles,
      planes,
    });
  } finally {
    await closeGraphSource(gConn);
  }
};

// Platform-injected sensors — always-on checks the RUNTIME owns, layered on
// top of whatever the block library authored (which we never modify). The
// graph-coverage evaluator (typed-item topology integrity: uncovered
// must-haves, unmapped stories, unknown refs, component cycles) runs as an
// ADVISORY on every stage that produces a registered structured artifact —
// exactly the stages that change the typed graph. Never injected when the
// library already binds it (an authored row may carry `blocking` or the
// strictness switch, which must win).
export const withPlatformSensors = (stage = {}) => {
  const authored = stage.sensors ?? [];
  const producesRegistered = (stage.outputArtifacts ?? []).some(
    (o) => REGISTRY[o.artifact ?? o] !== undefined,
  );
  if (!producesRegistered) return authored;
  if (authored.some((s) => s.sensorId === 'graph-coverage')) return authored;
  return [...authored, { sensorId: 'graph-coverage', severity: 'advisory' }];
};

// The sensor pass itself, given an already-opened graph-writer (or null). Split
// out so runStageSensors can guarantee the graph connection is closed in a
// finally regardless of how this returns/throws.
const runSensorsWithGraph = async ({
  graph,
  stage,
  stageInstanceId,
  unitSlug = null,
  sectionIndex = null,
  executionId,
  loadBlockScript,
  workspaceDir,
  env,
  spawnFn,
  store,
  publish,
  changedFiles = null,
  planes = null,
}) => {
  const runner = createSensorRunner({
    graph,
    loadBlockScript,
    workspaceDir,
    // The upstream sensor commands embed {{HARNESS_DIR}}; the materializer
    // already neutralizes it in prose, but the script-argv builder ignores the
    // command path entirely (it runs the S3-materialized script), so no
    // substitution is needed here. Pass-through for future shell-form sensors.
    substitutions: {},
    spawnFn,
    childEnv: env,
  });

  const verdicts = await runner.runStageSensors({
    sensors: withPlatformSensors(stage),
    outputArtifacts: stage.outputArtifacts ?? [],
    inputArtifacts: stage.inputArtifacts ?? [],
    stageId: stage.stageId,
    changedFiles,
    planes,
  });

  const heldReasons = [];
  for (const v of verdicts) {
    await store
      .recordSensorRun({
        executionId,
        stageInstanceId,
        unitSlug,
        sectionIndex,
        sensorId: v.sensorId,
        kind: v.kind,
        severity: v.severity,
        result: v.result,
        held: v.held,
        detail: v.detail,
      })
      .catch(() => {});
    await publish({
      action: 'agent.note',
      stageInstanceId,
      unitSlug,
      sectionIndex,
      note: `sensor ${v.sensorId}: ${v.result}${v.held ? ' (blocking)' : ''}`,
      kind: 'sensor',
    });
    // Surface a NON-PASS verdict in the durable activity feed too. A PASS stays
    // quiet (the SensorRun row already records it, and a note per passing sensor
    // is pure noise); anything else — FAIL / INCONCLUSIVE / BLOCKED — is worth a
    // persisted note so an advisory miss (e.g. an artifact "not found in graph")
    // is visible on reload even though it did not hold the stage. `held` blocking
    // failures already fail the stage below; this is the record for the rest.
    if (v.result !== 'PASS') {
      await store
        .appendEvent({
          executionId,
          type: 'v2.sensor.flagged',
          stageInstanceId,
          unitSlug,
          sectionIndex,
          actor: 'agentcore',
          summary: `Sensor ${v.sensorId} (${v.severity}) → ${v.result}${
            v.held ? ' — blocking' : ''
          }${summarizeSensorDetail(v.detail)}`,
        })
        .catch(() => {});
    }
    if (v.held) heldReasons.push(`${v.sensorId}=${v.result}`);
  }
  return { held: heldReasons.length ? heldReasons.join(', ') : null, verdicts };
};

// ── Change control ──────────────────────────────────────────────────────────
// Upstream keys change control off its own state files; the platform keys it off
// the fingerprints a `RECEIPT#stage-approval` recorded when the PRODUCING stage
// was approved. Everything below is pure so the comparison and the answer
// parsing are unit-testable without a graph, a store, or a CLI.

// The gate is opened BEFORE the agent, so it is the one human task on a stage
// that has no parked conversation behind it. The prefix is how the resume leg
// recognizes that and re-enters fresh instead of demanding a session that never
// existed; the id is deterministic per attempt so a re-drive reuses the gate
// rather than opening a second one, and a rewind (which bumps attempt) asks again.
const CHANGE_CONTROL_GATE_PREFIX = 'cc-';
const CHANGE_CONTROL_OPTIONS = Object.freeze([
  'Reconfirm and continue',
  'Stop here so I can rewind',
]);

const changeControlGateId = (stageInstanceId, attempt) =>
  `${CHANGE_CONTROL_GATE_PREFIX}${stageInstanceId}-${attempt}`;

const isChangeControlGate = (gate) =>
  typeof gate?.humanTaskId === 'string' && gate.humanTaskId.startsWith(CHANGE_CONTROL_GATE_PREFIX);

// The approved inputs whose bytes moved since an approval recorded them.
// Identity is the artifact's LOGICAL key, not its type: a stage may consume
// several artifacts of one type, and comparing by type would report the wrong
// one as changed. An input no approval ever recorded is not "changed" — there is
// nothing to have changed FROM.
const changedApprovedInputs = ({ requiredInputs = [], heads = [], approvals = [] }) => {
  const approvedByKey = new Map();
  for (const receipt of approvals) {
    for (const input of receipt?.detail?.approvedInputs ?? []) {
      if (!input?.logicalKey || !input?.snapshotHash) continue;
      const seen = approvedByKey.get(input.logicalKey);
      const decidedAt = String(receipt.decidedAt ?? receipt.sk ?? '');
      if (!seen || decidedAt >= seen.decidedAt) {
        approvedByKey.set(input.logicalKey, { snapshotHash: input.snapshotHash, decidedAt });
      }
    }
  }
  const wanted = new Set(requiredInputs);
  return heads
    .filter((head) => wanted.has(head.artifactType))
    .map((head) => ({ head, approved: approvedByKey.get(head.logicalKey) ?? null }))
    .filter(({ head, approved }) => approved && approved.snapshotHash !== head.snapshotHash)
    .map(({ head, approved }) => ({
      artifactId: head.artifactId,
      artifactType: head.artifactType,
      logicalKey: head.logicalKey,
      fromHash: approved.snapshotHash,
      toHash: head.snapshotHash,
      approvedAt: approved.decidedAt || null,
    }));
};

// Which of the two offered options the human chose. `null` means the answer did
// not name either one. The caller HALTS on that (recoverable via rewind) rather
// than inferring a reconfirmation: strict change control exists to stop a stage
// running against moved inputs without an explicit yes, and a garbled answer is
// not a yes.
const changeControlChoice = (gate) => {
  const answer = gate?.answer ?? null;
  const text =
    typeof answer === 'string'
      ? answer
      : (answer?.perQuestion?.[0]?.answer ?? answer?.freeText ?? answer?.decision ?? '');
  const normalized = String(text ?? '').toLowerCase();
  if (normalized.includes('stop')) return 'stop';
  if (normalized.includes('reconfirm') || normalized.includes('continue')) return 'reconfirm';
  return null;
};

// The prompt section a changed approved input adds. `relaxed` states the change
// and continues; `strict` states that the human already reconfirmed it, so the
// agent knows the divergence was accepted deliberately rather than missed.
const renderChangedInputs = (changed, { reconfirmed = false } = {}) => {
  if (!changed.length) return '';
  const lines = changed.map(
    (item) =>
      `- ${item.artifactType ?? item.artifactId} changed since it was approved (${item.fromHash.slice(0, 12)} → ${item.toHash.slice(0, 12)})`,
  );
  return [
    '## Inputs that changed since they were approved',
    '',
    ...lines,
    '',
    reconfirmed
      ? 'The human reconfirmed these changes and asked you to continue. Read the CURRENT content of each one — not a remembered version — and say in your output where the change affected your work.'
      : 'Read the CURRENT content of each one — not a remembered version — and say in your output where the change affected your work.',
  ].join('\n');
};

// ── The checkpoint completion ladder ────────────────────────────────────────
//
// Runs after the agent finishes and BEFORE the sensor pass, so a stage that never
// obtained its authorization never burns a reviewer session.
//
// Every outcome is one of exactly three (the anti-stuck contract): proceed, a
// human gate carrying an overridable blocking finding, or a rewind-eligible
// fail(). The repair turn is capped at ONE per attempt on a PERSISTED counter,
// because an uncapped repair loop is the classic stuck path.
const CHECKPOINT_FINDING_CODES = Object.freeze([
  'summary_confirmation_missing',
  'summary_confirmation_stale',
  'plan_approval_missing',
]);

// Which persisted counter bounds the repair turn for a given finding, which event
// records the unresolved state, and which tool the agent must call to fix it.
const CHECKPOINT_LADDER = Object.freeze({
  summary_confirmation_missing: {
    counter: 'summaryRepairAttempts',
    event: 'v2.summary.noncompliant',
    tool: 'confirm_summary',
  },
  summary_confirmation_stale: {
    counter: 'summaryRepairAttempts',
    event: 'v2.summary.noncompliant',
    tool: 'confirm_summary',
  },
  plan_approval_missing: {
    counter: 'planApprovalRepairAttempts',
    event: 'v2.plan.noncompliant',
    tool: 'request_plan_approval',
  },
});

// The newest recorded commit for this stage attempt, or null when the stage wrote
// no code at all. Plan Approval's enforcement seam is boundary LINEAGE, not
// interception: we cannot block the write, so we require the commit to be newer
// than the approval. A stage with no commit has nothing to have written
// unauthorized, so the receipt alone satisfies it.
const latestCommitAt = (events) =>
  (events ?? [])
    .filter((event) => eventTypeOf(event) === 'v2.git.pushed')
    .map((event) => String(event.timestamp ?? ''))
    .toSorted()
    .at(-1) ?? null;

// Drop a plan-approval receipt the stage's own commit predates, so the shared
// evaluator reports it exactly as it reports an absent one. Reusing the evaluator
// rather than hand-rolling a second finding keeps ONE definition of the finding
// shape, severity and remediation.
const withPlanApprovalLineage = (receipts, events) => {
  const commitAt = latestCommitAt(events);
  if (!commitAt) return receipts;
  return receipts.filter(
    (row) => row?.kind !== 'plan-approval' || commitAt > String(row.decidedAt ?? ''),
  );
};

const readCheckpointFindings = async ({
  store,
  executionId,
  stageInstanceId,
  stage,
  policy,
  attempt,
}) => {
  // Tolerant of a store without the receipt family (older injected test doubles,
  // and any deployment mid-rollout): no evidence store means no evidence to judge,
  // and a crash here would fail a stage for a reason the human cannot act on.
  const [receipts, allEvents] = await Promise.all([
    typeof store.listReceipts === 'function'
      ? store.listReceipts(executionId, { stageInstanceId, attempt }).catch(() => [])
      : [],
    typeof store.listEvents === 'function' ? store.listEvents(executionId).catch(() => []) : [],
  ]);
  const events = allEvents.filter((event) => event.stageInstanceId === stageInstanceId);
  const { findings } = evaluateGatePreconditions({
    stage,
    policy,
    attempt,
    receipts: withPlanApprovalLineage(receipts, events),
    events,
  });
  return findings.filter((finding) => CHECKPOINT_FINDING_CODES.includes(finding.code));
};

// The deterministic repair message. It names the missing evidence and the exact
// remedy — a vague "you did not comply" wastes the one turn the ladder allows.
const repairMessage = (findings) =>
  [
    'STAGE OUTPUT REJECTED — a required authorization is missing.',
    '',
    ...findings.map((finding) => `- ${finding.title}. ${finding.remediation ?? ''}`.trimEnd()),
    '',
    'Fix this NOW, in this order:',
    ...[...new Set(findings.map((finding) => CHECKPOINT_LADDER[finding.code]?.tool))]
      .filter(Boolean)
      .map((tool) => `1. Call \`${tool}\` and obtain the affirmative answer.`),
    '2. Re-save EVERY required output artifact afterwards (create_artifact /',
    '   update_artifact), so each write is recorded under that authorization.',
    '',
    'This is your only opportunity to correct it: if the evidence is still missing',
    'afterwards the stage is handed to the human with this finding attached.',
  ].join('\n');

// The message that re-enters the lead's conversation between adversarial reviewer
// rounds. The reviewer's findings are agent-authored text reaching another session,
// so the runtime-managed template tokens are neutralized like every other body
// that crosses a session boundary.
const reviewerRepairMessage = ({ reviewerAgent, round, reviewerFindings }) =>
  [
    `REVIEW ROUND ${round} — ${reviewerAgent} returned NOT-READY.`,
    '',
    'Findings:',
    neutralizeTokens(reviewerFindings) || '(no findings text recorded)',
    '',
    'Address every finding NOW and re-save the stage output artifacts',
    '(create_artifact / update_artifact) so the next review reads your revision.',
    'Do not argue with the reviewer and do not ask the human: fix what you can and',
    'say plainly in the output what you did not change and why.',
  ].join('\n');

/**
 * Enforce the checkpoint policy for a finished stage.
 *
 * `runRepairTurn` re-enters the SAME CLI session with a message and resolves once
 * the agent's turn ends; it is injected so the ladder is testable without a CLI,
 * and may be null when no resumable session exists (then the ladder skips straight
 * to the gate/fail rung rather than pretending a repair happened).
 *
 * Returns `{ findings }` to carry to the gate, or `{ failure }` when the stage has
 * no human gate to carry them to.
 */
const runCheckpointLadder = async ({
  store,
  executionId,
  stageInstanceId,
  unitSlug,
  sectionIndex,
  stage,
  policy,
  stageLabel,
  runRepairTurn = null,
  // Whether a repair turn may START now (the stage wall-clock budget). A refusal
  // takes the same path as "no resumable session": straight to the gate/fail rung,
  // with `onRepairSkipped` recording why.
  repairAllowed = () => true,
  onRepairSkipped = async () => {},
  pendingGate = null,
  logger: log = logger,
}) => {
  if (!policy) return { findings: [] };
  if (typeof store.listReceipts !== 'function') return { findings: [] };
  const parkedBeforeLadder = await pendingGate?.();
  if (parkedBeforeLadder) return { findings: [], parked: parkedBeforeLadder };
  const stageRow = await store.getStage(executionId, stageInstanceId).catch(() => null);
  const attempt = Number(stageRow?.attempt ?? 0);
  const read = () =>
    readCheckpointFindings({ store, executionId, stageInstanceId, stage, policy, attempt });

  let findings = await read();
  if (findings.length === 0) return { findings: [] };

  // One bounded repair turn per counter per attempt. The counter is read from the
  // STAGE# row and bumped atomically, so a re-invoked runner cannot grant a second.
  const counters = [
    ...new Set(findings.map((finding) => CHECKPOINT_LADDER[finding.code]?.counter).filter(Boolean)),
  ];
  const alreadyRepaired = counters.some((counter) => Number(stageRow?.[counter] ?? 0) > 0);
  const budgetAllowsRepair = runRepairTurn && !alreadyRepaired ? repairAllowed() : true;
  if (!budgetAllowsRepair) await onRepairSkipped();
  if (runRepairTurn && !alreadyRepaired && budgetAllowsRepair) {
    const parkedBeforeRepair = await pendingGate?.();
    if (parkedBeforeRepair) return { findings, parked: parkedBeforeRepair };
    let counterPersistenceFailed = false;
    for (const counter of counters) {
      await Promise.resolve(
        store.bumpStageCounter?.({ executionId, stageInstanceId, field: counter }),
      ).catch((error) => {
        counterPersistenceFailed = true;
        log.error('checkpoint repair counter not persisted', { error, counter });
      });
    }
    if (counterPersistenceFailed) {
      return {
        failure: {
          code: findings[0].code,
          detail: `checkpoint repair counter could not be persisted; rewind before retrying ${stageLabel}`,
        },
      };
    }
    if (!counterPersistenceFailed) {
      await store
        .appendEvent({
          executionId,
          type: 'v2.checkpoint.repair_requested',
          stageInstanceId,
          unitSlug,
          sectionIndex,
          actor: 'agentcore',
          summary: `Stage ${stageLabel} re-entered once for: ${findings
            .map((finding) => finding.code)
            .join(', ')}`,
          detail: { codes: findings.map((finding) => finding.code), attempt },
        })
        .catch(() => {});
      const parkedBeforeResume = await pendingGate?.();
      if (parkedBeforeResume) return { findings, parked: parkedBeforeResume };
      await runRepairTurn(repairMessage(findings)).catch((error) =>
        log.error('checkpoint repair turn failed', { error }),
      );
      const parkedAfterRepair = await pendingGate?.();
      if (parkedAfterRepair) return { findings, parked: parkedAfterRepair };
      findings = await read();
      if (findings.length === 0) return { findings: [] };
    }
  }

  for (const code of new Set(findings.map((finding) => finding.code))) {
    await store
      .appendEvent({
        executionId,
        type: CHECKPOINT_LADDER[code]?.event ?? 'v2.checkpoint.noncompliant',
        stageInstanceId,
        unitSlug,
        sectionIndex,
        actor: 'agentcore',
        summary: `Stage ${stageLabel} completed without the required authorization (${code})`,
        detail: { code, attempt },
      })
      .catch(() => {});
  }

  // A stage WITH a human gate carries the blocking finding there: the human can
  // approve (waiving it on the record), request changes, or override. A stage
  // WITHOUT one has no human to ask, so it fails with a rewind-eligible code
  // rather than succeeding with the semantic silently missing.
  if (stage.humanValidation === 'required') return { findings };
  return {
    failure: {
      code: findings[0].code,
      detail: findings.map((finding) => finding.title).join('; '),
    },
  };
};

// Render an answered gate into the message that re-enters the parked conversation.
// The agent asked structured questions; we feed back the human's answer so it
// continues from where it parked. Tolerant of the answer shapes the resume lambda
// / phaseb-answer write (`perQuestion[]`, `freeText`, or a raw string).
const formatResumeAnswer = (gate) => {
  const a = gate?.answer ?? null;
  // A checkpoint gate (summary confirmation / plan approval) is a `question` row
  // carrying `detail.checkpoint`, so it must be recognised BEFORE the generic
  // question branch: the agent needs to know which of the two decisions it got
  // and what that obliges it to do next, not just "the human answered".
  const checkpoint = gate?.detail?.checkpoint ?? null;
  if (checkpoint) {
    const label = typeof a === 'string' ? a : (a?.perQuestion?.[0]?.answer ?? a?.freeText ?? '');
    const approved = label === 'Looks correct' || label === 'Approve plan';
    const free = typeof a === 'string' ? '' : (a?.freeText ?? a?.feedback ?? '');
    if (approved) {
      return (
        `The human answered the ${checkpoint} checkpoint: "${label}".` +
        `${free ? `\nThey added: ${free}` : ''}\n\n` +
        (checkpoint === 'plan-approval'
          ? 'Your plan is approved and the approval is recorded. Implement it now.'
          : 'Your summary is confirmed and the authorization is recorded. Record your stage ' +
            'output artifacts NOW (create_artifact / update_artifact) so each one is written ' +
            'under this authorization, then finish.')
      );
    }
    return (
      `The human answered the ${checkpoint} checkpoint: "${label}" — nothing is authorized yet.` +
      `${free ? `\nWhat they want changed: ${free}` : ''}\n\n` +
      `Revise accordingly, then call ${
        checkpoint === 'plan-approval' ? '`request_plan_approval`' : '`confirm_summary`'
      } again with the revision.`
    );
  }
  // Validation gates AND engine gates answered request-changes (skeleton /
  // batch revision loops, docs/v2-parallel.md WP5) both re-enter the stage as
  // a REVISION with the human's feedback.
  if (gate?.kind === 'validation' || a?.decision === 'request-changes') {
    const text =
      typeof a === 'string'
        ? a
        : (a?.feedback ?? a?.freeText ?? a?.decision ?? JSON.stringify(a ?? {}));
    return `The human reviewed this stage's output and requested changes:\n${text}\n\nRevise the stage artifacts to address this feedback, then finish again.`;
  }
  if (a && Array.isArray(a.perQuestion) && a.perQuestion.length) {
    const lines = a.perQuestion.map((p) => `- ${p.text ?? 'Q'}: ${p.answer ?? ''}`);
    return `The human answered your question(s):\n${lines.join('\n')}\n\nContinue the stage with these answers.`;
  }
  const text = typeof a === 'string' ? a : (a?.freeText ?? JSON.stringify(a ?? {}));
  return `The human answered your question(s): ${text}\n\nContinue the stage with this answer.`;
};

// Render pending human steering (course corrections) into the block that enters
// the agent conversation at this deterministic injection point — appended to a
// resume answer or prepended to a fresh stage prompt (docs/v2-steering.md).
// Steering OVERRIDES the agent's current plan, so the framing is imperative.
const steeringLabel = (r) => {
  if (r.kind === 'rewind') return 'rewind guidance — this stage is re-running from scratch';
  if (r.kind === 'revision') return 'a previously given answer was CORRECTED';
  if (r.kind === 'artifact-edit') {
    return 'a project document was EDITED while this stage was parked';
  }
  return 'course correction';
};

const renderSteering = (rows = []) => {
  if (!rows.length) return '';
  const items = rows.map(
    (r) =>
      `- (${steeringLabel(r)}, from ${r.createdByName || 'the human team'}) ${r.message ?? ''}`,
  );
  return (
    `## COURSE CORRECTION from the human team\n\n` +
    `The human team has redirected this work. The following OVERRIDES your current plan ` +
    `and any conflicting earlier instruction or answer:\n${items.join('\n')}\n\n` +
    `Re-evaluate your approach in light of the above before doing anything else. ` +
    `Update or revert any artifacts, files, or decisions that conflict with this direction. ` +
    `If prior work in the working tree contradicts it, correct those files as part of this stage ` +
    `(edit or rewrite them — do NOT run git; the engine owns commits).`
  );
};

// Deliver pending steering at this injection point: CAS each row pending →
// consumed (a row another entry consumed concurrently is skipped), record the
// delivery in the audit trail, and return the consumed rows for rendering.
// Tolerant of stores without steering support (older mocks) — returns [].
const consumePendingSteering = async ({ store, executionId, stageInstanceId, publish }) => {
  if (typeof store.listPendingSteering !== 'function') return [];
  const pending = await store.listPendingSteering(executionId).catch(() => []);
  const consumed = [];
  for (const row of pending) {
    const ok = await store
      .markSteeringConsumed({
        executionId,
        steerId: row.steerId,
        createdAt: row.createdAt,
        stageInstanceId,
      })
      .catch(() => null);
    if (ok) consumed.push(row);
  }
  if (consumed.length) {
    await store
      .appendEvent({
        executionId,
        type: 'v2.steering.consumed',
        stageInstanceId,
        actor: 'agentcore',
        summary: `Delivered ${consumed.length} course correction(s) to the agent`,
      })
      .catch(() => {});
    await publish({
      action: 'agent.steering',
      stageInstanceId,
      state: 'consumed',
      steerIds: consumed.map((r) => r.steerId),
    });
  }
  return consumed;
};

// Managed session storage idle-expires after 14 days (docs/v2-resume.md). Past that
// a lost parked conversation is unrecoverable; inside it, a wipe is a routine
// redeploy we can recover from by re-running fresh with the answer injected.
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

// Age of a gate in ms from its createdAt (the "asked at" time). Null if unparseable
// — an unknown age is treated as recent (recoverable) so a bad timestamp never
// strands a routine wipe on the hard-fail path.
const gateAgeMs = (gate, nowIso) => {
  const asked = gate?.createdAt;
  if (!asked) return null;
  const askedMs = Date.parse(asked);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(askedMs) || Number.isNaN(nowMs)) return null;
  return nowMs - askedMs;
};

// Capture the Kiro session id created by a just-finished fresh run (Kiro can't be
// told the id up front). Lists sessions as JSON and returns the newest for the
// cwd; null when nothing parseable. The list spawn captures stdout (runChild
// inherits it, so it can't).
const captureKiroSession = async ({ env, driver, workspaceDir, spawnFn }) => {
  const list = buildKiroListSessions();
  const { stdout } = await captureChild({
    command: list.command,
    args: list.args,
    env: driver.envForAuth(env),
    cwd: workspaceDir,
    spawnFn,
  });
  return parseLatestKiroSession(stdout ?? '', workspaceDir);
};

// Capture Kiro's $/credit overage rate by running the `/usage` slash command
// headless and parsing "billed at $X.XX per credit" (printed on STDERR). The
// rate changes at most with the plan, so it's cached for the container's life —
// one extra kiro-cli spawn per container, not per stage. `/usage` only calls
// Kiro's usage API; it does not itself spend credits. Null (and cached null on
// hard failure only) when the rate can't be read — the credits metric is then
// recorded unpriced rather than priced at a guess.
let cachedKiroCreditRate; // undefined = not fetched; null/number = fetched
export const resetKiroCreditRateCache = () => {
  cachedKiroCreditRate = undefined;
};
const captureKiroCreditRate = async ({ env, driver, workspaceDir, spawnFn }) => {
  if (cachedKiroCreditRate !== undefined) return cachedKiroCreditRate;
  const usage = buildKiroUsage();
  const { stdout, stderr } = await captureChild({
    command: usage.command,
    args: usage.args,
    env: driver.envForAuth(env),
    cwd: workspaceDir,
    captureStderr: true,
    spawnFn,
  });
  cachedKiroCreditRate = parseKiroCreditRate(`${stderr ?? ''}\n${stdout ?? ''}`);
  return cachedKiroCreditRate;
};

// Recognise Kiro's BENIGN empty-final-completion crash. kiro-cli's ACP layer
// (its stdio JSON-RPC protocol) rejects a turn that ends with an empty final
// assistant message, exiting non-zero with a JSON-RPC -32603 whose data is
// "Kiro failed to generate a response" (rendered as `Failed to receive the next
// message: … error: Kiro failed to generate a response`). This fires AFTER the
// turn's tool work is already done — the agent completed the stage, then had no
// closing text to emit — so it is not a real stage failure.
//
// We gate narrowly on BOTH the ACP data string AND the empty-completion phrasing
// so we do NOT swallow genuine backend transport errors (`dispatch failure`,
// `InternalServerError`, `ThrottlingException`, `EOF while parsing`), which carry
// their own distinct error text and CAN fail mid-turn. The prompt annex already
// instructs the agent to end every stage with a non-empty line to avoid tripping
// this at all; this guard is the belt-and-braces for when the model still ends
// on a tool call.
export const isBenignKiroEmptyCompletion = (stderrTail = '') => {
  const s = String(stderrTail);
  if (!s.includes('Kiro failed to generate a response')) return false;
  // The empty-completion path always reports the failed final message fetch.
  // Transport errors name a concrete cause after `error:` instead; those must
  // still fail. So require the generic phrasing AND the absence of a transport
  // cause on the same signal.
  const transportCause =
    /dispatch failure|InternalServerError|ServiceUnavailable|ThrottlingException|EOF while parsing|invalid escape|request or response body error/i;
  return !transportCause.test(s);
};

// Return the HUMAN gate still owned by THIS stage at CLI exit. Stage ownership
// is the source of truth because one META pointer cannot represent concurrent
// lane questions. The META fallback supports old rows, but only when the gate
// names this exact stage; a sibling's question can therefore never park the
// current stage.
//
// Deliberately do NOT require gate.status === 'pending'. The human answer can
// land after ask_question's grace window but before the CLI exits. In that
// window the stage row still owns the gate and the conversation still needs a
// resume turn with the answer; treating the answered gate as absent would let
// the stage continue to sensors/success without ever delivering the answer.
const ownedGateAtExit = async ({ store, executionId, stageInstanceId, unitSlug, sectionIndex }) => {
  const stage = await store
    .getStage(executionId, stageInstanceId, { consistentRead: true })
    .catch(() => null);
  let humanTaskId = stage?.pendingHumanTaskId ?? null;
  if (!humanTaskId) {
    const meta = await store.getExecution(executionId, { consistentRead: true }).catch(() => null);
    humanTaskId = meta?.pendingHumanTaskId ?? null;
  }
  if (!humanTaskId) return null;
  const gate = await store
    .getHumanTask(executionId, humanTaskId, { consistentRead: true })
    .catch(() => null);
  if (!gate || (gate.status !== 'pending' && !isHumanTaskAnswerStatus(gate.status))) {
    return null;
  }
  // createdAt rides along for wait accounting: the park's parkedAt is the ASK
  // moment, not the (later) CLI exit.
  return humanTaskMatchesOwner({ task: gate, stageInstanceId, unitSlug, sectionIndex })
    ? { humanTaskId, createdAt: gate.createdAt ?? null }
    : null;
};

// Return this stage's pending gate, including an answer that landed while the
// CLI was shutting down. Consistent reads and the shared ownership predicate
// keep a sibling lane's single META pointer from parking this stage.
const pendingGate = async ({ store, executionId, stageInstanceId, unitSlug, sectionIndex }) => {
  const stage = await store
    .getStage(executionId, stageInstanceId, { consistentRead: true })
    .catch(() => null);
  let humanTaskId = stage?.pendingHumanTaskId ?? null;
  if (!humanTaskId) {
    const meta = await store.getExecution(executionId, { consistentRead: true }).catch(() => null);
    humanTaskId = meta?.pendingHumanTaskId ?? null;
  }
  if (!humanTaskId) return null;
  const gate = await store
    .getHumanTask(executionId, humanTaskId, { consistentRead: true })
    .catch(() => null);
  const stageStillParked =
    stage?.state === 'WAITING_FOR_HUMAN' && stage.pendingHumanTaskId === humanTaskId;
  const gateStillOwnsPark =
    gate?.status === 'pending' || (stageStillParked && isHumanTaskAnswerStatus(gate?.status));
  return gateStillOwnsPark &&
    humanTaskMatchesOwner({
      task: gate,
      stageInstanceId,
      unitSlug,
      sectionIndex,
    })
    ? { humanTaskId, createdAt: gate.createdAt ?? null }
    : null;
};

const mergeCodeCommitRefs = (priorRefs, gitResult) => {
  const refs = [];
  const seen = new Set();
  const add = (ref) => {
    const repo = typeof ref?.repo === 'string' ? ref.repo : '';
    const sha = typeof ref?.sha === 'string' ? ref.sha : '';
    if (!repo || !sha) return;
    const key = `${repo}\0${sha}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ repo, sha });
  };
  for (const ref of Array.isArray(priorRefs) ? priorRefs : []) add(ref);
  for (const change of gitResult?.results ?? []) {
    if (change?.committed === true) add(change);
  }
  return refs;
};

export const runStage = async (
  {
    projectId,
    intentId,
    executionId,
    stageId,
    workflowId,
    workflowVersion,
    aidlcRepoRef = null,
    methodologyPins = null,
    // Immutable AI-DLC release pinned on the intent's META row (issue #482).
    // Present => the methodology library and the conductor resolve from that
    // release closure alone, never from the reseedable SYSTEM rows or the
    // mutable aidlc-runtime/ prefix. Absent => unchanged legacy resolution.
    methodologyRelease = null,
    scope,
    // Per-run skip overlay (shared/stage-skip.js): intent-level deselections +
    // accumulated gate-time skips, forwarded by the orchestrator on EVERY
    // dispatch so this container resolves the same plan the walk executes —
    // downstream stages then see skipped producers' inputs as expectedAbsent
    // (prompt: "absence is by design, do NOT fabricate"). Empty = no overlay.
    skipStageIds = [],
    // Per-intent composed EXECUTE/SKIP grid, forwarded by the orchestrator on
    // every dispatch for the same plan-parity reason as the skip overlay: the
    // grid — not the scope name — is the projection this run executes.
    composedGrid = null,
    requestedCli,
    cliModels = {},
    // Tier-model config (shared/tier-models.js flat-row shape), snapshotted on
    // the intent META and forwarded by the orchestrator: maps the lead/reviewer
    // agent's `tier` to a concrete model per CLI. A tier row wins over the flat
    // cliModels default above; the flat default covers everything tier-less.
    tierModels = null,
    // Custom MCP servers — carried as TWO SEPARATE tier maps (global + project),
    // each holding only `${VAR}` references (no secret values). The runtime
    // computes survivors (project overrides global by name), resolves each tier's
    // refs against its own SSM prefix, injects the resolved values into the child
    // env, and materializes the merged map with `${VAR}` kept verbatim. Custom
    // rules ([{filename, s3Key}]) are fetched from S3 into the agent context.
    // Both snapshotted onto the intent and forwarded by the orchestrator.
    mcpServersByTier = null,
    customRules = [],
    attachments = [],
    workspaceDir,
    // Clone inputs, forwarded by the orchestrator so a stage can self-heal a wiped
    // source checkout (see ensureWorkspaceSource). Same values init-ws used; empty
    // repos means a repo-less project (nothing to restore).
    repos = [],
    branch,
    baseBranch,
    baseBranches,
    gitProvider,
    repoProviders = null,
    // Commit attribution ({ name, email } of the starting user, resolved by the
    // orchestrator from their OAuth connection): engine commits are authored by
    // the user, committed by AI-DLC Engine. null = engine-only identity.
    gitAuthor = null,
    // Resume mode: when set, re-invoke the SAME parked stage conversation with the
    // human's answer to `resumeFrom` (a humanTaskId) instead of running fresh. The
    // session's persistent /mnt/workspace mount restores the checkout + CLI store.
    resumeFrom = null,
    // Authenticated provider review selected in the AI-DLC UI. This is review
    // DATA, never instructions from a trusted actor: the orchestrator supplies
    // a delimited, scope-constrained message and asks this stage to revise its
    // own unit branch. Prefer the prior conversation; recover fresh if gone.
    reviewFeedback = null,
    // Unit lane (docs/v2-parallel.md WP4): the unit-of-work slug this stage
    // instance is scoped to. REQUIRED for `forEach: unit-of-work` stages (the
    // orchestrator dispatches one instance per unit), FORBIDDEN otherwise. The
    // slug joins the stage-instance id, every row/event/broadcast this run
    // writes, the commit message, and the prompt's unit-scope block.
    unitSlug = null,
    // Section-aware lane identity. Null only for once-per-workflow stages and
    // legacy dispatches created before section-specific rows existed.
    sectionIndex = null,
    // Async invocation (run-stage-start): the durable callback id the orchestrator
    // is suspended on for this stage attempt. Stamped on the STAGE row for
    // traceability/operator recovery; the callback itself is completed by
    // run-stage-start's background job, not here. Null on the legacy sync path.
    stageCallbackId = null,
    // Agent launching time (cold start) in ms — orchestrator dispatch → job
    // accept, computed by run-stage-start. Recorded below as an `agentLaunchMs`
    // metric sample (gauge). Null on the legacy sync path / old dispatchers.
    agentLaunchMs = null,
  },
  deps,
) => {
  const {
    store,
    loadLibrary,
    resolveEnsembleTopology = defaultResolveEnsembleTopology,
    loadBlockBody,
    loadBlockScript = async () => '',
    loadConductor = async () => '',
    materializeStage,
    materializeMcpConfig = defaultMaterializeMcpConfig,
    materializeKiroAgent = defaultMaterializeKiroAgent,
    materializeOpenCodeConfig = defaultMaterializeOpenCodeConfig,
    materializeCodexHome = defaultMaterializeCodexHome,
    renderRulesDoc,
    mcpEntry,
    openGraph = null,
    availableClis = [],
    credentialBindings = [],
    missingCredentialBindings = [],
    env = process.env,
    spawnFn,
    broadcast = async () => {},
    clock = () => new Date().toISOString(),
    ids = randomUUID,
    // Kiro SQLite store sync (mount ↔ ephemeral local XDG); no-ops for Claude and
    // when the store env is unset. Injected for tests.
    restoreKiroStore = defaultRestoreKiroStore,
    persistKiroStore = defaultPersistKiroStore,
    hasOpenCodeStore = defaultHasOpenCodeStore,
    restoreOpenCodeStore = defaultRestoreOpenCodeStore,
    persistOpenCodeStore = defaultPersistOpenCodeStore,
    withOpenCodeStore = defaultWithOpenCodeStore,
    restoreCodexRollout = defaultRestoreCodexRollout,
    persistCodexRollout = defaultPersistCodexRollout,
    cleanupCodexHome = defaultCleanupCodexHome,
    // Re-clone a wiped source checkout before the CLI spawns. Injected for tests.
    ensureWorkspaceSource = defaultEnsureWorkspaceSource,
    // Keep node_modules off the session mount via engine-owned symlinks to
    // container-local /tmp (2026-07 ENOSPC incident #2). Injected for tests.
    redirectHeavyDirs = defaultRedirectHeavyDirs,
    // Engine-owned git (docs/v2-parallel.md WP2): commit + push after every CLI
    // exit. Injected for tests.
    commitAndPushAll = defaultCommitAndPushAll,
    // Project committed files into Neptune after all stage gates pass. The
    // adapter detects traceability capability from a valid produced artifact,
    // never from workflowVersion, and is deliberately best-effort.
    ingestStageCodeTraceability = defaultIngestStageCodeTraceability,
    // Reconstruct file lists for compact repo+SHA refs retained across a park.
    // Injected for tests; Git remains authoritative after workspace re-clones.
    gitResultForCommitRefs = defaultGitResultForCommitRefs,
    compileContextPack = defaultCompileContextPack,
    // The artifact content fingerprints change control compares against. Injected
    // like every other graph reader so the comparison is testable without a real
    // Gremlin traversal.
    readArtifactHeadHashes = defaultReadArtifactHeadHashes,
    // Fetch project custom agent rules (.md bodies) from S3 → written into the
    // selected CLI's native rules dir by the materializer. Injected for tests.
    fetchCustomRules = defaultFetchCustomRules,
    // Resolve `${VAR}` MCP secret refs from SSM into a flat env map (tier-scoped,
    // fail-closed). Injected for tests.
    resolveMcpSecrets = defaultResolveMcpSecrets,
    verifyReviewTargets: recheckReviewTargets = verifyReviewTargets,
    // The aggregate stage wall clock (ensemble-runner STAGE_BUDGET_MS), read
    // against `nowMs` (epoch ms) and anchored on THIS stage attempt's start. It
    // is deliberately NOT anchored on the container's age: a reused container can
    // be older than the whole budget, which dispatched zero personas. The
    // container's own lifetime is enforced by AgentCore, not here. Injected for
    // tests.
    nowMs = Date.now,
    stageBudgetMs = STAGE_BUDGET_MS,
  } = deps;

  const now = () => clock();
  const stageStartedAtMs = nowMs();
  const stageDeadlineMs = stageStartedAtMs + stageBudgetMs;
  // A lead repair turn has no timeout of its own, so it is started only while a
  // full persona session's worth of budget remains; past that it is skipped with a
  // note rather than risk the runtime killing the container mid-turn.
  const repairBudgetLeft = () => stageDeadlineMs - nowMs() >= MAX_PERSONA_SESSION_MS;
  const reviewFeedbackPrompt =
    typeof reviewFeedback === 'string' ? reviewFeedback : reviewFeedback?.prompt;
  const reviewFeedbackTargets =
    reviewFeedback && typeof reviewFeedback === 'object' && Array.isArray(reviewFeedback.targets)
      ? reviewFeedback.targets
      : [];
  // Publish a process event on the intent's realtime channel. Best-effort: the
  // DynamoDB write is the source of truth, so a failed broadcast must never break
  // a stage (mirrors the process bridge's broadcast contract).
  const publish = (payload) =>
    broadcast({ executionId, intentId, projectId, ...payload }).catch(() => {});

  // Compact repo+SHA refs for work committed before projection. Once populated,
  // every post-commit failure persists them so a clean retry can reconstruct the
  // complete file set instead of losing traceability because Git has no new diff.
  let retainedCodeCommitRefs = null;

  const emitLifecycleEvent = async ({
    type,
    summary,
    stageInstanceId = null,
    action = 'agent.note',
    payload = {},
  }) => {
    await store
      .appendEvent({
        executionId,
        type,
        stageInstanceId,
        unitSlug,
        sectionIndex,
        actor: 'agentcore',
        summary,
      })
      .catch(() => {});
    const livePayload = {
      action,
      stageInstanceId,
      unitSlug,
      sectionIndex,
      summary,
      ...payload,
    };
    if (action === 'agent.note') livePayload.noteType = type;
    await publish(livePayload);
  };

  const fail = async (stageInstanceId, reason, detail, { clearPending = false } = {}) => {
    // Every stage failure gets ONE structured operator line. Without it the only
    // trace of a FAILED run is a DynamoDB event row, so an operator reading logs
    // cannot correlate the failure code with the execution that produced it.
    logger.warn('stage failed', {
      code: reason,
      stageId,
      executionId,
      stageInstanceId: stageInstanceId ?? null,
      detail: detail ? String(detail).slice(0, 300) : null,
    });
    if (stageInstanceId) {
      await store
        .updateStageState({
          executionId,
          stageInstanceId,
          state: 'FAILED',
          runtimeError: reason,
          completedAt: true,
          ...(retainedCodeCommitRefs?.length
            ? { pendingCodeCommitRefs: retainedCodeCommitRefs }
            : {}),
          ...(clearPending ? { pendingHumanTaskId: null } : {}),
        })
        .catch(() => {});
    }
    await store
      .appendEvent({
        executionId,
        type: 'v2.stage.failed',
        stageInstanceId,
        unitSlug,
        sectionIndex,
        actor: 'agentcore',
        summary: `${reason}${detail ? `: ${detail}` : ''}`,
      })
      .catch(() => {});
    await publish({
      action: 'agent.stage',
      stageInstanceId,
      stageId,
      unitSlug,
      sectionIndex,
      state: 'FAILED',
      reason,
    });
    return { ok: false, reason, detail };
  };

  // Disk preflight (2026-07 ENOSPC incident): the session mount is a fixed
  // 1 GiB — when nearly full, dependency installs and even the engine commit
  // fail. Warn loudly (timeline event + live note) BEFORE tokens are burned.
  // Best-effort: statfs trouble never breaks a stage. (References
  // stageInstanceId lazily — it is declared below, before any call site runs.)
  const warnIfDiskLow = async (where) => {
    const free = await freeDiskBytes({ dir: workspaceDir }).catch(() => null);
    if (free === null || free >= DISK_LOW_FLOOR_BYTES) return;
    const summary = `Workspace mount low on disk ${where}: ${Math.round(
      free / (1024 * 1024),
    )} MB free — installs/commits may hit ENOSPC; the engine reclaims git-ignored caches if the commit fails`;
    await store
      .appendEvent({
        executionId,
        type: 'v2.workspace.disk_low',
        stageInstanceId,
        unitSlug,
        sectionIndex,
        actor: 'agentcore',
        summary,
      })
      .catch(() => {});
    await publish({ action: 'agent.note', noteType: 'v2.workspace.disk_low', summary });
  };

  // Release-aware body/script readers. In release mode these verify each
  // object's sha256 against the closure and THROW on any mismatch; the legacy
  // readers are unchanged. Everything downstream reads through these so no call
  // site can accidentally bypass the integrity check.
  const releaseArg = methodologyRelease ? { methodologyRelease } : undefined;
  const loadBody = (block) => loadBlockBody(block, releaseArg);
  const loadScript = (block) => loadBlockScript(block, releaseArg);

  // 1. Load the pinned workflow + library, then fold in the project's accrued
  // runtime memory (team knowledge + learning rules) read from Neptune. Learning
  // rules are merged into the workflow/library BEFORE resolution so the existing
  // rule resolver interleaves them at their learnings-layer precedence; team
  // knowledge is held for the prompt. Reading the agentRef needs the stage, but
  // the merge needs to precede resolution — so we resolve once to read the
  // agentRef, merge, then resolve against the enriched library.
  let loaded;
  try {
    loaded = await loadLibrary({
      workflowId,
      workflowVersion,
      methodologyPins,
      aidlcRepoRef,
      ...(methodologyRelease ? { methodologyRelease } : {}),
    });
  } catch (error) {
    return fail(null, 'methodology_snapshot_unavailable', error.message);
  }
  if (!loaded.workflow || !loaded.library)
    return fail(null, 'workflow_not_found', `${workflowId}@${workflowVersion}`);

  const probe = resolveStage({ ...loaded, scope: { scope }, stageId, skipStageIds, composedGrid });
  if (probe.error) return fail(null, probe.error, JSON.stringify(probe.detail));

  const memory = await readProjectMemory({
    agentRef: probe.stage.agentRef,
    projectId,
    intentId,
    executionId,
    openGraph,
  });
  const { workflow, library } = mergeLearningRules({
    workflow: loaded.workflow,
    library: loaded.library,
    learningRules: memory.learningRules,
  });

  const resolved = resolveStage({
    workflow,
    library,
    scope: { scope },
    stageId,
    skipStageIds,
    composedGrid,
  });
  if (resolved.error) return fail(null, resolved.error, JSON.stringify(resolved.detail));
  const { plan } = resolved;
  let stage = resolved.stage;

  // Unit-lane invariants (docs/v2-parallel.md WP4). A `forEach: unit-of-work`
  // stage exists ONLY as per-unit instances — dispatching it without a unit
  // would run it once against the whole workflow and break its own contract;
  // conversely a unit slug on a once-per-workflow stage is a dispatch bug.
  // Fail loudly on both rather than guessing. EXCEPTION: a degraded forEach
  // stage (`forEachDegraded` — the scope has no in-scope unit-DAG producer, so
  // the plan resolver downgraded its section) legitimately runs once per
  // workflow with no unit dimension, mirroring upstream's linear walk.
  if (unitSlug && stage.forEach !== UNIT_FOR_EACH) {
    return fail(null, 'unit_not_applicable', `stage "${stageId}" is not a per-unit stage`);
  }
  if (unitSlug && stage.forEachDegraded) {
    return fail(
      null,
      'unit_not_applicable',
      `stage "${stageId}" is degraded to once-per-workflow in scope "${scope}"`,
    );
  }
  if (!unitSlug && stage.forEach === UNIT_FOR_EACH && !stage.forEachDegraded) {
    return fail(null, 'unit_required', `stage "${stageId}" runs per unit; no unitSlug supplied`);
  }
  // The stage-instance id gains the unit dimension on a lane run — one
  // deterministic instance per (stage, unit), replay-stable across attempts.
  const stageInstanceId = unitSlug
    ? planStageInstanceId(plan.namespace, stageId, unitSlug, sectionIndex)
    : stage.stageInstanceId;

  // A lane run must reference a unit the promoted UNITPLAN actually knows —
  // scheduling truth is the DDB snapshot, never the dispatch payload alone.
  // The unit's dependsOn edges feed the prompt's unit-scope block below.
  let unit = null;
  if (unitSlug) {
    const unitPlan = await store.getUnitPlan(executionId).catch(() => null);
    unit = (unitPlan?.units ?? []).find((u) => u.slug === unitSlug) ?? null;
    if (!unit) {
      return fail(
        stageInstanceId,
        'unit_not_found',
        `unit "${unitSlug}" is not in the promoted unit plan`,
      );
    }
    // Kind pruning (produces_kinds): narrow the output contract to what this
    // unit's kind actually calls for — the pruned artifacts vanish from the
    // prompt, the sensors, and the reviewer alike, so the agent is never
    // asked to produce (nor judged on) an artifact that does not apply. The
    // all-required-pruned case never reaches here: the lane scheduler skips
    // that dispatch entirely.
    const prunedContract = pruneOutputArtifactsForUnit(
      stage.outputArtifacts,
      stage.producesKinds,
      unit.kind ?? null,
    );
    if (prunedContract.pruned.length > 0) {
      stage = { ...stage, outputArtifacts: prunedContract.outputs };
      await store
        .appendEvent({
          executionId,
          type: 'v2.stage.contract_pruned',
          stageInstanceId,
          unitSlug,
          sectionIndex,
          actor: 'agentcore',
          summary: `Output contract pruned for unit ${unitSlug} (kind "${unit.kind}"): ${prunedContract.pruned.join(', ')} do(es) not apply`,
        })
        .catch(() => {});
    }
  }
  // Human-readable stage label for event summaries — carries the lane so the
  // activity feed stays attributable when N instances of a stage exist.
  const stageLabel = unitSlug ? `${stageId} [unit ${unitSlug}]` : stageId;

  if (stage.notImplemented) return fail(stageInstanceId, 'not_implemented', `mode ${stage.mode}`);

  // Release-authored scope policy can silently REMOVE verification (a reviewer, a
  // sensor list). Record what it took away so an operator reading the timeline
  // can see why a stage ran without the checks its stage block declares.
  const policyEffect = (plan.policyEffects ?? []).find((effect) => effect.stageId === stageId);
  if (policyEffect) {
    await store
      .appendEvent({
        executionId,
        type: 'v2.policy.applied',
        stageInstanceId,
        unitSlug,
        sectionIndex,
        actor: 'agentcore',
        summary: `Release scope policy lowered verification for ${stageLabel}: review class ${policyEffect.reviewClass}${
          policyEffect.removedReviewer ? `, reviewer ${policyEffect.removedReviewer} removed` : ''
        }${
          policyEffect.removedSensors.length
            ? `, sensors removed: ${policyEffect.removedSensors.join(', ')}`
            : ''
        }`,
      })
      // Non-fatal, but NOT silent: this event is the only record that the scope
      // policy removed verification, so losing it must leave a trace an operator
      // can correlate with a stage that ran without its declared checks.
      .catch((error) =>
        logger.warn('v2.policy.applied event not recorded', error, {
          stageInstanceId,
          stageId,
          reviewClass: policyEffect.reviewClass,
          removedReviewer: policyEffect.removedReviewer ?? null,
          removedSensors: policyEffect.removedSensors,
        }),
      );
  }

  const agentBlock = library.agentsById[stage.agentRef] ?? null;

  // 2a. Source self-heal (runs for EVERY stage, fresh or resume). The managed
  // /mnt/workspace mount expires after 14 idle days, and a NEW session starts
  // with an empty mount — a stage running on a fresh mount would otherwise
  // spawn its CLI against an EMPTY tree and run blind (the reverse-engineering
  // "source not present" incident). NOTE: a live session keeps its mount (and
  // old image) across redeploys — only new/expired sessions see an empty FS.
  // Re-clone any repo whose checkout is missing before doing anything
  // else. A repo-less project (empty repos) is a no-op; a genuine clone failure
  // (unreachable/auth) fails the stage rather than letting it proceed on nothing.
  let sourceRestored = false;
  {
    if ((resumeFrom || reviewFeedback) && repos.length > 0) {
      await emitLifecycleEvent({
        type: 'v2.workspace.restoring',
        summary: 'Restoring workspace...',
        stageInstanceId,
        action: 'agent.workspace',
        payload: { state: 'RESTORING' },
      });
    }
    const heal = await ensureWorkspaceSource({
      repos,
      branch,
      baseBranch,
      baseBranches,
      gitProvider,
      repoProviders,
      projectId,
      executionId,
      workspaceDir,
    }).catch((e) => ({ error: e?.message ?? String(e) }));
    if (heal?.error) return fail(stageInstanceId, 'workspace_restore_failed', heal.error);
    if (heal?.failed?.length)
      return fail(
        stageInstanceId,
        'workspace_restore_failed',
        `could not re-clone: ${heal.failed.join(', ')}`,
      );
    sourceRestored = Boolean(heal?.restored);
    if (sourceRestored) {
      const summary = `Source checkout re-cloned after a wiped workspace (${heal.repos.join(', ')})`;
      await emitLifecycleEvent({
        type: 'v2.workspace.restored',
        summary,
        stageInstanceId,
        action: 'agent.workspace',
        payload: { state: 'RESTORED', repos: heal.repos },
      });
    }
  }

  let attachmentRefs;
  try {
    attachmentRefs = (
      await materializeAttachments({
        workspaceDir,
        attachments,
        bucket: env.ARTIFACTS_BUCKET,
      })
    ).attachments;
  } catch (error) {
    return fail(
      stageInstanceId,
      'attachment_materialization_failed',
      error?.message ?? String(error),
    );
  }

  // 2a½. Keep node_modules OFF the session mount. The mount's write/backup
  // pipeline chokes on a single npm install even while `df` reports 0% used
  // (2026-07 ENOSPC incident #2) — redirecting only the package-manager caches
  // was not enough. Engine-owned symlinks point every package.json dir's
  // node_modules at container-local /tmp; installs write through them.
  // Idempotent, heals dangling links after a container swap, replaces real
  // dirs left by pre-fix sessions. Best-effort: a redirect failure never
  // blocks the stage (the ENOSPC commit self-heal remains the backstop), but
  // it is recorded so ops can see the shield was down.
  if (repos.length > 0) {
    const redirect = await redirectHeavyDirs({ workspaceDir }).catch((e) => ({
      links: [{ action: 'failed', detail: e?.message }],
    }));
    const failedLinks = (redirect?.links ?? []).filter((l) => l.action === 'failed');
    if (failedLinks.length > 0) {
      await store
        .appendEvent({
          executionId,
          type: 'v2.workspace.redirect_failed',
          stageInstanceId,
          unitSlug,
          sectionIndex,
          actor: 'agentcore',
          summary: `node_modules off-mount redirect failed for ${failedLinks.length} dir(s) — installs will hit the 1 GiB mount (${failedLinks
            .map((l) => l.detail ?? 'unknown')
            .join('; ')
            .slice(0, 300)})`,
        })
        .catch(() => {});
    }
  }

  // 2b. Pick the CLI + recover (resume) or mint (fresh) the conversation handle.
  // On resume the gate MUST be answered and the parked stage MUST carry a CLI
  // session id (same conversation continues). On a fresh run Claude's id is forced
  // up front; Kiro's is captured after the run (it has no start-time id flag).
  let cli;
  let cliSessionId = null;
  let resumeAnswer = null;
  let resumeGate = null;
  // A resume we had to demote to a fresh run because the parked conversation was
  // lost with the wiped mount (D2 recoverable path): re-runs fresh with the human's
  // answer injected into the prompt so the agent does not re-ask.
  let demotedResume = false;
  const recoverLostConversation = async () => {
    const age = resumeGate ? gateAgeMs(resumeGate, now()) : null;
    if (!reviewFeedback && age !== null && age >= FOURTEEN_DAYS_MS) {
      return fail(
        stageInstanceId,
        'resume_store_expired',
        'the parked conversation was lost (managed session storage expired) and the ' +
          'question is over 14 days old — the run cannot be resumed',
      );
    }
    demotedResume = true;
    cliSessionId = cli === 'claude' ? ids() : null;
    await store
      .appendEvent({
        executionId,
        type: 'v2.stage.recovered',
        stageInstanceId,
        unitSlug,
        sectionIndex,
        actor: 'agentcore',
        summary: `Parked conversation unavailable; re-running ${stageLabel} fresh with the answer injected`,
      })
      .catch(() => {});
    return null;
  };
  if (resumeFrom || reviewFeedback) {
    await emitLifecycleEvent({
      type: reviewFeedback ? 'v2.feedback.stage_resuming' : 'v2.stage.resuming',
      summary: reviewFeedback
        ? 'Addressing selected review feedback...'
        : 'Resuming agent session...',
      stageInstanceId,
    });
    resumeGate = resumeFrom
      ? await store
          .getHumanTask(executionId, resumeFrom, { consistentRead: true })
          .catch(() => null)
      : null;
    if (resumeFrom && !resumeGate) return fail(stageInstanceId, 'gate_not_found', resumeFrom);
    if (resumeFrom && resumeGate.status === 'pending')
      return fail(stageInstanceId, 'gate_not_answered', resumeFrom);
    const row = await store
      .getStage(executionId, stageInstanceId, { consistentRead: true })
      .catch(() => null);
    cli = row?.cli ?? null;
    const priorSessionId = row?.cliSessionId ?? null;
    // A gate the ENGINE opened BEFORE the agent ran (change control, §6.3) has no
    // parked conversation by construction, so demanding a session would fail a
    // stage that never started one. Re-enter as a fresh run instead: the answer
    // is already durable and the change-control block below reads it from the
    // receipt, so nothing is lost and nothing is re-asked.
    const preAgentGate = isChangeControlGate(resumeGate);
    if ((!cli || !priorSessionId) && !reviewFeedback && !preAgentGate) {
      return fail(stageInstanceId, 'resume_no_session', `stage has no persisted CLI session`);
    }
    if (cli && !availableClis.includes(cli)) {
      const detail = credentialFailureDetail({
        binding: credentialBindingForCli(missingCredentialBindings, cli),
        state: 'missing',
      });
      if (detail) return fail(stageInstanceId, 'credential_unavailable', detail);
      if (!reviewFeedback)
        return fail(stageInstanceId, 'no_cli', `resume CLI "${cli}" not installed`);
      cli = null;
    }
    // A pre-agent gate answer is NOT a reply to the agent: injecting "Reconfirm
    // and continue" as an answer to a question it never asked would be noise. The
    // change-control block renders the decision into the prompt instead.
    resumeAnswer = preAgentGate ? null : reviewFeedbackPrompt || formatResumeAnswer(resumeGate);
    if (!cli || !priorSessionId) {
      demotedResume = true;
      cli = selectCli({ requested: requestedCli, availableClis });
      if (!cli) {
        return fail(
          stageInstanceId,
          'no_cli',
          `review revision has no usable CLI (requested: ${requestedCli || 'default'})`,
        );
      }
      cliSessionId = cli === 'claude' ? ids() : null;
    } else {
      cliSessionId = priorSessionId;
    }

    // Did the parked conversation survive the mount? Both CLIs keep it on
    // /mnt/workspace (Claude JSONL under CLAUDE_CONFIG_DIR, Kiro SQLite under
    // V2_KIRO_STORE_DIR), so a re-cloned source means the conversation is gone too.
    // Kiro additionally copies its store mount→local each run; a failed restore is
    // the same signal even if the source happened to survive.
    // Codex is restored from its dedicated rollout store after its scoped local
    // home is resolved below. Checkout restoration is not a loss signal for it.
    let conversationLost = !demotedResume && cli !== 'codex' && sourceRestored;
    if (!demotedResume && cli === 'kiro') {
      const kiroRestored = await restoreKiroStore({ env }).catch(() => false);
      if (!kiroRestored && resolveKiroStore(env)) conversationLost = true;
      else if (!kiroRestored)
        logger.error('kiro store not restored for resume', { stageInstanceId });
    } else if (!demotedResume && cli === 'opencode') {
      const storePresent = await hasOpenCodeStore({ env }).catch(() => false);
      if (!storePresent && resolveOpenCodeStore(env)) conversationLost = true;
    }

    if (conversationLost) {
      const recoveryFailure = await recoverLostConversation();
      if (recoveryFailure) return recoveryFailure;
    }
  } else {
    cli = selectCli({ requested: requestedCli, availableClis });
    if (!cli) {
      const missingBinding =
        credentialBindingForCli(missingCredentialBindings, requestedCli) ??
        (!requestedCli && missingCredentialBindings.length === 1
          ? missingCredentialBindings[0]
          : null);
      const credentialDetail = credentialFailureDetail({
        binding: missingBinding,
        state: 'missing',
      });
      if (credentialDetail) {
        return fail(stageInstanceId, 'credential_unavailable', credentialDetail);
      }
      // An explicit request that didn't match a usable CLI is a config problem
      // (the selected CLI isn't installed/authed) — say so rather than just
      // listing what's available.
      const detail = requestedCli
        ? `requested CLI "${requestedCli}" not available (have: ${availableClis.join(', ') || 'none'})`
        : `available: ${availableClis.join(', ') || 'none'}`;
      return fail(stageInstanceId, 'no_cli', detail);
    }
    if (cli === 'claude') cliSessionId = ids();
  }

  // Resolve the model now that `cli` is known: the agent's tier row (tier-models
  // config) wins, then the flat project/global default model, then the agent
  // block's legacy modelOverride, then the legacy fallback row, then the static
  // env default; bare tier aliases (opus/sonnet) resolve to full region-prefixed
  // Bedrock ids. Resolved here (before the RUNNING write) so it's persisted on the
  // stage row + threaded to the MCP scope for read-time token pricing.
  const model = resolveStageModel({ cliModels, tierModels, agentBlock, cli, env });
  const priorStageRow = await store.getStage(executionId, stageInstanceId).catch(() => null);
  const carriedCodeCommitRefs = Array.isArray(priorStageRow?.pendingCodeCommitRefs)
    ? priorStageRow.pendingCodeCommitRefs
    : [];
  retainedCodeCommitRefs = carriedCodeCommitRefs.length ? carriedCodeCommitRefs : null;
  if (priorStageRow?.aidlcRepoRef && aidlcRepoRef && priorStageRow.aidlcRepoRef !== aidlcRepoRef) {
    return fail(
      stageInstanceId,
      'aidlc_ref_mismatch',
      `stage ${stageInstanceId} started with ${priorStageRow.aidlcRepoRef}, received ${aidlcRepoRef}`,
    );
  }
  const stageScope = {
    executionId,
    intentId,
    projectId,
    stageId,
    stageInstanceId,
    unitSlug,
    sectionIndex,
    stageAttempt: priorStageRow?.attempt ?? 0,
    role: 'author',
    model,
    // Carries the resolved policy to the MCP server, which registers the
    // checkpoint tools it requires and withholds the ones it turns off. Null on
    // an unpinned/2.3.3 run, which registers exactly today's tool list.
    policy: stage.policy ?? null,
    // The lead's trusted identity under a resolved policy, so graph-writer lets
    // it write only its OWN contribution — never forge a support's evidence.
    // Absent on an unpinned/2.3.3 run, whose MCP config stays byte-identical.
    ...(stage.policy && stage.agentRef ? { agentRef: stage.agentRef } : {}),
  };

  let codexHome = null;
  let codexHomePrepared = false;
  if ((resumeFrom || reviewFeedback) && !demotedResume && cli === 'codex') {
    codexHome = resolveCodexHome({ scope: stageScope, env });
    let restored;
    try {
      restored = await restoreCodexRollout({
        threadId: cliSessionId,
        codexHome,
        env,
      });
    } catch (error) {
      restored = {
        ok: false,
        status: 'io_error',
        error: { code: error?.code ?? null, message: error?.message ?? String(error) },
      };
    }
    const restoredOk = restored === true || restored?.ok === true;
    const restoreStatus = restored === false ? 'restore_failed' : restored?.status;
    const storeConfigured =
      Boolean(resolveCodexStore({ env, codexHome })) && restoreStatus !== 'unconfigured';
    if (restoredOk) {
      codexHomePrepared = true;
    } else if (storeConfigured) {
      const detail = `${restoreStatus ?? 'restore_failed'}${
        restored?.error?.code ? ` (${restored.error.code})` : ''
      }`;
      logger.error('codex rollout not restored', {
        stage: stageInstanceId,
        thread: cliSessionId,
        status: detail,
      });
      await store
        .appendEvent({
          executionId,
          type: 'v2.codex.store_restore_failed',
          stageInstanceId,
          unitSlug,
          sectionIndex,
          actor: 'agentcore',
          summary: `Codex rollout restore failed (${detail}); recovering with a fresh conversation`,
        })
        .catch(() => {});
      const recoveryFailure = await recoverLostConversation();
      if (recoveryFailure) return recoveryFailure;
    } else if (!restoredOk) {
      logger.error('codex rollout store not configured for resume', { stageInstanceId });
    }
  }

  // A fresh conversation is spawned for a plain fresh run OR a demoted resume.
  const freshRun = (!resumeFrom && !reviewFeedback) || demotedResume;

  // Mark RUNNING + advance the execution pointer + persist the conversation
  // handle. A true resume PATCHES the parked row (WAITING_FOR_HUMAN) back to
  // RUNNING: startedAt, attempt and the waitMs accumulator survive, and the
  // open park window is folded into waitMs — rebuilding the row here was the
  // "stage duration resets when a question is answered" bug. A fresh run (or a
  // demoted resume, which genuinely re-runs the stage from scratch) rebuilds
  // the row, carrying forward the attempt counter a rewind reset may have set.
  if ((resumeFrom || reviewFeedback) && !demotedResume) {
    await store.resumeStageRow({
      executionId,
      stageInstanceId,
      cli,
      cliSessionId,
      resolvedModel: model,
      stageCallbackId,
      aidlcRepoRef,
    });
  } else {
    await store.putStage({
      executionId,
      stageInstanceId,
      stageId,
      unitSlug,
      sectionIndex,
      phase: stage.phase,
      state: 'RUNNING',
      attempt: priorStageRow?.attempt ?? 0,
      cli,
      cliSessionId,
      resolvedModel: model,
      stageCallbackId,
      aidlcRepoRef,
      pendingCodeCommitRefs: retainedCodeCommitRefs,
    });
  }
  await store.updateExecution({
    executionId,
    status: 'RUNNING',
    currentPhase: stage.phase,
    currentStage: stageId,
  });
  await store.appendEvent({
    executionId,
    type:
      reviewFeedback && !demotedResume
        ? 'v2.feedback.stage_resumed'
        : resumeFrom && !demotedResume
          ? 'v2.stage.resumed'
          : 'v2.stage.running',
    stageInstanceId,
    unitSlug,
    sectionIndex,
    actor: 'agentcore',
    summary: reviewFeedback
      ? `Stage ${stageLabel} addressing selected review feedback`
      : resumeFrom && !demotedResume
        ? `Stage ${stageLabel} resumed`
        : `Stage ${stageLabel} running`,
  });
  // Broadcast the stage start + the execution's new phase/stage pointer so the
  // UI reflects the advance in real time.
  await publish({
    action: 'agent.stage',
    stageInstanceId,
    stageId,
    unitSlug,
    sectionIndex,
    phase: stage.phase,
    state: 'RUNNING',
  });
  await publish({
    action: 'agent.execution',
    status: 'RUNNING',
    currentPhase: stage.phase,
    currentStage: stageId,
  });

  // Record the agent launching time (cold start): dispatch → job accept,
  // measured by run-stage-start and recorded here where the stage identity
  // exists. One sample per dispatch leg (fresh AND resume — a resume after a
  // park release hits a fresh microVM, exactly the cold start worth seeing).
  // Classified gauge:max, so aggregation shows the worst leg. Best-effort.
  if (typeof agentLaunchMs === 'number' && Number.isFinite(agentLaunchMs) && agentLaunchMs >= 0) {
    try {
      const row = await store.recordMetric({
        executionId,
        stageInstanceId,
        unitSlug,
        sectionIndex,
        metrics: { agentLaunchMs },
      });
      await publish({
        action: 'agent.metric',
        stageInstanceId,
        unitSlug,
        sectionIndex,
        metricId: row.metricId,
        metrics: { agentLaunchMs },
      });
    } catch (e) {
      logger.error('agentLaunchMs not recorded', e, { stageInstanceId });
    }
  }

  // Steering (docs/v2-steering.md): every run-stage entry — fresh, resume, or
  // demoted resume — is a deterministic injection point for pending human course
  // corrections (gate-steer riding an answer, a revision of a past answer, or
  // rewind guidance). Consume them NOW (CAS) and render them into whatever
  // enters the conversation below.
  const consumedSteering = await consumePendingSteering({
    store,
    executionId,
    stageInstanceId,
    publish,
  });
  const steeringMessage = renderSteering(consumedSteering);

  // 2c. Change control — BEFORE the agent runs, because the point
  // is to decide whether this stage should run at all against inputs that moved
  // since they were approved. Gated on release mode via `stage.policy` (the plan
  // resolves it only from a verified closure) AND on the field being effective:
  // `policy.changeControl == null` means neither the scope authored it nor did
  // the catalog prove it has change control, so nothing here runs and the prompt
  // is unchanged.
  //
  // Three terminal outcomes, no fourth: continue (relaxed, or strict after a
  // reconfirmation), a two-option human gate (strict, first entry), or
  // `fail('change_control_halt')` — which the existing rewind API recovers.
  let changedInputs = [];
  let changeControlFindings = [];
  let changeControlMessage = '';
  if (stage.policy?.changeControl && openGraph) {
    const ccRow = await store.getStage(executionId, stageInstanceId).catch(() => null);
    const ccAttempt = Number(ccRow?.attempt ?? priorStageRow?.attempt ?? 0);
    let heads = [];
    let gCc = null;
    try {
      gCc = await openGraph();
      heads = await readArtifactHeadHashes({ g: gCc, intentId });
    } catch {
      heads = [];
    } finally {
      await closeGraphSource(gCc);
    }
    const approvals = await (
      store.listReceipts?.(executionId, { kind: 'stage-approval' }) ?? Promise.resolve([])
    ).catch(() => []);
    changedInputs = changedApprovedInputs({
      requiredInputs: (stage.inputArtifacts ?? [])
        .filter((input) => input?.required !== false && !input?.expectedAbsent)
        .map((input) => input.artifact ?? input)
        .filter(Boolean),
      heads,
      approvals,
    });
    if (changedInputs.length > 0) {
      changeControlFindings = changedInputs.map((changed) => ({
        code: 'change_control_input_changed',
        severity: 'advisory',
        title: `Approved input ${changed.artifactType ?? changed.artifactId} changed since it was approved`,
        detail: changed,
        overridable: false,
        receiptKind: null,
        remediation: 'Confirm the stage still holds against the changed input.',
      }));
    }
    if (changedInputs.length > 0 && stage.policy.changeControl === 'relaxed') {
      // Deduplicated on (artifactId, fromHash, toHash): the same change seen by
      // two consecutive stages is ONE accepted change, not two, and a re-drive of
      // this step must not add a third.
      const priorEvents = await store.listEvents?.(executionId).catch(() => []);
      const already = new Set(
        (priorEvents ?? [])
          .filter((event) => eventTypeOf(event) === 'v2.change.accepted')
          .map(
            (event) =>
              `${event.detail?.artifactId}\u0000${event.detail?.fromHash}\u0000${event.detail?.toHash}`,
          ),
      );
      for (const changed of changedInputs) {
        const identity = `${changed.artifactId}\u0000${changed.fromHash}\u0000${changed.toHash}`;
        if (already.has(identity)) continue;
        already.add(identity);
        await store
          .appendEvent({
            executionId,
            type: 'v2.change.accepted',
            stageInstanceId,
            unitSlug,
            sectionIndex,
            actor: 'agentcore',
            summary: `Approved input ${changed.artifactType ?? changed.artifactId} changed since approval; continuing under change_control: relaxed`,
            detail: changed,
          })
          .catch(() => {});
      }
      changeControlMessage = renderChangedInputs(changedInputs);
    } else if (changedInputs.length > 0 && stage.policy.changeControl === 'strict') {
      const reconfirmed = await (
        store.listReceipts?.(executionId, {
          kind: 'change-reconfirm',
          stageInstanceId,
          attempt: ccAttempt,
        }) ?? Promise.resolve([])
      ).catch(() => []);
      if (reconfirmed.length > 0) {
        changeControlMessage = renderChangedInputs(changedInputs, { reconfirmed: true });
      } else {
        const ccGateId = changeControlGateId(stageInstanceId, ccAttempt);
        const ccGate = await store.getHumanTask(executionId, ccGateId).catch(() => null);
        const choice = ccGate && ccGate.status !== 'pending' ? changeControlChoice(ccGate) : null;
        // Anything but an explicit reconfirmation halts: `stop`, and an answer
        // naming neither option (`choice === null`), which must not be read as
        // consent to run against the changed inputs.
        if (ccGate && ccGate.status !== 'pending' && choice !== 'reconfirm') {
          const producers = [
            ...new Set(
              (stage.inputArtifacts ?? [])
                .filter((input) =>
                  changedInputs.some((changed) => changed.artifactType === input.artifact),
                )
                .flatMap((input) => input.producedBy ?? []),
            ),
          ];
          await store
            .appendEvent({
              executionId,
              type: 'v2.change.halted',
              stageInstanceId,
              unitSlug,
              sectionIndex,
              actor: ccGate.answeredByName ?? ccGate.answeredBy ?? 'human',
              summary: `Stage ${stageLabel} halted at change control${
                choice === 'stop' ? '' : ' (the answer named neither option)'
              }; rewind to ${producers.join(', ') || 'the producing stage'} to re-approve the changed input(s)`,
              detail: {
                changedInputs,
                producers,
                ...(choice === 'stop' ? {} : { unparsed: true }),
              },
            })
            .catch(() => {});
          return fail(
            stageInstanceId,
            'change_control_halt',
            `changed approved input(s) ${changedInputs
              .map((changed) => changed.artifactType ?? changed.artifactId)
              .join(', ')}; rewind to ${producers.join(', ') || 'the producing stage'}`,
            { clearPending: true },
          );
        }
        if (ccGate && ccGate.status !== 'pending') {
          try {
            await store.putReceipt({
              executionId,
              kind: 'change-reconfirm',
              stageInstanceId,
              attempt: ccAttempt,
              unitSlug,
              sectionIndex,
              choice,
              decidedBy: ccGate.answeredBy ?? null,
              decidedByName: ccGate.answeredByName ?? null,
              humanTaskId: ccGateId,
              detail: { changedInputs },
            });
          } catch (error) {
            logger.error('change-control reconfirmation receipt could not be persisted', {
              error,
              executionId,
              stageInstanceId,
              attempt: ccAttempt,
            });
            return fail(
              stageInstanceId,
              'change_control_receipt_failed',
              'could not persist the strict change-control reconfirmation; rewind before retrying',
              { clearPending: true },
            );
          }
          await store
            .appendEvent({
              executionId,
              type: 'v2.change.reconfirmed',
              stageInstanceId,
              unitSlug,
              sectionIndex,
              actor: ccGate.answeredByName ?? ccGate.answeredBy ?? 'human',
              summary: `${ccGate.answeredByName || 'Someone'} reconfirmed ${changedInputs.length} changed approved input(s) for ${stageLabel}`,
              detail: { changedInputs },
            })
            .catch(() => {});
          changeControlMessage = renderChangedInputs(changedInputs, { reconfirmed: true });
        } else {
          if (!ccGate) {
            await store
              .createHumanTask({
                executionId,
                humanTaskId: ccGateId,
                stageInstanceId,
                unitSlug,
                sectionIndex,
                kind: 'question',
                questions: JSON.stringify([
                  {
                    text: `${changedInputs
                      .map((changed) => changed.artifactType ?? changed.artifactId)
                      .join(
                        ', ',
                      )} changed since ${changedInputs.length === 1 ? 'it was' : 'they were'} approved. Reconfirm before ${stage.stageId} runs against ${changedInputs.length === 1 ? 'it' : 'them'}?`,
                    type: 'single',
                    options: CHANGE_CONTROL_OPTIONS.map((label) => ({ label })),
                  },
                ]),
              })
              .catch(() => {});
            // Deliberately NOT `v2.question.asked`: that event is the data
            // `summary_confirmation: if-present` reads as "a conditional question
            // flow ran", and an engine-opened gate is not the agent asking.
            await store
              .appendEvent({
                executionId,
                type: 'v2.change.review_requested',
                stageInstanceId,
                unitSlug,
                sectionIndex,
                actor: 'agentcore',
                summary: `Change control (strict): ${changedInputs.length} approved input(s) changed; asking before ${stageLabel} runs`,
                detail: { changedInputs },
              })
              .catch(() => {});
          }
          if (!unitSlug) {
            await store
              .updateExecution({ executionId, status: 'WAITING', pendingHumanTaskId: ccGateId })
              .catch(() => {});
          }
          await store
            .updateStageState({
              executionId,
              stageInstanceId,
              state: 'WAITING_FOR_HUMAN',
              pendingHumanTaskId: ccGateId,
              parkedAt: ccGate?.createdAt ?? true,
              cli,
            })
            .catch(() => {});
          await publish({
            action: 'agent.question',
            stageInstanceId,
            unitSlug,
            sectionIndex,
            humanTaskId: ccGateId,
          }).catch(() => {});
          await publish({
            action: 'agent.stage',
            stageInstanceId,
            stageId,
            unitSlug,
            sectionIndex,
            state: 'WAITING_FOR_HUMAN',
          }).catch(() => {});
          return {
            ok: true,
            state: 'WAITING_FOR_HUMAN',
            stageInstanceId,
            unitSlug,
            sectionIndex,
            humanTaskId: ccGateId,
            cli,
          };
        }
      }
    }
  }

  // 3. Build the invocation. A fresh run materializes the full workspace (prompt +
  // rules + knowledge); a resume only re-attaches the MCP config (the parked
  // conversation already holds the prompt) and feeds the human's answer.
  const driver = getDriver(cli);

  // Custom MCP servers (two tier maps → merged per-CLI map). Authoritative order
  // (see mcp-secret-resolver.js): compute survivors (project overrides global by
  // name) → extract refs from survivors only → flat-env collision guard →
  // resolve each tier's refs against its own SSM prefix (fail closed) → merge.
  // The merged map keeps `${VAR}` verbatim; the resolved values go into the child
  // env (below) where the CLI natively expands them — never onto the config file.
  const { survivingGlobal, survivingProject } = computeSurvivors(
    mcpServersByTier?.global ?? {},
    mcpServersByTier?.project ?? {},
  );
  const { globalPath, projectPath } = mcpSecretPaths({ projectId });
  let mcpSecretEnv = {};
  try {
    ({ secretEnv: mcpSecretEnv } = await resolveMcpSecrets({
      survivingGlobal,
      survivingProject,
      globalPath,
      projectPath,
    }));
  } catch (e) {
    // Fail closed: a collision or an unset referenced secret aborts the stage
    // with a clear, actionable error (never a silent drop / a generic CLI 401).
    logger.error('mcp secret resolution failed', e);
    return fail(stageInstanceId, 'mcp_secret_error', e.message);
  }
  const customServers = {
    ...toMcpServerMap(survivingGlobal),
    ...toMcpServerMap(survivingProject),
  };

  // Materialize only the selected CLI's MCP context. OpenCode receives inline
  // config so repository AGENTS.md/.opencode files remain untouched.
  const materializeCliMcp = async () => {
    if (cli === 'kiro') {
      const agentName = await materializeKiroAgent({
        workspaceDir,
        mcpEntry,
        scope: stageScope,
        env,
        customServers,
      });
      return { agentName };
    }
    if (cli === 'opencode') {
      const opencodeConfigContent = await materializeOpenCodeConfig({
        workspaceDir,
        mcpEntry,
        scope: stageScope,
        env,
        customServers,
      });
      return { opencodeConfigContent };
    }
    if (cli === 'codex') {
      codexHome = await materializeCodexHome({
        workspaceDir,
        mcpEntry,
        scope: stageScope,
        env,
        customServers,
        // Embedded `${VAR}` refs (e.g. `Bearer ${KEY}`) resolve against the
        // SSM-resolved secret env; full-value refs are forwarded by NAME via
        // codex's env_vars/env_http_headers and expand from the child env.
        secretEnv: mcpSecretEnv,
        // A true resume already restored the selected rollout into this home.
        reset: !codexHomePrepared,
      });
      codexHomePrepared = true;
      return { codexHome };
    }
    const mcpConfigPath = await materializeMcpConfig({
      workspaceDir,
      mcpEntry,
      scope: stageScope,
      env,
      customServers,
    });
    return { mcpConfigPath };
  };

  // Native ensemble sessions: the authored `pipeline` / `mob`
  // / `subagent`-with-supports topology becomes REAL per-persona sessions instead
  // of one agent role-playing everybody. Resolved on BOTH the fresh and resume
  // legs, because a resume after a mid-ensemble park has to know the topology to
  // skip the personas that already produced their evidence. Null => the stage
  // keeps today's single-session behaviour, byte for byte (non-release mode,
  // `V2_ENSEMBLE_SESSIONS=off`, or a mode that resolves no support persona).
  //
  // Release mode normally fails closed on a body read, but a support persona is
  // ADDITIVE steering rather than the stage's own instructions: degrading to the
  // single-session path preserves the behavior of existing stage execution,
  // which is the conservative choice this whole block is written for.
  let ensemble = null;
  // The lead's persona body, reused verbatim for its integration session. Set on
  // the fresh leg where the prompt is materialized; re-read on a resume leg,
  // which never materializes a prompt at all.
  let leadPersonaBody = null;
  try {
    ensemble = await resolveEnsembleTopology({
      stage,
      library,
      loadBlockBody: loadBody,
      methodologyRelease,
      env,
    });
  } catch (error) {
    const detail = `Ensemble topology could not be resolved for ${stageId}: ${
      error?.message ?? String(error)
    }`;
    if (methodologyRelease) {
      return fail(stageInstanceId, 'ensemble_topology_unresolved', detail, { clearPending: true });
    }
    await store
      .appendEvent({
        executionId,
        type: 'v2.persona.gap',
        stageInstanceId,
        unitSlug,
        sectionIndex,
        actor: 'agentcore',
        summary: `${detail}; continuing with the single-session ensemble prompt`,
        detail: { mode: stage.mode, role: 'ensemble', reason: 'topology_unresolved' },
      })
      .catch(() => {});
  }

  let invocation;
  let prompt = null;
  if (!freshRun) {
    const mcpKwargs = await materializeCliMcp();
    // The resume message = the human's answer, plus any pending steering (a
    // course correction riding the answer, or revisions queued while parked).
    invocation = driver.buildResumeInvocation({
      sessionId: cliSessionId,
      answerMessage: [resumeAnswer, steeringMessage].filter(Boolean).join('\n\n'),
      model,
      ...mcpKwargs,
    });
  } else {
    const stageBlock = library.stagesById[stageId] ?? {};
    // Release mode does NOT swallow a body failure: the whole point of a pinned
    // release is that its bytes are the ones that run, so a missing, unreadable,
    // or digest-mismatched stage/agent body fails the stage instead of degrading
    // to '' and running the agent on a prompt with no instructions or persona.
    // Legacy mode keeps its lenient behaviour.
    const loadPromptBody = methodologyRelease
      ? loadBody
      : (block) => loadBody(block).catch(() => '');
    const conductorLoad = methodologyRelease
      ? loadConductor(null, { methodologyRelease }).then(
          (content) => ({ content }),
          (error) => ({ error }),
        )
      : loadConductor(aidlcRepoRef || env.AIDLC_REPO_REF)
          .catch(() => '')
          .then((content) => ({ content }));
    let bodies;
    try {
      bodies = await Promise.all([
        loadPromptBody(stageBlock),
        agentBlock ? loadPromptBody(agentBlock) : Promise.resolve(''),
        conductorLoad,
        loadSupportAgents({
          stage,
          library,
          loadBlockBody: loadPromptBody,
          modes: ensemble || !methodologyRelease ? [] : ENSEMBLE_MODES,
        }),
      ]);
    } catch (error) {
      return fail(stageInstanceId, 'methodology_body_unavailable', error?.message ?? String(error));
    }
    const [stageBody, agentPersona, conductorResult, supportAgents] = bodies;
    leadPersonaBody = agentPersona;
    if (conductorResult.error) {
      return fail(stageInstanceId, 'conductor_unavailable', conductorResult.error.message);
    }
    const conductor = conductorResult.content;
    // Knowledge has two tiers: the authored methodology (library blocks) and the
    // project's accrued team knowledge (already read from Neptune above). Both are
    // injected into the prompt so the agent always receives them; the team tier is
    // also re-readable on demand via the get_team_knowledge MCP tool.
    let methodology;
    try {
      methodology = await loadMethodologyKnowledge({
        agentRef: stage.agentRef,
        library,
        loadBlockBody: loadBody,
        methodologyRelease,
      });
    } catch (error) {
      return fail(stageInstanceId, 'methodology_body_unavailable', error?.message ?? String(error));
    }
    const knowledge = composeKnowledge(methodology, memory.teamKnowledge);

    // Resolve rule bodies for the steering doc. A merged learning rule carries its
    // text inline (`body`, from Neptune); an authored library rule resolves its
    // body from S3 via its bodyRef. Prefer the inline body when present.
    const ruleIds = [...(stage.rules?.universal ?? []), ...(stage.rules?.phase ?? [])];
    const ruleBodyEntries = await Promise.all(
      ruleIds.map(async (id) => {
        const ruleBlock = library.rulesById[id] ?? {};
        const body =
          typeof ruleBlock.body === 'string' && ruleBlock.body
            ? ruleBlock.body
            : await loadPromptBody(ruleBlock);
        return [id, body];
      }),
    );
    const rulesDoc = renderRulesDoc(stage, Object.fromEntries(ruleBodyEntries));

    // The intent's originating request lives on the META row, snapshotted at
    // intent create. Read it here and inject it into every fresh stage prompt
    // so agents do not have to ask the human what the run is about.
    const intentMeta = await store.getExecution(executionId).catch(() => null);
    let compiledContext = '';
    if (openGraph) {
      let gContext;
      try {
        gContext = await openGraph();
        const contextGraph = createGraphWriter({
          g: gContext,
          scope: { projectId, intentId, executionId, stageInstanceId },
        });
        const pack = await compileContextPack({ graph: contextGraph, stage, unit });
        compiledContext = pack.markdown ?? '';
      } catch (e) {
        compiledContext = `## Compiled graph context\n\n- Context compiler unavailable: ${e.message}`;
      } finally {
        await closeGraphSource(gContext);
      }
    }

    // Custom agent rules: fetch bodies from S3, then the materializer writes
    // them into the selected CLI's native rules dir (the CLI auto-loads them).
    const customRuleDocs = await fetchCustomRules({ customRules, env }).catch(() => []);

    const materialized = await materializeStage({
      workspaceDir,
      stage,
      // Unit lane: the unit-scope block restricts the agent to THIS unit's
      // stories/components (null outside a lane — no block rendered).
      unit,
      intent: intentMeta
        ? { title: intentMeta.title, prompt: intentMeta.prompt, scope }
        : { scope },
      stageBody,
      agentPersona,
      supportAgents,
      methodologyRelease,
      knowledge,
      conductor,
      compiledContext,
      rulesDoc,
      mcpEntry,
      scope: stageScope,
      env,
      customServers,
      // Codex only: embedded `${VAR}` refs in custom-server config resolve
      // against the SSM-resolved secret env (see materializeCliMcp above).
      secretEnv: mcpSecretEnv,
      cli,
      customRules: customRuleDocs,
      attachments: attachmentRefs,
      maxTurns: agentBlock?.maxTurns ?? null,
    });
    prompt = materialized.prompt;
    // Native ensemble sessions: the lead's own role in the topology, appended
    // where the single-session ensemble protocol would otherwise have rendered
    // (`supportAgents` was passed empty above, so that block rendered nothing).
    // Appended rather than woven in so the off-path prompt is untouched.
    if (ensemble) {
      prompt = `${prompt}\n\n${renderLeadTopologyBrief(ensemble)}`;
    }
    // Demoted resume (D2): the parked conversation was lost with the wiped mount,
    // so we re-run the stage fresh — but prepend the human's already-given answer
    // so the agent applies it instead of re-asking the same question.
    if (demotedResume && resumeAnswer) {
      prompt = `## Previously answered\n${resumeAnswer}\n\n---\n\n${prompt}`;
    }
    // Steering: prepend pending human course corrections (rewind guidance /
    // revisions) so they lead the fresh conversation — they override anything
    // the stage body would otherwise have the agent do first.
    if (steeringMessage) {
      prompt = `${steeringMessage}\n\n---\n\n${prompt}`;
    }
    // Change control (§6.3): the changed approved inputs lead the prompt, because
    // reading a stale remembered version of one is the failure the field exists
    // to prevent.
    if (changeControlMessage) {
      prompt = `${changeControlMessage}\n\n---\n\n${prompt}`;
    }
    // The stage materializer already created only the selected CLI's context;
    // pick it up via the driver's contextKey. Older injected test materializers
    // may return just the prompt, so retain a fallback through the shared
    // context helper.
    const mcpKwargs = materialized[driver.contextKey]
      ? { [driver.contextKey]: materialized[driver.contextKey] }
      : await materializeCliMcp();
    if (cli === 'codex' && materialized.codexHome) {
      codexHome = materialized.codexHome;
      codexHomePrepared = true;
    }
    invocation = driver.buildInvocation({
      prompt,
      model,
      allowedTools: [],
      sessionId: cliSessionId,
      ...mcpKwargs,
    });

    // Prompt-size sample — the WRITE side of the context-efficiency ledger.
    // The read ledger measures what agents pull; this measures what we push:
    // total materialized prompt bytes and the compiled-graph-context share of
    // them. The audit joins both to answer "does the graph context pay for
    // itself". Fresh runs only (a resume sends just the answer). Best-effort.
    await store
      .recordMetric?.({
        executionId,
        stageInstanceId,
        unitSlug,
        sectionIndex,
        metrics: {
          promptBytes: Buffer.byteLength(prompt, 'utf8'),
          compiledContextBytes: Buffer.byteLength(compiledContext ?? '', 'utf8'),
        },
        resolvedModel: model ?? null,
      })
      .catch(() => {});
  }

  // Kiro store handling for a RESUME is done in step 2b (restore + the D2 wiped-
  // mount decision) so a lost parked conversation is recovered, not run blind. For
  // a plain FRESH Kiro run we still restore the durable store here: Kiro keeps ALL
  // conversations in one SQLite DB and persistKiroStore does rm+cp at exit, so
  // without a prior restore this run would clobber sibling stages' conversations on
  // the mount. A missing store is fine (Kiro just starts new). Skip for a demoted
  // resume — its mount was wiped, so there is nothing to restore.
  if (freshRun && !demotedResume && cli === 'kiro') {
    const restored = await restoreKiroStore({ env }).catch(() => false);
    if (!restored) logger.error('kiro store not restored (fresh)', { stageInstanceId });
  }

  // 4. Spawn the headless CLI.
  // Package-manager caches and scratch files must NOT land on the session
  // mount — it is a fixed 1 GiB (AgentCore offers no larger size) and the
  // 2026-07 incident filled it with npm state until the engine commit ENOSPC'd.
  // Container-local /tmp is ephemeral but plentiful; the working tree (the
  // durable part) stays on the mount. Driver/invocation env still wins. The MCP
  // secret env (resolved `${VAR}` values) is injected here so the CLI expands the
  // `${VAR}` tokens in the (on-disk) MCP config from the child env — the literal
  // secret never touches the config file. An MCP `${VAR}` can NEVER be a reserved
  // runtime key (auth/AWS creds/cache): the resolver fails closed on such names
  // (mcp-secret-resolver RESERVED_MCP_ENV_KEYS), so mcpSecretEnv and the auth env
  // below are disjoint by construction. Auth env is still spread LAST as
  // defense-in-depth — even a resolver bug cannot let an MCP value shadow the
  // selected credential. The generated custom stdio server definitions override
  // every model-auth variable with an empty value, so those children do NOT
  // inherit the selected user's token. Resolved custom MCP secrets remain a flat
  // namespace shared by custom stdio servers; see mcp-secret-resolver.js.
  const childEnv = {
    ...OFF_MOUNT_CACHE_ENV,
    ...mcpSecretEnv,
    ...invocation.env,
    ...driver.envForAuth(env),
  };
  // Disk preflight — a nearly-full mount is loud BEFORE the CLI burns tokens.
  await warnIfDiskLow('before the agent run');
  let result;
  let outputQueue = Promise.resolve();
  const emitCliOutput = ({ content, display }) => {
    if (!content) return;
    outputQueue = outputQueue
      .then(async () => {
        const row = await store.appendOutput({
          executionId,
          stageInstanceId,
          unitSlug,
          sectionIndex,
          kind: 'stdout',
          content,
          display,
        });
        await publish({
          action: 'agent.output',
          stageInstanceId,
          unitSlug,
          sectionIndex,
          seq: row.seq,
          kind: 'stdout',
          content,
          timestamp: row.timestamp,
          ...(display ? { display } : {}),
        });
      })
      .catch(() => {});
  };
  let sessionUpdateQueue = Promise.resolve();
  const cliOutput = createCliOutputSink({
    cli,
    emit: emitCliOutput,
    onSession: (observedSessionId) => {
      // OpenCode and Codex choose their own session/thread id; capture the
      // first one observed on the stream so a later resume can target it.
      if ((cli !== 'opencode' && cli !== 'codex') || cliSessionId) return;
      cliSessionId = observedSessionId;
      // Persist the first id immediately; the queue is awaited before the park
      // check so a WAITING row can never be written ahead of its resume handle.
      sessionUpdateQueue = sessionUpdateQueue
        .then(() =>
          store.updateStageState({
            executionId,
            stageInstanceId,
            state: 'RUNNING',
            cli,
            cliSessionId,
          }),
        )
        .catch(() => {});
    },
  });
  // Correlate the [spawn:size] line below to THIS stage/cli — the diagnostic for
  // the 2026-07 nfr-design E2BIG (prompt now piped on stdin; this confirms it).
  logger.info('spawning cli', {
    cli,
    stage: stageId,
    unit: unitSlug ?? '-',
    promptBytes: Buffer.byteLength(prompt ?? invocation.prompt ?? '', 'utf8'),
    promptViaStdin: invocation.promptViaStdin,
    argc: invocation.args.length,
  });
  const spawnCli = () =>
    runChild({
      command: invocation.command,
      args: invocation.args,
      env: childEnv,
      cwd: workspaceDir,
      // Fresh runs materialize `prompt` locally; a resume carries it on the
      // invocation (the answer message). Either way the prompt is piped on stdin
      // (promptViaStdin) — never on argv, which would overflow ARG_MAX (E2BIG).
      prompt: prompt ?? invocation.prompt,
      promptViaStdin: invocation.promptViaStdin,
      // Keep a bounded stderr tail for typed failure classification. runChild
      // still tees stderr to the container log; the captured value is never
      // persisted verbatim.
      captureStderrTail: 16_384,
      onStdout: (chunk) => cliOutput.write(chunk),
      spawnFn,
    });
  let spawnError = null;
  try {
    result =
      cli === 'opencode'
        ? await withOpenCodeStore({
            env,
            operation: spawnCli,
            restore: restoreOpenCodeStore,
            persist: persistOpenCodeStore,
          })
        : await spawnCli();
  } catch (e) {
    spawnError = e;
  }
  cliOutput.flush();
  await outputQueue;
  await sessionUpdateQueue;

  // Codex runs entirely against local disk. Once stdout has been drained (and
  // therefore the thread id captured), persist only that thread's rollout.
  // This also runs after a thrown spawn so an already-started/resumed thread is
  // not lost merely because the child failed while shutting down.
  let codexPersistResult = null;
  let codexStoreConfigured = false;
  if (cli === 'codex') {
    codexHome = codexHome ?? invocation.env?.CODEX_HOME ?? null;
    if (cliSessionId && codexHome) {
      try {
        const persisted = await persistCodexRollout({
          threadId: cliSessionId,
          codexHome,
          env,
        });
        codexPersistResult =
          persisted === true
            ? { ok: true, status: 'persisted' }
            : persisted === false
              ? { ok: false, status: 'persist_failed' }
              : persisted;
      } catch (error) {
        codexPersistResult = {
          ok: false,
          status: 'persist_failed',
          error: { code: error?.code ?? null, message: error?.message ?? String(error) },
        };
      }
    } else {
      codexPersistResult = {
        ok: false,
        status: cliSessionId ? 'home_missing' : 'session_missing',
      };
    }

    codexStoreConfigured = Boolean(resolveCodexStore({ env, codexHome }));
    if (
      codexStoreConfigured &&
      !codexPersistResult?.ok &&
      codexPersistResult?.status !== 'unconfigured'
    ) {
      const detail = `${codexPersistResult?.status ?? 'persist_failed'}${
        codexPersistResult?.error?.code ? ` (${codexPersistResult.error.code})` : ''
      }`;
      logger.error('codex rollout not persisted', {
        stage: stageInstanceId,
        thread: cliSessionId ?? '-',
        status: detail,
      });
      await store
        .appendEvent({
          executionId,
          type: 'v2.codex.store_persist_failed',
          stageInstanceId,
          unitSlug,
          sectionIndex,
          actor: 'agentcore',
          summary: `Codex rollout persistence failed (${detail})`,
        })
        .catch(() => {});
    }
    await cleanupCodexHome({ codexHome, env }).catch(() => false);
  }

  if (spawnError) {
    // Log the failure at the catch point — fail() only records it to DynamoDB
    // (the UI's cli_error), never to the container log. This makes the E2BIG (or
    // any spawn failure) visible + attributable to THIS stage/cli.
    logger.error('cli_error', {
      cli,
      stage: stageId,
      unit: unitSlug ?? '-',
      code: spawnError?.code ?? '-',
      msg: spawnError?.message,
    });
    if (spawnError?.stack) logger.error(spawnError.stack);
    return fail(stageInstanceId, 'cli_error', spawnError.message);
  }

  const exitCode = result?.exitCode ?? 0;
  logger.error('cli exit', {
    cli,
    stage: stageId,
    exitCode,
    model: model ?? '(default)',
  });

  // Kiro only: persist the live local store back to the durable mount after the
  // run. Runs on ANY exit (success, park, or crash) so a parked conversation is
  // captured even if the CLI later errored. Best-effort — a failed persist never
  // fails the stage, but a parked conversation then won't survive a reap, so log it.
  if (cli === 'kiro') {
    const persisted = await persistKiroStore({ env }).catch(() => false);
    if (!persisted) {
      logger.error('kiro store not persisted', { stageInstanceId });
    }
  }

  // Kiro only: record the run's credit spend. kiro-cli prints a per-turn footer
  // on stderr (`▸ Credits: 0.03 • Time: 2s`) which runChild already tees into
  // stderrTail for the benign-crash check — scrape it and record a `credits`
  // metric sample, stamped with the trusted model AND the $/credit overage rate
  // (from `/usage`, cached per container) so the read path can price it as an
  // ESTIMATE (Kiro is credit-based; in-plan credits are covered by the plan).
  // Runs on ANY exit — a parked or crashed turn still spent its credits. Best-
  // effort: no credits footer / no rate never affects the stage outcome.
  if (cli === 'kiro') {
    try {
      const credits = parseKiroCredits(result?.stderrTail);
      if (credits != null && credits > 0) {
        const creditRate = await captureKiroCreditRate({
          env,
          driver,
          workspaceDir,
          spawnFn,
        }).catch(() => null);
        const row = await store.recordMetric({
          executionId,
          stageInstanceId,
          unitSlug,
          sectionIndex,
          metrics: { credits },
          resolvedModel: model ?? null,
          creditRate,
        });
        // Live-parity with the bridge's collect_metric broadcast so the UI can
        // refresh usage without waiting for the next full DTO fetch.
        await publish({
          action: 'agent.metric',
          stageInstanceId,
          unitSlug,
          sectionIndex,
          metricId: row.metricId,
          metrics: { credits },
        });
      }
    } catch (e) {
      logger.error('kiro credits not recorded', e, { stageInstanceId });
    }
  }

  // Kiro has no start-time session-id flag — capture the id it created so a later
  // resume can target the SAME conversation. Runs on ANY exit: a Kiro run can park
  // a question and THEN exit non-zero (e.g. a transient model error on the turn
  // after ask_question), and a parked stage still needs its session linked or
  // resume can't find it. A demoted resume is a fresh Kiro conversation, so it also
  // needs capture. Best-effort — a failed capture leaves cliSessionId null.
  if (freshRun && cli === 'kiro') {
    const captured = await captureKiroSession({ env, driver, workspaceDir, spawnFn }).catch(
      () => null,
    );
    if (captured) {
      cliSessionId = captured;
      await store
        .updateStageState({ executionId, stageInstanceId, state: 'RUNNING', cli, cliSessionId })
        .catch(() => {});
    }
  }

  // ── Native ensemble sessions ───────────────────────────────────────────────
  // ONE call point. The lead's session has fully wound down (its CLI store is
  // persisted, its session id captured), and the engine commit has NOT run yet —
  // so every persona's work, whether it lands in the graph or in the working
  // tree, is captured by the single commit below.
  //
  // Skipped when the lead parked (the human owes it an answer before anybody
  // enriches its draft) or when the lead did not finish cleanly. Session budget:
  // these are sequential dispatchPersona sessions, exactly like the reviewer loop
  // below, so they ride the SAME liveness mechanism — run-stage-start's
  // background job with its 60s heartbeats, which is what keeps a long stage
  // distinguishable from a dead container. The heartbeat cannot stop the runtime's
  // max_lifetime kill, though, so the whole topology runs against the stage's
  // aggregate deadline (`stageDeadlineMs`): a persona past it becomes a GAP.
  let ensembleEvidence = null;
  let stageFindings = [];
  if (ensemble) {
    const leadParked = await pendingGate({
      store,
      executionId,
      stageInstanceId,
      unitSlug,
      sectionIndex,
    });
    const leadFinished =
      exitCode === 0 || (cli === 'kiro' && isBenignKiroEmptyCompletion(result?.stderrTail));
    if (leadParked || !leadFinished) {
      await store
        .appendEvent({
          executionId,
          type: 'v2.persona.gap',
          stageInstanceId,
          unitSlug,
          sectionIndex,
          actor: 'agentcore',
          summary: `Ensemble sessions ${
            leadParked ? 'deferred until the lead resumes' : 'skipped'
          } for ${stageId}: the lead session ${
            leadParked ? 'parked on a question' : `exited ${exitCode}`
          } before its draft was complete`,
          detail: {
            mode: ensemble.mode,
            role: 'ensemble',
            reason: leadParked ? 'lead_parked' : 'lead_incomplete',
          },
        })
        .catch(() => {});
    } else {
      const stageRow = await store.getStage?.(executionId, stageInstanceId).catch(() => null);
      const attempt = Number(stageRow?.attempt ?? 0);
      const leadPersona =
        leadPersonaBody ?? (agentBlock ? await loadBody(agentBlock).catch(() => '') : '');
      const dispatchContext = {
        stageId,
        stageAttempt: attempt,
        cli,
        cliModels,
        tierModels,
        env,
        workspaceDir,
        spawnFn,
        mcpEntry,
        materializeMcpConfig,
        materializeKiroAgent,
        materializeOpenCodeConfig,
        materializeCodexHome,
        cleanupCodexHome,
        withOpenCodeStore,
        ids,
      };
      const personaScope = { policy: stage.policy ?? null, checkpointOwner: false };
      // The graph is the evidence channel: a support's contribution counts only
      // when the row is actually there (upstream §3.6 — artifacts alone never
      // satisfy, and neither does a session that exited 0 writing nothing). With
      // no graph we can observe nothing, which honestly reads as "no evidence"
      // and reaches the human as an advisory finding, never as a failure.
      // `systemWriter` marks this as the PLATFORM's writer: the only one allowed
      // to record a gap stub for another persona's contribution.
      const withGraph = async (operation, fallback) => {
        if (!openGraph) return fallback;
        let g = null;
        try {
          g = await openGraph();
          return await operation(
            createGraphWriter({
              g,
              scope: {
                projectId,
                intentId,
                executionId,
                stageInstanceId,
                unitSlug,
                sectionIndex,
                systemWriter: true,
              },
            }),
          );
        } catch {
          return fallback;
        } finally {
          await closeGraphSource(g);
        }
      };
      // The module is written never to throw (every internal surprise degrades to a
      // gap). This is the floor UNDER that: if it ever does, the stage still
      // SUCCEEDS with the same advisory findings naming every persona, because
      // these stages already run under the single-session approximation and a
      // regression here must not block a real intent.
      let ensembleResult = null;
      try {
        ensembleResult = await runEnsembleSessions({
          topology: ensemble,
          stage,
          unit,
          policy: stage.policy ?? null,
          personaScope,
          attempt,
          resumeAnswer,
          lead: { persona: leadPersona, block: agentBlock },
          dispatchContext,
          knowledgeFor: (agentRef) =>
            loadMethodologyKnowledge({
              agentRef,
              library,
              loadBlockBody: loadBody,
              methodologyRelease,
            }),
          readContributions: () =>
            withGraph(
              (writer) =>
                writer.lookupArtifacts({ artifactType: 'contribution', includeContent: true }),
              [],
            ),
          // The link/integrator evidence channel: the current rows of every declared
          // output. Compact (no bodies) — the runner only fingerprints them.
          readStageOutputs: () =>
            withGraph(async (writer) => {
              const rows = [];
              for (const artifactType of (stage.outputArtifacts ?? [])
                .map((output) => output?.artifact ?? output)
                .filter(Boolean)) {
                rows.push(...(await writer.lookupArtifacts({ artifactType }).catch(() => [])));
              }
              return rows;
            }, []),
          writeGapStub: ({ agentRef, reason }) =>
            withGraph(
              (writer) =>
                writer.createArtifact({
                  artifactType: 'contribution',
                  id: contributionArtifactId({ stageId, agentRef }),
                  title: `Contribution gap: ${agentRef}`,
                  content: `**Collaborator:** ${agentRef}\n\n## Contribution\n\nNone recorded — ${reason}.\n\n## Positions\n\n(none)\n`,
                  props: { collaborator: agentRef, status: 'gap', positions: '' },
                }),
              null,
            ),
          pendingGate: () =>
            pendingGate({ store, executionId, stageInstanceId, unitSlug, sectionIndex }),
          store,
          publish,
          executionId,
          projectId,
          intentId,
          stageInstanceId,
          unitSlug,
          sectionIndex,
          deadlineMs: stageDeadlineMs,
          nowMs,
          logger,
        });
      } catch (error) {
        logger.error('ensemble sessions degraded', {
          stage: stageId,
          mode: ensemble.mode,
          msg: error?.message ?? String(error),
        });
        await store
          .appendEvent({
            executionId,
            type: 'v2.persona.gap',
            stageInstanceId,
            unitSlug,
            sectionIndex,
            actor: 'agentcore',
            summary: `Ensemble sessions failed for ${stageId}: ${error?.message ?? String(error)}`,
            detail: {
              mode: ensemble.mode,
              role: 'ensemble',
              reason: 'ensemble_error',
              attempt,
            },
          })
          .catch(() => {});
        stageFindings = mergeFindings(
          stageFindings,
          ensembleGapFindings({
            stage,
            policy: stage.policy ?? null,
            attempt,
            topology: ensemble,
            reason: `ensemble sessions failed: ${error?.message ?? String(error)}`,
          }),
        );
      }
      if (ensembleResult) {
        ensembleEvidence = ensembleResult.ensembleEvidence;
        stageFindings = mergeFindings(stageFindings, ensembleResult.findings);
      }
    }
  }

  // Engine-owned git (docs/v2-parallel.md WP2): commit + push the working tree
  // after EVERY CLI exit — success, park, or failure — so no work ever exists
  // only on the wipeable session mount (the documented v2 loss mode: the mount
  // is wiped on redeploy/idle and self-heal re-clones the pristine remote).
  // The agent holds no credentials and never commits; this is the single place
  // tree state becomes durable. Sensors below inspect the same tree, so a
  // sensor hold AFTER the push is fine — the pushed commit preserves the work
  // for the retry. Artifact-only stages leave the tree clean (no commit, no
  // network). NEVER throws — failures are values recorded below.
  await warnIfDiskLow('before the engine commit');
  let reviewTargetCheck = null;
  if (reviewFeedbackTargets.length > 0) {
    try {
      reviewTargetCheck = await recheckReviewTargets({
        targets: reviewFeedbackTargets,
        projectId,
        gitProvider,
        repoProviders,
      });
      const changed = reviewTargetCheck.filter(
        (row) =>
          row.headMoved ||
          row.targetMoved ||
          row.status?.state === 'merged' ||
          row.status?.state === 'closed',
      );
      if (changed.length > 0) {
        await store
          .appendEvent({
            executionId,
            type: 'v2.feedback.provider_moved_before_push',
            stageInstanceId,
            unitSlug,
            sectionIndex,
            actor: 'agentcore',
            summary: changed
              .map(
                (row) =>
                  `${row.repoId} (${row.status?.state ?? 'unknown'}${
                    row.headMoved ? ', head moved' : ''
                  }${row.targetMoved ? ', target moved' : ''})`,
              )
              .join('; '),
          })
          .catch(() => {});
      }
    } catch (error) {
      await store
        .appendEvent({
          executionId,
          type: 'v2.feedback.provider_recheck_failed',
          stageInstanceId,
          unitSlug,
          sectionIndex,
          actor: 'agentcore',
          summary: error?.message ?? String(error),
        })
        .catch(() => {});
    }
  }
  const gitResult = await commitAndPushAll({
    repos,
    workspaceDir,
    branch,
    gitProvider,
    repoProviders,
    projectId,
    executionId,
    author: gitAuthor,
    // Commit message carries the unit dimension on lane runs (docs/v2-parallel.md
    // A3): every commit is attributable to stage + lane + execution from git alone.
    message: unitSlug
      ? `aidlc(${stageId}): ${unitSlug} — ${executionId}`
      : `aidlc(${stageId}): ${executionId}`,
  });
  const stageCodeCommitRefs = mergeCodeCommitRefs(carriedCodeCommitRefs, gitResult);
  retainedCodeCommitRefs = stageCodeCommitRefs.length ? stageCodeCommitRefs : null;
  if (gitResult.committed || !gitResult.ok) {
    const failedRepos = gitResult.results
      .filter((r) => r.pushed !== true && r.pushed !== 'empty' && r.pushed !== 'up_to_date')
      // Carry the git stderr into the event — the 2026-07 incident's ENOSPC
      // root cause was invisible because only the reason label was recorded.
      .map(
        (r) =>
          `${r.repo} (${r.reason ?? 'unknown'}${r.detail ? `: ${String(r.detail).slice(0, 300)}` : ''})`,
      );
    const gitSummary = gitResult.ok
      ? `Engine committed + pushed work for ${stageLabel} (${gitResult.results
          .filter((r) => r.committed)
          .map((r) => `${r.repo}@${(r.sha ?? '').slice(0, 8)}`)
          .join(', ')})`
      : `Engine push failed for ${stageLabel}: ${failedRepos.join(', ')}`;
    await store
      .appendEvent({
        executionId,
        type: gitResult.ok ? 'v2.git.pushed' : 'v2.git.push_failed',
        stageInstanceId,
        unitSlug,
        sectionIndex,
        actor: 'agentcore',
        summary: gitSummary,
      })
      .catch(() => {});
    // Surface a push failure live (agent.note is the timeline-note action the
    // UI already routes) — the user must see git trouble at stage N, not after
    // the whole run has burned its tokens.
    if (!gitResult.ok) {
      await publish({
        action: 'agent.note',
        noteType: 'v2.git.push_failed',
        stageInstanceId,
        unitSlug,
        sectionIndex,
        summary: gitSummary,
      });
    }
  }

  const parkStage = async (parked) => {
    if ((cli === 'opencode' || cli === 'codex') && !cliSessionId) {
      return fail(
        stageInstanceId,
        `${cli}_session_missing`,
        `${cli === 'codex' ? 'Codex' : 'OpenCode'} parked the stage without emitting a session id; the conversation cannot be resumed`,
      );
    }
    if (cli === 'codex' && codexStoreConfigured && !codexPersistResult?.ok) {
      await (store.supersedeHumanTask?.({
        executionId,
        humanTaskId: parked.humanTaskId,
        supersededBy: 'codex_store_persist_failed',
      }) ?? Promise.resolve());
      if (!unitSlug) {
        await store
          .updateExecution({
            executionId,
            pendingHumanTaskId: null,
          })
          .catch(() => {});
      }
      return fail(
        stageInstanceId,
        'codex_store_persist_failed',
        'Codex parked the stage, but its rollout could not be written to durable storage',
        { clearPending: true },
      );
    }
    await store
      .updateStageState({
        executionId,
        stageInstanceId,
        state: 'WAITING_FOR_HUMAN',
        pendingHumanTaskId: parked.humanTaskId,
        // Human-wait accounting: the wait started when the question was ASKED
        // (the bridge stamped it then); re-stamp with the gate's createdAt so
        // this exit-time write never shortens the window (and covers a failed
        // bridge stamp). resumeStageRow folds it into waitMs on resume.
        parkedAt: parked.createdAt ?? true,
        cli,
        cliSessionId,
        pendingCodeCommitRefs: stageCodeCommitRefs.length ? stageCodeCommitRefs : null,
      })
      .catch(() => {});
    await store.appendEvent({
      executionId,
      type: 'v2.stage.parked',
      stageInstanceId,
      unitSlug,
      sectionIndex,
      actor: 'agentcore',
      summary: `Stage ${stageLabel} parked on question ${parked.humanTaskId}`,
    });
    await publish({
      action: 'agent.stage',
      stageInstanceId,
      stageId,
      unitSlug,
      sectionIndex,
      state: 'WAITING_FOR_HUMAN',
    });
    return {
      ok: true,
      state: 'WAITING_FOR_HUMAN',
      stageInstanceId,
      unitSlug,
      sectionIndex,
      humanTaskId: parked.humanTaskId,
      cliSessionId,
      cli,
    };
  };

  // Check the durable park marker before any completion work. An answer that
  // lands after the bridge parks but before the CLI exits still belongs to the
  // orchestrator's resume callback; only an inline answer clears the marker.
  const parked = await ownedGateAtExit({
    store,
    executionId,
    stageInstanceId,
    unitSlug,
    sectionIndex,
  });
  if (parked) return parkStage(parked);

  // A clean exit OR a non-zero exit AFTER parking means "waiting on a human".
  // Check the park marker before treating a non-zero exit as failure so a run
  // that parks and then errors on its next turn still parks rather than fails.
  if (exitCode !== 0) {
    // Kiro's benign empty-final-completion crash: the turn's work completed, the
    // agent just ended without closing text and kiro-cli's ACP rejected the empty
    // message. Treat as success (not a stage failure) but record a note so the
    // signature stays visible. Sensors below still run and can hold the stage.
    if (cli === 'kiro' && isBenignKiroEmptyCompletion(result?.stderrTail)) {
      logger.error('kiro empty-completion (benign); treating as success', {
        stage: stageId,
        exitCode,
      });
      await store
        .appendEvent({
          executionId,
          type: 'v2.stage.note',
          stageInstanceId,
          unitSlug,
          sectionIndex,
          actor: 'agentcore',
          summary: `Kiro exited ${exitCode} with an empty final message after completing work; treated as success (ACP empty-completion).`,
        })
        .catch(() => {});
    } else if (isCredentialFailure(result?.stderrTail)) {
      const detail =
        credentialFailureDetail({
          binding: credentialBindingForCli(credentialBindings, cli),
          state: 'rejected',
        }) ??
        'The pinned agent credential was rejected; rotate it at the selected credential scope';
      return fail(stageInstanceId, 'credential_invalid', detail);
    } else {
      return fail(stageInstanceId, 'cli_nonzero_exit', String(exitCode));
    }
  }
  // A previous durable rollout may still exist after an atomic replace fails.
  // Clear the handle on an otherwise successful leg so later review feedback
  // demotes to fresh instead of resuming that stale transcript.
  if (cli === 'codex' && codexStoreConfigured && !codexPersistResult?.ok) {
    cliSessionId = null;
  }

  // WP2 policy (extended after the 2026-07 "no changes" incident): a git
  // failure fails the stage whenever NEW WORK IS AT RISK —
  //   (a) THIS run created commits that never reached the remote (the commit
  //       stays in the local tree for the retry), OR
  //   (b) the working tree holds uncommitted changes the engine could not
  //       commit (add/commit failed on a dirty tree — e.g. an ENOSPC'd mount;
  //       previously this sailed through because `committed` was false and the
  //       run finished "successfully" with zero durable work), OR
  //   (c) the engine crashed, leaving durability UNKNOWN — unknown must fail
  //       loud, not pass silent.
  // Pre-existing unpushed state without new work (e.g. a token-less project
  // whose stages only write graph artifacts) was recorded as a
  // v2.git.push_failed event above but does not change stage behavior.
  // A parked stage (above) parks regardless — the human loop must not be
  // blocked by a push outage; the resume leg retries the push.
  const atRiskRepos = gitResult.ok
    ? []
    : gitResult.results.filter(
        (r) =>
          (r.committed === true &&
            r.pushed !== true &&
            r.pushed !== 'empty' &&
            r.pushed !== 'up_to_date') ||
          (r.committed !== true && (r.dirty === true || r.reason === 'engine_crashed')),
      );
  if (atRiskRepos.length > 0) {
    const detail = atRiskRepos
      .map(
        (r) =>
          `${r.repo}: ${r.reason ?? 'push_failed'}${r.detail ? ` — ${String(r.detail).slice(0, 300)}` : ''}`,
      )
      .join('; ');
    const uncommitted = atRiskRepos.some((r) => r.committed !== true);
    // 'push_failed' keeps its v1 meaning (commit exists, push did not land);
    // 'git_commit_failed' is the new durability failure (work never became a
    // commit at all — the loss mode the engine exists to close).
    return fail(stageInstanceId, uncommitted ? 'git_commit_failed' : 'push_failed', detail);
  }

  // The lead repair turn: re-enter the SAME conversation with one deterministic
  // message and commit whatever it rewrote. Hoisted out of the checkpoint ladder
  // because the adversarial reviewer loop needs the identical machinery between
  // NOT-READY rounds. Codex is excluded in BOTH callers: its CODEX_HOME was
  // already cleaned up above and restoring a rollout is the resume path's job. With
  // no resumable session the callers simply skip the repair rung.
  const canRepair = Boolean(cliSessionId) && cli !== 'codex';
  const runRepairTurn = canRepair
    ? async (message, { label = 'checkpoint repair' } = {}) => {
        const mcpKwargs = await materializeCliMcp();
        const repair = driver.buildResumeInvocation({
          sessionId: cliSessionId,
          answerMessage: message,
          model,
          ...mcpKwargs,
        });
        const repairSink = createCliOutputSink({ cli, emit: emitCliOutput });
        const spawnRepair = () =>
          runChild({
            command: repair.command,
            args: repair.args,
            env: { ...childEnv, ...repair.env },
            cwd: workspaceDir,
            prompt: repair.prompt,
            promptViaStdin: repair.promptViaStdin,
            captureStderrTail: 16_384,
            onStdout: (chunk) => repairSink.write(chunk),
            spawnFn,
          });
        try {
          if (cli === 'opencode') {
            await withOpenCodeStore({
              env,
              operation: spawnRepair,
              restore: restoreOpenCodeStore,
              persist: persistOpenCodeStore,
            });
          } else {
            await spawnRepair();
          }
        } finally {
          repairSink.flush();
          await outputQueue;
          if (cli === 'kiro') await persistKiroStore({ env }).catch(() => false);
        }
        // The repair turn re-saves artifacts, so the tree moved: commit it, or
        // the lineage check (and the next reviewer round) would judge the stage on
        // the pre-repair commit.
        await commitAndPushAll({
          repos,
          workspaceDir,
          branch,
          gitProvider,
          repoProviders,
          projectId,
          executionId,
          author: gitAuthor,
          message: unitSlug
            ? `aidlc(${stageId}): ${unitSlug} \u2014 ${executionId} (${label})`
            : `aidlc(${stageId}): ${executionId} (${label})`,
        }).catch(() => null);
      }
    : null;

  // 5b. Checkpoint completion ladder — the authorization boundary. Placed after
  // the agent (and its commit, which Plan Approval's lineage check reads) and
  // BEFORE the sensor pass, so a stage that never obtained its authorization never
  // burns a reviewer session. Inert without a resolved release policy.
  // Records that a repair turn was skipped because the stage budget is spent, so
  // the timeline says why the lead was not re-entered.
  const noteRepairSkipped = async (what, detail = {}) => {
    await store
      .appendEvent({
        executionId,
        type: 'v2.stage.repair_skipped',
        stageInstanceId,
        unitSlug,
        sectionIndex,
        actor: 'agentcore',
        summary: `Skipped the ${what} for ${stageLabel}: the stage wall-clock budget is spent`,
        detail: { reason: 'stage_budget_exhausted', what, ...detail },
      })
      .catch(() => {});
  };
  if (stage.policy) {
    const ladder = await runCheckpointLadder({
      store,
      executionId,
      stageInstanceId,
      unitSlug,
      sectionIndex,
      stage,
      policy: stage.policy,
      stageLabel,
      runRepairTurn,
      repairAllowed: repairBudgetLeft,
      onRepairSkipped: () => noteRepairSkipped('checkpoint repair turn'),
      pendingGate: () =>
        pendingGate({ store, executionId, stageInstanceId, unitSlug, sectionIndex }),
    });
    if (ladder.parked) return parkStage(ladder.parked);
    if (ladder.failure) {
      return fail(stageInstanceId, ladder.failure.code, ladder.failure.detail);
    }
    // ONE findings channel: the ensemble stream writes `stageFindings` too, so the
    // ladder MERGES into it rather than replacing it \u2014 a stage can carry a missing
    // authorization AND a persona gap to the same human decision.
    stageFindings = mergeFindings(stageFindings, ladder.findings);
  }

  // 6. Deterministic sensors, WRITE plane — the verification axis that runs
  // AFTER the agent and BEFORE the reviewer. Graph sensors evaluate the produced
  // artifacts' content in-process; script sensors spawn against the workspace
  // checkout. Advisory verdicts record a note and never hold; a BLOCKING sensor
  // that did not PASS fails the stage. `fire_on: gate` sensors are NOT run here
  // — the adversarial repair loop below can still rewrite artifacts, so a gate
  // verdict taken now would not be on the bytes the human approves.
  // Best-effort wiring: a sensor subsystem error never masks a successful run.
  // The list is the authored sensors PLUS the platform-injected ones (see
  // withPlatformSensors) — hence the gate checks the merged list.
  if (withPlatformSensors(stage).length > 0) {
    // `fire_on: write` sensors inspect only what THIS attempt changed, so the
    // list must be TRUSTWORTHY or absent: a partial list silently narrows the
    // sweep and turns a real finding into "no files match". It is therefore null
    // unless the git engine succeeded, reported at least one repo, and every repo
    // reported an explicit `files` array (a clean commit counts as none). Paths are projected from repo-relative
    // (git's space) into workspace-relative (the sensor glob's space).
    const gitReportedFiles =
      gitResult.ok &&
      gitResult.results.length > 0 &&
      gitResult.results.every(
        (gitChange) => Array.isArray(gitChange.files) || gitChange.reason === 'clean',
      );
    const multiRepo = repos.length > 1;
    const attemptChangedFiles = gitReportedFiles
      ? [
          ...new Set(
            gitResult.results.flatMap((gitChange) =>
              (gitChange.files ?? [])
                .map((file) =>
                  workspaceRelativePath({ repo: gitChange.repo, file, multi: multiRepo }),
                )
                .filter(Boolean),
            ),
          ),
        ].toSorted()
      : null;
    const writePlane = await runStageSensors({
      stage,
      stageInstanceId,
      unitSlug,
      sectionIndex,
      executionId,
      projectId,
      intentId,
      openGraph,
      loadBlockScript: loadScript,
      workspaceDir,
      env,
      spawnFn,
      store,
      publish,
      changedFiles: attemptChangedFiles,
      planes: ['write'],
    }).catch(() => null);
    if (writePlane?.held) {
      return fail(stageInstanceId, 'sensor_blocked', writePlane.held);
    }
  }

  let reviewAdvisory = null;
  if (stage.reviewer?.reviewerAgent) {
    const reviewerAgent = stage.reviewer.reviewerAgent;
    const reviewArtifactUnderReview = stage.reviewer.artifact ?? null;
    const reviewerBlock = library.agentsById[reviewerAgent] ?? null;
    if (!reviewerBlock) {
      return fail(stageInstanceId, 'reviewer_not_found', reviewerAgent);
    }
    // Release mode fails closed on the reviewer persona too: tampered persona
    // bytes are a tampered verdict, and '' would seat a personaless judge.
    let reviewerPersona;
    try {
      reviewerPersona = methodologyRelease
        ? await loadBody(reviewerBlock)
        : await loadBody(reviewerBlock).catch(() => '');
    } catch (error) {
      return fail(stageInstanceId, 'methodology_body_unavailable', error?.message ?? String(error));
    }
    let reviewerMethodology;
    try {
      reviewerMethodology = await loadMethodologyKnowledge({
        agentRef: reviewerAgent,
        library,
        loadBlockBody: loadBody,
        methodologyRelease,
      });
    } catch (error) {
      return fail(stageInstanceId, 'methodology_body_unavailable', error?.message ?? String(error));
    }
    // An ADVISORY reviewer (≥2.6.18 `review_class: advisory`, or an adversarial
    // stage lowered by a scope `review_cap`) runs ONE terminal pass: the plan
    // already pinned maxIterations to 1, and NOT-READY must neither fail the
    // stage nor trigger a repair round. Its findings are instead persisted
    // verbatim so the human sees them at the approval gate.
    const advisory = Boolean(stage.reviewer.advisory);
    const maxIterations = advisory
      ? 1
      : Math.max(1, Number(stage.reviewer.maxIterations ?? 1) || 1);
    let verdict = null;
    for (let round = 1; round <= maxIterations; round += 1) {
      verdict = await runReviewer({
        stage,
        unit,
        reviewerAgent,
        reviewerBlock,
        reviewerPersona,
        knowledge: reviewerMethodology,
        round,
        cli,
        cliModels,
        tierModels,
        env,
        workspaceDir,
        spawnFn,
        mcpEntry,
        materializeMcpConfig,
        materializeKiroAgent,
        materializeOpenCodeConfig,
        materializeCodexHome,
        cleanupCodexHome,
        withOpenCodeStore,
        store,
        executionId,
        projectId,
        intentId,
        stageInstanceId,
        unitSlug,
        sectionIndex,
        publish,
        ids,
      }).catch(async (e) => {
        await store
          .appendEvent({
            executionId,
            type: 'v2.review.failed',
            stageInstanceId,
            unitSlug,
            sectionIndex,
            actor: reviewerAgent,
            summary: `Reviewer ${reviewerAgent} failed: ${e.message}`,
          })
          .catch(() => {});
        return null;
      });
      const reviewerParked = await pendingGate({
        store,
        executionId,
        stageInstanceId,
        unitSlug,
        sectionIndex,
      });
      if (reviewerParked) return parkStage(reviewerParked);
      const ready = verdict?.result === 'PASS' || verdict?.detail?.verdict === 'READY';
      const notReady = verdict?.result === 'FAIL' || verdict?.detail?.verdict === 'NOT-READY';
      if (ready || !notReady) break;
      // Upstream re-reviews only AFTER the builder has answered the findings. The
      // platform's pre-existing loop re-ran the reviewer against the SAME bytes, so
      // round 2 could only repeat round 1. In release mode with a resolved policy
      // the lead is resumed once per NOT-READY round with the findings, its work is
      // committed, and only then is the reviewer re-dispatched. Bounded by the same
      // `maxIterations` as the loop itself (no repair after the final round), and
      // inert for an unpinned/2.3.3 run, whose loop stays byte-identical.
      if (!methodologyRelease || !stage.policy || !runRepairTurn || round >= maxIterations) {
        continue;
      }
      // Out of budget: re-reviewing unrepaired bytes can only repeat this verdict,
      // so the loop ends here with this round's NOT-READY as the result.
      if (!repairBudgetLeft()) {
        await noteRepairSkipped(`review repair turn after round ${round}`, {
          round,
          reviewerAgent,
        });
        break;
      }
      const reviewerFindings = String(verdict?.detail?.findings ?? '').slice(0, 8000);
      await store
        .appendEvent({
          executionId,
          type: 'v2.review.repair_requested',
          stageInstanceId,
          unitSlug,
          sectionIndex,
          actor: 'agentcore',
          summary: `Reviewer ${reviewerAgent} returned NOT-READY on round ${round}; resuming ${
            stage.agentRef ?? 'the lead'
          } to address the findings before round ${round + 1}`,
          detail: { round, reviewerAgent, attempt: priorStageRow?.attempt ?? 0 },
        })
        .catch(() => {});
      await runRepairTurn(reviewerRepairMessage({ reviewerAgent, round, reviewerFindings }), {
        label: `review repair r${round}`,
      }).catch((error) => logger.error('reviewer repair turn failed', { error, round }));
      const repairParked = await pendingGate({
        store,
        executionId,
        stageInstanceId,
        unitSlug,
        sectionIndex,
      });
      if (repairParked) return parkStage(repairParked);
    }
    const notReady = verdict?.result === 'FAIL' || verdict?.detail?.verdict === 'NOT-READY';
    if (advisory) {
      reviewAdvisory = {
        reviewerAgent,
        // The flag the gate-precondition evaluator keys off: it must be able to
        // tell an advisory verdict (a finding for the human) from an adversarial
        // one (which already failed or repaired the stage) from the DTO alone.
        advisory: true,
        verdict: verdict?.detail?.verdict ?? verdict?.result ?? 'INCONCLUSIVE',
        findings: verdict?.detail?.findings ?? null,
        ...(reviewArtifactUnderReview ? { artifact: reviewArtifactUnderReview } : {}),
      };
      const findingsText = reviewAdvisory.findings
        ? String(reviewAdvisory.findings).slice(0, 4000)
        : 'no findings recorded';
      await store
        .appendEvent({
          executionId,
          type: 'v2.review.advisory',
          stageInstanceId,
          unitSlug,
          sectionIndex,
          actor: reviewerAgent,
          summary: `Advisory review of ${stage.stageId} by ${reviewerAgent}: ${reviewAdvisory.verdict} — ${findingsText}`,
        })
        .catch(() => {});
      await publish({
        action: 'agent.note',
        noteType: 'v2.review.advisory',
        stageInstanceId,
        unitSlug,
        sectionIndex,
        kind: 'review',
        note: `advisory review (${reviewerAgent}): ${reviewAdvisory.verdict}`,
        summary: findingsText,
      }).catch(() => {});
    } else if (notReady && stage.humanValidation !== 'required') {
      return fail(
        stageInstanceId,
        'reviewer_not_ready',
        verdict?.detail?.findings ?? `${reviewerAgent} returned NOT-READY`,
      );
    }
  }

  // 6b. Deterministic sensors, GATE plane. `fire_on: gate` fires
  // once per existing declared deliverable as the stage opens its gate, so it
  // runs HERE — after the reviewer loop has finished rewriting artifacts — and
  // its verdict is therefore on the bytes the human will actually approve. The
  // verdicts ride the stage result into the gate as findings; a blocking one does
  // NOT fail a gated stage, because holding the gate with an override on the
  // record is strictly better than a FAILED run the human has to rewind.
  //
  // Gated twice, exactly like every other release semantic: release mode (a
  // verified closure, never an unpinned DynamoDB row a user hand-edited) AND the
  // field actually authored (at least one sensor asks for the gate plane).
  let gateSensorVerdicts = [];
  let gateFindings = [];
  if (methodologyRelease && withPlatformSensors(stage).some((s) => s.fireOn === 'gate')) {
    let gatePlane = null;
    // A gate plane that could not run is NOT a pass. Swallowing the error to null
    // opened the gate with the sensor axis silently absent; the human now gets an
    // INCONCLUSIVE advisory naming the reason, through the same finding builder the
    // verdicts themselves go through.
    let gatePlaneError = null;
    try {
      gatePlane = await runStageSensors({
        stage,
        stageInstanceId,
        unitSlug,
        sectionIndex,
        executionId,
        projectId,
        intentId,
        openGraph,
        loadBlockScript: loadScript,
        workspaceDir,
        env,
        spawnFn,
        store,
        publish,
        planes: ['gate'],
      });
    } catch (error) {
      gatePlaneError = error?.message ?? String(error);
      logger.warn('gate sensor plane degraded', {
        stageId,
        executionId,
        stageInstanceId,
        msg: gatePlaneError,
      });
    }
    gateSensorVerdicts = gatePlane?.verdicts ?? [];
    const gateRow = await store.getStage(executionId, stageInstanceId).catch(() => null);
    const gateAttempt = Number(gateRow?.attempt ?? priorStageRow?.attempt ?? 0);
    const gateReceipts = await (
      store.listReceipts?.(executionId, { stageInstanceId, attempt: gateAttempt }) ??
      Promise.resolve([])
    ).catch(() => []);
    gateFindings = sensorGateFindings({
      sensorVerdicts: [
        ...gateSensorVerdicts,
        ...(gatePlaneError
          ? [
              {
                sensorId: 'gate-sensor-plane',
                severity: 'advisory',
                result: 'INCONCLUSIVE',
                detail: { reason: gatePlaneError },
              },
            ]
          : []),
      ],
      receipts: gateReceipts,
      attempt: gateAttempt,
    });
    // The sensor axis is only auditable if its RESULT is durable on every gate
    // pass, PASS included: "3 passed, 0 flagged" is the evidence that the plane
    // ran at all, and without it a silently absent plane is indistinguishable
    // from a clean one.
    const passed = gateSensorVerdicts.filter((verdict) => verdict.result === 'PASS').length;
    const flagged = gateSensorVerdicts.length - passed;
    await store
      .appendEvent({
        executionId,
        type: 'v2.sensor.gate',
        stageInstanceId,
        unitSlug,
        sectionIndex,
        actor: 'agentcore',
        summary: `Gate sensors: ${passed} passed, ${flagged} flagged${
          gatePlaneError ? ' (plane INCONCLUSIVE)' : ''
        }`,
        detail: {
          passed,
          flagged,
          attempt: gateAttempt,
          sensorIds: gateSensorVerdicts.map((verdict) => verdict.sensorId),
          ...(gatePlaneError ? { error: gatePlaneError } : {}),
        },
      })
      .catch(() => {});
    // No human gate means no one can override, so upstream's own autonomous
    // path applies: halt. FAILED + rewind is this platform's equivalent halt.
    if (gatePlane?.held && stage.humanValidation !== 'required') {
      return fail(stageInstanceId, 'sensor_blocked', gatePlane.held);
    }
  }

  // The set of changed files comes from this stage's git commit — a source
  // every workflow has, so we always create CodeFile nodes + their Intent/Unit
  // topology from it. A valid, stage/unit-produced traceability.json is an
  // OPTIONAL extra source (capability-detected) that only adds requirement→file
  // evidence edges on top. Projection is intentionally best-effort: missing or
  // malformed evidence and Neptune outages must not turn successful
  // implementation work into an execution failure.
  let completedGitResult = gitResult;
  try {
    if (carriedCodeCommitRefs.length > 0) {
      completedGitResult = await gitResultForCommitRefs({
        commitRefs: stageCodeCommitRefs,
        repos,
        workspaceDir,
      });
    }
    const projected = await ingestStageCodeTraceability({
      openGraph,
      scope: {
        projectId,
        intentId,
        executionId,
        stageInstanceId,
        sectionIndex,
        unitSlug,
      },
      gitResult: completedGitResult,
      repos,
      workspaceDir,
      stageId,
      stageInstanceId,
      unitSlug,
    });
    if (projected.codeFiles > 0) {
      await store
        .appendEvent({
          executionId,
          type: 'v2.code_files.ingested',
          stageInstanceId,
          unitSlug,
          sectionIndex,
          actor: 'agentcore',
          summary: `Projected ${projected.codeFiles} code file revision(s) with ${projected.evidenceEdges} evidence edge(s)`,
        })
        .catch(() => {});
    }
    if (projected.statuses.includes('invalid')) {
      await store
        .appendEvent({
          executionId,
          type: 'v2.traceability.degraded',
          stageInstanceId,
          unitSlug,
          sectionIndex,
          actor: 'agentcore',
          summary: `Stage ${stageLabel} produced invalid traceability.json; Git code topology was retained without evidence links`,
        })
        .catch(() => {});
    }
  } catch (error) {
    await store
      .appendEvent({
        executionId,
        type: 'v2.traceability.degraded',
        stageInstanceId,
        unitSlug,
        sectionIndex,
        actor: 'agentcore',
        summary: `Code traceability projection skipped: ${error?.message ?? String(error)}`,
      })
      .catch(() => {});
  }

  // 7. Terminal success.
  await store.updateStageState({
    executionId,
    stageInstanceId,
    state: 'SUCCEEDED',
    completedAt: true,
    cli,
    cliSessionId,
    pendingCodeCommitRefs: null,
  });
  // Steering provenance: link the corrections this stage consumed to the
  // artifacts it produced (Steering --INFLUENCES--> Artifact), mirroring the
  // answered-question linking. Best-effort — provenance never fails a stage.
  if (consumedSteering.length && openGraph) {
    let gLink = null;
    try {
      gLink = await openGraph();
      const writer = createGraphWriter({
        g: gLink,
        scope: { projectId, intentId, executionId, stageInstanceId },
      });
      await writer.linkSteeringInfluences({
        steerIds: consumedSteering.map((r) => r.steerId),
        stageInstanceId,
      });
    } catch {
      /* provenance linking is best-effort */
    } finally {
      await closeGraphSource(gLink);
    }
  }
  await store.appendEvent({
    executionId,
    type: 'v2.stage.succeeded',
    stageInstanceId,
    unitSlug,
    sectionIndex,
    actor: 'agentcore',
    summary: `Stage ${stageLabel} succeeded`,
    payloadRef: now(),
  });
  await publish({
    action: 'agent.stage',
    stageInstanceId,
    stageId,
    unitSlug,
    sectionIndex,
    state: 'SUCCEEDED',
  });
  // Same trustworthiness rule as the `fire_on: write` sensor feed above: a
  // partial list is worse than none, because a downstream consumer reading
  // `changedFiles: []` cannot tell "this stage changed nothing" from "the git
  // engine could not say". Null unless the engine succeeded, reported at least
  // one repo, and every repo reported an explicit `files` array or a clean commit.
  const completedReportedFiles =
    completedGitResult.ok &&
    completedGitResult.results.length > 0 &&
    completedGitResult.results.every(
      (gitChange) => Array.isArray(gitChange.files) || gitChange.reason === 'clean',
    );
  const changedFiles = completedReportedFiles
    ? [
        ...new Set(completedGitResult.results.flatMap((gitChange) => gitChange.files ?? [])),
      ].toSorted()
    : null;
  const commitSha =
    completedGitResult.results.find((gitChange) => gitChange.committed && gitChange.sha)?.sha ??
    null;
  // Change control compares a stage's required inputs against the
  // fingerprints recorded when their PRODUCER was approved. The orchestrator
  // writes that record at the approval gate but has no Neptune access, so the
  // container hands it the fingerprints of everything this stage leaves behind.
  // Read-only and best-effort: an unreachable graph costs the next stage its
  // comparison, never this stage its success.
  let producedHeads = null;
  if (stage.policy && openGraph) {
    let gHeads = null;
    try {
      gHeads = await openGraph();
      producedHeads = await readArtifactHeadHashes({ g: gHeads, intentId });
    } catch {
      producedHeads = null;
    } finally {
      await closeGraphSource(gHeads);
    }
  }
  return {
    ok: true,
    state: 'SUCCEEDED',
    stageInstanceId,
    unitSlug,
    sectionIndex,
    cli,
    changedFiles,
    commitSha,
    verification:
      withPlatformSensors(stage).length > 0 ? 'Stage sensors passed' : 'Stage completed',
    reviewTargetCheck,
    ...(reviewAdvisory ? { reviewAdvisory } : {}),
    // Gate-precondition inputs. `ensembleEvidence` is what
    // only this runner could observe — the declared topology and the evidence it
    // actually gathered; the orchestrator re-reads the receipts itself before the
    // gate opens and merges its findings with these. Omitted entirely when no
    // ensemble ran, which is what keeps the gate prompt byte-identical.
    ...(ensembleEvidence ? { ensembleEvidence } : {}),
    // Every new field is omitted when empty: a legacy stage result must stay the
    // exact object the orchestrator has always received.
    ...(gateSensorVerdicts.length ? { gateSensorVerdicts } : {}),
    ...(() => {
      const findings = mergeFindings(stageFindings, gateFindings, changeControlFindings);
      return findings.length ? { findings } : {};
    })(),
    ...(changedInputs.length ? { changedInputs } : {}),
    ...(producedHeads?.length ? { producedHeads } : {}),
  };
};

// Exposed for unit tests (pure helpers; the runStage flow is integration-tested).
export const __test = {
  mergeLearningRules,
  composeKnowledge,
  renderTeamKnowledge,
  formatResumeAnswer,
  stripTerminalControls,
  createCliOutputSink,
  renderSteering,
  consumePendingSteering,
  isBenignKiroEmptyCompletion,
  buildReviewerPrompt,
  renderReviewerReadScope,
  runCheckpointLadder,
  SHARED_CONTRACT_ARTIFACTS,
  changedApprovedInputs,
  changeControlChoice,
  changeControlGateId,
  isChangeControlGate,
  renderChangedInputs,
  CHANGE_CONTROL_OPTIONS,
};
