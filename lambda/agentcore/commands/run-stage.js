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

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import {
  selectCli,
  getDriver,
  buildKiroListSessions,
  parseLatestKiroSession,
} from '../cli/drivers.js';
import { runChild, captureChild } from '../cli/spawn.js';
import {
  materializeMcpConfig as defaultMaterializeMcpConfig,
  materializeKiroAgent as defaultMaterializeKiroAgent,
} from '../stage-materializer.js';
import {
  restoreKiroStore as defaultRestoreKiroStore,
  persistKiroStore as defaultPersistKiroStore,
  resolveKiroStore,
} from '../cli/kiro-store.js';
import { ensureWorkspaceSource as defaultEnsureWorkspaceSource } from '../workspace.js';
import { resolveStageModel } from '../model-resolver.js';
import { createGraphWriter } from '../mcp/graph-writer.js';
import { createSensorRunner } from '../sensor-runner.js';

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

// Run the stage's deterministic sensors after the agent finishes. Records a
// SensorRun verdict + broadcasts an `agent.note` per sensor. Returns a
// human-readable reason string when a BLOCKING sensor held the stage, else null.
// `graph` sensors need a graph-writer; we open the same private graph the rest
// of run-stage uses (best-effort — an unreachable graph yields INCONCLUSIVE
// graph verdicts, never a crash).
const runStageSensors = async ({
  stage,
  stageInstanceId,
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
}) => {
  let graph = null;
  if (openGraph) {
    try {
      const g = await openGraph();
      graph = createGraphWriter({ g, scope: { projectId, intentId, executionId } });
    } catch {
      graph = null;
    }
  }
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
    sensors: stage.sensors ?? [],
    outputArtifacts: stage.outputArtifacts ?? [],
    inputArtifacts: stage.inputArtifacts ?? [],
    stageId: stage.stageId,
  });

  const heldReasons = [];
  for (const v of verdicts) {
    await store
      .recordSensorRun({
        executionId,
        stageInstanceId,
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
          actor: 'agentcore',
          summary: `Sensor ${v.sensorId} (${v.severity}) → ${v.result}${
            v.held ? ' — blocking' : ''
          }${summarizeSensorDetail(v.detail)}`,
        })
        .catch(() => {});
    }
    if (v.held) heldReasons.push(`${v.sensorId}=${v.result}`);
  }
  return heldReasons.length ? heldReasons.join(', ') : null;
};

// Render an answered gate into the message that re-enters the parked conversation.
// The agent asked structured questions; we feed back the human's answer so it
// continues from where it parked. Tolerant of the answer shapes the resume lambda
// / phaseb-answer write (`perQuestion[]`, `freeText`, or a raw string).
const formatResumeAnswer = (gate) => {
  const a = gate?.answer ?? null;
  if (a && Array.isArray(a.perQuestion) && a.perQuestion.length) {
    const lines = a.perQuestion.map((p) => `- ${p.text ?? 'Q'}: ${p.answer ?? ''}`);
    return `The human answered your question(s):\n${lines.join('\n')}\n\nContinue the stage with these answers.`;
  }
  const text = typeof a === 'string' ? a : (a?.freeText ?? JSON.stringify(a ?? {}));
  return `The human answered your question(s): ${text}\n\nContinue the stage with this answer.`;
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

// Return the execution's still-pending HUMAN gate (if any). The meta row's
// `pendingHumanTaskId` is the source of truth ask_question sets when it parks; we
// confirm the gate is still pending before treating the stage as parked.
const pendingGate = async ({ store, executionId }) => {
  const meta = await store.getExecution(executionId).catch(() => null);
  const humanTaskId = meta?.pendingHumanTaskId ?? null;
  if (!humanTaskId) return null;
  const gate = await store.getHumanTask(executionId, humanTaskId).catch(() => null);
  return gate && gate.status === 'pending' ? { humanTaskId } : null;
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
    // Clone inputs, forwarded by the orchestrator so a stage can self-heal a wiped
    // source checkout (see ensureWorkspaceSource). Same values init-ws used; empty
    // repos means a repo-less project (nothing to restore).
    repos = [],
    branch,
    baseBranch,
    gitToken,
    gitProvider,
    // Resume mode: when set, re-invoke the SAME parked stage conversation with the
    // human's answer to `resumeFrom` (a humanTaskId) instead of running fresh. The
    // session's persistent /mnt/workspace mount restores the checkout + CLI store.
    resumeFrom = null,
  },
  deps,
) => {
  const {
    store,
    loadLibrary,
    loadBlockBody,
    loadBlockScript = async () => '',
    loadConductor = async () => '',
    materializeStage,
    materializeMcpConfig = defaultMaterializeMcpConfig,
    materializeKiroAgent = defaultMaterializeKiroAgent,
    renderRulesDoc,
    mcpEntry,
    openGraph = null,
    availableClis = [],
    env = process.env,
    spawnFn,
    broadcast = async () => {},
    clock = () => new Date().toISOString(),
    ids = randomUUID,
    // Kiro SQLite store sync (mount ↔ ephemeral local XDG); no-ops for Claude and
    // when the store env is unset. Injected for tests.
    restoreKiroStore = defaultRestoreKiroStore,
    persistKiroStore = defaultPersistKiroStore,
    // Re-clone a wiped source checkout before the CLI spawns. Injected for tests.
    ensureWorkspaceSource = defaultEnsureWorkspaceSource,
  } = deps;

  const now = () => clock();
  // Publish a process event on the intent's realtime channel. Best-effort: the
  // DynamoDB write is the source of truth, so a failed broadcast must never break
  // a stage (mirrors the process bridge's broadcast contract).
  const publish = (payload) =>
    broadcast({ executionId, intentId, projectId, ...payload }).catch(() => {});

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
    await publish({ action: 'agent.stage', stageInstanceId, stageId, state: 'FAILED', reason });
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

  const agentBlock = library.agentsById[stage.agentRef] ?? null;
  const stageScope = { executionId, intentId, projectId, stageInstanceId, role: 'author' };

  // 2a. Source self-heal (runs for EVERY stage, fresh or resume). The managed
  // /mnt/workspace mount is wiped by any runtime image redeploy and after 14 idle
  // days, so a stage running after a deploy would otherwise spawn its CLI against
  // an EMPTY tree and run blind (the reverse-engineering "source not present"
  // incident). Re-clone any repo whose checkout is missing before doing anything
  // else. A repo-less project (empty repos) is a no-op; a genuine clone failure
  // (unreachable/auth) fails the stage rather than letting it proceed on nothing.
  let sourceRestored = false;
  {
    const heal = await ensureWorkspaceSource({
      repos,
      branch,
      baseBranch,
      gitToken,
      gitProvider,
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
      await store
        .appendEvent({
          executionId,
          type: 'v2.workspace.restored',
          stageInstanceId,
          actor: 'agentcore',
          summary: `Source checkout re-cloned after a wiped workspace (${heal.repos.join(', ')})`,
        })
        .catch(() => {});
      await publish({
        action: 'agent.workspace',
        state: 'RESTORED',
        stageInstanceId,
        repos: heal.repos,
      });
    }
  }

  // 2b. Pick the CLI + recover (resume) or mint (fresh) the conversation handle.
  // On resume the gate MUST be answered and the parked stage MUST carry a CLI
  // session id (same conversation continues). On a fresh run Claude's id is forced
  // up front; Kiro's is captured after the run (it has no start-time id flag).
  let cli;
  let cliSessionId = null;
  let resumeAnswer = null;
  // A resume we had to demote to a fresh run because the parked conversation was
  // lost with the wiped mount (D2 recoverable path): re-runs fresh with the human's
  // answer injected into the prompt so the agent does not re-ask.
  let demotedResume = false;
  if (resumeFrom) {
    const gate = await store.getHumanTask(executionId, resumeFrom).catch(() => null);
    if (!gate) return fail(stageInstanceId, 'gate_not_found', resumeFrom);
    if (gate.status === 'pending') return fail(stageInstanceId, 'gate_not_answered', resumeFrom);
    const row = await store.getStage(executionId, stageInstanceId).catch(() => null);
    cli = row?.cli ?? null;
    const priorSessionId = row?.cliSessionId ?? null;
    if (!cli || !priorSessionId)
      return fail(stageInstanceId, 'resume_no_session', `stage has no persisted CLI session`);
    if (!availableClis.includes(cli))
      return fail(stageInstanceId, 'no_cli', `resume CLI "${cli}" not installed`);
    resumeAnswer = formatResumeAnswer(gate);

    // Did the parked conversation survive the mount? Both CLIs keep it on
    // /mnt/workspace (Claude JSONL under CLAUDE_CONFIG_DIR, Kiro SQLite under
    // V2_KIRO_STORE_DIR), so a re-cloned source means the conversation is gone too.
    // Kiro additionally copies its store mount→local each run; a failed restore is
    // the same signal even if the source happened to survive.
    let conversationLost = sourceRestored;
    if (cli === 'kiro') {
      const kiroRestored = await restoreKiroStore({ env }).catch(() => false);
      if (!kiroRestored && resolveKiroStore(env)) conversationLost = true;
      else if (!kiroRestored)
        console.error(`[run-stage] kiro store not restored for resume ${stageInstanceId}`);
    }

    if (conversationLost) {
      // D2 (docs/v2-resume.md): a lost parked conversation is recoverable only
      // inside managed session storage's 14-day window. Past it, hard-fail so the
      // UI can flag a stale project. Inside it — a routine redeploy wipe — re-run
      // the stage FRESH with the answered Q&A injected, so no work is stranded and
      // the agent does not re-ask. (Was a blind resume_store_lost hard-fail before.)
      const age = gateAgeMs(gate, now());
      if (age !== null && age >= FOURTEEN_DAYS_MS) {
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
          actor: 'agentcore',
          summary: `Parked conversation lost with the wiped workspace; re-running ${stageId} fresh with the answer injected`,
        })
        .catch(() => {});
    } else {
      cliSessionId = priorSessionId;
    }
  } else {
    cli = selectCli({ requested: requestedCli, availableClis });
    if (!cli) {
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

  // A fresh conversation is spawned for a plain fresh run OR a demoted resume.
  const freshRun = !resumeFrom || demotedResume;

  // Mark RUNNING + advance the execution pointer + persist the conversation
  // handle. A resume flips the parked stage (WAITING_FOR_HUMAN) back to RUNNING.
  await store.putStage({
    executionId,
    stageInstanceId,
    stageId,
    phase: stage.phase,
    state: 'RUNNING',
    cli,
    cliSessionId,
  });
  await store.updateExecution({
    executionId,
    status: 'RUNNING',
    currentPhase: stage.phase,
    currentStage: stageId,
  });
  await store.appendEvent({
    executionId,
    type: resumeFrom && !demotedResume ? 'v2.stage.resumed' : 'v2.stage.running',
    stageInstanceId,
    actor: 'agentcore',
    summary: resumeFrom && !demotedResume ? `Stage ${stageId} resumed` : `Stage ${stageId} running`,
  });
  // Broadcast the stage start + the execution's new phase/stage pointer so the
  // UI reflects the advance in real time.
  await publish({
    action: 'agent.stage',
    stageInstanceId,
    stageId,
    phase: stage.phase,
    state: 'RUNNING',
  });
  await publish({
    action: 'agent.execution',
    status: 'RUNNING',
    currentPhase: stage.phase,
    currentStage: stageId,
  });

  // 3. Build the invocation. A fresh run materializes the full workspace (prompt +
  // rules + knowledge); a resume only re-attaches the MCP config (the parked
  // conversation already holds the prompt) and feeds the human's answer.
  const driver = getDriver(cli);
  // Resolve the model: the project's per-CLI Admin selection wins, then the
  // stage/agent block's modelOverride, then the static env default; bare tier
  // aliases (opus/sonnet) are resolved to full region-prefixed Bedrock ids.
  const model = resolveStageModel({ cliModels, agentBlock, cli, env });

  // Materialize the MCP wiring the selected CLI expects: Claude loads a
  // --mcp-config file; Kiro discovers an --agent config at .kiro/agents/. Returns
  // the kwargs the driver's build* methods take (mcpConfigPath OR agentName).
  const materializeCliMcp = async () => {
    if (cli === 'kiro') {
      const agentName = await materializeKiroAgent({
        workspaceDir,
        mcpEntry,
        scope: stageScope,
        env,
      });
      return { agentName };
    }
    const mcpConfigPath = await materializeMcpConfig({
      workspaceDir,
      mcpEntry,
      scope: stageScope,
      env,
    });
    return { mcpConfigPath };
  };

  let invocation;
  let prompt = null;
  if (!freshRun) {
    const mcpKwargs = await materializeCliMcp();
    invocation = driver.buildResumeInvocation({
      sessionId: cliSessionId,
      answerMessage: resumeAnswer,
      model,
      ...mcpKwargs,
    });
  } else {
    const stageBlock = library.stagesById[stageId] ?? {};
    const [stageBody, agentPersona, conductor] = await Promise.all([
      loadBlockBody(stageBlock).catch(() => ''),
      agentBlock ? loadBlockBody(agentBlock).catch(() => '') : Promise.resolve(''),
      loadConductor(env.AIDLC_REPO_REF).catch(() => ''),
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

    const materialized = await materializeStage({
      workspaceDir,
      stage,
      stageBody,
      agentPersona,
      knowledge,
      conductor,
      rulesDoc,
      mcpEntry,
      scope: stageScope,
      env,
    });
    prompt = materialized.prompt;
    // Demoted resume (D2): the parked conversation was lost with the wiped mount,
    // so we re-run the stage fresh — but prepend the human's already-given answer
    // so the agent applies it instead of re-asking the same question.
    if (demotedResume && resumeAnswer) {
      prompt = `## Previously answered\n${resumeAnswer}\n\n---\n\n${prompt}`;
    }
    // materializeStage wrote the Claude --mcp-config; for Kiro we additionally
    // need its --agent config. materializeCliMcp returns the right driver kwargs.
    const mcpKwargs = await materializeCliMcp();
    invocation = driver.buildInvocation({
      prompt,
      model,
      allowedTools: [],
      sessionId: cliSessionId,
      ...mcpKwargs,
    });
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
    if (!restored) console.error(`[run-stage] kiro store not restored (fresh) ${stageInstanceId}`);
  }

  // 4. Spawn the headless CLI.
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
      // Kiro only: tee the stderr tail so we can recognise its benign
      // empty-final-completion crash (see isBenignKiroEmptyCompletion). Claude
      // needs no such inspection, so we leave its stderr purely inherited.
      captureStderrTail: cli === 'kiro' ? 16_384 : 0,
      spawnFn,
    });
  } catch (e) {
    return fail(stageInstanceId, 'cli_error', e.message);
  }

  const exitCode = result?.exitCode ?? 0;
  console.error(
    `[run-stage] cli=${cli} stage=${stageId} exitCode=${exitCode} model=${model ?? '(default)'}`,
  );

  // Kiro only: persist the live local store back to the durable mount after the
  // run. Runs on ANY exit (success, park, or crash) so a parked conversation is
  // captured even if the CLI later errored. Best-effort — a failed persist never
  // fails the stage, but a parked conversation then won't survive a reap, so log it.
  if (cli === 'kiro') {
    const persisted = await persistKiroStore({ env }).catch(() => false);
    if (!persisted) {
      console.error(`[run-stage] kiro store not persisted for ${stageInstanceId}`);
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

  // 5. Park check — did the agent leave a pending question? ask_question parks
  // (returns a sentinel) instead of blocking, so the agent is told to stop. The
  // durable pending gate — NOT the CLI exit code — is the source of truth for a
  // park: a clean exit OR a non-zero exit AFTER parking both mean "waiting on a
  // human". We therefore check the gate BEFORE treating a non-zero exit as failure,
  // so a Kiro run that parks then errors on its next turn parks rather than fails.
  const parked = await pendingGate({ store, executionId });
  if (!parked && exitCode !== 0) {
    // Kiro's benign empty-final-completion crash: the turn's work completed, the
    // agent just ended without closing text and kiro-cli's ACP rejected the empty
    // message. Treat as success (not a stage failure) but record a note so the
    // signature stays visible. Sensors below still run and can hold the stage.
    if (cli === 'kiro' && isBenignKiroEmptyCompletion(result?.stderrTail)) {
      console.error(
        `[run-stage] kiro empty-completion (benign) on ${stageId}; exitCode=${exitCode} — treating as success`,
      );
      await store
        .appendEvent({
          executionId,
          type: 'v2.stage.note',
          stageInstanceId,
          actor: 'agentcore',
          summary: `Kiro exited ${exitCode} with an empty final message after completing work; treated as success (ACP empty-completion).`,
        })
        .catch(() => {});
    } else {
      return fail(stageInstanceId, 'cli_nonzero_exit', String(exitCode));
    }
  }
  if (parked) {
    await store
      .updateStageState({
        executionId,
        stageInstanceId,
        state: 'WAITING_FOR_HUMAN',
        cli,
        cliSessionId,
      })
      .catch(() => {});
    await store.appendEvent({
      executionId,
      type: 'v2.stage.parked',
      stageInstanceId,
      actor: 'agentcore',
      summary: `Stage ${stageId} parked on question ${parked.humanTaskId}`,
    });
    await publish({ action: 'agent.stage', stageInstanceId, stageId, state: 'WAITING_FOR_HUMAN' });
    return {
      ok: true,
      state: 'WAITING_FOR_HUMAN',
      stageInstanceId,
      humanTaskId: parked.humanTaskId,
      cliSessionId,
      cli,
    };
  }

  // 6. Deterministic sensors — the verification axis that runs AFTER the agent.
  // Graph sensors evaluate the produced artifacts' content in-process; script
  // sensors spawn against the workspace checkout. Advisory verdicts record a
  // note and never hold; a BLOCKING sensor that did not PASS fails the stage.
  // Best-effort wiring: a sensor subsystem error never masks a successful run.
  if ((stage.sensors ?? []).length > 0) {
    const held = await runStageSensors({
      stage,
      stageInstanceId,
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
    }).catch(() => null);
    if (held) {
      return fail(stageInstanceId, 'sensor_blocked', held);
    }
  }

  // 7. Terminal success.
  await store.updateStageState({
    executionId,
    stageInstanceId,
    state: 'SUCCEEDED',
    completedAt: true,
    cli,
    cliSessionId,
  });
  await store.appendEvent({
    executionId,
    type: 'v2.stage.succeeded',
    stageInstanceId,
    actor: 'agentcore',
    summary: `Stage ${stageId} succeeded`,
    payloadRef: now(),
  });
  await publish({ action: 'agent.stage', stageInstanceId, stageId, state: 'SUCCEEDED' });
  return { ok: true, state: 'SUCCEEDED', stageInstanceId, cli };
};

// Exposed for unit tests (pure helpers; the runStage flow is integration-tested).
export const __test = {
  mergeLearningRules,
  composeKnowledge,
  renderTeamKnowledge,
  formatResumeAnswer,
  isBenignKiroEmptyCompletion,
};
