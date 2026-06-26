// run-stage — execute ONE workflow stage inside the AgentCore session.
//
// The AgentCore Runtime routes the same session to the same microVM, so the git
// checkout from init-ws (and prior stages) is already on disk. This command:
//   1. resolves the pinned plan + finds the requested stage,
//   2. marks the stage RUNNING in the v2 process table (+ current phase/stage),
//   3. materializes the stage workspace (prompt + rules + mcp-config),
//   4. selects + spawns the headless CLI with our MCP server wired in,
//   5. records the terminal stage state (SUCCEEDED/FAILED) and an event — ALWAYS,
//      including on error, so the control plane never sees a stuck stage.
//
// Business artifacts are written by the agent through the MCP tools during the
// run; this command owns ONLY process state. Every effect is injected so the
// whole flow is unit-tested with the CLI + AWS mocked.

import { createRequire } from 'node:module';
import { selectCli, getDriver } from '../cli/drivers.js';
import { runChild } from '../cli/spawn.js';
import { resolveStageModel } from '../model-resolver.js';
import { createGraphWriter } from '../mcp/graph-writer.js';

const require = createRequire(import.meta.url);
const { buildExecutionPlan } = require('../../shared/v2-execution-plan.js');

// Resolve the plan and locate the stage instance for `stageId`.
const resolveStage = ({ workflow, library, scope, stageId }) => {
  const { valid, errors, plan } = buildExecutionPlan({ workflow, scope: scope.scope, library });
  if (!valid) return { error: 'plan_invalid', detail: errors };
  const stage = plan.stages.find((s) => s.stageId === stageId);
  if (!stage)
    return {
      error: 'stage_not_in_scope',
      detail: `stage "${stageId}" not in scope "${scope.scope}"`,
    };
  return { plan, stage };
};

// Concatenate the methodology knowledge bodies for an agent (best-effort). This
// is the authored, baseline-shipped tier (KNOWLEDGE blocks from the library).
const loadMethodologyKnowledge = async ({ agentRef, library, loadBlockBody }) => {
  const knowledgeBlocks = Object.values(library.knowledgeById ?? {}).filter(
    (k) => k.agentRef === agentRef || k.agentRef === 'shared',
  );
  const bodies = await Promise.all(knowledgeBlocks.map((k) => loadBlockBody(k).catch(() => '')));
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
  try {
    const g = await openGraph();
    const writer = createGraphWriter({ g, scope: { projectId, intentId, executionId } });
    const [teamKnowledge, learningRules] = await Promise.all([
      writer.getTeamKnowledge({ agentRef }).catch(() => []),
      writer.getLearningRules().catch(() => []),
    ]);
    return { teamKnowledge, learningRules };
  } catch {
    return empty;
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

export const runStage = async (
  {
    projectId,
    intentId,
    executionId,
    stageId,
    workflowId,
    workflowVersion,
    scope,
    requestedCli,
    cliModels = {},
    workspaceDir,
  },
  deps,
) => {
  const {
    store,
    loadLibrary,
    loadBlockBody,
    materializeStage,
    renderRulesDoc,
    mcpEntry,
    openGraph = null,
    availableClis = [],
    env = process.env,
    spawnFn,
    clock = () => new Date().toISOString(),
  } = deps;

  const now = () => clock();
  const fail = async (stageInstanceId, reason, detail) => {
    if (stageInstanceId) {
      await store
        .updateStageState({
          executionId,
          stageInstanceId,
          state: 'FAILED',
          runtimeError: reason,
          completedAt: true,
        })
        .catch(() => {});
    }
    await store
      .appendEvent({
        executionId,
        type: 'v2.stage.failed',
        stageInstanceId,
        actor: 'agentcore',
        summary: `${reason}${detail ? `: ${detail}` : ''}`,
      })
      .catch(() => {});
    return { ok: false, reason, detail };
  };

  // 1. Load the pinned workflow + library, then fold in the project's accrued
  // runtime memory (team knowledge + learning rules) read from Neptune. Learning
  // rules are merged into the workflow/library BEFORE resolution so the existing
  // rule resolver interleaves them at their learnings-layer precedence; team
  // knowledge is held for the prompt. Reading the agentRef needs the stage, but
  // the merge needs to precede resolution — so we resolve once to read the
  // agentRef, merge, then resolve against the enriched library.
  const loaded = await loadLibrary({ workflowId, workflowVersion });
  if (!loaded.workflow || !loaded.library)
    return fail(null, 'workflow_not_found', `${workflowId}@${workflowVersion}`);

  const probe = resolveStage({ ...loaded, scope: { scope }, stageId });
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

  const resolved = resolveStage({ workflow, library, scope: { scope }, stageId });
  if (resolved.error) return fail(null, resolved.error, JSON.stringify(resolved.detail));
  const { stage } = resolved;
  const stageInstanceId = stage.stageInstanceId;

  if (stage.notImplemented) return fail(stageInstanceId, 'not_implemented', `mode ${stage.mode}`);

  // 2. Mark RUNNING + advance the execution's current phase/stage pointer.
  await store.putStage({
    executionId,
    stageInstanceId,
    stageId,
    phase: stage.phase,
    state: 'RUNNING',
  });
  await store.updateExecution({
    executionId,
    status: 'RUNNING',
    currentPhase: stage.phase,
    currentStage: stageId,
  });
  await store.appendEvent({
    executionId,
    type: 'v2.stage.running',
    stageInstanceId,
    actor: 'agentcore',
    summary: `Stage ${stageId} running`,
  });

  // 3. Select the CLI before doing workspace work — fail fast if none.
  const cli = selectCli({ requested: requestedCli, availableClis });
  if (!cli)
    return fail(stageInstanceId, 'no_cli', `available: ${availableClis.join(', ') || 'none'}`);

  // 4. Materialize the workspace: stage body + persona + knowledge + rules.
  const stageBlock = library.stagesById[stageId] ?? {};
  const agentBlock = library.agentsById[stage.agentRef] ?? null;
  const [stageBody, agentPersona] = await Promise.all([
    loadBlockBody(stageBlock).catch(() => ''),
    agentBlock ? loadBlockBody(agentBlock).catch(() => '') : Promise.resolve(''),
  ]);
  // Knowledge has two tiers: the authored methodology (library blocks) and the
  // project's accrued team knowledge (already read from Neptune above). Both are
  // injected into the prompt so the agent always receives them; the team tier is
  // also re-readable on demand via the get_team_knowledge MCP tool.
  const methodology = await loadMethodologyKnowledge({
    agentRef: stage.agentRef,
    library,
    loadBlockBody,
  });
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
          : await loadBlockBody(ruleBlock).catch(() => '');
      return [id, body];
    }),
  );
  const rulesDoc = renderRulesDoc(stage, Object.fromEntries(ruleBodyEntries));

  const stageScope = { executionId, intentId, projectId, stageInstanceId, role: 'author' };
  const { prompt, mcpConfigPath } = await materializeStage({
    workspaceDir,
    stage,
    stageBody,
    agentPersona,
    knowledge,
    rulesDoc,
    mcpEntry,
    scope: stageScope,
    env,
  });

  // 5. Spawn the headless CLI.
  const driver = getDriver(cli);
  // Resolve the model: the project's per-CLI Admin selection wins, then the
  // stage/agent block's modelOverride, then the static env default; bare tier
  // aliases (opus/sonnet) are resolved to full region-prefixed Bedrock ids.
  const model = resolveStageModel({ cliModels, agentBlock, cli, env });
  const invocation = driver.buildInvocation({ prompt, mcpConfigPath, model, allowedTools: [] });
  const childEnv = { ...invocation.env, ...driver.envForAuth(env) };

  let result;
  try {
    result = await runChild({
      command: invocation.command,
      args: invocation.args,
      env: childEnv,
      cwd: workspaceDir,
      prompt,
      promptViaStdin: invocation.promptViaStdin,
      spawnFn,
    });
  } catch (e) {
    return fail(stageInstanceId, 'cli_error', e.message);
  }

  const exitCode = result?.exitCode ?? 0;
  if (exitCode !== 0) return fail(stageInstanceId, 'cli_nonzero_exit', String(exitCode));

  // 6. Terminal success.
  await store.updateStageState({
    executionId,
    stageInstanceId,
    state: 'SUCCEEDED',
    completedAt: true,
  });
  await store.appendEvent({
    executionId,
    type: 'v2.stage.succeeded',
    stageInstanceId,
    actor: 'agentcore',
    summary: `Stage ${stageId} succeeded`,
    payloadRef: now(),
  });
  return { ok: true, state: 'SUCCEEDED', stageInstanceId, cli };
};

// Exposed for unit tests (pure helpers; the runStage flow is integration-tested).
export const __test = { mergeLearningRules, composeKnowledge, renderTeamKnowledge };
